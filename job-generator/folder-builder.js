// FranVision Job Generator -- job folder structure.
//
// Builds the standardized per-job folder tree confirmed against the
// "99 Sample Dr" reference structure (see project memory
// franvision-folder-structure-v2 for the full discussion/rationale).
//
// Takes the SAME `order` shape used by pricing-adapter.js (propertyType,
// photography, addons) -- selection of what to build is driven by the
// exact same fields that drive pricing, so there is one source of truth
// for "what was ordered" instead of a second parallel selection model.
//
//   0 RAW/
//     1 Raws          <- always (base photos, incl. Drone Photos raw files)
//     4 Raw HDR        <- Luxury tier only
//     2 Video          <- Walkthrough Video OR Vlog Video selected
//     3 Image          <- same condition as 2 Video (video-editing stock images)
//   Revisions           <- always, empty
//   Home Report         <- always
//   Local Report        <- always, empty (added 2026-09-07)
//   MLS                 <- always
//   Floorplan           <- Floor Plan OR Site Plan selected (Site Plan merges in, no separate folder)
//   Virtual Staging     <- Virtual Staging selected
//   Feature Sheets      <- Feature Sheets selected
//   Video               <- Walkthrough Video selected (finished)
//   VLOG                <- Vlog Video selected (finished)
//
// Drone Photos has no dedicated folder -- it's treated exactly like the
// base photography service and flows through 1 Raws / MLS / Home Report.
//
// Twilight and 3D Tour deliberately have NO dedicated folder (2026-09-06
// change -- they used to) -- Luxury tier still gets 0 RAW/4 Raw HDR, and
// 3D Virtual Tour is still a real priced addon in pricing-config.js, but
// neither gets its own folder anymore. Do not re-add these without
// re-confirming -- this was an explicit request, not an oversight.

const fs = require('fs');
const path = require('path');

// Pure logic: given an order, return the list of component folders to
// create, as '/'-joined relative paths (POSIX-style regardless of host
// OS -- callers split on '/' and path.join() for the real filesystem call).
function getComponentFolders(order) {
  const addons = (order && order.addons) || {};
  const isLuxury = order && order.photography === 'luxury';

  const wantsFloorplan = !!(addons.floor_plan || addons.site_plan);
  const wantsWalkthrough = !!addons.walkthrough_video;
  const wantsVlog = !!addons.vlog_video;
  const wantsVideoRaw = wantsWalkthrough || wantsVlog;
  // Deliberately DECOUPLED from pricing/engine.js's own inclusion rule
  // (qty > 0): the checkbox alone is enough to create the folder, even
  // with quantity still unknown. Photo count is often not decided until
  // later in the shoot -- the folder should exist so work can start, and
  // the price is allowed to show $0 for this line temporarily. See the
  // "pendingConfirmation" tracking in job-files.js for how this gets
  // flagged so it isn't forgotten before invoicing.
  const stagingQty = Number(addons.virtual_staging_qty) || 0;
  const wantsVirtualStaging = !!addons.virtual_staging || stagingQty > 0;

  const folders = ['0 RAW/1 Raws', 'Revisions', 'Home Report', 'Local Report', 'MLS'];

  if (isLuxury) {
    folders.push('0 RAW/4 Raw HDR');
  }
  if (wantsVideoRaw) {
    folders.push('0 RAW/2 Video');
    folders.push('0 RAW/3 Image');
  }
  if (wantsWalkthrough) folders.push('Video');
  if (wantsVlog) folders.push('VLOG');
  if (wantsFloorplan) folders.push('Floorplan');
  // three_d_tour intentionally does NOT add a folder anymore -- see the
  // file header comment above (2026-09-06).
  if (wantsVirtualStaging) folders.push('Virtual Staging');
  if (addons.feature_sheets) folders.push('Feature Sheets');

  return folders;
}

// fs layer: creates jobFolderAbsolutePath itself plus every component
// folder under it. Idempotent (mkdir recursive), safe to re-run on an
// existing job folder to "top up" missing subfolders. Returns the list
// of absolute paths created (jobFolderAbsolutePath first, then each
// component folder, in the same order getComponentFolders returned them).
function createJobFolders(jobFolderAbsolutePath, order) {
  fs.mkdirSync(jobFolderAbsolutePath, { recursive: true });

  const created = [jobFolderAbsolutePath];
  for (const relPath of getComponentFolders(order)) {
    const absPath = path.join(jobFolderAbsolutePath, ...relPath.split('/'));
    fs.mkdirSync(absPath, { recursive: true });
    created.push(absPath);
  }
  return created;
}

// Pure: which component folders a job would GAIN and which it would LOSE
// if its order changed from oldOrder to newOrder. Both lists are
// '/'-joined relative paths, same shape getComponentFolders returns.
// Used by the job-UPDATE path (see DESIGN-job-update.md): `toCreate`
// folders get made, `toRemove` folders get removed ONLY if empty (the
// caller checks with folderHasRealFiles). A shared parent like '0 RAW'
// is never in `toRemove` because '0 RAW/1 Raws' keeps it required.
function diffComponentFolders(newOrder, oldOrder) {
  const now = getComponentFolders(newOrder);
  const before = getComponentFolders(oldOrder || {});
  const nowSet = new Set(now);
  const beforeSet = new Set(before);
  return {
    toCreate: now.filter((p) => !beforeSet.has(p)),
    // Deepest first, so a child is removed before any (hypothetical) parent.
    toRemove: before.filter((p) => !nowSet.has(p)).sort((a, b) => b.split('/').length - a.split('/').length),
  };
}

const IGNORED_FILENAMES = new Set(['.DS_Store', '.dropbox-sync-manifest.json']);

// Pure-ish (fs read-only): true if absDir contains any real file anywhere
// in its subtree. .DS_Store, the sync manifest, and Office lock files
// (~$*) don't count -- so a component folder holding only OS cruft still
// reads as "empty" and is safe for the update path to delete. A
// missing/unreadable directory reads as "no real files".
function folderHasRealFiles(absDir) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (folderHasRealFiles(path.join(absDir, entry.name))) return true;
    } else if (!IGNORED_FILENAMES.has(entry.name) && !entry.name.startsWith('~$')) {
      return true;
    }
  }
  return false;
}

module.exports = { getComponentFolders, createJobFolders, diffComponentFolders, folderHasRealFiles };
