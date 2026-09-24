import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32Update, writeZip, dedupeNames, safeEntryName } from '../src/zip.js';

const enc = new TextEncoder();
const stream = (...chunks) => new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });

async function build(entries) {
  const parts = [];
  const writer = { async write(b) { parts.push(b); }, async close() {} };
  const res = await writeZip(writer, entries, new Date(Date.UTC(2026, 8, 24, 12, 0, 0)));
  const buf = Buffer.concat(parts);
  return { buf, res };
}

// Tiny central-directory reader -- what unzip/Explorer/Finder actually use.
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, crc, data: buf.subarray(start, start + size) });
    p += 46 + nameLen;
  }
  return out;
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32Update(0, enc.encode('123456789')), 0xcbf43926);
  const a = crc32Update(0, enc.encode('12345'));
  assert.equal(crc32Update(a, enc.encode('6789')), 0xcbf43926);
});

test('zip round-trips multi-chunk entries with correct CRCs', async () => {
  const { buf, res } = await build([
    { name: 'a.jpg', open: async () => stream(enc.encode('hello '), enc.encode('world')) },
    { name: 'ü b.jpg', open: async () => stream(new Uint8Array([0, 1, 2, 255])) },
  ]);
  assert.deepEqual(res, { written: 2 });
  const files = readZip(buf);
  assert.equal(files[0].name, 'a.jpg');
  assert.equal(files[0].data.toString(), 'hello world');
  assert.equal(files[0].crc, crc32Update(0, enc.encode('hello world')));
  assert.equal(files[1].name, 'ü b.jpg');
  assert.deepEqual([...files[1].data], [0, 1, 2, 255]);
});

test('an entry that cannot be opened aborts the zip (never a silently smaller archive)', async () => {
  await assert.rejects(build([
    { name: 'ok.jpg', open: async () => stream(enc.encode('x')) },
    { name: 'bad.jpg', open: async () => { throw new Error('nope'); } },
  ]), /nope/);
  await assert.rejects(build([{ name: 'null.jpg', open: async () => null }]), /could not open null\.jpg/);
});

test('empty zip is a valid bare end-of-central-directory record', async () => {
  const { buf } = await build([]);
  assert.equal(buf.length, 22);
  assert.equal(readZip(buf).length, 0);
});

test('dedupeNames / safeEntryName', () => {
  assert.deepEqual(dedupeNames(['a.jpg', 'A.jpg', 'b.jpg', 'a.jpg']), ['a.jpg', 'A (2).jpg', 'b.jpg', 'a (3).jpg']);
  assert.equal(safeEntryName('../../etc/passwd'), 'passwd');
  assert.equal(safeEntryName('C:\\x\\y.jpg'), 'y.jpg');
  assert.equal(safeEntryName(''), 'file');
});
