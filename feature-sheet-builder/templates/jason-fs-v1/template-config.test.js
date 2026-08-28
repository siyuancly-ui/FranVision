'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('./template-config.js');

function eachRect(cb) {
  T.overlays.forEach((o) => cb(o.id, o.rect, 'overlay'));
  T.photoSlots.forEach((s) => cb(s.id, s.rect, 'photoSlot'));
  T.textFields.forEach((f) => cb(f.id, f.rect, 'textField'));
  cb(T.logoSlot.id, T.logoSlot.rect, 'logoSlot');
  cb(T.qrBlock.id, T.qrBlock.rect, 'qrBlock');
  cb(T.qrBlock.id + '-cap', T.qrBlock.captionRect, 'qrCaption');
}

test('has exactly 16 photo slots with unique ids', () => {
  assert.strictEqual(T.photoSlots.length, 16);
  const ids = T.photoSlots.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, 16);
});

test('all element ids are globally unique', () => {
  const ids = [];
  eachRect((id) => ids.push(id));
  ids.push(T.headshotSlot.id);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert.deepStrictEqual(dupes, [], 'no duplicate ids: ' + dupes.join(','));
});

test('every rect is 4 finite fractions inside the page', () => {
  eachRect((id, rect, kind) => {
    assert.ok(Array.isArray(rect) && rect.length === 4, `${kind} ${id} rect shape`);
    rect.forEach((n) => assert.ok(typeof n === 'number' && isFinite(n) && n >= 0 && n <= 1.001, `${kind} ${id} value ${n}`));
    assert.ok(rect[0] + rect[2] <= 1.02, `${kind} ${id} overflows right`);
    assert.ok(rect[1] + rect[3] <= 1.02, `${kind} ${id} overflows bottom`);
  });
});

test('headshot centre + diameter stay on the page', () => {
  const h = T.headshotSlot;
  assert.ok(h.center[0] > 0 && h.center[0] < 1 && h.center[1] > 0 && h.center[1] < 1);
  assert.ok(h.diameter > 0 && h.diameter < 0.5);
});

test('text fields reference a known font and have a content source', () => {
  T.textFields.forEach((f) => {
    assert.ok(T.fonts[f.font], `${f.id} font "${f.font}" exists`);
    assert.ok(f.bind || f.bindLines || f.static != null, `${f.id} has a content source`);
    assert.ok(f.sizePt > 0 && f.lineHeightPt > 0, `${f.id} sized`);
  });
});

test('photo slots split 6 on page 1, 10 on page 2', () => {
  const p1 = T.photoSlots.filter((s) => s.page === 1).length;
  const p2 = T.photoSlots.filter((s) => s.page === 2).length;
  assert.strictEqual(p1, 6);
  assert.strictEqual(p2, 10);
});

test('blankProject() scaffolds every slot and the full agentInfo shape', () => {
  const b = T.blankProject();
  const slotIds = Object.keys(b.pages.page1.slots).concat(Object.keys(b.pages.page2.slots)).sort();
  assert.deepStrictEqual(slotIds, T.photoSlots.map((s) => s.id).sort());
  Object.values(b.pages.page1.slots).forEach((st) => {
    assert.deepStrictEqual(Object.keys(st).sort(), ['photoId', 'positionX', 'positionY', 'scale']);
  });
  ['name', 'credentials', 'busPhone', 'cellPhone', 'email', 'brokerage', 'brokerageAddress', 'website', 'onlineTourUrl', 'headshotPhotoId', 'brokerageLogoPhotoId']
    .forEach((k) => assert.ok(k in b.agentInfo, `agentInfo.${k}`));
  assert.strictEqual(b.confirmed, false);
});

test('form field keys line up with the blank project containers', () => {
  const b = T.blankProject();
  T.form.propertyInfo.forEach((f) => assert.ok(f.key in b.propertyInfo, `propertyInfo.${f.key}`));
  T.form.agentInfo.forEach((f) => assert.ok(f.key in b.agentInfo, `agentInfo.${f.key}`));
});
