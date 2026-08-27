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
//   Twilight            <- Luxury tier only (top-level, NOT under 0 RAW)
//   Revisions           <- always, empty
//   Home Report         <- always
//   MLS                 <- always
//   Floorplan           <- Floor Plan OR Site Plan selected (Site Plan merges in, no separate folder)
//   3D Tour             <- 3D Virtual Tour selected (finished only, no raw subfolder)
//   Virtual Staging     <- Virtual Staging selected
//   Feature Sheets      <- Feature Sheets selected
//   Video               <- Walkthrough Video selected (finished)
//   VLOG                <- Vlog Video selected (finished)
//
// Drone Photos has no dedicated folder -- it's treated exactly like the
// base photography service and flows through 1 Raws / MLS / Home Report.

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

  const folders = ['0 RAW/1 Raws', 'Revisions', 'Home Report', 'MLS'];

  if (isLuxury) {
    folders.push('0 RAW/4 Raw HDR');
    folders.push('Twilight');
  }
  if (wantsVideoRaw) {
    folders.push('0 RAW/2 Video');
    folders.push('0 RAW/3 Image');
  }
  if (wantsWalkthrough) folders.push('Video');
  if (wantsVlog) folders.push('VLOG');
  if (wantsFloorplan) folders.push('Floorplan');
  if (addons.three_d_tour) folders.push('3D Tour');
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

module.exports = { getComponentFolders, createJobFolders };
