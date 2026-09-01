/*
 * photo-source.js -- the ONLY seam between the editor and where photos
 * come from.
 *
 * The editor, photo library, template renderer, preview and PDF export
 * NEVER read `project.photos` or call the storage/upload layer directly.
 * They go through this interface. Swapping the source (v1 project uploads
 * -> future "Wix Gallery / Wix Data via API") is a new object here and
 * nothing else changes.
 *
 * ---------------------------------------------------------------------
 * INTERFACE  (window.FSB.photoSource)
 * ---------------------------------------------------------------------
 *   ready(project)            -> Promise | undefined
 *       Optional. If present, app.js awaits it before the first render.
 *       A remote source (Wix) fetches its list here and caches it.
 *
 *   list(project)             -> [ { id, filename, width, height } ]
 *       Synchronous. The photos to show in the library, in order.
 *
 *   getMeta(project, id)      -> { width, height, filename } | null
 *       Pixel size + name for one photo. crop-math needs width/height to
 *       keep the photo covering its slot. null => not known yet / gone.
 *
 *   thumbUrl(project, id)     -> string      (grid thumbnail)
 *   fullUrl(project, id)      -> string      (slot image / preview / export)
 *
 *   supportsUpload()          -> bool
 *       false => the library hides its upload button, dropzone and the
 *       per-photo delete control (the list is read-only, e.g. a Wix gallery).
 *
 *   upload(projectId, File)   -> Promise<photoMeta>     (only if supportsUpload)
 *   remove(projectId, id)     -> Promise<project>       (only if supportsUpload)
 *
 * `id` is an opaque string. Slots store only this id; every lookup that
 * needs more goes back through getMeta / *Url. So a Wix source can use
 * Wix media ids and Wix CDN URLs with zero editor changes.
 *
 * ---------------------------------------------------------------------
 * FUTURE: Wix Gallery source -- sketch (do NOT wire yet)
 * ---------------------------------------------------------------------
 *   var wixGallerySource = {
 *     _items: [],                       // cached [{id,filename,width,height,src,thumb}]
 *     ready: function (project) {
 *       return wixApi.listGalleryItems(project.propertyInfo.wixGalleryId)
 *         .then(function (items) { wixGallerySource._items = items.map(normalize); });
 *     },
 *     list:    function ()      { return wixGallerySource._items.map(pick('id','filename','width','height')); },
 *     getMeta: function (_p, id){ var i = byId(id); return i ? {width:i.width, height:i.height, filename:i.filename} : null; },
 *     thumbUrl:function (_p, id){ return byId(id).thumb; },
 *     fullUrl: function (_p, id){ return byId(id).src; },
 *     supportsUpload: function () { return false; },   // gallery is managed in Wix
 *   };
 *   window.FSB.photoSource = wixGallerySource;
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var store = window.FSB.store;

  function metaOf(project, id) {
    return (project && project.photos ? project.photos : []).filter(function (p) { return p.photoId === id; })[0] || null;
  }

  // v1 source: photos uploaded into THIS project. The list + per-photo
  // metadata live in project.photos; binaries + URLs are handled by store.js.
  var uploadSource = {
    id: 'project-uploads',

    // No async prep needed -- project.photos arrives with the project.
    ready: undefined,

    // The property photo library only. Info-form identity assets
    // (headshot / logo -> p.role) are looked up via getMeta / *Url but
    // never listed in the grid or the per-slot picker.
    list: function (project) {
      return (project && project.photos ? project.photos : [])
        .filter(function (p) { return !p.role; })
        .map(function (p) {
          return { id: p.photoId, filename: p.filename, width: p.width || 0, height: p.height || 0 };
        });
    },

    getMeta: function (project, id) {
      var m = metaOf(project, id);
      return m ? { width: m.width || 0, height: m.height || 0, filename: m.filename || '' } : null;
    },

    thumbUrl: function (project, id) {
      var m = metaOf(project, id);
      return m ? store.photoUrls(project.projectId, m).thumb : '';
    },
    fullUrl: function (project, id) {
      var m = metaOf(project, id);
      return m ? store.photoUrls(project.projectId, m).full : '';
    },

    supportsUpload: function () { return true; },
    upload: function (projectId, file, role) { return store.uploadPhoto(projectId, file, role); },
    remove: function (projectId, id) { return store.deletePhoto(projectId, id); },
    clearAll: function (projectId) { return store.clearPhotos(projectId); },
  };

  window.FSB.photoSource = uploadSource;
})();
