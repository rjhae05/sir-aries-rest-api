// gdrive-setup.js
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Write secret key JSON to temp file if using env variable
const momKeyPath = '/tmp/smartminutesMoMkey.json';
if (!fs.existsSync(momKeyPath)) {
  if (!process.env.SMARTMINUTES_MOM_KEY_FILE) {
    console.error('❌ No Google Drive key provided');
    process.exit(1);
  }
  fs.writeFileSync(momKeyPath, process.env.SMARTMINUTES_MOM_KEY_FILE);
}

// Drive folder ID
const parentFolderId = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr';

async function initDrive() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: momKeyPath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });

    console.log('✅ Google Drive initialized');

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

initDrive();
