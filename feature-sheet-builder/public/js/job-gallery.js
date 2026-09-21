/*
 * job-gallery.js -- pure helpers for a Feature Sheet that is CONNECTED to a Job.
 *
 * A sheet keeps its own random id (headshot/logo and everything the FSB owns live
 * in its own projects row). Connecting stores `jobId` on the sheet; the photo
 * list is then READ from that job's row, which the photo-sync-worker keeps
 * mirrored from Dropbox (photos[] entries with dropboxPath, folder, ...). The
 * FSB never writes a job row. No DOM, no network -- unit-tested in Node.
 */
(function (root) {
  'use strict';

  // Dropbox sub-folders whose photos the agent may pick from.
  var GALLERY_FOLDERS = ['HDR Photos', 'MLS'];

  var JOB_ID_RE = /^FVS-\d{8}-\d{3,}$/;

  // any id that is a Job's row (never a sheet) -- used to refuse whole-blob writes to it
  function isJobId(id) { return typeof id === 'string' && /^FVS-/.test(id); }

  // "  fvs-20260918-001 " -> "FVS-20260918-001"; '' when it isn't a job id
  function normalizeJobId(raw) {
    var s = String(raw == null ? '' : raw).trim().toUpperCase();
    return JOB_ID_RE.test(s) ? s : '';
  }

  // the job a sheet is connected to, or ''
  function jobIdOf(project) { return project ? normalizeJobId(project.jobId) : ''; }

  function isGalleryPhoto(p) {
    return !!(p && !p.role && p.dropboxPath && p.hasThumb !== false &&
      p.status !== 'pending_review' && GALLERY_FOLDERS.indexOf(p.folder) >= 0);
  }

  function byFilename(a, b) {
    return String(a.filename || '').localeCompare(String(b.filename || ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  // worker-synced photos the picker may show, in filename order
  function galleryPhotos(photos) {
    return (photos || []).filter(isGalleryPhoto).slice().sort(byFilename);
  }

  // Storage object names (relative to <jobId>/). A synced photo has NO original in
  // the bucket, only the 1024 thumb -- deliberately all the editor/preview ever
  // show. The full-resolution original (a paid deliverable) is fetched only for the
  // PDF export, through the photo-sync-worker's token-gated /render.
  function syncedFiles(meta) {
    var thumb = meta.photoId + '_thumb.jpg';
    return { thumb: thumb, full: thumb };
  }
  function isSynced(meta) { return !!(meta && meta.dropboxPath); }

  var API = {
    GALLERY_FOLDERS: GALLERY_FOLDERS,
    isJobId: isJobId, normalizeJobId: normalizeJobId, jobIdOf: jobIdOf,
    isGalleryPhoto: isGalleryPhoto, galleryPhotos: galleryPhotos,
    syncedFiles: syncedFiles, isSynced: isSynced,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) { root.FSB = root.FSB || {}; root.FSB.jobGallery = API; }
})(typeof window !== 'undefined' ? window : null);
