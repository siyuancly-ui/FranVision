// Run with: node calendar-file.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  validateImages, writeCalendarFile, buildIcs, readExistingImages, mergeImages,
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

test('buildIcs: DTSTART/DTEND reflect the shoot date+time and default 2h duration', () => {
  const ics = buildIcs(BASE_JOB);
  assert.ok(ics.includes('DTSTART:20260910T143000'));
  assert.ok(ics.includes('DTEND:20260910T163000')); // +2h default
});

test('buildIcs: DTEND respects a custom durationMinutes', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { durationMinutes: 30 }));
  assert.ok(ics.includes('DTSTART:20260910T143000'));
  assert.ok(ics.includes('DTEND:20260910T150000'));
});

test('buildIcs: DTEND rolls over midnight correctly', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { shootTime: '23:15' }));
  assert.ok(ics.includes('DTSTART:20260910T231500'));
  assert.ok(ics.includes('DTEND:20260911T011500'));
});

test('buildIcs: includes client name in SUMMARY and address in LOCATION', () => {
  const ics = buildIcs(BASE_JOB);
  assert.ok(ics.includes('SUMMARY:Photo Shoot -- Jane Doe'));
  assert.ok(ics.includes('LOCATION:123 Main St'));
});

test('buildIcs: includes notes text in DESCRIPTION', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { notes: 'Please shoot at dusk.' }));
  assert.ok(ics.includes('DESCRIPTION:Please shoot at dusk.'));
});

test('buildIcs: omits DESCRIPTION entirely when there are no notes (images do NOT go there)', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { images: [fakeImage('x.jpg')] }));
  assert.ok(!ics.includes('DESCRIPTION:'));
});

test('buildIcs: embeds each image as a base64 ATTACH with FMTTYPE + filename params', () => {
  const png = Buffer.from('fake png bytes').toString('base64');
  const unfolded = buildIcs(Object.assign({}, BASE_JOB, {
    images: [{ filename: 'lockbox.png', dataBase64: png }],
  })).replace(/\r\n[ \t]/g, '');
  assert.ok(unfolded.includes('ATTACH;FMTTYPE=image/png;ENCODING=BASE64;VALUE=BINARY;X-APPLE-FILENAME="lockbox.png";X-FILENAME="lockbox.png":' + png));
});

test('buildIcs: escapes commas, semicolons, and newlines in text fields', () => {
  const ics = buildIcs(Object.assign({}, BASE_JOB, { notes: 'Line one\nLine two; with, punctuation' }));
  assert.ok(ics.includes('Line one\\nLine two\\; with\\, punctuation'));
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
    assert.ok(fs.readFileSync(path.join(dir, ICS_FILENAME), 'utf8').includes('SUMMARY:Photo Shoot -- Jane Doe'));
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

test('writeCalendarFile: embeds images (no loose files), reports sanitized filenames', () => {
  const dir = makeTmpDir();
  try {
    const result = writeCalendarFile(dir, Object.assign({}, BASE_JOB, { images: [fakeImage('front yard.jpg', 20), fakeImage('kitchen.png', 20)] }));
    assert.deepStrictEqual(result.attachedImages.slice().sort(), ['front yard.jpg', 'kitchen.png']);
    // No loose image files anywhere.
    assert.deepStrictEqual(fs.readdirSync(dir), [ICS_FILENAME]);
    const ics = fs.readFileSync(path.join(dir, ICS_FILENAME), 'utf8').replace(/\r\n[ \t]/g, '');
    assert.ok(ics.includes('X-APPLE-FILENAME="front yard.jpg"'));
    assert.ok(ics.includes('X-APPLE-FILENAME="kitchen.png"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: de-dupes two images with the same filename', () => {
  const dir = makeTmpDir();
  try {
    const result = writeCalendarFile(dir, Object.assign({}, BASE_JOB, { images: [fakeImage('ref.jpg', 5), fakeImage('ref.jpg', 7)] }));
    assert.strictEqual(result.attachedImages.length, 2);
    assert.notStrictEqual(result.attachedImages[0], result.attachedImages[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCalendarFile: image bytes round-trip exactly through the ATTACH base64', () => {
  const dir = makeTmpDir();
  try {
    const original = Buffer.from('not really a jpg but bytes are bytes');
    writeCalendarFile(dir, Object.assign({}, BASE_JOB, { images: [{ filename: 'x.jpg', dataBase64: original.toString('base64') }] }));
    const back = readExistingImages(dir);
    assert.strictEqual(back.length, 1);
    assert.ok(Buffer.from(back[0].dataBase64, 'base64').equals(original));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('readExistingImages: parses embedded ATTACH images back out of the .ics', () => {
  const dir = makeTmpDir();
  try {
    writeCalendarFile(dir, Object.assign({}, BASE_JOB, { images: [fakeImage('lockbox.jpg', 12), fakeImage('gate.png', 8)] }));
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
