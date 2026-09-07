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
    relPathFromJob: segs.slice(1).join('/'), // "" when the path IS the job folder
    filename,
    depth: segs.length,
  };
}

// Does this file path belong to a folder we mirror, and is it a web image?
// `syncFolders` is the already-parsed list (parseFolderList).
export function isSyncCandidate(pathDisplay, { root, syncFolders }) {
  const parsed = parseJobPath(pathDisplay, root);
  if (!parsed || !parsed.subFolder || parsed.depth < 3) return false;
  if (!folderMatches(parsed.subFolder, syncFolders)) return false;
  return isWebImage(parsed.filename);
}

// Case-insensitive membership.
export function folderMatches(subFolder, list) {
  const s = String(subFolder || '').toLowerCase();
  return list.some((f) => f.toLowerCase() === s);
}

// Absolute Dropbox path of the compressed download copy for an MLS photo:
// /<jobFolder>/<downloadSubfolder>/<basename>.jpg  (extension forced to jpg,
// because the Dropbox thumbnail is always JPEG).
export function downloadCopyPath(jobFolderPath, downloadSubfolder, filename) {
  const base = String(filename).replace(/\.[^.]+$/, '');
  return `${jobFolderPath}/${downloadSubfolder}/${base}.jpg`;
}

export { WEB_IMAGE_EXTS };
