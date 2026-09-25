// Admin directory -- GET /admin?admin=<ADMIN_TOKEN>, same query-param-token
// shape as Feature Sheet Builder's own admin page (admin.js there: "Reached
// at ?admin=<ADMIN_TOKEN>... shared secret checked server-side, NOT stored
// in the DB"). Read-only: a delivery page exists because a Job exists, it
// isn't something to create/duplicate/delete from here the way a Feature
// Sheet is -- so unlike FSB's admin, there is no recycle bin, no row
// actions beyond "open the page". Pure logic (buildAdminModel/
// renderAdminPage), same split as render.js, so this is unit-tested without
// touching Supabase.

import { escapeHtml, deliveryPath, isDerivedCopy } from './render.js';
import { galleryPath } from './gallery.js';

// agentInfo/agentInfo2 are Feature Sheet Builder's fields (this system's
// `projects` table is shared with it -- see supabase.js#listProjects). Not
// populated by anything today for a Job Generator jobId (FSB's own projects
// still use a separate random-hex id space), but once FSB moves its
// projects onto the same shared jobId scheme (planned, see [[franvision-
// custom-system-buildout]]), this starts populating with no code change --
// same forward-compatible reasoning as the FVS- filter in supabase.js.
// Mirrors storage.js#listProjects' exact derivation: up to 2 names, primary
// then secondary, blanks dropped.
function agentNames(data) {
  return [data.agentInfo && data.agentInfo.name, data.agentInfo2 && data.agentInfo2.name]
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter(Boolean);
}

// First name of the primary agent, lowercased -- the primary sort key,
// exactly matching FSB admin.js#agentFirstName().
function agentFirstName(job) {
  const n = (job.agents[0] || '').trim();
  return n.split(/\s+/)[0].toLowerCase();
}

// Every projects row this system might have (shared with Feature Sheet
// Builder -- see supabase.js#listProjects) -> the rows this directory shows.
// A Job's presence here doesn't imply it has photos/a tour link/anything
// specific, same as FSB's own admin list isn't filtered to "real feature
// sheets" either.
//
// Sort order matches FSB admin.js#sortRows() exactly: primary agent's first
// name A-Z (a job with no agent sinks to the bottom), then newest-updated
// first within the same name.
export function buildAdminModel(rows, galleryTokens = {}) {
  const jobs = (rows || []).map((row) => {
    const data = (row && row.data) || {};
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const videos = Array.isArray(data.videos) ? data.videos : [];
    return {
      jobId: row.id,
      address: (typeof data.address === 'string' && data.address.trim()) || null,
      agents: agentNames(data),
      photoCount: photos.filter((p) => p && p.status === 'ok' && !isDerivedCopy(p)).length,
      hasVideo: videos.length > 0,
      hasTour: typeof data.tourUrl === 'string' && !!data.tourUrl.trim(),
      updatedAt: row.updated_at || null,
      // Minted by the job server at Create/Update Job, or automatically when this
      // directory loads (supabase.js#ensureGalleryTokens); null only if the token
      // table isn't reachable.
      galleryToken: (galleryTokens && galleryTokens[row.id]) || null,
    };
  });

  jobs.sort((a, b) => {
    const fa = agentFirstName(a);
    const fb = agentFirstName(b);
    if (fa !== fb) {
      if (!fa) return 1;
      if (!fb) return -1;
      return fa < fb ? -1 : 1;
    }
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
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
  .copy-btn{padding:5px 10px;border:1px solid #d1d1d6;border-radius:6px;background:#fff;color:#1c1c1e;font-size:12.5px;cursor:pointer;white-space:nowrap;}
  .copy-btn:hover{border-color:#8e8e93;}
  .copy-btn.done{border-color:#1f8b3a;color:#1f8b3a;}
  .copy-btn.err{border-color:#c0392b;color:#c0392b;}
  .open-link{color:#0a5cd8;text-decoration:none;font-size:12.5px;}
  .open-link:hover{text-decoration:underline;}
  .open-link.is-off{color:#c7c7cc;cursor:default;pointer-events:none;}  /* only if the token table isn't reachable */
  .copy-btn:disabled{opacity:.45;cursor:default;}
  .btns{display:flex;flex-direction:column;gap:6px;align-items:flex-start;}
  @media (prefers-color-scheme: dark){
    body{background:#000;color:#f2f2f7;}
    header{border-color:#2c2c2e;}
    #q{background:#1c1c1e;border-color:#3a3a3c;color:#f2f2f7;}
    th{border-color:#2c2c2e;}
    td{border-color:#1c1c1e;}
    tr:hover td{background:#1c1c1e;}
    .copy-btn{background:#1c1c1e;border-color:#3a3a3c;color:#f2f2f7;}
    .open-link.is-off{color:#48484a;}
  }
`;

// `origin` (e.g. "https://real.gta3d.ca") makes the copy-link button's
// clipboard text a real absolute URL an agent can paste anywhere -- a
// relative path is useless once it leaves this page. Falls back to a
// relative link (still a valid href on this page, just not copy-able
// meaningfully) if no origin is given, e.g. in a unit test.
export function renderAdminPage(model, { origin = '' } = {}) {
  const jobs = model.jobs || [];
  const base = String(origin || '').replace(/\/+$/, '');
  const rows = jobs.map((j) => {
    const path = deliveryPath(j.jobId, j.address);
    const fullLink = base + path;
    // Two columns per Job: All in One (agent-facing preview) and Gallery (the
    // client's post-payment download page, its own URL with a random token).
    const gPath = j.galleryToken ? galleryPath(j.address, j.galleryToken) : '';
    const gFull = gPath ? base + gPath : '';
    return `
    <tr data-search="${escapeHtml((j.address || '') + ' ' + j.jobId + ' ' + j.agents.join(' ')).toLowerCase()}">
      <td><a class="addr" href="${path}" target="_blank" rel="noopener">${escapeHtml(j.address || '(no address yet)')}</a><div class="jobid">${escapeHtml(j.jobId)}</div></td>
      <td>${escapeHtml(j.agents.join(' & ') || '—')}</td>
      <td>${j.photoCount || '—'}</td>
      <td class="${j.hasVideo ? 'yes' : 'no'}">${j.hasVideo ? '✓' : '—'}</td>
      <td class="${j.hasTour ? 'yes' : 'no'}">${j.hasTour ? '✓' : '—'}</td>
      <td>${fmtTime(j.updatedAt)}</td>
      <td><div class="btns">
        <a class="open-link" href="${path}" target="_blank" rel="noopener">Open 打开</a>
        <button class="copy-btn" type="button" data-link="${escapeHtml(fullLink)}">Copy link 复制链接</button>
      </div></td>
      <td><div class="btns">
        <a class="open-link${gPath ? '' : ' is-off'}"${gPath ? ` href="${escapeHtml(gPath)}" target="_blank" rel="noopener"` : ' aria-disabled="true"'}>Open 打开</a>
        <button class="copy-btn" type="button" data-link="${escapeHtml(gFull)}"${gFull ? '' : ' disabled'}>Copy link 复制链接</button>
      </div></td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>All Delivery Pages — FranVision</title>
<style>${CSS}</style></head>
<body>
<header>
  <h1>All Delivery Pages 交付页列表</h1>
  <span class="count">${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>
  <input id="q" type="search" placeholder="Filter by address / agent / Job ID 筛选…">
</header>
<main>
  ${jobs.length ? `<table>
    <thead><tr><th>Address 地址</th><th>Agent 经纪</th><th>Photos 照片</th><th>Video 视频</th><th>Tour 全景</th><th>Updated 更新时间</th><th>All in One</th><th>Gallery</th></tr></thead>
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
  function flash(btn, text, cls) {
    var label = btn.dataset.label || btn.textContent;
    btn.dataset.label = label;
    btn.textContent = text;
    btn.classList.add(cls);
    setTimeout(function () { btn.textContent = btn.dataset.label; btn.classList.remove(cls); }, 1500);
  }
  function copy(btn, link) {
    var done = function () { flash(btn, 'Copied 已复制', 'done'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { prompt('Copy link:', link); });
    } else {
      prompt('Copy link:', link);
    }
  }
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { if (btn.dataset.link) copy(btn, btn.dataset.link); });
  });
</script>
</body></html>`;
}
