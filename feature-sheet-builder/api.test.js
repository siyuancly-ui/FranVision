'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated data dir + ephemeral port before the server module loads.
process.env.FSB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fsb-api-'));
process.env.PORT = '0';
const server = require('./server.js');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function base() {
  const a = server.address();
  return 'http://127.0.0.1:' + a.port;
}

test.after(() => server.close());

test('full workflow: create -> update -> upload -> reference -> confirm -> reload', async (t) => {
  const B = base();

  // create
  let r = await fetch(B + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ propertyInfo: { address: '6-260 Eagle St' } }),
  });
  assert.strictEqual(r.status, 201);
  const { projectId, project } = await r.json();
  assert.ok(projectId);
  assert.strictEqual(project.propertyInfo.address, '6-260 Eagle St');

  // update info + a slot crop
  r = await fetch(B + '/api/projects/' + projectId, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentInfo: { name: 'Cindy Lu', cellPhone: '416-000-0000' },
      pages: { page2: { slots: { 'p2L-1': { positionX: -0.4, positionY: 0.2, scale: 1.8 } } } },
    }),
  });
  assert.strictEqual(r.status, 200);

  // upload a photo (raw binary)
  r = await fetch(B + '/api/projects/' + projectId + '/photos', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('living.png') },
    body: PNG_1PX,
  });
  assert.strictEqual(r.status, 201);
  const { photo } = await r.json();
  assert.ok(photo.photoId);

  // fetch its bytes
  r = await fetch(B + '/photos/' + projectId + '/' + photo.photoId);
  assert.strictEqual(r.status, 200);
  assert.ok((await r.arrayBuffer()).byteLength > 0);

  // reference the photo from a slot
  r = await fetch(B + '/api/projects/' + projectId, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages: { page2: { slots: { 'p2L-1': { photoId: photo.photoId } } } } }),
  });
  assert.strictEqual(r.status, 200);

  // confirm
  r = await fetch(B + '/api/projects/' + projectId + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const confirmed = (await r.json()).project;
  assert.strictEqual(confirmed.confirmed, true);
  assert.ok(confirmed.confirmedAt);

  // reload -> everything survived
  r = await fetch(B + '/api/projects/' + projectId);
  const reload = (await r.json()).project;
  assert.strictEqual(reload.agentInfo.name, 'Cindy Lu');
  assert.strictEqual(reload.pages.page2.slots['p2L-1'].photoId, photo.photoId);
  assert.strictEqual(reload.pages.page2.slots['p2L-1'].scale, 1.8);
  assert.strictEqual(reload.confirmed, true);
});

test('unknown project -> 404', async () => {
  const r = await fetch(base() + '/api/projects/doesnotexist99');
  assert.strictEqual(r.status, 404);
});

test('templates endpoint lists the default', async () => {
  const r = await fetch(base() + '/api/templates');
  const b = await r.json();
  assert.strictEqual(b.defaultId, 'jason-fs-v1');
  assert.ok(b.ids.includes('jason-fs-v1'));
});

test('static shared module is served', async () => {
  const r = await fetch(base() + '/shared/crop-math.js');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /computeLayout/);
});
