const { google } = require('googleapis');
const path = require('path');

async function testDriveListInFolder(folderId) {
  try {
    // On Render, use an environment variable for the service account key file path
    // e.g., set GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/key.json
    const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!keyFilePath) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable not set');
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: keyFilePath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: 100,  // adjust as needed (max 1000)
      fields: 'files(id, name)',
    });

    console.log('Files in folder:', response.data.files);

    if (response.data.files.length > 0) {
      response.data.files.forEach(file => {
        console.log(`File: ${file.name} (${file.id})`);
      });
    } else {
      console.log('No files found in the specified folder.');
    }
  } catch (error) {
    console.error('Error calling Drive API:', error);
  }
}

// Example usage - replace with your actual folder ID
testDriveListInFolder('1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr');
