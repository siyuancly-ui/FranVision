// Admin directory -- GET /admin?admin=<ADMIN_TOKEN>, same query-param-token
// shape as Feature Sheet Builder's own admin page (admin.js there: "Reached
// at ?admin=<ADMIN_TOKEN>... shared secret checked server-side, NOT stored
// in the DB"). Read-only: a delivery page exists because a Job exists, it
// isn't something to create/duplicate/delete from here the way a Feature
// Sheet is -- so unlike FSB's admin, there is no recycle bin, no row
// actions beyond "open the page". Pure logic (buildAdminModel/
// renderAdminPage), same split as render.js, so this is unit-tested without
// touching Supabase.

import { escapeHtml } from './render.js';

// Every projects row this system might have (shared with Feature Sheet
// Builder -- see supabase.js#listProjects) -> the rows this directory shows.
// A Job's presence here doesn't imply it has photos/a tour link/anything
// specific, same as FSB's own admin list isn't filtered to "real feature
// sheets" either.
export function buildAdminModel(rows) {
  const jobs = (rows || []).map((row) => {
    const data = (row && row.data) || {};
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const videos = Array.isArray(data.videos) ? data.videos : [];
    return {
      jobId: row.id,
      address: (typeof data.address === 'string' && data.address.trim()) || null,
      photoCount: photos.filter((p) => p && p.status === 'ok').length,
      hasVideo: videos.length > 0,
      hasTour: typeof data.tourUrl === 'string' && !!data.tourUrl.trim(),
      updatedAt: row.updated_at || null,
    };
  });
  return { jobs };
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

const CSS = `
  :root{color-scheme:light dark;}
  body{font-family:-apple-system,"system-ui","Segoe UI",Roboto,sans-serif;margin:0;background:#fbfbfd;color:#1c1c1e;}
  header{padding:20px 24px;border-bottom:1px solid #e5e5ea;display:flex;align-items:center;gap:16px;flex-wrap:wrap;}
  header h1{font-size:17px;margin:0;font-weight:600;}
  header .count{color:#8e8e93;font-size:13px;}
  #q{margin-left:auto;padding:8px 12px;border:1px solid #d1d1d6;border-radius:8px;font-size:14px;min-width:220px;}
  main{padding:16px 24px 40px;max-width:1100px;margin:0 auto;}
  table{width:100%;border-collapse:collapse;font-size:13.5px;}
  th{text-align:left;color:#8e8e93;font-weight:500;padding:8px 10px;border-bottom:1px solid #e5e5ea;white-space:nowrap;}
  td{padding:10px;border-bottom:1px solid #f0f0f2;vertical-align:top;}
  tr:hover td{background:#f5f5f7;}
  a.addr{color:#0a5cd8;text-decoration:none;font-weight:500;}
  a.addr:hover{text-decoration:underline;}
  .jobid{color:#8e8e93;font-family:ui-monospace,monospace;font-size:12px;}
  .yes{color:#1f8b3a;}
  .no{color:#c7c7cc;}
  .empty{color:#8e8e93;padding:40px 0;text-align:center;}
  @media (prefers-color-scheme: dark){
    body{background:#000;color:#f2f2f7;}
    header{border-color:#2c2c2e;}
    #q{background:#1c1c1e;border-color:#3a3a3c;color:#f2f2f7;}
    th{border-color:#2c2c2e;}
    td{border-color:#1c1c1e;}
    tr:hover td{background:#1c1c1e;}
  }
`;

export function renderAdminPage(model) {
  const jobs = model.jobs || [];
  const rows = jobs.map((j) => `
    <tr data-search="${escapeHtml((j.address || '') + ' ' + j.jobId).toLowerCase()}">
      <td><a class="addr" href="/delivery/${encodeURIComponent(j.jobId)}" target="_blank" rel="noopener">${escapeHtml(j.address || '(no address yet)')}</a><div class="jobid">${escapeHtml(j.jobId)}</div></td>
      <td>${j.photoCount || '—'}</td>
      <td class="${j.hasVideo ? 'yes' : 'no'}">${j.hasVideo ? '✓' : '—'}</td>
      <td class="${j.hasTour ? 'yes' : 'no'}">${j.hasTour ? '✓' : '—'}</td>
      <td>${fmtTime(j.updatedAt)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>All Delivery Pages — FranVision</title>
<style>${CSS}</style></head>
<body>
<header>
  <h1>All Delivery Pages 交付页列表</h1>
  <span class="count">${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>
  <input id="q" type="search" placeholder="Filter by address / Job ID 筛选…">
</header>
<main>
  ${jobs.length ? `<table>
    <thead><tr><th>Address 地址</th><th>Photos 照片</th><th>Video 视频</th><th>Tour 全景</th><th>Updated 更新时间</th></tr></thead>
    <tbody id="rows">${rows}</tbody>
  </table>` : '<div class="empty">No jobs yet 还没有任何 job</div>'}
</main>
<script>
  document.getElementById('q').addEventListener('input', function () {
    var q = this.value.trim().toLowerCase();
    document.querySelectorAll('#rows tr').forEach(function (tr) {
      tr.hidden = q && tr.dataset.search.indexOf(q) === -1;
    });
  });
</script>
</body></html>`;
}
