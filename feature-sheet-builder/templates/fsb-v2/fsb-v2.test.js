'use strict';
/*
 * fsb-v2 template system -- unit tests (node --test).
 * Guards the geometry / module / compose invariants that broke and got
 * re-fixed repeatedly by hand: rect validity, slot enumeration, left-
 * column variant choice, dual-agent symmetry, headshot aspect, and the
 * address / phone text helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const GEO = require('./geometry.js');
const THEMES = require('./themes.js');
const MOD = require('./modules.js');
const REG = require('./registry.js');
const TXT = require('./text-util.js');

// ---- helpers --------------------------------------------------------
function isFrac(n) { return typeof n === 'number' && isFinite(n) && n >= -0.05 && n <= 1.2; }
function assertRect(r, label) {
  assert.ok(Array.isArray(r) && r.length === 4, label + ': rect is [x,y,w,h]');
  r.forEach((n, i) => assert.ok(isFrac(n), `${label}: rect[${i}]=${n} out of range`));
  assert.ok(r[2] > 0 && r[3] > 0, label + ': width/height positive');
}
function centreX(r) { return r[0] + r[2] / 2; }

// ================================================================
test('geometry: page frame + page-2 slots', () => {
  assert.equal(GEO.page.count, 2);
  assert.equal(GEO.page.trimWidthPt, 1224);
  assert.equal(GEO.page.trimHeightPt, 792);

  assertRect(GEO.page1Right.address.rect, 'address');
  assertRect(GEO.page1Right.hero.rect, 'hero');
  assertRect(GEO.page1Right.agentBandRect, 'agentBand');

  const slots = GEO.page2.slots;
  assert.equal(slots.length, 10, 'page 2 has 10 photo slots');
  const ids = slots.map((s) => s.id);
  assert.equal(new Set(ids).size, 10, 'page-2 slot ids unique');
  assert.equal(slots.filter((s) => s.panel === 'L').length, 5);
  assert.equal(slots.filter((s) => s.panel === 'R').length, 5);
  slots.forEach((s) => assertRect(s.rect, 'p2 slot ' + s.id));
  GEO.page2.panelBorder.forEach((b) => assertRect(b.rect, 'panelBorder ' + b.panel));
  GEO.page2.flourish.forEach((f) => assertRect(f.rect, 'flourish ' + f.panel));
});

test('geometry: bed/bath/garage icon row entries', () => {
  const keys = GEO.page1Right.iconRow.entries.map((e) => e.key);
  assert.deepEqual(keys, ['bedrooms', 'bathrooms', 'garage']);
});

// ================================================================
test('themes: 3 themes, each with the token + font set', () => {
  ['navy', 'marble', 'burgundy'].forEach((id) => {
    const t = THEMES[id];
    assert.ok(t, id + ' theme exists');
    ['ink', 'gold', 'goldLine', 'bg', 'agentText'].forEach((tok) => {
      assert.equal(typeof t.tokens[tok], 'string', `${id}.tokens.${tok}`);
    });
    ['serif', 'sans', 'script'].forEach((f) => {
      assert.equal(typeof t.fonts[f].family, 'string', `${id}.fonts.${f}`);
    });
  });
});

// ================================================================
test('modules: left column variants', () => {
  const lc = MOD.leftColumn;
  // no description -> 6-photo collage
  assert.ok(lc.collage6.explicit);
  assert.equal(lc.collage6.photos.length, 6);
  assert.equal(new Set(lc.collage6.photos.map((p) => p.id)).size, 6, 'collage6 ids unique');
  lc.collage6.photos.forEach((p) => assertRect(p.rect, 'collage6 ' + p.id));

  // with description -> 5-photo staggered collage + desc box, + a paired option
  assert.ok(lc.stagger5.explicit);
  assert.equal(lc.stagger5.photos.length, 5);
  lc.stagger5.photos.forEach((p) => assertRect(p.rect, 'stagger5 ' + p.id));
  assert.equal(lc.stagger5.photosPaired.length, 5);
  assertRect(lc.stagger5.desc.rect, 'stagger5 desc');
  assert.ok(lc.stagger5.desc.rect[1] + lc.stagger5.desc.rect[3] > 0.9, 'desc box reaches near the column bottom');
});

test('modules: agent block boxes valid + keys unique', () => {
  ['single', 'dual'].forEach((v) => {
    const boxes = MOD.agentBlock[v].boxes;
    assert.ok(boxes.length >= 5, v + ' has boxes');
    const keys = boxes.map((b) => b.key);
    assert.equal(new Set(keys).size, keys.length, v + ': box keys unique');
    boxes.forEach((b) => {
      assert.equal(typeof b.key, 'string');
      assertRect(b.rect, `${v} box ${b.key}`);
    });
  });
});

test('modules: dual agent card is mirrored about the centre line', () => {
  const by = {};
  MOD.agentBlock.dual.boxes.forEach((b) => { by[b.key] = b.rect; });

  const pairs = [
    ['headshot1', 'headshot2'],
    ['agentInfo-name', 'agentInfo2-name'],
    ['agentInfo-contact', 'agentInfo2-contact'],
  ];
  pairs.forEach(([l, r]) => {
    assert.ok(by[l] && by[r], `${l} / ${r} present`);
    const sum = centreX(by[l]) + centreX(by[r]);
    assert.ok(Math.abs(sum - 1) < 0.02, `${l}+${r} centres mirror (sum ${sum.toFixed(3)})`);
    assert.equal(by[l][2].toFixed(3), by[r][2].toFixed(3), `${l}/${r} same width`);
    assert.equal(by[l][3].toFixed(3), by[r][3].toFixed(3), `${l}/${r} same height`);
  });
  ['logo', 'broker-address', 'online-tour'].forEach((k) => {
    assert.ok(Math.abs(centreX(by[k]) - 0.5) < 0.02, `${k} centred on 0.5 (${centreX(by[k]).toFixed(3)})`);
  });
});

test('modules: headshot boxes are locked to 3:4 portrait', () => {
  const all = [...MOD.agentBlock.single.boxes, ...MOD.agentBlock.dual.boxes];
  const heads = all.filter((b) => b.kind === 'headshot');
  assert.ok(heads.length >= 3, 'single + dual headshots');
  heads.forEach((b) => assert.equal(b.aspect, 4 / 3, b.key + ' aspect 4/3'));
});

// ================================================================
test('registry: left variant follows the description field', () => {
  const withDesc = REG.blankProject('navy');
  withDesc.propertyInfo.description = 'A home.';
  assert.equal(REG.compose(withDesc).flags.leftVariant, 'stagger5');

  const noDesc = REG.blankProject('navy');
  assert.equal(REG.compose(noDesc).flags.leftVariant, 'collage6');
});

test('registry: agent variant follows agentInfo2.name', () => {
  const single = REG.blankProject('navy');
  assert.equal(REG.compose(single).flags.agentVariant, 'single');

  const dual = REG.blankProject('navy');
  dual.agentInfo2 = { name: 'June Liu' };
  assert.equal(REG.compose(dual).flags.agentVariant, 'dual');
});

test('registry: icon row only lists filled bed/bath/garage', () => {
  const p = REG.blankProject('navy');
  assert.deepEqual(REG.compose(p).flags.iconRow, []);
  p.propertyInfo.bedrooms = '4+1';
  p.propertyInfo.garage = '2';
  assert.deepEqual(REG.compose(p).flags.iconRow, ['bedrooms', 'garage']);
});

test('registry: slotIds enumerates the right set per combo', () => {
  const p2 = GEO.page2.slots.map((s) => s.id);

  const noDesc = REG.blankProject('navy');
  const a = REG.slotIds(noDesc);
  assert.equal(new Set(a).size, a.length, 'slot ids unique (no desc)');
  assert.deepEqual(a.filter((s) => s.startsWith('p1L')).sort(),
    ['p1L-1', 'p1L-2', 'p1L-3', 'p1L-4', 'p1L-5', 'p1L-6']);
  assert.ok(a.includes('p1R-hero'));
  p2.forEach((id) => assert.ok(a.includes(id), 'includes ' + id));

  const withDesc = REG.blankProject('navy');
  withDesc.propertyInfo.description = 'x';
  const b = REG.slotIds(withDesc);
  assert.deepEqual(b.filter((s) => s.startsWith('p1L')), ['p1L-1', 'p1L-2', 'p1L-3', 'p1L-4', 'p1L-5']);

  const paired = REG.blankProject('navy');
  paired.propertyInfo.description = 'x';
  paired.topPhotoStyle = 'paired';
  const c = REG.slotIds(paired);
  assert.deepEqual(c.filter((s) => s.startsWith('p1L')), ['p1L-1', 'p1L-2', 'p1L-3', 'p1L-4', 'p1L-5']);
});

test('registry: compose output shape + no-overflow agent band', () => {
  const p = REG.blankProject('marble');
  p.propertyInfo.description = 'A description that should drive the stagger layout.';
  const s = REG.compose(p);
  assert.ok(s.theme && s.geometry && s.page1 && s.page2);
  assert.ok(s.page1.left.desc, 'desc present when description filled');
  assertRect(s.page1.right.address.rect, 'composed address');
  assertRect(s.page1.right.hero.rect, 'composed hero');
  assertRect(s.page1.right.agent.rect, 'composed agent band');
  const ar = s.page1.right.agent.rect;
  assert.ok(ar[1] + ar[3] <= 1.001, 'agent band stays on the page');
});

test('registry: blankProject scaffold shape', () => {
  const p = REG.blankProject('burgundy');
  assert.equal(p.templateSystem, 'fsb-v2');
  assert.equal(p.colorTheme, 'burgundy');
  assert.equal(p.agentInfo2, null);
  ['address', 'city', 'description', 'bedrooms', 'bathrooms', 'garage'].forEach((k) =>
    assert.ok(k in p.propertyInfo, 'propertyInfo.' + k));
  ['name', 'credentials', 'cellPhone', 'email', 'brokerage', 'brokerageAddress',
    'headshotPhotoId', 'brokerageLogoPhotoId'].forEach((k) =>
    assert.ok(k in p.agentInfo, 'agentInfo.' + k));
  assert.ok(p.pages.page1.slots && p.pages.page2.slots);
});

// ================================================================
test('text-util: splitAddress always yields two lines, city on line 2', () => {
  const cases = [
    ['333 Denison St, Unit 2, Markham, ON L3R 2Z4', ['333 Denison St, Unit 2', 'Markham, ON L3R 2Z4']],
    ['333 Denison St, Unit 2 Markham, ON L3R 2Z4', ['333 Denison St, Unit 2', 'Markham, ON L3R 2Z4']],
    ['95 Mural Street, Unit 400, Richmond Hill, ON L4B 3G2', ['95 Mural Street, Unit 400', 'Richmond Hill, ON L4B 3G2']],
    ['500 Yonge Street, Toronto, ON M5B 2H1', ['500 Yonge Street', 'Toronto, ON M5B 2H1']],
    ['10 King St W, Toronto, ON', ['10 King St W', 'Toronto, ON']],
    ['1 Dundas St E, Suite 2500 Toronto, ON M5G 1Z3', ['1 Dundas St E, Suite 2500', 'Toronto, ON M5G 1Z3']],
    ['123 Main St\nToronto, ON M5V 2T6', ['123 Main St', 'Toronto, ON M5V 2T6']],
  ];
  cases.forEach(([input, want]) => {
    assert.deepEqual(TXT.splitAddress(input), want, input);
  });
  assert.deepEqual(TXT.splitAddress('500 Yonge Street'), ['500 Yonge Street']);
  assert.deepEqual(TXT.splitAddress(''), []);
});

test('text-util: formatPhone normalises 10/11-digit numbers', () => {
  assert.equal(TXT.formatPhone('6472686266'), '647-268-6266');
  assert.equal(TXT.formatPhone('1 647 268 6266'), '647-268-6266');
  assert.equal(TXT.formatPhone('(647) 268-6266'), '647-268-6266');
  assert.equal(TXT.formatPhone('12345'), '12345'); // leave odd input alone
});
