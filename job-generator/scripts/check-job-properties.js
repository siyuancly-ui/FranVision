#!/usr/bin/env node
// FranVision Job Generator -- Dropbox verification/debug utility.
//
// Reads back the hidden jobId property Dropbox sync attached to a job
// folder, via files/get_metadata with include_property_groups. Useful for:
//   - acceptance-testing dropbox-sync.js against a real Dropbox account
//   - manually confirming a specific job's folder is tagged correctly
//     (e.g. after retrying a job.json marked pendingConfirmation)
//
// Usage:
//   node scripts/check-job-properties.js "/2026.09.05 999 Some St_Client Name"
//
// The path is the Dropbox-relative path (same as job.json's folders.jobFolderName,
// with a leading "/").

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { Dropbox } = require('dropbox');
const { extractDropboxErrorMessage } = require('../dropbox-sync.js');

async function main() {
  const dropboxPath = process.argv[2];
  if (!dropboxPath) {
    console.error('Usage: node scripts/check-job-properties.js "/<job folder name>"');
    process.exitCode = 1;
    return;
  }

  const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, DROPBOX_TEMPLATE_ID } = process.env;
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN || !DROPBOX_TEMPLATE_ID) {
    console.error('Missing Dropbox config in job-generator/.env (see .env.example).');
    process.exitCode = 1;
    return;
  }

  const dbx = new Dropbox({
    clientId: DROPBOX_APP_KEY,
    clientSecret: DROPBOX_APP_SECRET,
    refreshToken: DROPBOX_REFRESH_TOKEN,
    fetch,
  });

  try {
    const { result } = await dbx.filesGetMetadata({
      path: dropboxPath,
      include_property_groups: { '.tag': 'filter_some', filter_some: [DROPBOX_TEMPLATE_ID] },
    });

    console.log('Folder:', result.path_display);
    const groups = result.property_groups || [];
    if (!groups.length) {
      console.log('No property group found for template ' + DROPBOX_TEMPLATE_ID + ' on this folder.');
      return;
    }
    for (const group of groups) {
      for (const field of group.fields) {
        console.log('  ' + field.name + ' = ' + field.value);
      }
    }
  } catch (err) {
    console.error('Lookup failed: ' + extractDropboxErrorMessage(err));
    process.exitCode = 1;
  }
}

main();
