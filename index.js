// gdrive-setup.js
const { google } = require('googleapis');
const fs = require('fs');

// Path to your secret key on Render
const momKeyPath = '/etc/secrets/smartminutesMoMkey.json';
const parentFolderId = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr'; // Replace with your folder ID

if (!fs.existsSync(momKeyPath)) {
  console.error('❌ Key file not found at', momKeyPath);
  process.exit(1);
}

// Initialize Google Drive
async function initDrive() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: momKeyPath,
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
