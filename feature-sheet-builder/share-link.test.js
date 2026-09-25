'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./public/js/share-link.js');

const LOC = { origin: 'https://fs.realgta.ca', pathname: '/', search: '' };

test('agentLink: origin + path + ?p=<id>, nothing else', () => {
  assert.equal(S.agentLink(LOC, 'a1B2c3D4e5F6'), 'https://fs.realgta.ca/?p=a1B2c3D4e5F6');
});

test('agentLink never carries the admin token, whatever the current URL has', () => {
  const adminLoc = { origin: 'https://fs.realgta.ca', pathname: '/', search: '?p=abc&admin=SECRET-TOKEN' };
  const link = S.agentLink(adminLoc, 'abc');
  assert.equal(link, 'https://fs.realgta.ca/?p=abc');
  assert.ok(!/admin|SECRET/i.test(link));
});

test('agentLink keeps the dev ?local=1 flag (as the admin list always did) and encodes odd ids', () => {
  const dev = { origin: 'http://localhost:4180', pathname: '/', search: '?admin=x&local=1' };
  assert.equal(S.agentLink(dev, 'abc'), 'http://localhost:4180/?p=abc&local=1');
  assert.equal(S.agentLink(LOC, 'a b/c'), 'https://fs.realgta.ca/?p=a%20b%2Fc');
  assert.equal(S.agentLink({ origin: 'https://x.test', pathname: '/fsb/', search: '' }, 'z'), 'https://x.test/fsb/?p=z');
});

// Wiring: the editor's button exists only for admin, both places use the ONE shared link builder,
// and the module is loaded before the scripts that use it.
const read = (f) => fs.readFileSync(path.join(__dirname, 'public', f), 'utf8');

test('editor "Copy agent link" button: admin-only, uses the shared builder', () => {
  const app = read('js/app.js');
  assert.match(app, /app\.adminToken\s*\?\s*el\('button', \{ class: 'fsb-btn fsb-btn--info', id: 'fsb-btn-copylink'/);
  assert.match(app, /FSB\.shareLink\.agentLink\(window\.location, app\.projectId\)/);
  assert.match(app, /Copy agent link 复制经纪链接/);
});

test('admin list and editor share ONE link definition; share-link.js loads before them', () => {
  const admin = read('js/admin.js');
  assert.match(admin, /FSB\.shareLink\.agentLink\(window\.location, id\)/);
  assert.doesNotMatch(admin, /\?p=' \+ encodeURIComponent/);          // no second copy of the URL shape
  const html = read('index.html');
  const at = (f) => html.indexOf(`/js/${f}`);
  assert.ok(at('share-link.js') > at('util.js') && at('share-link.js') < at('admin.js') && at('share-link.js') < at('app.js'));
});
