// Run with: node calendar-file.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.
//
// Pinned BEFORE requiring calendar-file.js (or constructing any Date) so
// the DTSTART/DTEND/DTSTAMP UTC-conversion tests give the same answer on
// any machine running this suite -- Node re-reads process.env.TZ per
// Date computation, so this works even though other test files earlier
// in a full-suite run may have already constructed Dates.
process.env.TZ = 'America/Toronto';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  validateImages, writeCalendarFile, buildIcs, readExistingImages, mergeImages,
  buildEventTitle, buildPackageCode, photographerCode,
  LEGACY_FOLDER_NAME, ICS_FILENAME, DEFAULT_DURATION_MINUTES, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES,
} = require('./calendar-file.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fv-calendar-test-'));
}

function fakeImage(filename, sizeBytes) {
  return { filename, dataBase64: Buffer.alloc(sizeBytes || 10).toString('base64') };
}

function linkedImage(filename, n) {
  return { filename, url: 'https://x.supabase.co/storage/v1/object/public/jg-shoot-notes/' + 'ab'.repeat(16) + '-' + (n || 1) + '/' + filename };
}

// The OLD on-disk format (base64 ATTACH), hand-built -- the writer no longer
// produces it, but drafts saved before 2026-09-21 still contain it.
function writeLegacyAttachIcs(file, images) {
  const lines = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:x'];
  for (const img of images) {
    lines.push('ATTACH;FMTTYPE=image/jpeg;ENCODING=BASE64;VALUE=BINARY;X-APPLE-FILENAME="' + img.filename + '";X-FILENAME="' + img.filename + '":' + img.dataBase64);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
}

const BASE_JOB = { jobId: 'FVS-20260908-001', clientName: 'Jane Doe', address: '123 Main St', shootDate: '2026/09/10', shootTime: '14:30' };

// ---- validateImages ----

test('validateImages: no problems for a normal small jpg', () => {
  assert.deepStrictEqual(validateImages([fakeImage('reference.jpg', 1000)]), []);
});

test('validateImages: rejects an unsupported file extension', () => {
  const problems = validateImages([fakeImage('reference.pdf', 1000)]);
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('unsupported file type'));
});

test('validateImages: rejects more than MAX_IMAGES', () => {
  const images = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => fakeImage('img' + i + '.jpg', 10));
  const problems = validateImages(images);
  assert.ok(problems.some((p) => p.includes('Too many')));
});

test('validateImages: rejects an oversized image', () => {
  const problems = validateImages([fakeImage('huge.jpg', MAX_IMAGE_BYTES + 1000)]);
  assert.ok(problems.some((p) => p.includes('too large')));
});

test('validateImages: rejects a batch that individually fits but exceeds the combined total', () => {
  const perImage = Math.floor(MAX_TOTAL_BYTES / 4); // 4 of these already exceeds MAX_TOTAL_BYTES
  const images = [1, 2, 3, 4, 5].map((i) => fakeImage('img' + i + '.jpg', perImage));
  const problems = validateImages(images);
  assert.ok(problems.some((p) => p.includes('combined')));
});

test('validateImages: accepts every allowed extension', () => {
  ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif'].forEach((ext) => {
    assert.deepStrictEqual(validateImages([fakeImage('x.' + ext, 10)]), [], ext);
  });
});

// ---- buildIcs ----

// DTSTART/DTEND are real UTC ("Z") instants now, not a "floating" local
// time (see calendar-file.js's formatUtcStamp() comment for why -- a
// floating time was found to display wrong on a real Windows machine).
// process.env.TZ is pinned to America/Toronto at the top of this file, so
// these expected values (EDT = UTC-4 in September) are deterministic
// wherever this suite runs.

test('buildIcs: DTSTART/DTEND reflect the shoot date+time (as real UTC) and default 2h duration', () => {
  const ics = buildIcs(BASE_JOB);
  assert.ok(ics.includes('DTSTART:20260910T183000Z')); // 14:30 EDT -> 18:30 UTC
  assert.ok(ics.includes('DTEND:20260910T203000Z'));   // +2h default -> 20:30 UTC
});

test('buildIcs: DTEND respects a custom durationMinutes', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { durationMinutes: 30 }));
  assert.ok(ics.includes('DTSTART:20260910T183000Z'));
  assert.ok(ics.includes('DTEND:20260910T190000Z')); // +30min
});

test('buildIcs: DTEND rolls over midnight correctly (in UTC too)', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { shootTime: '23:15' }));
  assert.ok(ics.includes('DTSTART:20260911T031500Z')); // 23:15 EDT Sep 10 -> 03:15 UTC Sep 11
  assert.ok(ics.includes('DTEND:20260911T051500Z'));   // +2h -> 05:15 UTC Sep 11
});

test('buildIcs: SUMMARY is the package/client/photographer title, LOCATION is the address', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { order: { photography: 'luxury', addons: { walkthrough_video: true, drone_photos: true } }, photographerName: 'Johnson' }));
  assert.ok(ics.includes('SUMMARY:HDR P+V+D_Jane Doe_jo'));
  assert.ok(ics.includes('LOCATION:123 Main St'));
});

test('buildIcs: with no order/photographerName given, SUMMARY falls back to plain "P" and the unknown-photographer placeholder', () => {
  const ics = buildIcs(BASE_JOB);
  assert.ok(ics.includes('SUMMARY:P_Jane Doe_？'));
});

// ---- buildPackageCode / photographerCode / buildEventTitle (2026-09-16
// calendar title naming rule, e.g. "HDR P+V+D_Paul_jo") ----

test('buildPackageCode: standard photography alone is just "P"', () => {
  assert.strictEqual(buildPackageCode({ photography: 'standard', addons: {} }), 'P');
});

test('buildPackageCode: luxury photography alone is "HDR P"', () => {
  assert.strictEqual(buildPackageCode({ photography: 'luxury', addons: {} }), 'HDR P');
});

test('buildPackageCode: the user\'s own example -- luxury + walkthrough video + drone', () => {
  assert.strictEqual(buildPackageCode({ photography: 'luxury', addons: { walkthrough_video: true, drone_photos: true } }), 'HDR P+V+D');
});

test('buildPackageCode: vlog video uses "Vlog", never combined with walkthrough\'s "V"', () => {
  assert.strictEqual(buildPackageCode({ photography: 'luxury', addons: { vlog_video: true } }), 'HDR P+Vlog');
});

test('buildPackageCode: fixed code order regardless of the addons object\'s key order -- video, drone, 3D, floorplan, feature sheets', () => {
  const order = { photography: 'standard', addons: { feature_sheets: true, floor_plan: true, three_d_tour: true, drone_photos: true, walkthrough_video: true } };
  assert.strictEqual(buildPackageCode(order), 'P+V+D+3D+fl+FS');
});

test('buildPackageCode: site_plan also triggers the "fl" code (shares Floor Plan\'s slot)', () => {
  assert.strictEqual(buildPackageCode({ photography: 'standard', addons: { site_plan: true } }), 'P+fl');
});

test('buildPackageCode: an addon that is not in the naming rule (e.g. virtual_staging) contributes no code', () => {
  assert.strictEqual(buildPackageCode({ photography: 'standard', addons: { virtual_staging: true } }), 'P');
});

test('photographerCode: known photographers use their fixed abbreviation, case-insensitively', () => {
  assert.strictEqual(photographerCode('Franky'), 'F');
  assert.strictEqual(photographerCode('johnson'), 'jo');
  assert.strictEqual(photographerCode('JASON'), 'j');
  assert.strictEqual(photographerCode('elsa'), 'E');
});

test('photographerCode: an unrecognized name uses its first two letters, capitalized like "Mi"', () => {
  assert.strictEqual(photographerCode('Mike'), 'Mi');
  assert.strictEqual(photographerCode('mike'), 'Mi');
});

test('photographerCode: a blank/missing name is the "？" placeholder, not an omitted segment', () => {
  assert.strictEqual(photographerCode(''), '？');
  assert.strictEqual(photographerCode('   '), '？');
  assert.strictEqual(photographerCode(undefined), '？');
});

test('buildEventTitle: assembles "package_client_photographer" -- the user\'s own example', () => {
  const title = buildEventTitle({ order: { photography: 'luxury', addons: { walkthrough_video: true, drone_photos: true } }, clientName: 'Paul', photographerName: 'Johnson' });
  assert.strictEqual(title, 'HDR P+V+D_Paul_jo');
});

test('buildIcs: includes notes text in DESCRIPTION', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { notes: 'Please shoot at dusk.' }));
  assert.ok(ics.includes('DESCRIPTION:Please shoot at dusk.'));
});

test('buildIcs: omits DESCRIPTION entirely when there are no notes (images do NOT go there)', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { images: [fakeImage('x.jpg')] }));
  assert.ok(!ics.includes('DESCRIPTION:'));
});

test('buildIcs: images are listed as links in DESCRIPTION after the notes, and there is NO ATTACH', () => {
  const img = linkedImage('lockbox.png');
  const unfolded = buildIcs(Object.assign({}, BASE_JOB, { notes: 'Gate code 1234', images: [img] })).replace(/\r\n[ \t]/g, '');
  assert.ok(!unfolded.includes('ATTACH'));
  const desc = unfolded.split('\r\n').find((l) => l.startsWith('DESCRIPTION:'));
  assert.ok(desc.includes('Gate code 1234'));
  assert.ok(desc.includes('Images:\\n1. lockbox.png\\n' + img.url));
  assert.ok(desc.indexOf('Gate code 1234') < desc.indexOf(img.url), 'notes come first');
});

test('buildIcs: images alone (no notes) still produce a DESCRIPTION with the links', () => {
  const img = linkedImage('a.jpg');
  const unfolded = buildIcs(Object.assign({}, BASE_JOB, { notes: '', images: [img] })).replace(/\r\n[ \t]/g, '');
  assert.ok(unfolded.includes('DESCRIPTION:') && unfolded.includes(img.url));
});

test('buildIcs: escapes commas, semicolons, and newlines in text fields', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { notes: 'Line one\nLine two; with, punctuation' }));
  assert.ok(ics.includes('Line one\\nLine two\\; with\\, punctuation'));
});

test('buildIcs: DTSTART is correct UTC regardless of the HOST machine\'s own timezone', () => {
  // Round-trip invariant, independent of America/Toronto specifically:
  // whatever timezone the computer running job-generator is set to, the
  // emitted UTC instant must convert BACK to the exact local wall-clock
  // time that was typed. This is what actually matters (a shoot entered
  // as "14:30" must display as 2:30 PM wherever it's viewed) -- proving
  // it for a second, very different zone guards against ever
  // reintroducing an offset bug that only some timezones would expose.
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai'; // UTC+8, no DST -- deliberately unlike Toronto
    const ics = buildIcs(BASE_JOB); // shootDate 2026/09/10, shootTime 14:30
    const m = ics.match(/DTSTART:(\d{8})T(\d{6})Z/);
    assert.ok(m, 'DTSTART not found');
    const utc = new Date(Date.UTC(
      Number(m[1].slice(0, 4)), Number(m[1].slice(4, 6)) - 1, Number(m[1].slice(6, 8)),
      Number(m[2].slice(0, 2)), Number(m[2].slice(2, 4)), Number(m[2].slice(4, 6))
    ));
    // Converted back to Shanghai local time, must read 2026/09/10 14:30 again.
    assert.strictEqual(utc.getFullYear() + '/' + String(utc.getMonth() + 1).padStart(2, '0') + '/' + String(utc.getDate()).padStart(2, '0'), '2026/09/10');
    assert.strictEqual(utc.getHours() + ':' + String(utc.getMinutes()).padStart(2, '0'), '14:30');
  } finally {
    process.env.TZ = saved;
  }
});

test('buildIcs: produces a well-formed VCALENDAR/VEVENT wrapper', () => {
  const ics = buildIcs(BASE_JOB);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trim().endsWith('END:VCALENDAR'));
  assert.ok(ics.includes('BEGIN:VEVENT'));
  assert.ok(ics.includes('END:VEVENT'));
  assert.ok(ics.includes('UID:' + BASE_JOB.jobId + '@franvision.local'));
});

// ---- writeCalendarFile ----

test('writeCalendarFile: returns null and writes nothing when Shoot Time is blank', () => {
  const dir = makeTmpDir();
  try {
    const result = writeCalendarFile(dir, Object.assign({}, BASE_JOB, { shootTime: '' }));
    assert.strictEqual(result, null);
    assert.ok(!fs.existsSync(path.join(dir, ICS_FILENAME)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: writes Shoot Schedule.ics at the job-folder root (no Shoot Info folder)', () => {
  const dir = makeTmpDir();
  try {
    const result = writeCalendarFile(dir, BASE_JOB);
    assert.strictEqual(result.icsFilename, ICS_FILENAME);
    assert.ok(fs.existsSync(path.join(dir, ICS_FILENAME)));
    assert.ok(!fs.existsSync(path.join(dir, LEGACY_FOLDER_NAME)));
    assert.ok(fs.readFileSync(path.join(dir, ICS_FILENAME), 'utf8').includes('SUMMARY:P_Jane Doe_？'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: throws on an invalid Shoot Time format', () => {
  const dir = makeTmpDir();
  try {
    assert.throws(() => writeCalendarFile(dir, Object.assign({}, BASE_JOB, { shootTime: '2:30pm' })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: throws (does not write a corrupt .ics) when Shoot Date is blank but Shoot Time is set', () => {
  const dir = makeTmpDir();
  try {
    assert.throws(() => writeCalendarFile(dir, Object.assign({}, BASE_JOB, { shootDate: '' })));
    assert.ok(!fs.existsSync(path.join(dir, ICS_FILENAME)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: throws when Shoot Date is malformed but Shoot Time is set', () => {
  const dir = makeTmpDir();
  try {
    assert.throws(() => writeCalendarFile(dir, Object.assign({}, BASE_JOB, { shootDate: '2026-09-20' })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: writes image links (no loose files), reports sanitized filenames', () => {
  const dir = makeTmpDir();
  try {
    const a = linkedImage('front yard.jpg', 1), b = linkedImage('kitchen.png', 2);
    const result = writeCalendarFile(dir, Object.assign({}, BASE_JOB, { images: [a, b] }));
    assert.deepStrictEqual(result.attachedImages.slice().sort(), ['front yard.jpg', 'kitchen.png']);
    assert.deepStrictEqual(fs.readdirSync(dir), [ICS_FILENAME]);
    const ics = fs.readFileSync(path.join(dir, ICS_FILENAME), 'utf8').replace(/\r\n[ \t]/g, '');
    assert.ok(ics.includes(a.url) && ics.includes(b.url));
    assert.ok(!ics.includes('ATTACH'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: de-dupes two images with the same filename', () => {
  const dir = makeTmpDir();
  try {
    const result = writeCalendarFile(dir, Object.assign({}, BASE_JOB, { images: [linkedImage('ref.jpg', 1), linkedImage('ref.jpg', 2)] }));
    assert.strictEqual(result.attachedImages.length, 2);
    assert.notStrictEqual(result.attachedImages[0], result.attachedImages[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: refuses an image that has not been uploaded (no url) rather than dropping it silently', () => {
  const dir = makeTmpDir();
  try {
    assert.throws(() => writeCalendarFile(dir, Object.assign({}, BASE_JOB, { images: [fakeImage('raw.jpg', 5)] })), /not been uploaded/);
    assert.ok(!fs.existsSync(path.join(dir, ICS_FILENAME)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateImages: an already-uploaded (url) image needs no size check', () => {
  assert.deepStrictEqual(validateImages([linkedImage('a.jpg')]), []);
});

test('writeCalendarFile: throws (does not partially write) on an invalid image', () => {
  const dir = makeTmpDir();
  try {
    assert.throws(() => writeCalendarFile(dir, Object.assign({}, BASE_JOB, { images: [fakeImage('bad.exe', 10)] })));
    assert.ok(!fs.existsSync(path.join(dir, ICS_FILENAME)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: cleans up a legacy Shoot Info folder when it runs', () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, LEGACY_FOLDER_NAME));
    fs.writeFileSync(path.join(dir, LEGACY_FOLDER_NAME, 'old.jpg'), 'old');
    writeCalendarFile(dir, BASE_JOB);
    assert.ok(!fs.existsSync(path.join(dir, LEGACY_FOLDER_NAME)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: works with no notes and no images', () => {
  const dir = makeTmpDir();
  try {
    const result = writeCalendarFile(dir, BASE_JOB);
    assert.strictEqual(result.attachedImages.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- readExistingImages ----

test('readExistingImages: [] when there is no calendar file', () => {
  const dir = makeTmpDir();
  try {
    assert.deepStrictEqual(readExistingImages(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readExistingImages: still parses OLD base64 ATTACH images out of an existing .ics', () => {
  const dir = makeTmpDir();
  try {
    writeLegacyAttachIcs(path.join(dir, ICS_FILENAME), [fakeImage('lockbox.jpg', 12), fakeImage('gate.png', 8)]);
    const back = readExistingImages(dir).sort((a, b) => a.filename.localeCompare(b.filename));
    assert.deepStrictEqual(back.map((i) => i.filename), ['gate.png', 'lockbox.jpg']);
    back.forEach((i) => assert.ok(typeof i.dataBase64 === 'string' && i.dataBase64.length > 0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readExistingImages: still reads a legacy Shoot Info folder, merged with any .ics attachments', () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, LEGACY_FOLDER_NAME));
    fs.writeFileSync(path.join(dir, LEGACY_FOLDER_NAME, 'legacy.jpg'), Buffer.from('legacy bytes'));
    const back = readExistingImages(dir);
    assert.deepStrictEqual(back.map((i) => i.filename), ['legacy.jpg']);
    assert.ok(Buffer.from(back[0].dataBase64, 'base64').equals(Buffer.from('legacy bytes')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- mergeImages ----

test('mergeImages: keeps preserved images and appends fresh ones', () => {
  const merged = mergeImages([fakeImage('a.jpg')], [fakeImage('b.jpg')]);
  assert.deepStrictEqual(merged.map((i) => i.filename), ['a.jpg', 'b.jpg']);
});

test('mergeImages: a fresh upload with the same filename replaces the preserved one (case-insensitive)', () => {
  const merged = mergeImages([{ filename: 'Ref.JPG', dataBase64: 'OLD' }], [{ filename: 'ref.jpg', dataBase64: 'NEW' }]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].dataBase64, 'NEW');
});

test('mergeImages: tolerates null/undefined on either side', () => {
  assert.deepStrictEqual(mergeImages(null, [fakeImage('x.jpg')]).map((i) => i.filename), ['x.jpg']);
  assert.deepStrictEqual(mergeImages([fakeImage('y.jpg')], null).map((i) => i.filename), ['y.jpg']);
  assert.deepStrictEqual(mergeImages(null, null), []);
});

// ---- draft calendar file (Save as Draft, 2026-09-19) ----

const cal = require('./calendar-file.js');

test('shortAddress: house number + street NAME only (street type and trailing direction dropped, city dropped)', () => {
  assert.strictEqual(cal.shortAddress('12 Cozens Dr, Markham'), '12 Cozens');
  assert.strictEqual(cal.shortAddress('394 Centre St E, Richmond Hill'), '394 Centre');
  assert.strictEqual(cal.shortAddress('4633 Glen Erin Dr, Mississauga'), '4633 Glen Erin');
  assert.strictEqual(cal.shortAddress('5 Lake Shore Blvd W'), '5 Lake Shore');
});

test('shortAddress: never strips the last remaining word; blank stays blank', () => {
  assert.strictEqual(cal.shortAddress('12 Park St'), '12 Park');
  assert.strictEqual(cal.shortAddress('Main'), 'Main');
  assert.strictEqual(cal.shortAddress(''), '');
  assert.strictEqual(cal.shortAddress(undefined), '');
});

test('buildDraftCalendarFilename: <event title> <date, no leading zeros> <short address>.ics', () => {
  const name = cal.buildDraftCalendarFilename({
    order: { photography: 'standard', addons: {} }, clientName: 'Jane', photographerName: 'Franky',
    shootDate: '2026/09/25', address: '12 Cozens Dr, Markham',
  });
  assert.ok(/^.+_Jane_.+ 2026\.9\.25 12 Cozens\.ics$/.test(name), name);
});

test('buildDraftCalendarFilename: same client/package on another date or address gets a different name', () => {
  const base = { order: { photography: 'standard', addons: {} }, clientName: 'Jane', photographerName: 'Franky', shootDate: '2026/09/25', address: '12 Cozens Dr' };
  const a = cal.buildDraftCalendarFilename(base);
  assert.notStrictEqual(a, cal.buildDraftCalendarFilename({ ...base, shootDate: '2026/09/26' }));
  assert.notStrictEqual(a, cal.buildDraftCalendarFilename({ ...base, address: '14 Cozens Dr' }));
});

test('buildDraftCalendarFilename: characters illegal in a filename are sanitized', () => {
  const name = cal.buildDraftCalendarFilename({ order: {}, clientName: 'A/B: C', photographerName: '', shootDate: '2026/09/25', address: '1 X St' });
  assert.ok(!/[\\/:*?"<>|]/.test(name.replace('？', '')), name);
});

test('writeCalendarFile: writeOpts.filename writes that name (not Shoot Schedule.ics) and reports it', () => {
  const dir = makeTmpDir();
  try {
    const r = cal.writeCalendarFile(dir, { jobId: 'draft-abc', clientName: 'J', address: '1 X', shootDate: '2026/09/25', shootTime: '10:00', notes: '', images: [], order: {} }, { filename: 'My Draft.ics' });
    assert.strictEqual(r.icsFilename, 'My Draft.ics');
    assert.ok(fs.existsSync(path.join(dir, 'My Draft.ics')));
    assert.ok(!fs.existsSync(path.join(dir, 'Shoot Schedule.ics')));
    assert.ok(fs.readFileSync(path.join(dir, 'My Draft.ics'), 'utf8').includes('UID:draft-abc@franvision.local'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readImagesFromIcsFile: reads the (old) ATTACH images of one named .ics file; [] when it does not exist', () => {
  const dir = makeTmpDir();
  try {
    writeLegacyAttachIcs(path.join(dir, 'D.ics'), [fakeImage('gate.jpg')]);
    assert.deepStrictEqual(cal.readImagesFromIcsFile(path.join(dir, 'D.ics')).map((i) => i.filename), ['gate.jpg']);
    assert.deepStrictEqual(cal.readImagesFromIcsFile(path.join(dir, 'nope.ics')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
