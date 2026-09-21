// FranVision Job Generator -- glue between the local job folders and the
// shared job backend (job-backend.js / supabase/schema.sql).
//
// Everything here takes the backend as an argument (`backend`), so it's
// unit-testable with a fake and never touches the network itself. Pure
// row <-> app-shape conversions plus the two multi-step operations
// server.js needs: "find the existing job, wherever it lives" and
// "allocate a Job ID that's unique across machines".
//
// Source-of-truth rules (2026-09-19):
//   - Job ID and job/draft METADATA: the server (jg_jobs) is authoritative
//     once configured -- a draft saved on the Mac shows up on the Windows
//     desktop and vice versa.
//   - The LOCAL job folder is still per-machine and mandatory (RAW import,
//     editing) -- opening a job that was created on another machine just
//     builds its folder tree here on Create Job/Update; files come over via
//     Sync to Local.

const path = require('path');
const idGenerator = require('./id-generator.js');

function jobOf(row) { return (row && row.data && row.data.job) || {}; }
function formOf(row) { return (row && row.data && row.data.form) || {}; }

// Same shape id-generator.js#findExistingJob returns, built from a server row.
function existingFromRow(row, rootFolder) {
  const job = jobOf(row);
  return {
    folderName: row.folder_name,
    folderPath: path.join(rootFolder, row.folder_name),
    jobId: row.job_id || null,
    createdAt: row.created_at || null,
    previousTotalCents: (job.pricing && Number.isInteger(job.pricing.totalCents)) ? job.pricing.totalCents : null,
    order: job.services || {},
    source: 'server',
  };
}

// Shape job-list.js#scanJobs produces, for the Drafts / Recent Jobs panels.
function summaryFromRow(row) {
  const job = jobOf(row);
  const form = formOf(row);
  return {
    folderName: row.folder_name,
    folderPath: null,
    jobId: row.job_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || row.created_at || null,
    clientName: row.client_name || (job.client && job.client.name) || '',
    address: row.address || (job.property && job.property.address) || '',
    propertyType: (job.property && job.property.propertyType) || '',
    shootDate: row.shoot_date || job.shootDate || '',
    shootTime: form.shootTime || '',
    previousTotalCents: (job.pricing && Number.isInteger(job.pricing.totalCents)) ? job.pricing.totalCents : null,
    hasCalendar: !!form.shootTime,
  };
}

// Shape POST /api/job-detail returns (what loadJobIntoForm() consumes).
function detailFromRow(row) {
  const job = jobOf(row);
  const form = formOf(row);
  return {
    found: true,
    folderName: row.folder_name,
    jobId: row.job_id || null,
    createdAt: row.created_at,
    clientName: row.client_name || (job.client && job.client.name) || '',
    photographerName: job.photographer || '',
    address: row.address || (job.property && job.property.address) || '',
    propertyType: (job.property && job.property.propertyType) || '',
    shootDate: row.shoot_date || job.shootDate || '',
    order: job.services || {},
    shootTime: form.shootTime || '',
    notes: form.notes || '',
    chosenCandidateIndex: Number.isInteger(form.chosenCandidateIndex) ? form.chosenCandidateIndex : null,
    commission: form.commission || { checkedItemIds: [], travelCents: 0 },
    calendarFile: form.calendarFile || null,
    // Screenshots as links ({filename, url}) -- see server.js#uploadDraftImages.
    images: Array.isArray(form.images) ? form.images : [],
  };
}

// The row jg_upsert_job wants. `job` is job-files.js#buildJobJson's output,
// `form` is form-state.js's record.
function buildRow({ folderName, previousFolderName, job, form }) {
  return {
    folder_name: folderName,
    previous_folder_name: previousFolderName || null,
    job_id: job.jobId || null,
    client_name: (job.client && job.client.name) || '',
    address: (job.property && job.property.address) || '',
    shoot_date: job.shootDate || '',
    created_at: job.createdAt || null,
    data: { job, form },
  };
}

// The job for `folderName` -- server row first (authoritative), local folder
// as the fallback for jobs made before the backend existed / while it was
// unconfigured. Returns { existing, remote, conflict }:
//   existing -- findExistingJob()'s shape (null / {unreadable} / job), or the
//               server row converted to it
//   conflict -- { local, remote } when both sides hold DIFFERENT real Job IDs
//               for the same identity (must never be merged silently)
async function resolveExisting(rootFolder, folderName, backend) {
  const local = idGenerator.findExistingJob(rootFolder, folderName);
  if (!backend || !backend.isConfigured()) return { existing: local, remote: null, conflict: null };

  const remote = await backend.getJob(folderName); // BackendError propagates -- caller decides
  if (!remote) return { existing: local, remote: null, conflict: null };

  const localReal = local && !local.unreadable && typeof local.jobId === 'string';
  if (localReal && remote.job_id && local.jobId !== remote.job_id) {
    return { existing: local, remote, conflict: { local: local.jobId, remote: remote.job_id } };
  }
  // Server is behind: this machine already promoted the draft (or predates
  // the backend) -- keep the local ID; the upsert at the end registers it.
  if (localReal && !remote.job_id) return { existing: local, remote, conflict: null };
  return { existing: existingFromRow(remote, rootFolder), remote, conflict: null };
}

function localSequenceFloor(rootFolder, date) {
  const stamp = idGenerator.formatDateStamp(date || new Date());
  return idGenerator.nextSequenceFromExistingIds(idGenerator.collectExistingJobIds(rootFolder), stamp) - 1;
}

// Reserves a Job ID on the server. `floor` = the highest sequence known to
// be taken already (local folders here), so the server counter jumps past
// legacy jobs it never saw; `checkFn` (dropbox-sync#jobIdExistsOnDropbox)
// additionally skips an ID some other machine already tagged on Dropbox --
// best-effort, same as before the backend existed.
async function allocateJobId({ rootFolder, backend, checkFn, date }) {
  date = date || new Date();
  const prefixLen = ('FVS-' + idGenerator.formatDateStamp(date) + '-').length;
  let floor = localSequenceFloor(rootFolder, date);
  let id;
  for (let i = 0; i < 50; i++) {
    id = await backend.allocateJobId({ date, floor });
    if (typeof checkFn !== 'function') return id;
    let result;
    try { result = await checkFn(id); } catch (err) { return id; }
    if (!result || !result.checked || !result.exists) return id;
    floor = parseInt(id.slice(prefixLen), 10) || floor + 1;
  }
  return id;
}

async function previewJobId({ rootFolder, backend, date }) {
  return backend.peekJobId({ date: date || new Date(), floor: localSequenceFloor(rootFolder, date) });
}

module.exports = {
  existingFromRow, summaryFromRow, detailFromRow, buildRow,
  resolveExisting, localSequenceFloor, allocateJobId, previewJobId,
};
