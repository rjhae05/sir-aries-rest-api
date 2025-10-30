const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const { Document, Packer, Paragraph } = require('docx');
const { google } = require('googleapis');
require('dotenv').config();

console.log('🚀 ENV LOADED:', !!process.env.SMARTMINUTES_MOM_KEY);
console.log('🔑 SMARTMINUTES_MOM_KEY path:', process.env.SMARTMINUTES_MOM_KEY);
console.log('📂 File exists at path?', fs.existsSync(process.env.SMARTMINUTES_MOM_KEY));

const admin = require('./firebaseAdmin');
const db = admin.database();

// ——— Express App Setup ———
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cors());

// ——— Environment Variables ———
const openaiKey = process.env.OPENAI_API_KEY;
const momKey = process.env.SMARTMINUTES_MOM_KEY;
const smartMinutesKey = process.env.SMART_MINUTES_KEY;

// ——— Google Cloud Config ———
const projectId = 'speech-to-text-459913';
const bucketName = 'smart-minutes-bucket';
process.env.GOOGLE_APPLICATION_CREDENTIALS = smartMinutesKey;

const storage = new Storage({ projectId });
const speechClient = new speech.SpeechClient();
const openai = new OpenAI({ apiKey: openaiKey });

// ——— Multer (File Uploads) ———
const upload = multer({ storage: multer.memoryStorage() });

// ——— Google Drive Auth ———
console.log('🧩 SMARTMINUTES_MOM_KEY =', momKey);
console.log('📂 File exists:', fs.existsSync(momKey));

const auth = new google.auth.GoogleAuth({
  keyFile: momKey,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

let drive;
let parentFolderId = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr'; // your Drive folder ID

// ——— Auto-correction ———
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

// ——— Google Drive Initialization ———
async function testListFiles() {
  try {
    const res = await drive.files.list({
      q: `'${parentFolderId}' in parents`,
      fields: 'files(id, name)',
      pageSize: 5,
    });

    if (!res.data.files || res.data.files.length === 0) {
      console.log(`📂 Folder "${parentFolderId}" accessible but empty.`);
    } else {
      console.log(`✅ Folder "${parentFolderId}" accessible. Sample files:`);
      res.data.files.forEach(file => console.log(`📄 ${file.name} (ID: ${file.id})`));
    }
  } catch (err) {
    console.error(`❌ Cannot access folder "${parentFolderId}":`, err.message);
  }
}

async function initDrive() {
  try {
    const authClient = await auth.getClient();
    drive = google.drive({ version: 'v3', auth: authClient });
    console.log('🔑 Google Drive client initialized.');
    await testListFiles();
  } catch (err) {
    console.error('❌ Failed to initialize Google Drive:', err.message);
    process.exit(1); // Stop server if Drive setup fails
  }
}

// ——— Firebase Login ———
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const usersRef = db.ref('Users');

  try {
    const snapshot = await usersRef.once('value');
    const users = snapshot.val();

    for (const key in users) {
      if (users[key].email === email && users[key].password === password) {
        return res.status(200).json({ success: true, message: 'Login successful', uid: key });
      }
    }

    res.status(401).json({ success: false, message: 'Invalid email or password' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ——— Upload to GCS ———
async function uploadBufferToGCS(fileBuffer, gcsFileName) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(gcsFileName);

  await file.save(fileBuffer, {
    metadata: { contentType: 'audio/mpeg' },
    resumable: false,
  });

  console.log(`✅ Uploaded to gs://${bucketName}/${gcsFileName}`);
  return `gs://${bucketName}/${gcsFileName}`;
}

// ——— Speech-to-Text Transcription ———
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
  const wordsInfo = result.alternatives[0].words;

  let transcript = '';
  let currentSpeaker = null;

  for (const wordInfo of wordsInfo) {
    if (wordInfo.speakerTag !== currentSpeaker) {
      currentSpeaker = wordInfo.speakerTag;
      transcript += `\n\nSpeaker ${currentSpeaker}:\n`;
    }
    transcript += wordInfo.word + ' ';
  }

  return transcript.trim();
}

// ——— Transcribe Endpoint ———
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const { uid } = req.body;

  if (!req.file || !uid) {
    return res.status(400).json({ success: false, message: 'Missing file or user ID' });
  }

  try {
    const audioFileName = req.file.originalname;
    const gcsFileName = `${Date.now()}-${audioFileName}`;
    const gcsUri = await uploadBufferToGCS(req.file.buffer, gcsFileName);
    const transcript = await transcribeFromGCS(gcsUri);
    const cleanedTranscript = applyCorrections(transcript);

    const newRef = db.ref(`transcriptions/${uid}`).push();
    await newRef.set({
      filename: audioFileName,
      text: cleanedTranscript,
      gcsUri,
      status: "✅ Transcription Complete",
      createdAt: Date.now(),
    });

    fs.writeFileSync('./transcript.txt', cleanedTranscript);
    res.json({ success: true, transcription: cleanedTranscript, audioFileName });
  } catch (err) {
    console.error('❌ Error in /transcribe:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ——— Summarize Endpoint ———
app.post('/summarize', async (req, res) => {
  console.log('SMARTMINUTES_MOM_KEY:', momKey);

  try {
    if (!drive) {
      console.log("🔄 Drive not initialized — initializing now...");
      await initDrive();
    }

    const transcript = fs.readFileSync('./transcript.txt', 'utf-8');
    const audioFileName = req.body?.audioFileName || 'Transcription';
    const mp3BaseName = audioFileName.replace(/\.[^/.]+$/, "");
    const userId = req.body?.userId;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId in request body.' });
    }

    const templates = [
      {
        name: 'Template-Formal',
        dbField: 'formal_template',
        prompt: `Summarize the following transcription and format it like formal Minutes of the Meeting:\n\n"${transcript}"`,
      },
      {
        name: 'Template-Simple',
        dbField: 'simple_template',
        prompt: `Summarize and format this as a simple MoM:\n\n"${transcript}"`,
      },
      {
        name: 'Template-Detailed',
        dbField: 'detailed_template',
        prompt: `Summarize this transcript into detailed Minutes of the Meeting:\n\n"${transcript}"`,
      }
    ];

    const summariesTable = {};
    const results = [];

    for (const template of templates) {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that formats meeting transcriptions.' },
          { role: 'user', content: template.prompt },
        ],
        temperature: 0.4,
      });

      const summaryText = aiResponse.choices[0].message.content;
      const doc = new Document({
        creator: 'Smart Minutes App',
        title: `Minutes of the Meeting - ${template.name}`,
        sections: [{ children: summaryText.split('\n').map(line => new Paragraph(line)) }],
      });

      const buffer = await Packer.toBuffer(doc);
      const fileName = `${mp3BaseName}-${template.name}-${Date.now()}.docx`;

      const { Readable } = require('stream');
      const bufferStream = new Readable();
      bufferStream.push(buffer);
      bufferStream.push(null);

      const fileMetadata = {
        name: fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        parents: [parentFolderId],
      };

      const media = { mimeType: fileMetadata.mimeType, body: bufferStream };
      const driveRes = await drive.files.create({ requestBody: fileMetadata, media, fields: 'id' });

      const fileId = driveRes.data.id;
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const publicLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
      summariesTable[template.dbField] = publicLink;

      results.push({ template: template.name, link: publicLink });
      console.log(`✅ Created and uploaded: ${template.name}`);
    }

    const tableRef = db.ref(`summaries/${userId}`).push();
    await tableRef.set({
      audioFileName,
      createdAt: admin.database.ServerValue.TIMESTAMP,
      ...summariesTable,
    });

    res.json({
      success: true,
      message: 'All templates processed, uploaded to Google Drive, and saved under user.',
      results,
      tableRecordId: tableRef.key,
    });

  } catch (error) {
    console.error('❌ Error in /summarize:', error);
    res.status(500).json({ success: false, message: 'Error during summarization.', error: error.message });
  }
});

// ——— Fetch all minutes by userId ———
app.get('/allminutes/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    if (!userId)
      return res.status(400).json({ success: false, message: 'Missing user ID.' });

    const snapshot = await db.ref(`summaries/${userId}`).once('value');
    const data = snapshot.val();

    if (!data)
      return res.json({ success: true, message: 'No minutes found.', minutes: [] });

    const minutes = Object.entries(data).map(([id, d]) => ({
      summaryId: id,
      audioFileName: d.audioFileName || 'Untitled',
      createdAt: d.createdAt || null,
      formal_template: d.formal_template || null,
      simple_template: d.simple_template || null,
      detailed_template: d.detailed_template || null,
    }));

    res.json({ success: true, minutes });
  } catch (error) {
    console.error('❌ Error in /allminutes:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch minutes.' });
  }
});

// ——— Initialize Drive then Start Server ———
initDrive().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });
});

