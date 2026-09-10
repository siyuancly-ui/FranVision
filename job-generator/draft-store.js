// FranVision Job Generator -- local-only Job Drafts.
//
// Before a shoot is fully locked in -- date fixed but time still TBD, the
// package/add-ons still being negotiated, a reschedule risk, who ends up
// actually shooting it -- the form can be saved as a Draft instead of
// finalized into a real job. A Draft:
//   - lives entirely under job-generator/drafts/<draftId>/ -- gitignored,
//     never synced to Dropbox, and NOT inside any client's Job Root
//     Folder (no job folder exists yet at draft stage). Contains real
//     client PII (name, address, notes, lockbox codes/screenshots).
//   - has no jobId, no folders, no Dropbox state -- those only come into
//     existence once a draft is finalized into a real job via
//     POST /api/create-job (see server.js).
//   - reuses calendar-file.js's writeCalendarFile() completely unchanged
//     -- the draft's own folder is passed as the "job folder" argument,
//     so a draft's live-updatable Shoot Schedule.ics + any images sit at
//     <draftId>/Shoot Info/, the exact same shape a real job's Shoot Info
//     folder has. Every saveDraft() call wipes and regenerates that
//     folder from the current notes/images/time -- there's no separate
//     add/remove-image endpoint to keep in sync with the draft record.
//   - is deleted once finalized (explicit user decision, 2026-09-09: no
//     draft history is kept -- the finished job.json/Job Info.txt already
//     holds whatever was true at the end).
//
// job-generator is expected to eventually be ported into the Wix/Velo
// backend (see root CLAUDE.md) -- this module isn't that port, but the
// draft record shape is kept as a clean, self-contained JSON object (no
// filesystem-specific fields baked into it beyond the images array) so
// that a future "Drafts" collection in Wix CMS can adopt the same shape
// without a redesign.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const calendarFile = require('./calendar-file.js');

// Overridable per-call (same pattern as config-store.js) so tests never
// touch the real drafts/ directory.
const DRAFTS_DIR = path.join(__dirname, 'drafts');
const DRAFT_FILENAME = 'draft.json';

function draftDir(draftId, draftsDir) {
  return path.join(draftsDir || DRAFTS_DIR, draftId);
}

// draftIds are always our own crypto.randomUUID() output, never
// user-typed -- this is a defensive check against path traversal via a
// malformed :draftId in a URL, not a real-world UUID format validator.
function isValidDraftId(draftId) {
  return typeof draftId === 'string' && /^[a-f0-9-]{36}$/.test(draftId);
}

function summarize(draftId, record) {
  return {
    draftId,
    clientName: record.clientName || '',
    address: record.address || '',
    propertyType: record.propertyType || '',
    shootDate: record.shootDate || '',
    shootTime: record.shootTime || '',
    updatedAt: record.updatedAt,
    hasCalendar: !!(record.shootTime && String(record.shootTime).trim()),
  };
}

// Lightweight list for the Drafts panel -- does not read back image
// bytes (see getDraft() for that), just the small draft.json per draft.
// Sorted most-recently-updated first. Skips (rather than throws on) a
// corrupted/partial draft folder so one bad entry can't break the list.
function listDrafts(draftsDir) {
  draftsDir = draftsDir || DRAFTS_DIR;
  if (!fs.existsSync(draftsDir)) return [];
  return fs.readdirSync(draftsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidDraftId(entry.name))
    .map((entry) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(draftDir(entry.name, draftsDir), DRAFT_FILENAME), 'utf8'));
        return summarize(entry.name, record);
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// Full draft record for re-opening it in the UI, including any
// previously-saved images read back as base64 -- so the form can show
// them as already-attached without asking the user to re-select them.
// Returns null if the draft doesn't exist (already deleted, bad id, etc).
function getDraft(draftId, draftsDir) {
  if (!isValidDraftId(draftId)) return null;
  const file = path.join(draftDir(draftId, draftsDir), DRAFT_FILENAME);
  if (!fs.existsSync(file)) return null;

  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }

  const images = calendarFile.readExistingImages(draftDir(draftId, draftsDir));

  return Object.assign({}, record, { draftId, images });
}

// Creates (draftId is falsy) or updates (draftId matches an existing
// draft) a draft. Always re-derives the ENTIRE Shoot Info folder from the
// images/notes/time passed in THIS call -- same "client always sends the
// full current state" pattern /api/create-job already uses, so a removed
// image or a cleared Shoot Time never lingers from a previous save.
//
// Deliberately does NOT validate shootDate's format the way
// /api/create-job does -- a draft is explicitly for the "date isn't
// locked in yet" case, so whatever string is there (including blank) is
// stored as-is. Shoot Time and images ARE still validated (callers should
// validate up front and this re-checks as a safety net, same pattern as
// calendar-file.js).
function saveDraft(draftId, data, draftsDir) {
  const id = isValidDraftId(draftId) && fs.existsSync(draftDir(draftId, draftsDir)) ? draftId : crypto.randomUUID();
  const dir = draftDir(id, draftsDir);
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const record = {
    clientName: data.clientName || '',
    photographerName: data.photographerName || '',
    address: data.address || '',
    propertyType: data.propertyType || '',
    shootDate: data.shootDate || '',
    shootTime: data.shootTime || '',
    order: data.order || {},
    chosenCandidateIndex: Number.isInteger(data.chosenCandidateIndex) ? data.chosenCandidateIndex : null,
    notes: data.notes || '',
    commission: {
      checkedItemIds: (data.commission && data.commission.checkedItemIds) || [],
      travelCents: (data.commission && data.commission.travelCents) || 0,
    },
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, DRAFT_FILENAME), JSON.stringify(record, null, 2), 'utf8');

  // Clear any prior calendar file first, so a draft that just had its
  // Shoot Time removed doesn't keep a stale .ics (writeCalendarFile
  // returns null and writes nothing in that case).
  fs.rmSync(path.join(dir, calendarFile.ICS_FILENAME), { force: true });
  fs.rmSync(path.join(dir, calendarFile.LEGACY_FOLDER_NAME), { recursive: true, force: true });
  const calendarResult = calendarFile.writeCalendarFile(dir, {
    jobId: 'DRAFT-' + id,
    clientName: record.clientName,
    address: record.address,
    shootDate: record.shootDate,
    shootTime: record.shootTime,
    notes: record.notes,
    images: data.images,
  });

  return { draftId: id, record, calendarResult };
}

function deleteDraft(draftId, draftsDir) {
  if (!isValidDraftId(draftId)) return false;
  fs.rmSync(draftDir(draftId, draftsDir), { recursive: true, force: true });
  return true;
}

module.exports = { DRAFTS_DIR, isValidDraftId, listDrafts, getDraft, saveDraft, deleteDraft };
