// gdrive-setup-env.js
const { google } = require('googleapis');

// Environment variable containing the full JSON string of your service account
const serviceAccountJson = process.env.SMARTMINUTES_MOM_KEY_JSON;

// Google Drive folder ID you want to access
const parentFolderId = process.env.SMARTMINUTES_PARENT_FOLDER_ID || '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr';

if (!serviceAccountJson) {
  console.error('❌ SMARTMINUTES_MOM_KEY_JSON environment variable not set');
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

// Initialize Google Drive
async function initDrive() {
  try {
    // Create GoogleAuth client using JSON credentials
    const auth = new google.auth.GoogleAuth({
      credentials: keyObj,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });

    // Log authenticated email
    const about = await drive.about.get({ fields: 'user' });
    console.log('✅ Authenticated as:', about.data.user.emailAddress);

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
    console.error('❌ Failed to connect to Google Drive:', err.message);
    process.exit(1);
  }
}

// Example usage
initDrive().then(drive => {
  console.log('🚀 Drive client ready for use!');
}).catch(err => {
  console.error('❌ Unexpected error:', err);
});
