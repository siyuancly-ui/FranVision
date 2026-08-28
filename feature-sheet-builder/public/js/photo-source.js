/*
 * photo-source.js -- where the Photo Library gets its list of photos.
 *
 * v1 source: photos uploaded into THIS project (project.photos + the
 * server's /photos and /thumbs endpoints).
 *
 * Future: a "delivered assets" source that lists the photos already
 * delivered to the client through the wider FranVision (Wix) platform.
 * The library + editor only use the interface below, so adding that is a
 * new implementation here -- no other file changes.
 *
 * Interface:
 *   list(project)                 -> [ { id, filename, width, height } ]
 *   thumbUrl(project, id)         -> string
 *   fullUrl(project, id)          -> string
 *   supportsUpload()              -> bool
 *   upload(projectId, file)       -> Promise<photoMeta>   (if supportsUpload)
 *   remove(projectId, id)         -> Promise<project>     (if supportsUpload)
 *
 * Attaches to window.FSB.photoSource
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var store = window.FSB.store;

  var uploadSource = {
    id: 'project-uploads',
    list: function (project) {
      return (project && project.photos ? project.photos : []).map(function (p) {
        return { id: p.photoId, filename: p.filename, width: p.width || 0, height: p.height || 0 };
      });
    },
    thumbUrl: function (project, id) {
      return (project && project.photos.some(function (p) { return p.photoId === id && p.hasThumb; }))
        ? store.thumbUrl(project.projectId, id)
        : store.photoUrl(project.projectId, id);
    },
    fullUrl: function (project, id) { return store.photoUrl(project.projectId, id); },
    supportsUpload: function () { return true; },
    upload: function (projectId, file) { return store.uploadPhoto(projectId, file); },
    remove: function (projectId, id) { return store.deletePhoto(projectId, id); },
  };

  // Single active source for v1.
  window.FSB.photoSource = uploadSource;
})();
