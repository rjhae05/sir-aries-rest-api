// gdrive-setup-render.js
const { google } = require('googleapis');

// 🔹 Debug top-level
console.log('🚀 Starting Google Drive init script on Render...');

// Environment variable containing the full JSON string of your service account
const serviceAccountJson = process.env.SMARTMINUTES_MOM_KEY;
const parentFolderId = process.env.SMARTMINUTES_PARENT_FOLDER_ID || '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr';

console.log('DEBUG: Folder ID:', parentFolderId);

// Check environment variable
if (!serviceAccountJson) {
  console.error('❌ SMARTMINUTES_MOM_KEY_JSON environment variable not set!');
  process.exit(1);
} else {
  console.log('✅ SMARTMINUTES_MOM_KEY_JSON found');
}

// Parse JSON string safely
let keyObj;
try {
  keyObj = JSON.parse(serviceAccountJson);
  console.log('✅ JSON parsed successfully');
} catch (err) {
  console.error('❌ Failed to parse SMARTMINUTES_MOM_KEY_JSON:', err.message);
  process.exit(1);
}

// Initialize Google Drive
async function initDrive() {
  try {
    console.log('🔹 Creating GoogleAuth client...');
    const auth = new google.auth.GoogleAuth({
      credentials: keyObj,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    console.log('🔹 Getting auth client...');
    const authClient = await auth.getClient();

    console.log('🔹 Initializing Drive client...');
    const drive = google.drive({ version: 'v3', auth: authClient });

    console.log('🔹 Checking authenticated user...');
    const about = await drive.about.get({ fields: 'user' });
    console.log('✅ Authenticated as:', about.data.user.emailAddress);

    console.log('🔹 Listing files in folder...');
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

// Run the script directly
initDrive()
  .then(() => console.log('🚀 Drive client ready for use!'))
  .catch(err => console.error('❌ Unexpected error:', err));

