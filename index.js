// ——— Imports & Config ———
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const { OpenAI } = require('openai');
const { Document, Packer, Paragraph } = require('docx');
const { google } = require('googleapis');
require('dotenv').config();

const admin = require('./firebaseAdmin');
const db = admin.database();

// ——— Constants & Environment Variables ———
const PORT = process.env.PORT || 3000;
const openaiKey = process.env.OPENAI_API_KEY;
const smartMinutesKey = process.env.SMART_MINUTES_KEY;
// The path Render mounts the file
const momKeyPath = process.env.SMARTMINUTES_MOM_KEY_FILE || '/etc/secrets/smartminutesMoMkey.json';

const projectId = 'speech-to-text-459913';
const bucketName = 'smart-minutes-bucket';
const parentFolderId = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr'; // Google Drive folder ID

process.env.GOOGLE_APPLICATION_CREDENTIALS = smartMinutesKey;

// ——— Clients ———
const storage = new Storage({ projectId });
const speechClient = new speech.SpeechClient();
const openai = new OpenAI({ apiKey: openaiKey });
const upload = multer({ storage: multer.memoryStorage() });

// ——— Google Drive Setup ———
const auth = new google.auth.GoogleAuth({
  keyFile: momKey,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

let drive;

// Initialize Google Drive
async function initDrive() {
  try {
    const authClient = await auth.getClient();
    drive = google.drive({ version: 'v3', auth: authClient });
    console.log('✅ Google Drive initialized');
    await testDriveFolder();
  } catch (err) {
    console.error('❌ Google Drive initialization failed:', err.message);
    process.exit(1);
  }
}

// Test Drive folder access
async function testDriveFolder() {
  try {
    const res = await drive.files.list({
      q: `'${parentFolderId}' in parents`,
      fields: 'files(id, name)',
      pageSize: 5,
    });

    if (!res.data.files || !res.data.files.length) {
      console.log(`📂 Drive folder accessible but empty.`);
    } else {
      console.log('📂 Drive folder accessible. Sample files:');
      res.data.files.forEach(f => console.log(`- ${f.name} (${f.id})`));
    }
  } catch (err) {
    console.error('❌ Cannot access Drive folder:', err.message);
  }
}

// ——— Auto-Corrections ———
const corrections = {
  'Thank you, sir. Have a good day in the': 'Thank you sa pag attend',
  'young': 'yoong',
};

function applyCorrections(text) {
  for (const [wrong, correct] of Object.entries(corrections)) {
    const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
    text = text.replace(regex, correct);
  }
  return text;
}

// ——— Express App ———
const app = express();
app.use(express.json());
app.use(cors());

// ——— Firebase Login ———
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

  try {
    const snapshot = await db.ref('Users').once('value');
    const users = snapshot.val() || {};

    const userEntry = Object.entries(users).find(([id, user]) => user.email === email && user.password === password);

    if (userEntry) {
      const [uid] = userEntry;
      return res.status(200).json({ success: true, message: 'Login successful', uid });
    }

    res.status(401).json({ success: false, message: 'Invalid email or password' });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ——— Upload Audio to GCS ———
async function uploadBufferToGCS(buffer, filename) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(filename);

  await file.save(buffer, { metadata: { contentType: 'audio/mpeg' }, resumable: false });
  console.log(`✅ Uploaded audio: gs://${bucketName}/${filename}`);
  return `gs://${bucketName}/${filename}`;
}

// ——— Speech-to-Text ———
async function transcribeFromGCS(gcsUri) {
  const request = {
    audio: { uri: gcsUri },
    config: {
      encoding: 'MP3',
      sampleRateHertz: 16000,
      languageCode: 'fil-PH',
      alternativeLanguageCodes: ['en-US'],
      enableSpeakerDiarization: true,
      diarizationSpeakerCount: 2,
      model: 'default',
    },
  };

  const [operation] = await speechClient.longRunningRecognize(request);
  const [response] = await operation.promise();

  const result = response.results[response.results.length - 1];
  let transcript = '';
  let currentSpeaker = null;

  for (const wordInfo of result.alternatives[0].words) {
    if (wordInfo.speakerTag !== currentSpeaker) {
      currentSpeaker = wordInfo.speakerTag;
      transcript += `\n\nSpeaker ${currentSpeaker}:\n`;
    }
    transcript += wordInfo.word + ' ';
  }

  return transcript.trim();
}

// ——— Transcription Endpoint ———
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const { uid } = req.body;
  if (!req.file || !uid) return res.status(400).json({ success: false, message: 'Missing file or user ID' });

  try {
    const gcsFileName = `${Date.now()}-${req.file.originalname}`;
    const gcsUri = await uploadBufferToGCS(req.file.buffer, gcsFileName);

    const rawTranscript = await transcribeFromGCS(gcsUri);
    const cleanedTranscript = applyCorrections(rawTranscript);

    const dbRef = db.ref(`transcriptions/${uid}`).push();
    await dbRef.set({
      filename: req.file.originalname,
      text: cleanedTranscript,
      gcsUri,
      status: "✅ Transcription Complete",
      createdAt: Date.now(),
    });

    fs.writeFileSync('./transcript.txt', cleanedTranscript);
    res.json({ success: true, transcription: cleanedTranscript, audioFileName: req.file.originalname });
  } catch (err) {
    console.error('❌ /transcribe error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ——— Summarization Endpoint ———
app.post('/summarize', async (req, res) => {
  const { userId, audioFileName } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

  try {
    if (!drive) await initDrive();

    const transcript = fs.readFileSync('./transcript.txt', 'utf-8');
    const baseName = (audioFileName || 'Transcription').replace(/\.[^/.]+$/, "");

    const templates = [
      { name: 'Template-Formal', dbField: 'formal_template', prompt: `Summarize the transcription formally:\n\n"${transcript}"` },
      { name: 'Template-Simple', dbField: 'simple_template', prompt: `Summarize simply:\n\n"${transcript}"` },
      { name: 'Template-Detailed', dbField: 'detailed_template', prompt: `Summarize in detail:\n\n"${transcript}"` },
    ];

    const summariesTable = {};
    const results = [];

    for (const t of templates) {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant formatting meeting transcriptions.' },
          { role: 'user', content: t.prompt },
        ],
        temperature: 0.4,
      });

      const summaryText = aiResponse.choices[0].message.content;

      // Create DOCX
      const doc = new Document({ creator: 'Smart Minutes App', title: `MoM - ${t.name}`, sections: [{ children: summaryText.split('\n').map(l => new Paragraph(l)) }] });
      const buffer = await Packer.toBuffer(doc);
      const fileName = `${baseName}-${t.name}-${Date.now()}.docx`;

      // Upload to Drive
      const { Readable } = require('stream');
      const bufferStream = new Readable();
      bufferStream.push(buffer);
      bufferStream.push(null);

      const fileMetadata = { name: fileName, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', parents: [parentFolderId] };
      const media = { mimeType: fileMetadata.mimeType, body: bufferStream };
      const driveRes = await drive.files.create({ requestBody: fileMetadata, media, fields: 'id' });

      await drive.permissions.create({ fileId: driveRes.data.id, requestBody: { role: 'reader', type: 'anyone' } });

      const publicLink = `https://drive.google.com/file/d/${driveRes.data.id}/view?usp=sharing`;
      summariesTable[t.dbField] = publicLink;
      results.push({ template: t.name, link: publicLink });
      console.log(`✅ ${t.name} created and uploaded`);
    }

    const tableRef = db.ref(`summaries/${userId}`).push();
    await tableRef.set({ audioFileName, createdAt: admin.database.ServerValue.TIMESTAMP, ...summariesTable });

    res.json({ success: true, results, tableRecordId: tableRef.key });

  } catch (err) {
    console.error('❌ /summarize error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ——— Get all minutes for user ———
app.get('/allminutes/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing user ID.' });

    const snapshot = await db.ref(`summaries/${userId}`).once('value');
    const data = snapshot.val() || {};

    const minutes = Object.entries(data).map(([id, d]) => ({
      summaryId: id,
      audioFileName: d.audioFileName || 'Untitled',
      createdAt: d.createdAt || null,
      formal_template: d.formal_template || null,
      simple_template: d.simple_template || null,
      detailed_template: d.detailed_template || null,
    }));

    res.json({ success: true, minutes });
  } catch (err) {
    console.error('❌ /allminutes error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch minutes.' });
  }
});

// ——— Start Server ———
initDrive().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
});

