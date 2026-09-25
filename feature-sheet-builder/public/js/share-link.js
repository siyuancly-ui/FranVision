/*
 * share-link.js -- builds the link Franky sends to an agent (the plain
 * ?p=<sheetId> URL: no admin token, so the agent gets the agent view only).
 *
 * One definition shared by the admin list ("Copy agent link" per row) and the
 * editor's own "Copy agent link" button, so the two can never disagree. No DOM,
 * no network -- `loc` is passed in (window.location or a stand-in) and the module
 * is unit-tested in Node.
 */
(function (root) {
  'use strict';

  // loc: { origin, pathname, search }. The dev flag ?local=1 is kept on every
  // internally generated link (same rule the admin list always applied).
  function agentLink(loc, id) {
    var l = loc || {};
    var dev = /[?&]local=1\b/.test(l.search || '') ? '&local=1' : '';
    return (l.origin || '') + (l.pathname || '/') + '?p=' + encodeURIComponent(id) + dev;
  }

  var API = { agentLink: agentLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) { root.FSB = root.FSB || {}; root.FSB.shareLink = API; }
})(typeof window !== 'undefined' ? window : null);
