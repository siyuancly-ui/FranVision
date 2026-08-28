'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CROP = require('./crop-math.js');

const combos = [
  { photoW: 6000, photoH: 4000, slotW: 300, slotH: 400 }, // landscape photo, portrait slot
  { photoW: 3000, photoH: 4500, slotW: 500, slotH: 200 }, // portrait photo, wide slot
  { photoW: 4000, photoH: 4000, slotW: 350, slotH: 350 }, // square into square
  { photoW: 1200, photoH: 300, slotW: 400, slotH: 400 },  // panorama
];

test('computeLayout: photo always covers the slot at default state', () => {
  combos.forEach((c) => {
    const L = CROP.computeLayout(Object.assign({ scale: 1, positionX: 0, positionY: 0 }, c));
    assert.ok(L.displayW >= c.slotW - 0.5, 'width covers');
    assert.ok(L.displayH >= c.slotH - 0.5, 'height covers');
    assert.ok(L.offsetX <= 0.5 && L.offsetY <= 0.5, 'no gap top-left');
    assert.ok(L.offsetX + L.displayW >= c.slotW - 0.5, 'no gap right');
    assert.ok(L.offsetY + L.displayH >= c.slotH - 0.5, 'no gap bottom');
  });
});

test('covers() holds after extreme pan and zoom', () => {
  combos.forEach((c) => {
    [-999, -1, -0.3, 0, 0.7, 1, 999].forEach((p) => {
      [1, 1.5, 4, 99].forEach((z) => {
        const st = CROP.clampState({ photoId: 'x', positionX: p, positionY: -p, scale: z });
        assert.ok(CROP.covers(st, c), `covers p=${p} z=${z} ${JSON.stringify(c)}`);
      });
    });
  });
});

test('clampState bounds scale to [1,4] and position to [-1,1]', () => {
  const a = CROP.clampState({ positionX: 5, positionY: -5, scale: 100 });
  assert.deepStrictEqual([a.positionX, a.positionY, a.scale], [1, -1, 4]);
  const b = CROP.clampState({ positionX: -9, positionY: 9, scale: 0.1 });
  assert.deepStrictEqual([b.positionX, b.positionY, b.scale], [-1, 1, 1]);
  const c = CROP.clampState({});
  assert.deepStrictEqual([c.positionX, c.positionY, c.scale], [0, 0, 1]);
});

test('panByPixels never escapes [-1,1] and moves in the drag direction', () => {
  const c = combos[0];
  let st = CROP.clampState({ photoId: 'x', scale: 2 });
  st = CROP.panByPixels(st, c, 40, 0);
  assert.ok(st.positionX > 0 && st.positionX <= 1);
  for (let i = 0; i < 50; i++) st = CROP.panByPixels(st, c, 200, 200);
  assert.ok(st.positionX === 1 && st.positionY === 1);
});

test('zoomAt increases scale, stays covered, keeps focus roughly stable', () => {
  const c = combos[2];
  let st = CROP.clampState({ photoId: 'x' });
  const before = CROP.computeLayout(Object.assign({ scale: st.scale, positionX: st.positionX, positionY: st.positionY }, c));
  const focus = { x: c.slotW * 0.25, y: c.slotH * 0.75 };
  const imgFxBefore = (focus.x - before.offsetX) / before.displayW;

  st = CROP.zoomAt(st, c, 2, focus.x, focus.y);
  assert.ok(st.scale > 1 && st.scale <= 4);
  assert.ok(CROP.covers(st, c));

  const after = CROP.computeLayout(Object.assign({ scale: st.scale, positionX: st.positionX, positionY: st.positionY }, c));
  const imgFxAfter = (focus.x - after.offsetX) / after.displayW;
  // Within clamping, the focused image point shouldn't jump wildly.
  assert.ok(Math.abs(imgFxAfter - imgFxBefore) < 0.3);
});

test('missing photo dimensions degrade to an exact-fit cover', () => {
  const L = CROP.computeLayout({ slotW: 200, slotH: 100, photoW: 0, photoH: 0, scale: 1, positionX: 0, positionY: 0 });
  assert.strictEqual(Math.round(L.displayW), 200);
  assert.strictEqual(Math.round(L.displayH), 100);
});
