// Pure path helpers -- no network, fully unit-tested.
//
// A Dropbox job photo path looks like (DROPBOX_JOBS_ROOT = ""):
//
//   /2026.09.07 12 Main St_Smith/MLS/DSC_0001.jpg
//    \__________ jobFolder ______/\_/ \__________/
//                                 |    filename
//                              subFolder
//
// relPathFromJob = "MLS/DSC_0001.jpg"  (everything below the job folder;
// this is what the stable photoId is hashed from).
//
// With DROPBOX_JOBS_ROOT = "/FranVision Jobs", the same file is
// /FranVision Jobs/2026.09.07 .../MLS/DSC_0001.jpg and the root prefix is
// stripped before the segments above are read.

const WEB_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v']);

// "/A/B/" -> "/A/B" ; "" | "/" -> "" ; "A/B" -> "/A/B"
export function normalizeRoot(root) {
  let r = String(root || '').trim().replace(/\/+$/, '');
  if (r === '' || r === '/') return '';
  if (!r.startsWith('/')) r = '/' + r;
  return r;
}

// Split a comma-separated env var into a trimmed, non-empty list.
export function parseFolderList(csv) {
  return String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fileExt(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function isWebImage(name) {
  return WEB_IMAGE_EXTS.has(fileExt(name));
}

// Content-Type for a true-original upload (see supabase.js#uploadLarge's
// ORIGINAL_RENDER_FOLDERS path) -- defaults to jpeg for anything
// unrecognized, same as every Dropbox-thumbnail-API render already is.
const IMAGE_CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export function imageContentType(name) {
  return IMAGE_CONTENT_TYPES[fileExt(name)] || 'image/jpeg';
}

export function isVideoFile(name) {
  return VIDEO_EXTS.has(fileExt(name));
}

// Parse a Dropbox path (pass path_display so casing is preserved) against
// the configured jobs root. Returns null if the path is not under the root
// or has no job folder segment.
export function parseJobPath(pathDisplay, root) {
  const r = normalizeRoot(root);
  const p = String(pathDisplay || '');
  if (!p.startsWith('/')) return null;

  let rest;
  if (r === '') {
    rest = p.slice(1);
  } else {
    const rLower = r.toLowerCase();
    const pLower = p.toLowerCase();
    if (pLower !== rLower && !pLower.startsWith(rLower + '/')) return null;
    rest = p.slice(r.length + 1);
  }

  const segs = rest.split('/').filter(Boolean);
  if (segs.length < 1) return null;

  const jobFolder = segs[0];
  const subFolder = segs.length >= 2 ? segs[1] : null;
  const filename = segs.length >= 1 ? segs[segs.length - 1] : null;

  return {
    jobFolder,
    jobFolderPath: (r === '' ? '' : r) + '/' + jobFolder, // absolute Dropbox path of the job folder
    subFolder,
    // Every directory name between the job folder and the file, outermost
    // first (e.g. ["HDR Photos", "Drone Callout"] for .../HDR Photos/Drone
    // Callout/x.jpg) -- lets a recognized folder name match at ANY depth,
    // not just directly under the job folder. See matchAncestorFolder().
    ancestors: segs.slice(1, -1),
    relPathFromJob: segs.slice(1).join('/'), // "" when the path IS the job folder
    filename,
    depth: segs.length,
  };
}

// Case-insensitive membership.
export function folderMatches(subFolder, list) {
  const s = String(subFolder || '').toLowerCase();
  return list.some((f) => f.toLowerCase() === s);
}

// Which of a path's ancestor directory names (if any) matches `list`,
// searching INNERMOST-first (closest to the file). This is what lets a
// folder like "Drone Callout" be recognized whether it sits directly under
// the job folder OR nested inside another recognized folder (e.g. "HDR
// Photos/Drone Callout/x.jpg", confirmed 2026-09-16) -- the more specific,
// innermost match wins over an outer one (e.g. "HDR Photos") that would
// otherwise also match. A plain, non-nested file (ancestors.length === 1)
// behaves exactly as before: that one ancestor either matches or it doesn't.
export function matchAncestorFolder(ancestors, list) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (folderMatches(ancestors[i], list)) return ancestors[i];
  }
  return null;
}

// Does this file path belong to a folder we mirror (at any depth), and is
// it a web image? `syncFolders` is the already-parsed list (parseFolderList).
// `excludeFolders` = folders THIS WORKER WRITES INTO (the `MLS for download` delivery copies).
// Anything under one of them, at ANY depth, is a derived copy and must never be synced back as a
// photo. Matching by any ancestor matters: SYNC_FOLDERS is matched at any depth too, so
// `MLS for download/Callout/x.jpg` (the Callout delivery copy, added 2026-09-23) matched `Callout`
// and was synced a second time -- every Callout photo appeared twice on the delivery page and the
// Gallery. The old guard only worked while the copies sat directly under `MLS for download/`.
export function isSyncCandidate(pathDisplay, { root, syncFolders, excludeFolders }) {
  const parsed = parseJobPath(pathDisplay, root);
  if (!parsed || parsed.depth < 3) return false;
  if (excludeFolders && excludeFolders.length && parsed.ancestors.some((a) => folderMatches(a, excludeFolders))) return false;
  if (!matchAncestorFolder(parsed.ancestors, syncFolders)) return false;
  return isWebImage(parsed.filename);
}

// Does this file path belong to a video-sync folder (at any depth), and is
// it a video file? Mirrors isSyncCandidate but for VIDEO_SYNC_FOLDERS / VIDEO_EXTS.
export function isVideoSyncCandidate(pathDisplay, { root, videoSyncFolders }) {
  const parsed = parseJobPath(pathDisplay, root);
  if (!parsed || parsed.depth < 3) return false;
  if (!matchAncestorFolder(parsed.ancestors, videoSyncFolders)) return false;
  return isVideoFile(parsed.filename);
}

// Does this file path point at the one well-known Tour Link text file,
// directly at a job folder's root (depth 2 -- NOT nested in any sub-folder,
// unlike SYNC_FOLDERS/VIDEO_SYNC_FOLDERS content). One file, one link, no
// per-provider (Floor Tour vs 3D Tour) distinction -- both render identically
// on delivery-page, so there's nothing for a filename/type field to encode.
export function isTourLinkCandidate(pathDisplay, { root, tourLinkFilename }) {
  const parsed = parseJobPath(pathDisplay, root);
  if (!parsed || parsed.depth !== 2) return false;
  return parsed.filename.toLowerCase() === String(tourLinkFilename || '').toLowerCase();
}

// Best-effort reverse of job-generator's sanitize.js#buildJobFolderName():
// "YYYY.M.D Address_Client" -> "Address". Interim measure so delivery-page
// has an address to show without job-generator pushing job.json data to
// Supabase (job.json is local-only) -- see franvision-delivery-page-design
// -spec.md's "Future automation goal". Returns null if the folder name
// doesn't look like the expected shape (e.g. a legacy/hand-renamed folder),
// never throws.
const JOB_FOLDER_DATE_PREFIX = /^\d{4}\.\d{1,2}\.\d{1,2}\s+(.+)$/;

export function parseAddressFromJobFolder(jobFolder) {
  const m = JOB_FOLDER_DATE_PREFIX.exec(String(jobFolder || '').trim());
  if (!m) return null;
  const rest = m[1];
  const idx = rest.lastIndexOf('_');
  if (idx === -1) return null;
  const address = rest.slice(0, idx).trim();
  return address || null;
}

// Absolute Dropbox path of the compressed download copy for an MLS photo:
// /<jobFolder>/<downloadSubfolder>/<basename>.jpg  (extension forced to jpg,
// because the Dropbox thumbnail is always JPEG).
export function downloadCopyPath(jobFolderPath, downloadSubfolder, filename, subdir = '') {
  const base = String(filename).replace(/\.[^.]+$/, '');
  return `${jobFolderPath}/${downloadSubfolder}/${subdir ? subdir + '/' : ''}${base}.jpg`;
}

// Does this classified sync item get a downloadable copy, and in which
// sub-directory of the download folder? Returns null (no copy), '' (directly
// in the download folder -- HDR Photos/MLS files) or a folder name (a nested
// folder such as HDR Photos/Callout/x.jpg -> "MLS for download/Callout/x.jpg",
// mirroring the source structure). A nested folder only counts when it sits
// UNDER a download-set folder: a Callout folder sitting directly under the
// job folder is not a layout Job Generator creates (it only makes
// HDR Photos/Callout), so it is deliberately left alone.
export function downloadSubdirFor(item, { downloadSetFolders, downloadNestedFolders }) {
  if (folderMatches(item.subFolder, downloadSetFolders)) return '';
  if (!folderMatches(item.subFolder, downloadNestedFolders || [])) return null;
  const dirs = String(item.relPathFromJob || '').split('/').filter(Boolean).slice(0, -1);
  const outer = dirs.findIndex((d) => folderMatches(d, downloadSetFolders));
  if (outer === -1) return null;
  const nested = dirs.slice(outer + 1).find((d) => folderMatches(d, downloadNestedFolders));
  return nested || null;
}

export { WEB_IMAGE_EXTS, VIDEO_EXTS };
