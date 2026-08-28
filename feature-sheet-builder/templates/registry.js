/*
 * Template registry. Add a template by requiring its config here and
 * putting it in the map under its `id`. Everything else (server, client,
 * PDF export) discovers templates through this file.
 */
(function (root) {
  'use strict';

  var jasonFsV1 = (typeof require !== 'undefined')
    ? require('./jason-fs-v1/template-config.js')
    : (root && root.FSB_TEMPLATE);

  var REGISTRY = {
    'jason-fs-v1': jasonFsV1,
  };

  var api = {
    DEFAULT_ID: 'jason-fs-v1',
    all: function () { return REGISTRY; },
    get: function (id) { return REGISTRY[id] || REGISTRY[api.DEFAULT_ID]; },
    has: function (id) { return Object.prototype.hasOwnProperty.call(REGISTRY, id); },
    ids: function () { return Object.keys(REGISTRY); },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FSB_TEMPLATES = api;
})(typeof window !== 'undefined' ? window : null);
