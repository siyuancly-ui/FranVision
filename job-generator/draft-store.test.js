// Run with: node draft-store.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner. Always
// passes an explicit tmp `draftsDir` -- never touches the real
// job-generator/drafts/ folder.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const draftStore = require('./draft-store.js');
const { isValidDraftId, listDrafts, getDraft, saveDraft, deleteDraft } = draftStore;

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

function makeTmpDraftsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fv-drafts-test-'));
}

function fakeImage(filename, sizeBytes) {
  return { filename, dataBase64: Buffer.alloc(sizeBytes || 10).toString('base64') };
}

// ---- isValidDraftId ----

test('isValidDraftId: accepts a real crypto.randomUUID() shape', () => {
  assert.strictEqual(isValidDraftId('a1b2c3d4-0000-4000-8000-abcdefabcdef'), true);
});

test('isValidDraftId: rejects path-traversal-shaped input', () => {
  assert.strictEqual(isValidDraftId('../../etc'), false);
  assert.strictEqual(isValidDraftId(''), false);
  assert.strictEqual(isValidDraftId(null), false);
  assert.strictEqual(isValidDraftId(undefined), false);
});

// ---- saveDraft / getDraft ----

test('saveDraft: creates a new draft with a fresh id when none is given', () => {
  const dir = makeTmpDraftsDir();
  try {
    const result = saveDraft(null, { clientName: 'Jane Doe', address: '1 Main St' }, dir);
    assert.ok(isValidDraftId(result.draftId));
    assert.strictEqual(result.record.clientName, 'Jane Doe');
    assert.ok(fs.existsSync(path.join(dir, result.draftId, 'draft.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: does NOT require a valid (or any) Shoot Date -- unlike a real job', () => {
  const dir = makeTmpDraftsDir();
  try {
    const result = saveDraft(null, { clientName: 'Jane Doe', shootDate: '' }, dir);
    assert.strictEqual(result.record.shootDate, '');
    const reloaded = getDraft(result.draftId, dir);
    assert.strictEqual(reloaded.shootDate, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: throws (does not write a corrupt calendar file) when Shoot Time is set but Shoot Date is still blank', () => {
  const dir = makeTmpDraftsDir();
  try {
    assert.throws(() => saveDraft(null, { clientName: 'Jane Doe', shootDate: '', shootTime: '14:00' }, dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: updates an existing draft in place when its draftId is passed', () => {
  const dir = makeTmpDraftsDir();
  try {
    const first = saveDraft(null, { clientName: 'Jane Doe' }, dir);
    const second = saveDraft(first.draftId, { clientName: 'Jane Doe (renamed)' }, dir);
    assert.strictEqual(second.draftId, first.draftId);
    assert.strictEqual(getDraft(first.draftId, dir).clientName, 'Jane Doe (renamed)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: preserves createdAt across updates but always bumps updatedAt', () => {
  const dir = makeTmpDraftsDir();
  try {
    const first = saveDraft(null, { clientName: 'Jane Doe' }, dir);
    const firstCreatedAt = first.record.createdAt;
    // Re-send createdAt like the real client would (it always sends the
    // full current state back, including whatever createdAt it was given).
    const second = saveDraft(first.draftId, { clientName: 'Jane Doe', createdAt: firstCreatedAt }, dir);
    assert.strictEqual(second.record.updatedAt >= first.record.updatedAt, true);
    const reloaded = getDraft(first.draftId, dir);
    assert.strictEqual(reloaded.createdAt, firstCreatedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: with no Shoot Time, no calendar file is written', () => {
  const dir = makeTmpDraftsDir();
  try {
    const result = saveDraft(null, { clientName: 'Jane Doe' }, dir);
    assert.strictEqual(result.calendarResult, null);
    assert.ok(!fs.existsSync(path.join(dir, result.draftId, 'Shoot Schedule.ics')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: with a Shoot Time, writes Shoot Schedule.ics (at the draft root) reusing calendar-file.js', () => {
  const dir = makeTmpDraftsDir();
  try {
    const result = saveDraft(null, { clientName: 'Jane Doe', address: '1 Main St', shootDate: '2026/09/20', shootTime: '10:00' }, dir);
    assert.ok(result.calendarResult);
    assert.ok(fs.existsSync(path.join(dir, result.draftId, 'Shoot Schedule.ics')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: images round-trip through getDraft as base64', () => {
  const dir = makeTmpDraftsDir();
  try {
    const original = Buffer.from('lockbox code: 4821');
    const result = saveDraft(null, {
      clientName: 'Jane Doe', shootDate: '2026/09/20', shootTime: '10:00',
      images: [{ filename: 'lockbox.jpg', dataBase64: original.toString('base64') }],
    }, dir);
    const reloaded = getDraft(result.draftId, dir);
    assert.strictEqual(reloaded.images.length, 1);
    assert.strictEqual(reloaded.images[0].filename, 'lockbox.jpg');
    assert.ok(Buffer.from(reloaded.images[0].dataBase64, 'base64').equals(original));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: re-saving with Shoot Time removed deletes the stale calendar file', () => {
  const dir = makeTmpDraftsDir();
  try {
    const first = saveDraft(null, { clientName: 'Jane Doe', shootDate: '2026/09/20', shootTime: '10:00' }, dir);
    assert.ok(fs.existsSync(path.join(dir, first.draftId, 'Shoot Schedule.ics')));
    saveDraft(first.draftId, { clientName: 'Jane Doe', shootDate: '2026/09/20', shootTime: '' }, dir);
    assert.ok(!fs.existsSync(path.join(dir, first.draftId, 'Shoot Schedule.ics')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: re-saving without a previously-attached image drops it (full-state, not additive)', () => {
  const dir = makeTmpDraftsDir();
  try {
    const first = saveDraft(null, {
      clientName: 'Jane Doe', shootDate: '2026/09/20', shootTime: '10:00',
      images: [fakeImage('a.jpg'), fakeImage('b.jpg')],
    }, dir);
    saveDraft(first.draftId, {
      clientName: 'Jane Doe', shootDate: '2026/09/20', shootTime: '10:00',
      images: [fakeImage('a.jpg')],
    }, dir);
    const reloaded = getDraft(first.draftId, dir);
    assert.deepStrictEqual(reloaded.images.map((i) => i.filename), ['a.jpg']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft: preserves commission overrides (checkedItemIds/travelCents) and chosenCandidateIndex', () => {
  const dir = makeTmpDraftsDir();
  try {
    const result = saveDraft(null, {
      clientName: 'Jane Doe',
      chosenCandidateIndex: 1,
      commission: { checkedItemIds: ['photography', 'drone'], travelCents: 2500 },
    }, dir);
    const reloaded = getDraft(result.draftId, dir);
    assert.strictEqual(reloaded.chosenCandidateIndex, 1);
    assert.deepStrictEqual(reloaded.commission, { checkedItemIds: ['photography', 'drone'], travelCents: 2500 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- getDraft ----

test('getDraft: returns null for a missing/unknown draftId', () => {
  const dir = makeTmpDraftsDir();
  try {
    assert.strictEqual(getDraft('a1b2c3d4-0000-4000-8000-abcdefabcdef', dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDraft: returns null for an invalid draftId rather than throwing', () => {
  assert.strictEqual(getDraft('../../etc/passwd', makeTmpDraftsDir()), null);
});

// ---- listDrafts ----

test('listDrafts: empty array when the drafts dir does not exist yet', () => {
  assert.deepStrictEqual(listDrafts(path.join(os.tmpdir(), 'fv-drafts-never-created')), []);
});

test('listDrafts: lists saved drafts, most-recently-updated first', () => {
  const dir = makeTmpDraftsDir();
  try {
    const a = saveDraft(null, { clientName: 'A' }, dir);
    // Force a distinguishable updatedAt ordering.
    const aData = JSON.parse(fs.readFileSync(path.join(dir, a.draftId, 'draft.json'), 'utf8'));
    aData.updatedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(path.join(dir, a.draftId, 'draft.json'), JSON.stringify(aData));
    const b = saveDraft(null, { clientName: 'B' }, dir);

    const list = listDrafts(dir);
    assert.deepStrictEqual(list.map((d) => d.clientName), ['B', 'A']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listDrafts: hasCalendar reflects whether Shoot Time is set', () => {
  const dir = makeTmpDraftsDir();
  try {
    const withTime = saveDraft(null, { clientName: 'A', shootDate: '2026/09/20', shootTime: '10:00' }, dir);
    const withoutTime = saveDraft(null, { clientName: 'B' }, dir);
    const list = listDrafts(dir);
    assert.strictEqual(list.find((d) => d.draftId === withTime.draftId).hasCalendar, true);
    assert.strictEqual(list.find((d) => d.draftId === withoutTime.draftId).hasCalendar, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listDrafts: skips a corrupted draft.json instead of throwing', () => {
  const dir = makeTmpDraftsDir();
  try {
    const good = saveDraft(null, { clientName: 'Good' }, dir);
    fs.mkdirSync(path.join(dir, 'a1b2c3d4-0000-4000-8000-abcdefabcdef'));
    fs.writeFileSync(path.join(dir, 'a1b2c3d4-0000-4000-8000-abcdefabcdef', 'draft.json'), 'not json');
    const list = listDrafts(dir);
    assert.deepStrictEqual(list.map((d) => d.draftId), [good.draftId]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- deleteDraft ----

test('deleteDraft: removes the draft folder entirely', () => {
  const dir = makeTmpDraftsDir();
  try {
    const result = saveDraft(null, { clientName: 'Jane Doe' }, dir);
    assert.strictEqual(deleteDraft(result.draftId, dir), true);
    assert.ok(!fs.existsSync(path.join(dir, result.draftId)));
    assert.strictEqual(getDraft(result.draftId, dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteDraft: a second delete (or an unknown id) does not throw', () => {
  const dir = makeTmpDraftsDir();
  try {
    const result = saveDraft(null, { clientName: 'Jane Doe' }, dir);
    deleteDraft(result.draftId, dir);
    assert.doesNotThrow(() => deleteDraft(result.draftId, dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteDraft: rejects an invalid draftId without touching the filesystem', () => {
  assert.strictEqual(deleteDraft('../../etc', makeTmpDraftsDir()), false);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
