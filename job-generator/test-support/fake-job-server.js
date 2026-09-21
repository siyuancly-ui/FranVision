// Dev-only stand-in for the Supabase RPCs in supabase/schema.sql (same
// rules: write-once job_id, atomic per-day counter, rename-in-place,
// drafts-only delete, token check) so server.js can be exercised end to
// end -- including "two machines" via two different rootFolder values --
// without a real Supabase project. Not used by the unit tests.
//   node test-support/fake-job-server.js   # listens on :4999, token "tok"
//   JG_SUPABASE_URL=http://localhost:4999 JG_SUPABASE_ANON_KEY=anon JG_TOKEN=tok node server.js
const http = require('http');
const rows = new Map();
const counters = {};
const TOKEN = 'tok';
const call = {
  jg_peek_job_id: (a) => 'FVS-' + a.p_day + '-' + String(Math.max(counters[a.p_day] || 0, a.p_floor || 0) + 1).padStart(3, '0'),
  jg_allocate_job_id: (a) => { counters[a.p_day] = Math.max(counters[a.p_day] || 0, a.p_floor || 0) + 1; return 'FVS-' + a.p_day + '-' + String(counters[a.p_day]).padStart(3, '0'); },
  jg_upsert_job: (a) => {
    const r = a.p_row;
    if (r.previous_folder_name && r.previous_folder_name !== r.folder_name) {
      if (rows.has(r.folder_name)) throw new Error('jg: folder_exists');
      const o = rows.get(r.previous_folder_name);
      if (o) { rows.delete(r.previous_folder_name); o.folder_name = r.folder_name; rows.set(r.folder_name, o); }
    }
    const ex = rows.get(r.folder_name);
    const row = {
      id: ex ? ex.id : Math.random().toString(16).slice(2), folder_name: r.folder_name,
      job_id: (ex && ex.job_id) || r.job_id || null, client_name: r.client_name, address: r.address, shoot_date: r.shoot_date,
      data: r.data, created_at: ex ? ex.created_at : (r.created_at || new Date().toISOString()), updated_at: new Date().toISOString(),
    };
    rows.set(r.folder_name, row);
    return row;
  },
  jg_get_job: (a) => rows.get(a.p_folder_name) || null,
  jg_list_jobs: (a) => [...rows.values()].filter((j) => a.p_kind === 'drafts' ? !j.job_id : (j.job_id && j.created_at >= (a.p_since || ''))).sort((x, y) => y.updated_at.localeCompare(x.updated_at)),
  jg_delete_draft: (a) => {
    const j = rows.get(a.p_folder_name);
    if (!j) return { deleted: false, reason: 'not_found' };
    if (j.job_id) return { deleted: false, reason: 'real_job', job_id: j.job_id };
    rows.delete(a.p_folder_name);
    return { deleted: true };
  },
};
const objects = new Map(); // storage stand-in for supabase/storage.sql's bucket
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => { chunks.push(c); });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const PUB = '/storage/v1/object/public/jg-shoot-notes/', UP = '/storage/v1/object/jg-shoot-notes/';
    if (req.method === 'GET' && req.url.startsWith(PUB)) {
      const o = objects.get(req.url.slice(PUB.length));
      if (!o) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': o.type }); return res.end(o.buf);
    }
    if (req.method === 'POST' && req.url.startsWith(UP)) {
      const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers['x-jg-token'] !== TOKEN) return send(403, { message: 'new row violates row-level security policy' });
      const p = req.url.slice(UP.length);
      if (objects.has(p)) return send(409, { message: 'The resource already exists' });
      objects.set(p, { buf, type: req.headers['content-type'] });
      return send(200, { Key: 'jg-shoot-notes/' + p });
    }
    const name = req.url.split('/').pop();
    const a = JSON.parse(buf.toString('utf8') || '{}');
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (a.p_token !== TOKEN) return send(400, { message: 'jg: invalid token' });
    try { send(200, call[name](a)); } catch (e) { send(400, { message: e.message }); }
  });
}).listen(4999, () => console.log('fake job server on :4999'));
