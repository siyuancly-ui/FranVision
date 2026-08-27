// FranVision Job Generator -- Job ID generation.
//
// Format: FVS-YYYYMMDD-XXX (e.g. FVS-20260827-001), incrementing by
// creation order within the same day. The source of truth for "what
// already exists today" is each job folder's job.json (not the folder
// name), since job.json is the one place the Job ID is guaranteed to live.
//
// Split into pure logic (testable without touching disk) and a thin fs
// layer that scans the Job Root Folder.

const fs = require('fs');
const path = require('path');

function pad2(n) {
  return String(n).padStart(2, '0');
}

// date -> "YYYYMMDD"
function formatDateStamp(date) {
  return String(date.getFullYear()) + pad2(date.getMonth() + 1) + pad2(date.getDate());
}

function buildJobId(date, sequence) {
  return 'FVS-' + formatDateStamp(date) + '-' + String(sequence).padStart(3, '0');
}

// Given a list of existing job IDs (strings, may include unrelated/garbage
// values) and today's date stamp, returns the next sequence number.
function nextSequenceFromExistingIds(existingIds, dateStamp) {
  const prefix = 'FVS-' + dateStamp + '-';
  let maxSeq = 0;
  for (const id of existingIds) {
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
    const seqPart = id.slice(prefix.length);
    const seq = parseInt(seqPart, 10);
    if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
  }
  return maxSeq + 1;
}

// Scans jobRootFolder's immediate subfolders for a job.json in each,
// collects their jobId fields. Missing folder / unreadable / malformed
// job.json are all treated as "no id found there" rather than thrown --
// one bad job folder should never block generating a new Job ID.
function collectExistingJobIds(jobRootFolder) {
  const ids = [];
  let entries;
  try {
    entries = fs.readdirSync(jobRootFolder, { withFileTypes: true });
  } catch (err) {
    return ids; // root folder doesn't exist yet, or unreadable -- treat as empty
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobJsonPath = path.join(jobRootFolder, entry.name, 'job.json');
    try {
      const raw = fs.readFileSync(jobJsonPath, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.jobId === 'string') ids.push(data.jobId);
    } catch (err) {
      // no job.json here, or it's not valid JSON -- skip
    }
  }
  return ids;
}

function getNextJobId(jobRootFolder, date) {
  date = date || new Date();
  const dateStamp = formatDateStamp(date);
  const existingIds = collectExistingJobIds(jobRootFolder);
  const sequence = nextSequenceFromExistingIds(existingIds, dateStamp);
  return buildJobId(date, sequence);
}

module.exports = {
  formatDateStamp,
  buildJobId,
  nextSequenceFromExistingIds,
  collectExistingJobIds,
  getNextJobId,
};
