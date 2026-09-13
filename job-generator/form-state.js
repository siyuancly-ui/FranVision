// FranVision Job Generator -- per-job form-state sidecar.
//
// job.json (see job-files.js) is the OFFICIAL record -- client/address/
// shootDate/services/pricing/commission-breakdown, meant to be read by
// Job Info.txt, delivery-email.js, and (eventually) whatever consumes it
// in Wix. It deliberately does NOT carry a few fields the CREATE-JOB FORM
// itself needs back when re-opening a job to edit it (from the Drafts
// panel or the Recent Jobs panel, see job-list.js):
//   - shootTime / notes           -- only ever mirrored into the generated
//                                     Shoot Schedule.ics, never job.json
//                                     (see calendar-file.js / job-files.js
//                                     header comments)
//   - chosenCandidateIndex        -- which pricing candidate the user
//                                     picked when pricing was ambiguous;
//                                     job.json only keeps the resolved
//                                     price, not which candidate produced
//                                     it
//   - commission.checkedItemIds/  -- job.json's `commission` is the
//     travelCents                    computed breakdown (items already
//                                     filtered to checked ones); the
//                                     ORIGINAL checkbox state isn't
//                                     recoverable from that alone
//
// This sidecar exists purely to make "load this job back into the form"
// possible for BOTH a Save-Draft'd job (jobId: null) and a real Recent Job
// -- before 2026-09-13 only Drafts had this (the old draft-store.js kept
// the whole draft record, including these fields, in its own standalone
// draft.json). It is local-only: added to file-sync.js's
// LOCAL_ONLY_FILENAMES so Push/Pull never sends it to Dropbox, same as
// job.json/Job Info.txt/Shoot Schedule.ics.
//
// Never throws -- a missing or corrupted sidecar just means "no saved
// form state", not a fatal error (the rest of the job -- job.json, the
// actual folders -- is unaffected either way).

const fs = require('fs');
const path = require('path');

const FORM_STATE_FILENAME = '.form-state.json';

function defaults() {
  return {
    shootTime: '',
    notes: '',
    chosenCandidateIndex: null,
    commission: { checkedItemIds: [], travelCents: 0 },
  };
}

function readFormState(jobFolderPath) {
  const file = path.join(jobFolderPath, FORM_STATE_FILENAME);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return defaults();
  }
  if (!data || typeof data !== 'object') return defaults();

  return {
    shootTime: data.shootTime || '',
    notes: data.notes || '',
    chosenCandidateIndex: Number.isInteger(data.chosenCandidateIndex) ? data.chosenCandidateIndex : null,
    commission: {
      checkedItemIds: (data.commission && Array.isArray(data.commission.checkedItemIds)) ? data.commission.checkedItemIds : [],
      travelCents: (data.commission && Number.isInteger(data.commission.travelCents)) ? data.commission.travelCents : 0,
    },
  };
}

// Always writes the full current state (same "client sends the whole
// truth" pattern as everything else in this module) -- never merges with
// what was there before.
function writeFormState(jobFolderPath, data) {
  const record = {
    shootTime: (data && data.shootTime) || '',
    notes: (data && data.notes) || '',
    chosenCandidateIndex: Number.isInteger(data && data.chosenCandidateIndex) ? data.chosenCandidateIndex : null,
    commission: {
      checkedItemIds: (data && data.commission && data.commission.checkedItemIds) || [],
      travelCents: (data && data.commission && data.commission.travelCents) || 0,
    },
  };
  fs.writeFileSync(path.join(jobFolderPath, FORM_STATE_FILENAME), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

module.exports = { FORM_STATE_FILENAME, readFormState, writeFormState };
