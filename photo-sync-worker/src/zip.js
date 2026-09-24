// Minimal streaming ZIP writer (store method, no compression) for POST /zip.
//
// JPEGs don't compress, so "stored" costs nothing in size and keeps CPU down;
// the only per-byte work is the CRC-32 the format requires. Entries are
// written with a data descriptor (flag bit 3) so each file can be streamed
// straight from Dropbox without knowing its CRC/size up front -- the real
// values go in the descriptor after the bytes and again in the central
// directory at the end. No ZIP64: callers must stay under 4 GB total and
// 65535 entries (a Job's photo set is nowhere near either).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// Running CRC-32: start with crc32Update(0, bytes), keep feeding the result back.
export function crc32Update(crc, bytes) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// MS-DOS date/time, as ZIP wants (UTC so output is deterministic).
function dosDateTime(d) {
  const year = Math.max(1980, d.getUTCFullYear());
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

const FLAGS = 0x0808; // bit 3: data descriptor follows; bit 11: UTF-8 names
const enc = new TextEncoder();

// Filenames that collide inside one zip get " (2)", " (3)" ... before the extension.
export function dedupeNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const key = name.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  });
}

// Strips path separators/control chars so an entry can never escape the extraction folder.
export function safeEntryName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
  return base || 'file';
}

// Writes a whole zip to `writer` (a WritableStreamDefaultWriter or anything with
// async write(Uint8Array)/close()). `entries` = [{ name, open }] where
// open() -> Promise<ReadableStream<Uint8Array>>. An entry that can't be opened
// THROWS out of writeZip (never silently skipped -- a zip quietly missing photos
// is worse than a failed download; the caller aborts the stream).
// Returns { written }.
export async function writeZip(writer, entries, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const central = [];
  let offset = 0;
  const put = async (bytes) => { await writer.write(bytes); offset += bytes.length; };

  for (const entry of entries) {
    const stream = await entry.open();
    if (!stream) throw new Error(`could not open ${entry.name}`);

    const name = enc.encode(entry.name);
    const localOffset = offset;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, FLAGS, true);
    head.setUint16(8, 0, true); // stored
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    // crc, sizes = 0 (in the descriptor)
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    await put(new Uint8Array(head.buffer));
    await put(name);

    let crc = 0;
    let size = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32Update(crc, value);
      size += value.length;
      await put(value);
    }
    if (size >= 0xffffffff || offset >= 0xffffffff) throw new Error('zip too large (no ZIP64 support)');

    const desc = new DataView(new ArrayBuffer(16));
    desc.setUint32(0, 0x08074b50, true);
    desc.setUint32(4, crc, true);
    desc.setUint32(8, size, true);
    desc.setUint32(12, size, true);
    await put(new Uint8Array(desc.buffer));

    central.push({ name, crc, size, localOffset });
  }

  const cdStart = offset;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 20, true);
    h.setUint16(8, FLAGS, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, time, true);
    h.setUint16(14, date, true);
    h.setUint32(16, c.crc, true);
    h.setUint32(20, c.size, true);
    h.setUint32(24, c.size, true);
    h.setUint16(28, c.name.length, true);
    h.setUint32(42, c.localOffset, true);
    await put(new Uint8Array(h.buffer));
    await put(c.name);
  }
  const cdSize = offset - cdStart;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, cdStart, true);
  await put(new Uint8Array(end.buffer));
  await writer.close();
  return { written: central.length };
}
