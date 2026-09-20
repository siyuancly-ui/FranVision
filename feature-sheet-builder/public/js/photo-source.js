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

  // ---- job-linked sheets: read-only gallery from Dropbox-synced photos --------
  // (project id = jobId; see job-gallery.js). The picker lists HDR Photos / MLS
  // photos as 1024 thumbs; slots / preview / PDF use the 2048 render. Headshot
  // and logo (role-tagged) still upload like before.
  var J = window.FSB.jobGallery;
  var dimCache = {};   // photoId -> {width,height}; only for synced photos whose dims the worker could not read

  function isJob(project) { return !!(project && J.isJobId(project.projectId)); }
  function dimsOf(m) {
    var c = dimCache[m.photoId];
    return { width: m.width || (c && c.width) || 0, height: m.height || (c && c.height) || 0 };
  }

  function probeDims(project) {
    var missing = J.galleryPhotos(project.photos).filter(function (m) { return !(m.width > 0 && m.height > 0) && !dimCache[m.photoId]; });
    if (!missing.length) return Promise.resolve();
    var jobs = missing.map(function (m) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { dimCache[m.photoId] = { width: img.naturalWidth, height: img.naturalHeight }; resolve(); };
        img.onerror = resolve;
        img.src = store.photoUrls(project.projectId, m).thumb;
      });
    });
    // never hold the first render hostage to slow thumbnails
    return Promise.race([Promise.all(jobs), new Promise(function (r) { setTimeout(r, 5000); })]);
  }

  // ---- PDF export: pull the 2048 render of each PLACED synced photo -----------
  // The worker's /render is bearer-gated, so an <img> can't fetch it directly:
  // download each as a blob (limited parallelism), hand out blob: URLs, revoke after.
  var printCache = {};   // photoId -> blob: URL

  function workerBase() {
    var cfg = window.FSB_CONFIG || {};
    var m = /[?&]local=1\b/.test(window.location.search) && /[?&]photoSync=([^&]+)/.exec(window.location.search);
    return String((m ? decodeURIComponent(m[1]) : cfg.photoSyncUrl) || '').replace(/\/+$/, '');
  }
  function placedSyncedIds(project) {
    var ids = {};
    ['page1', 'page2'].forEach(function (pk) {
      var slots = (project.pages && project.pages[pk] && project.pages[pk].slots) || {};
      Object.keys(slots).forEach(function (sid) {
        var pid = slots[sid] && slots[sid].photoId;
        var m = pid && metaOf(project, pid);
        if (m && J.isSynced(m)) ids[pid] = m;
      });
    });
    return Object.keys(ids).map(function (k) { return ids[k]; });
  }
  function releasePrint() {
    Object.keys(printCache).forEach(function (k) { try { URL.revokeObjectURL(printCache[k]); } catch (e) { /* ignore */ } });
    printCache = {};
  }
  function preparePrint(project, token) {
    releasePrint();
    if (!isJob(project)) return Promise.resolve();
    var metas = placedSyncedIds(project);
    if (!metas.length) return Promise.resolve();
    var base = workerBase();
    if (!token || !base) return Promise.reject(new Error('High-resolution export needs the admin link. 导出高清 PDF 需要管理员链接。'));
    var failed = [], i = 0;
    function worker() {
      if (i >= metas.length) return Promise.resolve();
      var m = metas[i++];
      return fetch(base + '/render/' + encodeURIComponent(project.projectId) + '/' + encodeURIComponent(m.photoId), {
        headers: { Authorization: 'Bearer ' + token },
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        printCache[m.photoId] = URL.createObjectURL(blob);
      }).catch(function () { failed.push(m.filename || m.photoId); }).then(worker);
    }
    return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
      if (failed.length) {
        releasePrint();
        throw new Error('Could not get the high-res photo(s): ' + failed.join(', ') + '. 无法获取高清原图,请稍后重试。');
      }
    });
  }

  var source = {
    id: 'auto',
    ready: function (project) { return isJob(project) ? probeDims(project) : undefined; },

    list: function (project) {
      if (!isJob(project)) return uploadSource.list(project);
      return J.galleryPhotos(project.photos).map(function (p) {
        var d = dimsOf(p);
        return { id: p.photoId, filename: p.filename, width: d.width, height: d.height };
      });
    },
    getMeta: function (project, id) {
      var m = metaOf(project, id);
      if (!m) return null;
      if (!isJob(project) || !J.isSynced(m)) return uploadSource.getMeta(project, id);
      var d = dimsOf(m);
      return { width: d.width, height: d.height, filename: m.filename || '' };
    },
    printUrl: function (project, id) { return printCache[id] || uploadSource.fullUrl(project, id); },
    preparePrint: preparePrint,
    releasePrint: releasePrint,
    thumbUrl: function (project, id) { return uploadSource.thumbUrl(project, id); },
    fullUrl: function (project, id) { return uploadSource.fullUrl(project, id); },

    // the photo LIBRARY (grid upload / delete / clear-all): read-only for a job
    supportsUpload: function (project) { return !isJob(project); },
    // headshot / logo uploads (info form) are always allowed
    supportsAssetUpload: function () { return true; },
    upload: uploadSource.upload,
    remove: uploadSource.remove,
    clearAll: uploadSource.clearAll,
  };

  window.FSB.photoSource = source;
})();
