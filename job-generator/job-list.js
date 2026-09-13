// FranVision Job Generator -- listing job folders for the Drafts panel and
// the Recent Jobs panel (2026-09-13, see root CLAUDE.md's "Draft/Job
// unification" note).
//
// Before this, a Draft was a lightweight standalone record under
// job-generator/drafts/<uuid>/ -- no real folder, no job.json, no Dropbox
// state (see the old draft-store.js). That's gone: a Draft is now just a
// real job folder (created via POST /api/create-job with `saveAsDraft:
// true`) whose job.json has `jobId: null` -- everything else (folders,
// Dropbox mirror, calendar file) is created exactly like a real job. The
// ONLY thing Save Draft withholds is the Job ID -- see id-generator.js's
// findExistingJob() for the `jobId: null` sentinel this relies on.
//
// This module is the read side of that: scan the Job Root Folder's
// immediate subfolders (same walk id-generator.js#collectExistingJobIds
// already does for a different purpose) and split them into:
//   - Drafts:      jobId === null
//   - Recent Jobs: jobId is a real string AND createdAt is within the
//                  last RECENT_JOBS_WINDOW_MS (see DESIGN-job-update.md's
//                  "no created jobs list" decision -- superseded 2026-09-13
//                  by this, scoped to a rolling recent window rather than
//                  every job ever created).
//
// A folder with no readable job.json, or a job.json with a jobId that's
// neither a string nor null (corrupted), is silently skipped from BOTH
// lists -- same "one bad folder can't break the list" contract as
// id-generator.js#collectExistingJobIds and the old draft-store.js#listDrafts.

const fs = require('fs');
const path = require('path');
const calendarFile = require('./calendar-file.js');
const formState = require('./form-state.js');

const RECENT_JOBS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// Scans jobRootFolder's immediate subfolders and returns a parsed summary
// for every one with a readable job.json and a valid jobId (string or
// null). Not sorted -- callers sort for their own purpose (drafts:
// most-recently-updated first; recent jobs: most-recently-created first).
function scanJobs(jobRootFolder) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(jobRootFolder, { withFileTypes: true });
  } catch (err) {
    return results; // root folder doesn't exist yet, or unreadable -- treat as empty
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(jobRootFolder, entry.name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(folderPath, 'job.json'), 'utf8'));
    } catch (err) {
      continue; // no job.json here, or it's not valid JSON -- skip
    }
    if (!data || (typeof data.jobId !== 'string' && data.jobId !== null)) continue; // corrupted -- skip

    results.push({
      folderName: entry.name,
      folderPath,
      jobId: data.jobId,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : data.createdAt || null,
      clientName: (data.client && data.client.name) || '',
      address: (data.property && data.property.address) || '',
      propertyType: (data.property && data.property.propertyType) || '',
      shootDate: data.shootDate || '',
      // shootTime lives only in form-state.js's sidecar (see its header
      // comment for why job.json itself doesn't carry it) -- read back
      // here purely for the Drafts/Recent Jobs list display.
      shootTime: formState.readFormState(folderPath).shootTime,
      previousTotalCents: (data.pricing && Number.isInteger(data.pricing.totalCents)) ? data.pricing.totalCents : null,
      hasCalendar: fs.existsSync(path.join(folderPath, calendarFile.ICS_FILENAME)),
    });
  }
  return results;
}

// Drafts panel -- jobId === null, most-recently-updated first.
function listDrafts(jobRootFolder) {
  return scanJobs(jobRootFolder)
    .filter((j) => j.jobId === null)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// Recent Jobs panel -- a real jobId, created within the last 3 days.
// most-recently-created first. `now` is overridable for tests.
function listRecentJobs(jobRootFolder, now) {
  const cutoff = (now instanceof Date ? now.getTime() : Date.now()) - RECENT_JOBS_WINDOW_MS;
  return scanJobs(jobRootFolder)
    .filter((j) => typeof j.jobId === 'string' && j.createdAt && Date.parse(j.createdAt) >= cutoff)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

module.exports = { RECENT_JOBS_WINDOW_MS, scanJobs, listDrafts, listRecentJobs };
