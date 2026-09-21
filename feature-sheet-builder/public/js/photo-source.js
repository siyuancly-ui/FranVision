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

  // ---- a sheet CONNECTED to a Job: read-only gallery from Dropbox-synced photos --------
  // The sheet keeps its own id/row; `project.jobId` points at a job's row, whose photos[]
  // the photo-sync-worker mirrors from Dropbox (see job-gallery.js). We only READ it. The
  // picker lists HDR Photos / MLS as 1024 thumbs; the editor / preview show the 1024; only
  // the admin PDF export pulls originals. Headshot / logo (role-tagged, in the sheet's own
  // photos[]) still upload like before.
  var J = window.FSB.jobGallery;
  var jobCache = {};   // jobId -> { photos: [...], byId: {photoId: meta}, address, error }
  var dimCache = {};   // photoId -> {width,height}; only for synced photos whose dims the worker could not read

  function cacheJob(jobId, data) {
    var byId = {};
    (data.photos || []).forEach(function (p) { byId[p.photoId] = p; });
    jobCache[jobId] = { photos: data.photos || [], byId: byId, address: data.address || '', error: null };
    return jobCache[jobId];
  }
  function loadJob(jobId) {
    return store.getJobGallery(jobId).then(function (d) { return cacheJob(jobId, d); }, function (err) {
      jobCache[jobId] = { photos: [], byId: {}, address: '', error: err.message || String(err) };
      return jobCache[jobId];
    });
  }
  function jobOf(project) {
    var jid = J.jobIdOf(project);
    return jid ? { id: jid, data: jobCache[jid] || null } : null;
  }

  // a photo's meta + whose storage folder it lives under (the sheet's own, or the job's)
  function metaFor(project, id) {
    var own = metaOf(project, id);
    if (own) return { m: own, owner: project.projectId };
    var j = jobOf(project);
    var jm = j && j.data && j.data.byId[id];
    return jm ? { m: jm, owner: j.id } : null;
  }
  function dimsOf(m) {
    var c = dimCache[m.photoId];
    return { width: m.width || (c && c.width) || 0, height: m.height || (c && c.height) || 0 };
  }

  function probeDims(project) {
    var j = jobOf(project);
    if (!j || !j.data) return Promise.resolve();
    var missing = J.galleryPhotos(j.data.photos).filter(function (m) { return !(m.width > 0 && m.height > 0) && !dimCache[m.photoId]; });
    if (!missing.length) return Promise.resolve();
    var jobs = missing.map(function (m) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { dimCache[m.photoId] = { width: img.naturalWidth, height: img.naturalHeight }; resolve(); };
        img.onerror = resolve;
        img.src = store.photoUrls(j.id, m).thumb;
      });
    });
    // never hold the first render hostage to slow thumbnails
    var timer;
    var cap = new Promise(function (r) { timer = setTimeout(r, 5000); });
    return Promise.race([Promise.all(jobs), cap]).then(function () { clearTimeout(timer); });
  }

  // ---- PDF export: pull the HDR original of each PLACED synced photo -----------
  // The worker's /render is bearer-gated, so an <img> can't fetch it directly:
  // download each as a blob (limited parallelism), hand out blob: URLs, revoke after.
  var printCache = {};   // photoId -> blob: URL

  function workerBase() {
    var cfg = window.FSB_CONFIG || {};
    var m = /[?&]local=1\b/.test(window.location.search) && /[?&]photoSync=([^&]+)/.exec(window.location.search);
    return String((m ? decodeURIComponent(m[1]) : cfg.photoSyncUrl) || '').replace(/\/+$/, '');
  }
  function placedSyncedMetas(project) {
    var out = {};
    ['page1', 'page2'].forEach(function (pk) {
      var slots = (project.pages && project.pages[pk] && project.pages[pk].slots) || {};
      Object.keys(slots).forEach(function (sid) {
        var pid = slots[sid] && slots[sid].photoId;
        var f = pid && metaFor(project, pid);
        if (f && J.isSynced(f.m)) out[pid] = f.m;
      });
    });
    return Object.keys(out).map(function (k) { return out[k]; });
  }
  function releasePrint() {
    Object.keys(printCache).forEach(function (k) { try { URL.revokeObjectURL(printCache[k]); } catch (e) { /* ignore */ } });
    printCache = {};
  }
  function preparePrint(project, token) {
    releasePrint();
    var jid = J.jobIdOf(project);
    if (!jid) return Promise.resolve();
    var metas = placedSyncedMetas(project);
    if (!metas.length) return Promise.resolve();
    var base = workerBase();
    if (!token || !base) return Promise.reject(new Error('High-resolution export needs the admin link. 导出高清 PDF 需要管理员链接。'));
    var failed = [], i = 0;
    function worker() {
      if (i >= metas.length) return Promise.resolve();
      var m = metas[i++];
      return fetch(base + '/render/' + encodeURIComponent(jid) + '/' + encodeURIComponent(m.photoId), {
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

    // load the connected job's photo list before the first render
    ready: function (project) {
      var jid = J.jobIdOf(project);
      return jid ? loadJob(jid).then(function () { return probeDims(project); }) : undefined;
    },

    // Connect a sheet to a job: validate the id, read the job's gallery, cache it.
    // Resolves { jobId, count, address }; rejects with a message fit to show.
    connect: function (project, raw) {
      var jid = J.normalizeJobId(raw);
      if (!jid) return Promise.reject(new Error('Not a valid Job ID (like FVS-20260918-001). Job ID 格式不对。'));
      return loadJob(jid).then(function (d) {
        if (d.error) throw new Error(/not found/i.test(d.error) ? 'Job not found — no photos have synced for it yet. 找不到该 Job(照片可能还没同步)。' : d.error);
        var count = J.galleryPhotos(d.photos).length;
        if (!count) throw new Error('This Job has no HDR Photos synced yet. 该 Job 还没有同步到 HDR 照片。');
        return probeDims({ jobId: jid }).then(function () { return { jobId: jid, count: count, address: d.address }; });
      });
    },
    // {jobId, count, address, error} for the info form, or null when not connected
    jobStatus: function (project) {
      var j = jobOf(project);
      if (!j) return null;
      var d = j.data;
      return { jobId: j.id, count: d ? J.galleryPhotos(d.photos).length : 0, address: d ? d.address : '', error: d ? d.error : null };
    },

    list: function (project) {
      var j = jobOf(project);
      if (!j) return uploadSource.list(project);
      return J.galleryPhotos(j.data ? j.data.photos : []).map(function (p) {
        var d = dimsOf(p);
        return { id: p.photoId, filename: p.filename, width: d.width, height: d.height };
      });
    },
    getMeta: function (project, id) {
      var f = metaFor(project, id);
      if (!f) return null;
      if (!J.isSynced(f.m)) return uploadSource.getMeta(project, id);
      var d = dimsOf(f.m);
      return { width: d.width, height: d.height, filename: f.m.filename || '' };
    },
    thumbUrl: function (project, id) {
      var f = metaFor(project, id);
      return f ? store.photoUrls(f.owner, f.m).thumb : '';
    },
    fullUrl: function (project, id) {
      var f = metaFor(project, id);
      return f ? store.photoUrls(f.owner, f.m).full : '';
    },
    printUrl: function (project, id) { return printCache[id] || source.fullUrl(project, id); },
    preparePrint: preparePrint,
    releasePrint: releasePrint,

    // the photo LIBRARY (grid upload / delete / clear-all): read-only once connected to a job
    supportsUpload: function (project) { return !J.jobIdOf(project); },
    // headshot / logo uploads (info form) are always allowed
    supportsAssetUpload: function () { return true; },
    upload: uploadSource.upload,
    remove: uploadSource.remove,
    clearAll: uploadSource.clearAll,
  };

  window.FSB.photoSource = source;
})();
