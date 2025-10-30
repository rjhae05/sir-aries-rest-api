// ——— Dependencies ———
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

// Firebase Admin
const admin = require('./firebaseAdmin');
const db = admin.database();

// ——— App Setup ———
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cors());

// ——— API Keys & Config ———
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SMARTMINUTES_MOM_KEY = process.env.SMARTMINUTES_MOM_KEY;
const SMART_MINUTES_KEY = process.env.SMART_MINUTES_KEY;

// Google Cloud Storage
const PROJECT_ID = 'speech-to-text-459913';
const BUCKET_NAME = 'smart-minutes-bucket';
process.env.GOOGLE_APPLICATION_CREDENTIALS = SMART_MINUTES_KEY;

const storage = new Storage({ projectId: PROJECT_ID });
const speechClient = new speech.SpeechClient();

// OpenAI Client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Multer Setup (in-memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// Google Drive Setup
const auth = new google.auth.GoogleAuth({
  keyFile: SMARTMINUTES_MOM_KEY,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

let drive; // will hold Google Drive client
const PARENT_FOLDER_ID = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr';

// Initialize Google Drive Client
async function initDrive() {
  if (!drive) {
    const authClient = await auth.getClient();
    drive = google.drive({ version: 'v3', auth: authClient });
    console.log('🔑 Google Drive initialized');
  }
}
initDrive();

// ——— Auto-Correction Dictionary ———
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

// ——— Firebase Login ———
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required.' });
  }

  try {
    const snapshot = await db.ref('Users').once('value');
    const users = snapshot.val();

    const userEntry = Object.entries(users || {}).find(([key, user]) => user.email === email && user.password === password);

    if (!userEntry) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const [uid] = userEntry;
    res.json({ success: true, message: 'Login successful', uid });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ——— Upload File to GCS ———
async function uploadBufferToGCS(fileBuffer, fileName) {
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(fileName);

  await file.save(fileBuffer, { metadata: { contentType: 'audio/mpeg' }, resumable: false });
  console.log(`✅ Uploaded to gs://${BUCKET_NAME}/${fileName}`);
  return `gs://${BUCKET_NAME}/${fileName}`;
}

// ——— Transcription with Speaker Diarization ———
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

    const timestamp = Date.now();
    const newRef = db.ref(`transcriptions/${uid}`).push();
    await newRef.set({
      filename: audioFileName,
      text: cleanedTranscript,
      gcsUri,
      status: "✅ Transcription Complete",
      createdAt: timestamp,
    });

    // Save transcript locally for summarization
    fs.writeFileSync('./transcript.txt', cleanedTranscript);

    res.json({ success: true, transcription: cleanedTranscript, audioFileName });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ——— Summarize Endpoint ———
app.post('/summarize', async (req, res) => {
  try {
    const transcript = fs.readFileSync('./transcript.txt', 'utf-8');
    const audioFileName = req.body?.audioFileName || 'Transcription';
    const mp3BaseName = audioFileName.replace(/\.[^/.]+$/, "");
    const userId = req.body?.userId;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId in request body.' });
    }

    const templates = [
      { name: 'Template-Formal', dbField: 'formal_template', promptPrefix: 'Format this as formal MoM:' },
      { name: 'Template-Simple', dbField: 'simple_template', promptPrefix: 'Format this as simple MoM:' },
      { name: 'Template-Detailed', dbField: 'detailed_template', promptPrefix: 'Format this as detailed MoM:' },
    ];

    const results = [];
    const summariesTable = {};

    for (const template of templates) {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant who formats meeting transcriptions.' },
          { role: 'user', content: `${template.promptPrefix}\n\n${transcript}` },
        ],
        temperature: 0.4,
      });

      const summaryText = aiResponse.choices[0].message.content;

      const doc = new Document({
        creator: 'Smart Minutes App',
        title: `Minutes of the Meeting - ${template.name}`,
        sections: [{ children: summaryText.split('\n').map(line => new Paragraph(line)) }],
      });

      const fileName = `${mp3BaseName}-${template.name}-${Date.now()}.docx`;
      const buffer = await Packer.toBuffer(doc);

      const { Readable } = require('stream');
      const bufferStream = new Readable();
      bufferStream.push(buffer);
      bufferStream.push(null);

      const fileMetadata = {
        name: fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        parents: [PARENT_FOLDER_ID],
      };

      const media = { mimeType: fileMetadata.mimeType, body: bufferStream };

      const driveRes = await drive.files.create({ requestBody: fileMetadata, media, fields: 'id' });
      const fileId = driveRes.data.id;

      await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
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
      message: 'Summaries processed and uploaded successfully.',
      results,
      tableRecordId: tableRef.key,
    });
  } catch (err) {
    console.error('Summarization error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ——— Fetch all minutes by userId ———
app.get('/allminutes/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing user ID.' });

    const snapshot = await db.ref(`summaries/${userId}`).once('value');
    const data = snapshot.val();

    const minutes = Object.entries(data || {}).map(([summaryId, details]) => ({
      summaryId,
      audioFileName: details.audioFileName || 'Untitled',
      createdAt: details.createdAt || null,
      formal_template: details.formal_template || null,
      simple_template: details.simple_template || null,
      detailed_template: details.detailed_template || null,
    }));

    res.json({ success: true, message: 'Minutes fetched successfully.', minutes });
  } catch (err) {
    console.error('Fetch minutes error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ——— Start Server ———
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
