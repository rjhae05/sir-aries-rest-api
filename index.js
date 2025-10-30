// gdrive-setup-env.js
const { google } = require('googleapis');

// Get the JSON string from env variable
const serviceAccountJson = process.env.SMARTMINUTES_MOM_KEY_JSON;
const parentFolderId = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr'; // your folder ID

if (!serviceAccountJson) {
  console.error('❌ SMARTMINUTES_MOM_KEY_JSON not set');
  process.exit(1);
}

// Parse JSON string
let keyObj;
try {
  keyObj = JSON.parse(serviceAccountJson);
} catch (err) {
  console.error('❌ Failed to parse SMARTMINUTES_MOM_KEY_JSON:', err.message);
  process.exit(1);
}

// Initialize Drive
async function initDrive() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: keyObj,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });

    console.log('✅ Google Drive initialized');

    // Test folder access
    const res = await drive.files.list({
      q: `'${parentFolderId}' in parents`,
      fields: 'files(id, name)',
      pageSize: 10,
    });

    if (!res.data.files || res.data.files.length === 0) {
      console.log('📂 Drive folder accessible but empty');
    } else {
      console.log('📂 Files in folder:');
      res.data.files.forEach(f => console.log(`- ${f.name} (${f.id})`));
    }

    return drive;
  } catch (err) {
    console.error('❌ Failed to connect to Drive:', err.message);
    process.exit(1);
  }
}

// Example usage
initDrive();
