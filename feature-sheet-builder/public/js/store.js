/*
 * store.js -- the ONLY place the client talks to a backend.
 *
 * Two interchangeable implementations behind one interface:
 *   - 'supabase' : direct to Supabase (Postgres `projects` row + `photos`
 *                  storage bucket). Used when window.FSB_CONFIG has creds.
 *                  This is the hosted / production path.
 *   - 'local'    : the zero-dep Node server (server.js). Used for dev when
 *                  FSB_CONFIG is blank.
 *
 * Interface (all return Promises unless noted):
 *   createProject(seed)              -> project
 *   getProject(id)                   -> project
 *   updateProject(id, project)       -> project   (pass the whole in-memory project)
 *   confirmProject(id, bool)         -> project
 *   uploadPhoto(id, File)            -> photoMeta  { photoId, filename, ext, width, height, hasThumb, bytes, uploadedAt }
 *   deletePhoto(id, photoId)         -> project
 *   photoUrls(id, photoMeta)         -> { full, thumb }   (sync)
 *
 * A "project" object is: { projectId, templateId, propertyInfo, agentInfo,
 *   photos, pages, confirmed, confirmedAt, createdAt, updatedAt }.
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};

  var CFG = window.FSB_CONFIG || {};
  // ?local=1 forces the Node-server backend even when Supabase creds are
  // present -- for local testing without touching the live database.
  var FORCE_LOCAL = /[?&]local=1\b/.test(window.location.search);
  var MODE = (!FORCE_LOCAL && CFG.supabaseUrl && CFG.supabaseAnonKey) ? 'supabase' : 'local';

  var DATA_KEYS = ['templateSystem', 'colorTheme', 'topPhotoStyle', 'imageSizes', 'boxOffsets', 'boxSizes', 'templateId',
    'propertyInfo', 'agentInfo', 'agentInfo2', 'photos', 'pages', 'confirmed', 'confirmedAt', 'deletedAt'];

  function pickData(p) {
    var d = {};
    DATA_KEYS.forEach(function (k) { if (p[k] !== undefined) d[k] = p[k]; });
    return d;
  }
  function reconstruct(id, data, createdAt, updatedAt) {
    return Object.assign({ projectId: id }, data, { createdAt: createdAt, updatedAt: updatedAt });
  }
  function nowIso() { return new Date().toISOString(); }

  function newId() {
    var bytes = new Uint8Array(9);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    // 18 hex chars -> trim to 12, url-safe by construction
    return s.slice(0, 12);
  }

  function clearPhotoRefs(project, photoId) {
    ['page1', 'page2'].forEach(function (pk) {
      var slots = (project.pages[pk] && project.pages[pk].slots) || {};
      Object.keys(slots).forEach(function (sid) {
        if (slots[sid] && slots[sid].photoId === photoId) {
          slots[sid] = { photoId: null, positionX: 0, positionY: 0, scale: 1 };
        }
      });
    });
    if (project.agentInfo) {
      if (project.agentInfo.headshotPhotoId === photoId) project.agentInfo.headshotPhotoId = null;
      if (project.agentInfo.brokerageLogoPhotoId === photoId) project.agentInfo.brokerageLogoPhotoId = null;
    }
  }

  // Read pixel size of an image File without decoding it twice.
  function imageSize(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ width: 0, height: 0 }); };
      img.src = url;
    });
  }

  // Downscale to a JPEG thumbnail (long edge <= maxEdge) entirely in the browser.
  function makeThumb(file, maxEdge) {
    maxEdge = maxEdge || 480;
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * scale));
        var h = Math.max(1, Math.round(img.naturalHeight * scale));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        c.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', 0.72);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function extOf(file) {
    var t = (file.type || '').toLowerCase();
    if (t === 'image/png') return 'png';
    if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
    var m = /\.([a-z0-9]+)$/i.exec(file.name || '');
    var e = m ? m[1].toLowerCase() : 'jpg';
    return e === 'jpeg' ? 'jpg' : e;
  }

  // =====================================================================
  //  LOCAL (Node server) implementation
  // =====================================================================
  function buildLocal() {
    function jsonFetch(url, opts) {
      return fetch(url, opts).then(function (r) {
        return r.text().then(function (txt) {
          var body;
          try { body = txt ? JSON.parse(txt) : {}; } catch (_e) { body = { error: txt || ('HTTP ' + r.status) }; }
          if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
          return body;
        });
      });
    }
    return {
      mode: 'local',
      createProject: function (seed) {
        return jsonFetch('/api/projects', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed || {}),
        }).then(function (b) { return b.project; });
      },
      getProject: function (id) {
        return jsonFetch('/api/projects/' + encodeURIComponent(id)).then(function (b) { return b.project; });
      },
      updateProject: function (id, project) {
        var patch = {
          templateSystem: project.templateSystem,
          colorTheme: project.colorTheme,
          topPhotoStyle: project.topPhotoStyle,
          imageSizes: project.imageSizes,
          boxOffsets: project.boxOffsets,
          boxSizes: project.boxSizes,
          templateId: project.templateId,
          propertyInfo: project.propertyInfo,
          agentInfo: project.agentInfo,
          agentInfo2: project.agentInfo2,
          pages: project.pages,
          photos: project.photos,
        };
        return jsonFetch('/api/projects/' + encodeURIComponent(id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
        }).then(function (b) { return b.project; });
      },
      confirmProject: function (id, confirmed) {
        return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/confirm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: confirmed === undefined ? true : !!confirmed }),
        }).then(function (b) { return b.project; });
      },
      deleteProject: function (id) {   // -> recycle bin (soft)
        return jsonFetch('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () { return true; });
      },
      restoreProject: function (id) {
        return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/restore', { method: 'POST' })
          .then(function (b) { return b.project; });
      },
      purgeProject: function (id) {
        return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/purge', { method: 'POST' }).then(function () { return true; });
      },
      emptyTrash: function (token) {
        return jsonFetch('/api/admin/trash/empty', { method: 'POST', headers: { 'X-Admin-Token': token || '' } })
          .then(function (b) { return b.purged || 0; });
      },
      listTrash: function (token) {
        return jsonFetch('/api/admin/trash', { headers: { 'X-Admin-Token': token || '' } })
          .then(function (b) { return b.projects || []; });
      },
      duplicateProject: function (id) {
        return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/duplicate', { method: 'POST' })
          .then(function (b) { return b.project; });
      },
      uploadPhoto: function (id, file) {
        return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/photos', {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'photo.jpg') },
          body: file,
        }).then(function (b) { return b.photo; });
      },
      deletePhoto: function (id, photoId) {
        return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/photos/' + encodeURIComponent(photoId), {
          method: 'DELETE',
        }).then(function (b) { return b.project; });
      },
      photoUrls: function (id, meta) {
        return {
          full: '/photos/' + id + '/' + meta.photoId,
          thumb: meta.hasThumb ? ('/thumbs/' + id + '/' + meta.photoId) : ('/photos/' + id + '/' + meta.photoId),
        };
      },

      // Submit-for-printing is a Supabase-only feature (edge function + email).
      uploadSubmission: function () { return Promise.reject(new Error('submission upload needs the Supabase backend')); },
      invokeFunction: function () { return Promise.reject(new Error('edge functions need the Supabase backend')); },

      // Admin (Franky) -- list every project. Gated by the admin token.
      listAllProjects: function (token) {
        return jsonFetch('/api/admin/projects', { headers: { 'X-Admin-Token': token || '' } })
          .then(function (b) { return b.projects || []; });
      },
    };
  }

  // =====================================================================
  //  SUPABASE implementation
  // =====================================================================
  function buildSupabase() {
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('supabase-js failed to load');
    }
    var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: false },
    });
    var BUCKET = CFG.photosBucket || 'photos';
    var V2 = window.FSB_V2;

    function pubUrl(path) {
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    }
    function origPath(id, meta) { return id + '/' + meta.photoId + '.' + (meta.ext || 'jpg'); }
    function thumbPath(id, meta) { return id + '/' + meta.photoId + '_thumb.jpg'; }

    function row2project(row) {
      return reconstruct(row.id, row.data, row.created_at, row.updated_at);
    }

    function fetchProject(id) {
      return sb.from('projects').select('*').eq('id', id).single().then(function (res) {
        if (res.error) throw new Error(res.error.message);
        if (!res.data) throw new Error('Project not found');
        return row2project(res.data);
      });
    }

    return {
      mode: 'supabase',

      createProject: function (seed) {
        seed = seed || {};
        var data = V2.blankProject(seed.colorTheme);
        if (seed.topPhotoStyle) data.topPhotoStyle = seed.topPhotoStyle;
        if (seed.propertyInfo) data.propertyInfo = Object.assign({}, data.propertyInfo, seed.propertyInfo);
        if (seed.agentInfo) data.agentInfo = Object.assign({}, data.agentInfo, seed.agentInfo);
        if (seed.agentInfo2) data.agentInfo2 = Object.assign({}, seed.agentInfo2);
        if (Array.isArray(seed.photos)) data.photos = seed.photos;
        var id = newId();
        return sb.from('projects').insert({ id: id, data: data }).select('*').single().then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return row2project(res.data);
        });
      },

      getProject: fetchProject,

      updateProject: function (id, project) {
        return sb.from('projects')
          .update({ data: pickData(project), updated_at: nowIso() })
          .eq('id', id).select('*').single()
          .then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return row2project(res.data);
          });
      },

      confirmProject: function (id, confirmed) {
        confirmed = confirmed === undefined ? true : !!confirmed;
        return fetchProject(id).then(function (p) {
          p.confirmed = confirmed;
          p.confirmedAt = confirmed ? (p.confirmedAt || nowIso()) : null;
          return sb.from('projects').update({ data: pickData(p), updated_at: nowIso() })
            .eq('id', id).select('*').single().then(function (res) {
              if (res.error) throw new Error(res.error.message);
              return row2project(res.data);
            });
        });
      },

      deleteProject: function (id) {   // -> recycle bin (soft)
        return fetchProject(id).then(function (p) {
          p.deletedAt = nowIso();
          return sb.from('projects').update({ data: pickData(p), updated_at: nowIso() })
            .eq('id', id).select('*').single();
        }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return true;
        });
      },
      restoreProject: function (id) {
        return fetchProject(id).then(function (p) {
          delete p.deletedAt;
          return sb.from('projects').update({ data: pickData(p), updated_at: nowIso() })
            .eq('id', id).select('*').single();
        }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return row2project(res.data);
        });
      },
      purgeProject: function (id) {
        return sb.storage.from(BUCKET).list(id).then(function (res) {
          var files = ((res && res.data) || []).map(function (f) { return id + '/' + f.name; });
          return files.length ? sb.storage.from(BUCKET).remove(files) : Promise.resolve({});
        }).then(function () {
          return sb.from('projects').delete().eq('id', id);
        }).then(function (res) {
          if (res && res.error) throw new Error(res.error.message);
          return true;
        });
      },
      emptyTrash: function (token) {
        var self = this;
        return this.listTrash(token).then(function (list) {
          return list.reduce(function (chain, r) {
            return chain.then(function (n) { return self.purgeProject(r.id).then(function () { return n + 1; }); });
          }, Promise.resolve(0));
        });
      },
      listTrash: function (token) {
        return sb.functions.invoke('list-projects', { body: { token: token || '', view: 'trash' } }).then(function (res) {
          if (res.error) throw new Error(res.error.message || 'unauthorized');
          return (res.data && res.data.projects) || [];
        });
      },

      duplicateProject: function (id) {
        return fetchProject(id).then(function (src) {
          var a1 = src.agentInfo || {};
          var a2 = src.agentInfo2 || null;
          var keep = [a1.headshotPhotoId, a1.brokerageLogoPhotoId, a2 && a2.headshotPhotoId].filter(Boolean);
          var photos = (src.photos || []).filter(function (p) { return keep.indexOf(p.photoId) >= 0; });
          var data = V2.blankProject(src.colorTheme);
          data.topPhotoStyle = src.topPhotoStyle || data.topPhotoStyle;
          data.agentInfo = Object.assign({}, a1);
          data.agentInfo2 = a2 ? Object.assign({}, a2) : null;
          data.photos = photos.map(function (p) { return Object.assign({}, p); });
          if (src.boxOffsets) data.boxOffsets = JSON.parse(JSON.stringify(src.boxOffsets));
          if (src.boxSizes) data.boxSizes = JSON.parse(JSON.stringify(src.boxSizes));
          if (src.imageSizes) data.imageSizes = JSON.parse(JSON.stringify(src.imageSizes));
          var nid = newId();
          var copies = [];
          photos.forEach(function (p) {
            var ext = p.ext || 'jpg';
            copies.push(sb.storage.from(BUCKET).copy(id + '/' + p.photoId + '.' + ext, nid + '/' + p.photoId + '.' + ext));
            if (p.hasThumb) copies.push(sb.storage.from(BUCKET).copy(id + '/' + p.photoId + '_thumb.jpg', nid + '/' + p.photoId + '_thumb.jpg'));
          });
          return Promise.all(copies).then(function () {
            return sb.from('projects').insert({ id: nid, data: data }).select('*').single();
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return row2project(res.data);
          });
        });
      },

      uploadPhoto: function (id, file) {
        var photoId = newId();
        var ext = extOf(file);
        var meta = {
          photoId: photoId, filename: file.name || (photoId + '.' + ext), ext: ext,
          width: 0, height: 0, hasThumb: false, bytes: file.size || 0, uploadedAt: nowIso(),
        };
        return Promise.all([imageSize(file), makeThumb(file)]).then(function (out) {
          meta.width = out[0].width; meta.height = out[0].height;
          var thumbBlob = out[1];
          var jobs = [
            sb.storage.from(BUCKET).upload(origPath(id, meta), file, { contentType: file.type || 'image/jpeg', upsert: true }),
          ];
          if (thumbBlob) {
            jobs.push(sb.storage.from(BUCKET).upload(thumbPath(id, meta), thumbBlob, { contentType: 'image/jpeg', upsert: true }));
          }
          return Promise.all(jobs).then(function (results) {
            var upErr = results.map(function (r) { return r && r.error; }).filter(Boolean)[0];
            if (upErr) throw new Error(upErr.message || 'upload failed');
            meta.hasThumb = !!thumbBlob;
            return meta;
          });
        });
      },

      deletePhoto: function (id, photoId) {
        return fetchProject(id).then(function (project) {
          var meta = (project.photos || []).filter(function (p) { return p.photoId === photoId; })[0];
          var paths = [];
          if (meta) {
            paths.push(origPath(id, meta));
            if (meta.hasThumb) paths.push(thumbPath(id, meta));
          }
          project.photos = (project.photos || []).filter(function (p) { return p.photoId !== photoId; });
          clearPhotoRefs(project, photoId);
          var removeJob = paths.length ? sb.storage.from(BUCKET).remove(paths) : Promise.resolve({});
          return removeJob.then(function () {
            return sb.from('projects').update({ data: pickData(project), updated_at: nowIso() })
              .eq('id', id).select('*').single();
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return row2project(res.data);
          });
        });
      },

      photoUrls: function (id, meta) {
        return {
          full: pubUrl(origPath(id, meta)),
          thumb: meta.hasThumb ? pubUrl(thumbPath(id, meta)) : pubUrl(origPath(id, meta)),
        };
      },

      // ---- submit for printing --------------------------------------
      // Stored in the working `photos` bucket under a `submissions/` prefix
      // (a dedicated private bucket refused anon writes on this project).
      // The path is never surfaced in the UI.
      uploadSubmission: function (projectId, blob) {
        return sb.storage.from(BUCKET).upload('submissions/' + projectId + '.pdf', blob, {
          contentType: 'application/pdf', upsert: true,
        }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return res.data;
        });
      },
      invokeFunction: function (name, body) {
        return sb.functions.invoke(name, { body: body }).then(function (res) {
          if (res.error) throw new Error(res.error.message || 'function error');
          return res.data;
        });
      },

      // Admin (Franky) -- list every project via an edge function that
      // checks the shared admin token and reads with the service role.
      listAllProjects: function (token) {
        return sb.functions.invoke('list-projects', { body: { token: token || '' } }).then(function (res) {
          if (res.error) throw new Error(res.error.message || 'unauthorized');
          return (res.data && res.data.projects) || [];
        });
      },
    };
  }

  var impl;
  try {
    impl = (MODE === 'supabase') ? buildSupabase() : buildLocal();
  } catch (e) {
    console.error('[FSB] store init failed (' + MODE + '):', e);
    impl = buildLocal();
  }

  impl.MODE = impl.mode;
  window.FSB.store = impl;
})();
