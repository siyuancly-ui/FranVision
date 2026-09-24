#!/usr/bin/env node
// One-time (re-runnable) upload of the Wave product-id map into the shared job server (jg_wave_map).
//   node scripts/import-wave-map.js <path-to-map.json>
// The JSON is a flat { "<pricing-config id>": "<Wave product id>" } object -- e.g. the output of
// wave-probe/setup-real-products.js (wave-probe/out/real-product-map.json), or the old
// wave-product-map.json. Keys starting with "_" (like "_comment") are skipped. Keys not in the file are
// left alone on the server; the resulting full map is printed. Needs JG_SUPABASE_URL / JG_SUPABASE_ANON_KEY /
// JG_TOKEN in job-generator/.env, and supabase/schema.sql's jg_wave_map section applied.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const jobBackend = require('../job-backend.js');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/import-wave-map.js <map.json>'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (typeof v !== 'string' || !v.trim()) { console.error('bad/empty product id for key ' + k); process.exit(1); }
    map[k] = v.trim();
  }
  if (!Object.keys(map).length) { console.error('no entries in ' + file); process.exit(1); }
  const result = await jobBackend.setWaveMap(map);
  console.log('Server map now has ' + Object.keys(result).length + ' entries:');
  for (const k of Object.keys(result).sort()) console.log('  ' + k + ' -> ' + result[k]);
})().catch((err) => { console.error(err && err.message || err); process.exit(1); });
