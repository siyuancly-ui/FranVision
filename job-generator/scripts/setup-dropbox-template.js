#!/usr/bin/env node
// FranVision Job Generator -- ONE-TIME Dropbox setup script.
//
// Registers the "FranVision Job" file_properties PropertyGroupTemplate
// used to attach a hidden `jobId` tag to each job's top-level Dropbox
// folder. Every job folder's tag is an instance of this one template, so
// it only needs to be registered ONCE per Dropbox app -- run this exactly
// once, not once per job.
//
// Re-running this script is safe: it checks for an existing "FranVision
// Job" template first and reuses it instead of registering a duplicate
// (which would produce a second, different template_id that dropbox-sync.js
// would then need to be pointed at instead -- avoid that by not re-running
// unnecessarily, though it won't corrupt anything if you do).
//
// Usage:
//   1. cp job-generator/.env.example job-generator/.env
//      and fill in DROPBOX_APP_KEY / DROPBOX_APP_SECRET /
//      DROPBOX_REFRESH_TOKEN (leave DROPBOX_TEMPLATE_ID blank -- that's
//      what this script produces).
//   2. cd job-generator && node scripts/setup-dropbox-template.js
//   3. Copy the printed "DROPBOX_TEMPLATE_ID=..." line into job-generator/.env.
//      dropbox-sync.js reads it from there for every job created afterwards.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { Dropbox } = require('dropbox');
const { TEMPLATE_NAME, extractDropboxErrorMessage } = require('../dropbox-sync.js');

async function main() {
  const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN } = process.env;
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN) {
    console.error('Missing DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN.');
    console.error('Fill these in job-generator/.env first (see .env.example), then re-run.');
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
    const existing = await dbx.filePropertiesTemplatesListForUser();
    for (const templateId of existing.result.template_ids) {
      const tpl = await dbx.filePropertiesTemplatesGetForUser({ template_id: templateId });
      if (tpl.result.name === TEMPLATE_NAME) {
        console.log('A "' + TEMPLATE_NAME + '" template already exists -- reusing it, not creating a duplicate.');
        console.log('\nAdd this line to job-generator/.env:\n');
        console.log('DROPBOX_TEMPLATE_ID=' + templateId);
        return;
      }
    }
  } catch (err) {
    console.error('Could not list existing templates (continuing to attempt creation): ' + extractDropboxErrorMessage(err));
  }

  const result = await dbx.filePropertiesTemplatesAddForUser({
    name: TEMPLATE_NAME,
    description: 'Links a Dropbox job folder back to its FranVision Job ID (FVS-YYYYMMDD-XXX). Hidden metadata -- not shown in the folder name.',
    fields: [
      { name: 'jobId', description: 'FranVision Job ID, e.g. FVS-20260827-001', type: { '.tag': 'string' } },
    ],
  });

  console.log('Template registered successfully.');
  console.log('\nAdd this line to job-generator/.env:\n');
  console.log('DROPBOX_TEMPLATE_ID=' + result.result.template_id);
}

main().catch((err) => {
  console.error('Setup failed: ' + extractDropboxErrorMessage(err));
  process.exitCode = 1;
});
