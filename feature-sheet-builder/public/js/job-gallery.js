/*
 * job-gallery.js -- pure helpers for a JOB-LINKED sheet (project id = a
 * Job Generator jobId such as FVS-20260915-001).
 *
 * Such a project shares its projects row with the photo-sync-worker, whose
 * photos[] entries mirror the studio's Dropbox job folder. The FSB shows those
 * photos read-only and must save only what it owns (see
 * supabase/fsb_project_patch.sql). No DOM, no network -- unit-tested in Node.
 */
(function (root) {
  'use strict';

  // Dropbox sub-folders whose photos the agent may pick from.
  var GALLERY_FOLDERS = ['HDR Photos', 'MLS'];

  // Keys the FSB owns on a project row (everything except photos[]).
  var FSB_KEYS = ['templateSystem', 'colorTheme', 'topPhotoStyle', 'imageSizes', 'boxOffsets', 'boxSizes',
    'templateId', 'propertyInfo', 'agentInfo', 'agentInfo2', 'pages', 'confirmed', 'confirmedAt', 'deletedAt'];

  function isJobId(id) { return typeof id === 'string' && /^FVS-/.test(id); }

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

  // FSB-owned uploads (headshot / logo) living in the same photos[] array
  function assetPhotos(photos) {
    return (photos || []).filter(function (p) { return p && p.role; });
  }

  // Storage object names (relative to <jobId>/). A synced photo has NO
  // original in the bucket, only the 1024 thumb -- and that is deliberately all
  // the editor/preview ever show. The 2048 (a paid deliverable) is fetched only
  // for the PDF export, through the photo-sync-worker's token-gated /render.
  function syncedFiles(meta) {
    var thumb = meta.photoId + '_thumb.jpg';
    return { thumb: thumb, full: thumb };
  }
  function isSynced(meta) { return !!(meta && meta.dropboxPath); }

  // The patch sent to fsb_project_patch: FSB-owned keys only. A key that is
  // absent on the project is sent as null so the server removes it (restore
  // deletes deletedAt this way).
  function patchOf(project) {
    var patch = {};
    FSB_KEYS.forEach(function (k) {
      patch[k] = project[k] === undefined ? null : project[k];
    });
    return patch;
  }

  var API = {
    GALLERY_FOLDERS: GALLERY_FOLDERS, FSB_KEYS: FSB_KEYS,
    isJobId: isJobId, isGalleryPhoto: isGalleryPhoto, galleryPhotos: galleryPhotos,
    assetPhotos: assetPhotos, syncedFiles: syncedFiles, isSynced: isSynced, patchOf: patchOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) { root.FSB = root.FSB || {}; root.FSB.jobGallery = API; }
})(typeof window !== 'undefined' ? window : null);
