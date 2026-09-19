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
//   Local Report        <- always, empty (added 2026-09-07)
//   HDR Photos          <- always (renamed from "MLS" 2026-09-12 -- see below)
//     Callout          <- always, empty (added 2026-09-18, delivery page's Callout photos)
//   Floorplan           <- Floor Plan OR Site Plan selected (Site Plan merges in, no separate folder)
//   Virtual Staging     <- Virtual Staging selected
//   Feature Sheets      <- Feature Sheets selected
//   Video               <- Walkthrough Video selected (finished)
//   VLOG                <- Vlog Video selected (finished)
//
// Drone Photos has no dedicated folder -- it's treated exactly like the
// base photography service and flows through 1 Raws / HDR Photos / Local Report.
//
// Twilight and 3D Tour deliberately have NO dedicated folder (2026-09-06
// change -- they used to) -- Luxury tier still gets 0 RAW/4 Raw HDR, and
// 3D Virtual Tour is still a real priced addon in pricing-config.js, but
// neither gets its own folder anymore. Do not re-add these without
// re-confirming -- this was an explicit request, not an oversight.
//
// "Home Report" REMOVED 2026-09-10 -- it was never a real distinct thing
// in this list; it was a naming mistake for what should always have been
// called "Local Report" ("本地报表" on the price sheet), so both ended up
// getting generated on every job since 2026-09-07. There IS a real,
// separate "Home Report" service, but it's a newly-added service not yet
// wired into pricing-config.js -- when that happens it gets its own
// CONDITIONAL folder logic here, tied to that new service being selected.
// Do not re-add an unconditional "Home Report" folder before then.
//
// "MLS" RENAMED to "HDR Photos" 2026-09-12 -- pure naming change, no
// behavior change (still always-present, still the folder the Delivery
// Email's HDR line links to). Chosen because the folder actually holds
// the studio's finished high-res photos, and "MLS" as a name was
// confusing next to the Delivery Email's own separate "MLS Photos" line
// (which points at Photo Sync Worker's derived "MLS for download"
// folder, an entirely different thing). Existing jobs created before
// this change keep their real "MLS" folder on disk (this is a
// go-forward rename, not a migration) -- file-sync.js's
// KNOWN_COMPONENT_FOLDER_NAMES and photo-sync-worker's
// SYNC_FOLDERS/DOWNLOAD_SET_FOLDERS both list BOTH names for exactly
// this reason. Do not remove "MLS" from either of those until no job
// with the old folder name is still in active use.

const fs = require('fs');
const path = require('path');

// 3D Virtual Tour selected -> a Tour Link.txt at the job folder's root for
// staff to paste the tour URL into (added 2026-09-18). photo-sync-worker's
// tour-link-sync.js watches for exactly this filename (TOUR_LINK_FILENAME
// there) and writes its text into the delivery page's tourUrl -- so the
// file is created EMPTY (an empty file just yields no tour, a placeholder
// sentence would be published as the URL). Created locally only, and only
// if missing (an Update must never overwrite a link already pasted in);
// it syncs to Dropbox through the normal Push like any other file -- NOT
// uploaded from here, since a directly-uploaded copy with no sync-manifest
// entry would make the very first Push after it's edited look like a
// both-sides-changed conflict. Not removed if 3D Tour is later unchecked.
const TOUR_LINK_FILENAME = 'Tour Link.txt';

// Returns 'created' | 'exists' | null (3D Tour not selected).
function ensureTourLinkFile(jobFolderAbsolutePath, order) {
  const addons = (order && order.addons) || {};
  if (!addons.three_d_tour) return null;
  const file = path.join(jobFolderAbsolutePath, TOUR_LINK_FILENAME);
  if (fs.existsSync(file)) return 'exists';
  fs.writeFileSync(file, '', 'utf8');
  return 'created';
}

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

  // 'HDR Photos/Callout' (added 2026-09-18): where the photos for the
  // delivery page's Callout section go (drone/aerial or any highlight
  // shots) -- delivery-page/photo-sync-worker read it as a nested folder
  // under HDR Photos. A normal synced component folder, unlike the
  // Dropbox-only 'Cover&Closing' (see dropbox-sync.js).
  const folders = ['0 RAW/1 Raws', 'Revisions', 'Local Report', 'HDR Photos', 'HDR Photos/Callout'];

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

module.exports = { TOUR_LINK_FILENAME, ensureTourLinkFile, getComponentFolders, createJobFolders, diffComponentFolders, folderHasRealFiles };
