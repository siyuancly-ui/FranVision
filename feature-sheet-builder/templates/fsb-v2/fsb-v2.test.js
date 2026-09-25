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
test('themes: 4 standard themes, each with the token + font set', () => {
  ['navy', 'marble', 'burgundy', 'emerald'].forEach((id) => {
    const t = THEMES[id];
    assert.ok(t, id + ' theme exists');
    ['ink', 'gold', 'goldLine', 'goldSoft', 'bg', 'agentText'].forEach((tok) => {
      assert.equal(typeof t.tokens[tok], 'string', `${id}.tokens.${tok}`);
    });
    ['serif', 'sans', 'script'].forEach((f) => {
      assert.equal(typeof t.fonts[f].family, 'string', `${id}.fonts.${f}`);
    });
  });
});

test('geometry: page-2 flourish frame (shared Kevin-9 ornament)', () => {
  const [L, R] = GEO.page2.flourish.map((f) => f.rect);
  assertRect(L, 'flourish L');
  assertRect(R, 'flourish R');
  // mirrored across the spread: same band, same size
  assert.equal(L[1], R[1], 'L/R share the top edge');
  assert.equal(L[2], R[2], 'L/R share the width');
  assert.equal(L[3], R[3], 'L/R share the height');
  // centred over each panel (panelBorder centre), tolerance 0.01
  const [PL, PR] = GEO.page2.panelBorder.map((b) => b.rect);
  assert.ok(Math.abs((L[0] + L[2] / 2) - (PL[0] + PL[2] / 2)) < 0.01, 'L centred over its panel');
  assert.ok(Math.abs((R[0] + R[2] / 2) - (PR[0] + PR[2] / 2)) < 0.01, 'R centred over its panel');
  // sits in the band above the panel border, not overlapping it
  assert.ok(L[1] + L[3] <= PL[1] + 0.003, 'flourish clears the panel border');
  // frame aspect tracks the ornament art (flourish-v2.svg is ~3.8:1)
  const aspect = (L[2] * 1224) / (L[3] * 792);
  assert.ok(aspect > 3.5 && aspect < 4.1, 'frame aspect ~3.8:1, got ' + aspect.toFixed(2));
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

  // page-2 flourish flows through unchanged from geometry.js (shared by all themes)
  assert.equal(s.page2.flourish.length, 2, 'two flourishes composed');
  s.page2.flourish.forEach((f, i) => {
    assertRect(f.rect, 'composed flourish ' + f.panel);
    assert.deepEqual(f.rect, GEO.page2.flourish[i].rect);
  });
  assert.deepEqual(REG.compose(REG.blankProject('navy')).page2.flourish,
    s.page2.flourish, 'flourish frame is theme-independent');
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
    // full province name (not just the 2-letter code) must still split
    // before the city -- previously the postal code was left stranded
    // alone on line 2, throwing off its auto-fit font size.
    ['302-7030 Woodbine Ave, Markham, Ontario L3R 6G2', ['302-7030 Woodbine Ave', 'Markham, Ontario L3R 6G2']],
    ['302-7030 Woodbine Ave, Markham, Ontario, L3R 6G2', ['302-7030 Woodbine Ave', 'Markham, Ontario, L3R 6G2']],
    ['500 Yonge Street, Toronto, Ontario', ['500 Yonge Street', 'Toronto, Ontario']],
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

test('registry: hasContent is false for every fresh blank project and for theme/layout-only changes', () => {
  for (const t of REG.list()) assert.equal(REG.hasContent(REG.blankProject(t.id)), false, t.id);
  const p = REG.blankProject('navy');
  p.colorTheme = 'estate-emerald'; p.topPhotoStyle = 'paired'; p.imageSizes = { a: 2 };
  p.pages.page1.slots['p1R-hero'] = { photoId: null, positionX: 0, positionY: 0, scale: 1 };
  assert.equal(REG.hasContent(p), false);
  assert.equal(REG.hasContent(null), false);
});

test('registry: hasContent becomes true for typed text, a library photo, or a placed photo', () => {
  let p = REG.blankProject('navy'); p.propertyInfo.address = '1 Main St'; assert.equal(REG.hasContent(p), true);
  p = REG.blankProject('navy'); p.agentInfo.name = '  '; assert.equal(REG.hasContent(p), false);   // whitespace only
  p = REG.blankProject('navy'); p.agentInfo.email = 'a@b.co'; assert.equal(REG.hasContent(p), true);
  p = REG.blankProject('navy'); p.agentInfo2 = { name: 'Co-agent' }; assert.equal(REG.hasContent(p), true);
  p = REG.blankProject('navy'); p.photos.push({ photoId: 'x' }); assert.equal(REG.hasContent(p), true);
  p = REG.blankProject('navy'); p.pages.page2.slots['p2L-hero'] = { photoId: 'x' }; assert.equal(REG.hasContent(p), true);
});

test('registry: hasContent counts a connected Job as content (a deliberate act)', () => {
  const p = REG.blankProject('navy'); p.jobId = 'FVS-20260918-001';
  assert.equal(REG.hasContent(p), true);
});

// ================================================================
//  Gold ornamental frame around the page-1 description (2026-09-24)
//  ONLY the four 华邸 themes, ONLY when a description exists.
// ================================================================
const fs = require('node:fs');
const path = require('node:path');
const HUADI = ['navy', 'marble', 'burgundy', 'emerald'];

function withDescription(themeId, text) {
  const p = REG.blankProject(themeId);
  p.propertyInfo.description = text === undefined ? 'A bright, spacious home close to everything.' : text;
  return p;
}

test('descFrame: exactly the four 华邸 themes are flagged (explicit allow-list), the Estate-layout ones are not', () => {
  const flagged = Object.keys(THEMES).filter((id) => THEMES[id].descFrame).sort();
  assert.deepEqual(flagged, [...HUADI].sort());
  ['estate-navy', 'estate-burgundy', 'estate-emerald', 'estate-charcoal'].forEach((id) => {
    assert.ok(!THEMES[id].descFrame, id + ' must not get the frame');
    assert.equal(THEMES[id].layout, 'jason');
  });
  // the dropdown labels of the flagged ones are the 华邸 ones
  HUADI.forEach((id) => assert.match(THEMES[id].name, /^华邸/));
});

test('descFrame: in a 华邸 theme with a description, the frame fills the description box and the text sits inset inside it', () => {
  HUADI.forEach((id) => {
    const s = REG.compose(withDescription(id));
    const d = s.page1.left.desc;
    assert.ok(d && d.frame, id + ': frame present');
    assert.equal(d.frame.asset, '/template-assets/fsb-v2/assets/desc-frame.png');
    assert.deepEqual(d.frame.rect, MOD.leftColumn.stagger5.desc.rect, id + ': frame = the original description box');
    const [fx, fy, fw, fh] = d.frame.rect, [tx, ty, tw, th] = d.rect;
    const { x, y } = MOD.descFrame.inset;
    assert.ok(tx > fx && ty > fy && tx + tw < fx + fw && ty + th < fy + fh, id + ': text strictly inside the frame');
    assert.ok(Math.abs((tx - fx) / fw - x) < 1e-9 && Math.abs((ty - fy) / fh - y) < 1e-9, id + ': inset as configured');
    assert.ok(Math.abs((fx + fw - tx - tw) / fw - x) < 1e-9 && Math.abs((fy + fh - ty - th) / fh - y) < 1e-9, id + ': symmetric');
  });
});

test('descFrame: NOT drawn without a description (6-photo collage), and NOT in the Estate-layout themes (their text box is unchanged)', () => {
  HUADI.forEach((id) => {
    const blank = REG.compose(REG.blankProject(id));
    assert.equal(blank.page1.left.desc, null, id + ': no description -> no desc block, so no frame');
    assert.equal(blank.flags.leftVariant, 'collage6');
  });
  ['estate-navy', 'estate-burgundy', 'estate-emerald', 'estate-charcoal'].forEach((id) => {
    const s = REG.compose(withDescription(id));
    assert.equal(JSON.stringify(s).includes('desc-frame.png'), false, id + ': no frame anywhere in its render spec');
  });
});

test('descFrame: a blank/whitespace description counts as none; a real one switches the frame on', () => {
  assert.equal(REG.compose(withDescription('navy', '   ')).page1.left.desc, null);
  assert.ok(REG.compose(withDescription('navy', 'x')).page1.left.desc.frame);
});

test('descFrame: the inset keeps the text clear of the artwork (measured on the PNG: side lines 1.8%, top ornament to 12.3%, bottom ornament from 86.8%)', () => {
  const { x, y } = MOD.descFrame.inset;
  assert.ok(x > 0.018 + 0.02, 'text clear of the side lines');
  assert.ok(y > 0.123, 'text below the top ornament');
  assert.ok(1 - y < 0.868, 'text above the bottom ornament');
  assert.ok(x < 0.12 && y < 0.25, 'but not so big that the text area collapses');
});

test('descFrame colour: the frame uses the SAME theme token as the theme\'s other frames (page-2 panel frames + page-1 agent card), so it is the identical hex', () => {
  const token = MOD.descFrame.token;
  HUADI.forEach((id) => {
    assert.ok(THEMES[id].tokens[token], id + ' defines ' + token);
    assert.equal(REG.compose(withDescription(id)).page1.left.desc.frame.token, token);
  });
  // the renderer draws the page-2 panel frames with that very token (not a hard-coded colour)
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'template-render-v2.js'), 'utf8');
  const panel = /fsb-panel-border[\s\S]{0,400}?tokenColor\(theme, '([A-Za-z]+)'\)/.exec(src);
  assert.ok(panel, 'found the panel-border colour in the renderer');
  assert.equal(panel[1], token, 'panel frames and the description frame share one colour token');
  // ...and the description frame itself is filled from the theme (a mask), never from a baked-in colour
  assert.match(src, /var frameColor = tokenColor\(theme, LD\.frame\.token/);
  assert.match(src, /background-color:' \+ frameColor/);
});

test('descFrame: the artwork ships in the template assets (a 2:1 RGBA PNG)', () => {
  const file = path.join(__dirname, 'assets', 'desc-frame.png');   // the SHAPE mask (the supplied artwork, cleaned, lives in _assets-src/)
  const buf = fs.readFileSync(file);
  assert.equal(buf.slice(1, 4).toString(), 'PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), colorType = buf[25];
  assert.ok(Math.abs(w / h - 2) < 0.01, `2:1 (got ${w}x${h})`);
  assert.equal(colorType, 6, 'RGBA, so the middle is transparent');
  // it fits the description box without visible distortion
  const box = MOD.leftColumn.stagger5.desc.rect;
  const boxAspect = (box[2] * GEO.page.trimWidthPt) / (box[3] * GEO.page.trimHeightPt);
  assert.ok(Math.abs(boxAspect / (w / h) - 1) < 0.03, `description box ${boxAspect.toFixed(3)}:1 ~ artwork ${(w / h).toFixed(3)}:1`);
});
