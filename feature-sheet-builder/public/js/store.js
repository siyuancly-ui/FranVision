/*
 * store.js -- the ONLY place the client talks to a backend.
 *
 * Today it calls the local Node server (server.js). To move persistence to
 * Supabase (or, later, Wix Data / Media) you reimplement these six methods
 * against that backend and change nothing else in the app. Keep the method
 * names and return shapes identical.
 *
 * Attaches to window.FSB.store
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};

  var BASE = ''; // same-origin

  function jsonFetch(url, opts) {
    return fetch(BASE + url, opts).then(function (r) {
      return r.text().then(function (txt) {
        var body;
        try { body = txt ? JSON.parse(txt) : {}; } catch (_e) { body = { error: txt || ('HTTP ' + r.status) }; }
        if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
        return body;
      });
    });
  }

  var store = {
    /** Create a project. `seed` may include propertyInfo / agentInfo / photos / templateId. */
    createProject: function (seed) {
      return jsonFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(seed || {}),
      }).then(function (b) { return b.project; });
    },

    getProject: function (id) {
      return jsonFetch('/api/projects/' + encodeURIComponent(id)).then(function (b) { return b.project; });
    },

    /** Persist a patch: { propertyInfo?, agentInfo?, pages?, templateId?, confirmed? } */
    updateProject: function (id, patch) {
      return jsonFetch('/api/projects/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch || {}),
      }).then(function (b) { return b.project; });
    },

    confirmProject: function (id, confirmed) {
      return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: confirmed === undefined ? true : !!confirmed }),
      }).then(function (b) { return b.project; });
    },

    /** Upload one File/Blob. Returns photo meta { photoId, width, height, ... }. */
    uploadPhoto: function (id, file) {
      return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/photos', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name || 'photo.jpg'),
        },
        body: file,
      }).then(function (b) { return b.photo; });
    },

    deletePhoto: function (id, photoId) {
      return jsonFetch('/api/projects/' + encodeURIComponent(id) + '/photos/' + encodeURIComponent(photoId), {
        method: 'DELETE',
      }).then(function (b) { return b.project; });
    },

    /** URLs for rendering. */
    photoUrl: function (id, photoId) { return BASE + '/photos/' + id + '/' + photoId; },
    thumbUrl: function (id, photoId) { return BASE + '/thumbs/' + id + '/' + photoId; },
  };

  window.FSB.store = store;
})();
