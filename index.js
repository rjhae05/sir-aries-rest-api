// gdrive-simple.js
const { google } = require('googleapis');

const SERVICE_ACCOUNT_JSON = process.env.SMARTMINUTES_MOM_KEY;
const FOLDER_ID = process.env.SMARTMINUTES_PARENT_FOLDER_ID || '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr';

if (!SERVICE_ACCOUNT_JSON) {
  console.error('❌ SMARTMINUTES_MOM_KEY_JSON not set');
  process.exit(1);
}

let key;
try {
  key = JSON.parse(SERVICE_ACCOUNT_JSON);
} catch (err) {
  console.error('❌ Failed to parse service account JSON:', err.message);
  process.exit(1);
}

async function main() {
  try {
    // Initialize Google Drive client
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({ version: 'v3', auth: await auth.getClient() });

    // Simple test: list first 5 files in folder
    const res = await drive.files.list({
      q: `'${FOLDER_ID}' in parents`,
      fields: 'files(id, name)',
      pageSize: 5,
    });

    console.log('✅ Connected to Google Drive');
    if (res.data.files.length === 0) {
      console.log('📂 Folder is empty');
    } else {
      console.log('📂 Files:');
      res.data.files.forEach(f => console.log(`- ${f.name} (${f.id})`));
    }
  } catch (err) {
    console.error('❌ Google Drive connection failed:', err.message);
  }
}

main();
