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

// Async wrapper around getNextJobId() that additionally guards against a
// CROSS-MACHINE collision -- the local scan above only sees IDs used on
// THIS machine's Job Root Folder, but Job Generator can run independently
// on more than one machine at once (e.g. a local test copy on one machine
// alongside Franky's own separate install) with no shared local
// filesystem between them. Real incident (2026-09-15): a test job and a
// real job, created the same day on two different machines, both
// independently computed "FVS-20260915-001" and collided on Dropbox,
// merging their synced photo data into one Supabase record. See root
// CLAUDE.md / franvision-job-generator memory for the full story.
//
// `checkFn(candidateId)` should resolve `{checked, exists}` against the
// one thing genuinely shared across machines -- Dropbox's jobId property
// tags, via dropbox-sync.js#jobIdExistsOnDropbox -- and is injected so
// this stays testable without touching Dropbox. This is a BEST-EFFORT
// guard, not a hard guarantee: if checkFn can't check at all (Dropbox not
// configured, unreachable, etc. -- checkFn resolves `checked:false`, or
// throws), the loop stops and the local-only candidate is used as-is --
// job creation must never block on Dropbox reachability. The real fix is
// moving ID assignment to a shared backend once job-generator is online
// (see the architecture pivot docs); this is an interim mitigation.
async function getNextJobIdChecked(jobRootFolder, date, checkFn) {
  date = date || new Date();
  let candidate = getNextJobId(jobRootFolder, date);
  if (typeof checkFn !== 'function') return candidate;

  const dateStamp = formatDateStamp(date);
  const prefix = 'FVS-' + dateStamp + '-';
  const MAX_ATTEMPTS = 50; // sanity cap -- never loop forever on a weird checkFn

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let result;
    try {
      result = await checkFn(candidate);
    } catch (err) {
      break; // checkFn is expected not to throw, but never block on it if it does
    }
    if (!result || !result.checked || !result.exists) break;

    const seq = parseInt(candidate.slice(prefix.length), 10) || 0;
    candidate = buildJobId(date, seq + 1);
  }
  return candidate;
}

// Looks for an already-created job at <jobRootFolder>/<folderName> (the
// canonical name buildJobFolderName() produces from Shoot Date + Address
// + Client Name). This is how "clicking Create Job again for the same
// job" is turned into an UPDATE instead of a second Job ID -- see
// DESIGN-job-update.md. Returns:
//   null                                  -- no folder with that name
//   { folderName, folderPath, jobId,      -- a real, updatable job
//     createdAt, previousTotalCents, order }
//   { folderName, folderPath, jobId: null, -- a Save-Draft'd job: real
//     createdAt, previousTotalCents, order }  folder + job.json, no ID
//                                            assigned yet (2026-09-13, see
//                                            root CLAUDE.md's "Draft/Job
//                                            unification" note) -- treated
//                                            the same as a real match for
//                                            update-in-place purposes, just
//                                            without a jobId to keep
//   { folderName, folderPath, unreadable: true }
//                                         -- folder exists but has no
//                                            readable job.json, or jobId is
//                                            neither a string nor null
//                                            (corrupted/garbage); the
//                                            caller should refuse rather
//                                            than write a 2nd identity in
function findExistingJob(jobRootFolder, folderName) {
  const folderPath = path.join(jobRootFolder, folderName);
  let stat;
  try {
    stat = fs.statSync(folderPath);
  } catch (err) {
    return null; // no folder with this canonical name
  }
  if (!stat.isDirectory()) return null;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(folderPath, 'job.json'), 'utf8'));
  } catch (err) {
    return { folderName, folderPath, unreadable: true };
  }
  // `jobId: null` is our own deliberate "no ID assigned yet" sentinel
  // (a Save-Draft'd job) -- distinct from a missing/garbage jobId, which
  // means the file is corrupted and must not be treated as either state.
  if (!data || (typeof data.jobId !== 'string' && data.jobId !== null)) {
    return { folderName, folderPath, unreadable: true };
  }

  return {
    folderName,
    folderPath,
    jobId: data.jobId,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
    previousTotalCents: (data.pricing && Number.isInteger(data.pricing.totalCents)) ? data.pricing.totalCents : null,
    order: data.services || {},
  };
}

module.exports = {
  formatDateStamp,
  buildJobId,
  nextSequenceFromExistingIds,
  collectExistingJobIds,
  getNextJobId,
  getNextJobIdChecked,
  findExistingJob,
};
