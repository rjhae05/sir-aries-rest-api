// index.js
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const fs = require('fs');
const path = require('path');

// ——— CONFIG ———
const projectId = 'speech-to-text-459913';
const bucketName = 'smart-minutes-bucket';
const localFilePath = path.join(__dirname, 'Special Meeting Audio File - April 29, 2025.mp3');
const gcsFileName = 'uploaded-audio.mp3';  // name in GCS
// —————————————————

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'smart-minutes-key.json');

// 1. Upload local file to GCS
async function uploadToGCS() {
  const storage = new Storage({ projectId });
  await storage.bucket(bucketName).upload(localFilePath, {
    destination: gcsFileName,
    resumable: false,
    metadata: { contentType: 'audio/mpeg' }
  });
  console.log(`✅ Uploaded to gs://${bucketName}/${gcsFileName}`);
  return `gs://${bucketName}/${gcsFileName}`;
}

// 2. Transcribe using longRunningRecognize with GCS URI
async function transcribeFromGCS(gcsUri) {
  const client = new speech.SpeechClient();

  const request = {
    audio: { uri: gcsUri },
    config: {
      encoding: 'MP3',
      sampleRateHertz: 44100,
      languageCode: 'en-US',
      model: 'default',
      enableAutomaticPunctuation: true,
    },
  };

  console.log('🕐 Starting long-running transcription...');
  const [operation] = await client.longRunningRecognize(request);
  const [response] = await operation.promise();
  console.log('✅ Transcription complete.');

  const transcription = response.results
    .map(r => r.alternatives[0].transcript)
    .join('\n');
  return transcription;
}

// Main
(async () => {
  try {
    const gcsUri = await uploadToGCS();
    const text = await transcribeFromGCS(gcsUri);
    console.log('\nTranscription:\n', text);
  } catch (err) {
    console.error('❌ Error:', err);
  }
})();

