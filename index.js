const express = require('express');
const cors = require('cors'); // <-- ADD THIS
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // <-- ENABLE CORS HERE

// ——— CONFIG ———
const projectId = 'speech-to-text-459913';
const bucketName = 'smart-minutes-bucket';
const keyPath = path.join(__dirname, 'smart-minutes-key.json');
process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;

// Google Cloud Clients
const storage = new Storage({ projectId });
const speechClient = new speech.SpeechClient();

// Multer setup (store in memory only — no local file system)
const upload = multer({ storage: multer.memoryStorage() });

// Upload file from memory to GCS
async function uploadBufferToGCS(fileBuffer, gcsFileName) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(gcsFileName);

  await file.save(fileBuffer, {
    metadata: {
      contentType: 'audio/mpeg',
    },
    resumable: false,
  });

  console.log(`✅ Uploaded to gs://${bucketName}/${gcsFileName}`);
  return `gs://${bucketName}/${gcsFileName}`;
}

// Transcribe file from GCS URI
async function transcribeFromGCS(gcsUri) {
  const request = {
    audio: { uri: gcsUri },
    config: {
      encoding: 'MP3',
      sampleRateHertz: 44100,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
    },
  };

  console.log('🕐 Starting transcription...');
  const [operation] = await speechClient.longRunningRecognize(request);
  const [response] = await operation.promise();
  console.log('✅ Transcription complete.');

  const transcription = response.results
    .map(result => result.alternatives[0]?.transcript || '')
    .join('\n');

  return transcription;
}

// POST /transcribe
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }

  const gcsFileName = `${Date.now()}-${req.file.originalname}`;

  try {
    const gcsUri = await uploadBufferToGCS(req.file.buffer, gcsFileName);
    const transcript = await transcribeFromGCS(gcsUri);

    res.json({ success: true, transcription: transcript });
  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
