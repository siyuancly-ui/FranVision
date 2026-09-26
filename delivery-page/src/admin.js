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
import { hubPath } from './hub.js';

// agentInfo/agentInfo2 are Feature Sheet Builder's fields (this system's
// `projects` table is shared with it -- see supabase.js#listProjects). Not
// populated by anything today for a Job Generator jobId (FSB's own projects
// still use a separate random-hex id space), but once FSB moves its
// projects onto the same shared jobId scheme (planned, see [[franvision-
// custom-system-buildout]]), this starts populating with no code change --
// same forward-compatible reasoning as the FVS- filter in supabase.js.
// Mirrors storage.js#listProjects' exact derivation: up to 2 names, primary
// then secondary, blanks dropped.
function clientNameOf(clientNames, jobId) {
  const n = clientNames && clientNames[jobId];
  return typeof n === 'string' && n.trim() ? n.trim() : '';
}

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
// `clientNames` = { jobId: "Client Name typed in Job Generator" } (supabase.js#listClientNames). Job Generator's
// Client Name is the agent, so it fills the Agent column; the Feature Sheet Builder's agentInfo names are only the
// fallback (a Job Generator job normally has no FSB agentInfo).
export function buildAdminModel(rows, galleryTokens = {}, hubs = {}, clientNames = {}) {
  const jobs = (rows || []).map((row) => {
    const data = (row && row.data) || {};
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const videos = Array.isArray(data.videos) ? data.videos : [];
    return {
      jobId: row.id,
      address: (typeof data.address === 'string' && data.address.trim()) || null,
      agents: clientNameOf(clientNames, row.id) ? [clientNameOf(clientNames, row.id)] : agentNames(data),
      photoCount: photos.filter((p) => p && p.status === 'ok' && !isDerivedCopy(p)).length,
      hasVideo: videos.length > 0,
      hasTour: typeof data.tourUrl === 'string' && !!data.tourUrl.trim(),
      updatedAt: row.updated_at || null,
      // Minted by the job server at Create/Update Job, or automatically when this
      // directory loads (supabase.js#ensureGalleryTokens); null only if the token
      // table isn't reachable.
      galleryToken: (galleryTokens && galleryTokens[row.id]) || null,
      // Delivery Hub row (written by Job Generator at Create/Update Job); null for a Job
      // that has not been created/updated since the hub existed.
      hub: (hubs && hubs[row.id]) || null,
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

function cents(c) {
  return Number.isFinite(c) ? `$${(c / 100).toFixed(2)}` : '—';
}

const CSS = `
  :root{color-scheme:light dark;}
  *{box-sizing:border-box;}
  body{font-family:-apple-system,"system-ui","Segoe UI",Roboto,sans-serif;font-size:17px;margin:0;background:#fbfbfd;color:#1c1c1e;-webkit-text-size-adjust:100%;}
  header{padding:22px 28px;border-bottom:1px solid #e5e5ea;display:flex;align-items:center;gap:16px;flex-wrap:wrap;}
  header h1{font-size:22px;margin:0;font-weight:600;}
  header .count{color:#8e8e93;font-size:16px;}
  #q{margin-left:auto;padding:12px 16px;border:1px solid #d1d1d6;border-radius:10px;font-size:17px;min-width:280px;}
  main{padding:18px 28px 48px;max-width:1240px;margin:0 auto;}
  table{width:100%;border-collapse:collapse;font-size:17px;}
  th{text-align:left;color:#8e8e93;font-weight:500;font-size:15px;padding:12px 16px;border-bottom:1px solid #e5e5ea;white-space:nowrap;position:sticky;top:0;background:#fbfbfd;}
  td{padding:16px;border-bottom:1px solid #f0f0f2;vertical-align:middle;}
  td.addr-cell{min-width:320px;}
  td.agent{min-width:140px;font-weight:500;}
  tr:hover td{background:#f5f5f7;}
  tr[hidden]{display:none !important;}
  a.addr{color:#0a5cd8;text-decoration:none;font-weight:500;font-size:18px;line-height:1.35;}
  a.addr:hover{text-decoration:underline;}
  .jobid{color:#8e8e93;font-family:ui-monospace,monospace;font-size:13.5px;white-space:nowrap;margin-top:3px;}
  .yes{color:#1f8b3a;}
  .no{color:#c7c7cc;}
  .empty{color:#8e8e93;padding:48px 0;text-align:center;font-size:18px;}
  /* Big tap targets: Open is a pill, Copy link a proper button, the Paid / Unlock boxes are large and their whole label taps. */
  .open-link{display:inline-block;padding:10px 20px;border-radius:10px;background:#eaf1ff;color:#0a5cd8;text-decoration:none;font-size:17px;font-weight:500;white-space:nowrap;}
  .open-link:hover{background:#dbe8ff;}
  .open-link.is-off{background:#f2f2f4;color:#c7c7cc;cursor:default;pointer-events:none;}  /* only if the token table isn't reachable */
  .copy-btn{padding:10px 18px;border:1px solid #d1d1d6;border-radius:10px;background:#fff;color:#1c1c1e;font-size:16px;cursor:pointer;white-space:nowrap;}
  .copy-btn:hover{border-color:#8e8e93;}
  .copy-btn.done{border-color:#1f8b3a;color:#1f8b3a;}
  .copy-btn.err{border-color:#c0392b;color:#c0392b;}
  .copy-btn:disabled{opacity:.45;cursor:default;}
  .sw{display:flex;align-items:center;gap:12px;font-size:18px;white-space:nowrap;cursor:pointer;padding:6px 0;}
  .sw input{width:26px;height:26px;margin:0;accent-color:#0a5cd8;cursor:pointer;}
  .sw.err{color:#c0392b;}
  .sw.is-wave{opacity:.55;cursor:not-allowed;}
  .sw.is-wave input{cursor:not-allowed;}
  .partial{font-size:15px;color:#b3541e;white-space:nowrap;}
  .btns{display:flex;flex-direction:column;gap:10px;align-items:flex-start;}
  /* Phones: no table. Each Job is a card -- address + agent on top, then one labelled row per link, then the switches. */
  @media (max-width:760px){
    body{font-size:17px;}
    header{padding:16px 16px 14px;gap:10px 12px;}
    header h1{font-size:20px;}
    #q{margin-left:0;width:100%;min-width:0;font-size:17px;}
    main{padding:8px 12px 40px;}
    table,tbody,tr,td{display:block;}
    thead{display:none;}
    tr{background:#fff;border:1px solid #e5e5ea;border-radius:16px;padding:16px 18px 6px;margin:14px 0;box-shadow:0 1px 4px rgba(0,0,0,.05);}
    tr:hover td{background:transparent;}
    td{border:0;padding:4px 0;}
    td.addr-cell{min-width:0;padding-top:0;}
    a.addr{font-size:20px;}
    td.agent{min-width:0;font-size:18px;color:#3a3a3c;padding-bottom:10px;}
    td[data-label]{display:flex;align-items:center;justify-content:space-between;gap:14px;border-top:1px solid #f0f0f2;padding:14px 0;}
    td[data-label]::before{content:attr(data-label);color:#8e8e93;font-size:15px;}
    td[data-label="付款状态"]{align-items:flex-start;}
    td.is-empty{display:none;}   /* a Job with no delivery page yet: nothing to show, so no empty rows on the card */
    .btns{flex-direction:row;flex-wrap:wrap;align-items:center;gap:12px;justify-content:flex-end;}
    td[data-label="付款状态"] .btns{flex-direction:column;align-items:flex-start;gap:6px;}
    .open-link{padding:12px 22px;}
    .copy-btn{padding:12px 20px;}
    .sw{font-size:19px;padding:8px 0;}
    .partial{white-space:normal;}
  }
  @media (prefers-color-scheme: dark){
    body{background:#000;color:#f2f2f7;}
    header{border-color:#2c2c2e;}
    #q{background:#1c1c1e;border-color:#3a3a3c;color:#f2f2f7;}
    th{border-color:#2c2c2e;background:#000;}
    td{border-color:#1c1c1e;}
    tr:hover td{background:#1c1c1e;}
    .open-link{background:#0f2447;color:#7fb0ff;}
    .open-link.is-off{background:#1c1c1e;color:#48484a;}
    .copy-btn{background:#1c1c1e;border-color:#3a3a3c;color:#f2f2f7;}
    @media (max-width:760px){ tr{background:#111113;border-color:#2c2c2e;} td[data-label]{border-color:#2c2c2e;} }
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
    // Two columns per Job: All in One (agent-facing preview) and Gallery (the client's post-payment download
    // page, its own URL with a random token) -- Open only, no copy button (user 2026-09-26).
    const gPath = j.galleryToken ? galleryPath(j.address, j.galleryToken) : '';
    // Delivery Hub column: the client-facing download page + Franky's two switches.
    const hPath = j.hub ? hubPath(j.address, j.hub.token) : '';
    const hFull = hPath ? base + hPath : '';
    const hubCell = j.hub ? `<div class="btns">
        <a class="open-link" href="${escapeHtml(hPath)}" target="_blank" rel="noopener">Open</a>
        <button class="copy-btn" type="button" data-link="${escapeHtml(hFull)}">Copy link</button>
      </div>` : '<span class="no">—</span>';
    // Paid through Wave (fully paid, by the webhook): a greyed-out tick that can't be undone -- that
    // alone tells Franky it was Wave, not his own e-Transfer tick. A PARTIAL Wave payment does not tick;
    // it shows what was paid / is still owed.
    const wavePaid = j.hub && j.hub.paid && j.hub.paidSource === 'wave';
    const partial = j.hub && !j.hub.paid && j.hub.waveRemainingCents > 0
      ? `<div class="partial">Partial: ${cents(j.hub.wavePaidCents)} paid, ${cents(j.hub.waveRemainingCents)} left</div>` : '';
    const payCell = j.hub ? `<div class="btns">
        <label class="sw${wavePaid ? ' is-wave' : ''}"${wavePaid ? ' title="Paid via Wave"' : ''}><input type="checkbox" data-hub="${escapeHtml(j.jobId)}" data-flag="paid"${j.hub.paid ? ' checked' : ''}${wavePaid ? ' disabled' : ''}> Paid</label>
        <label class="sw"><input type="checkbox" data-hub="${escapeHtml(j.jobId)}" data-flag="unlocked"${j.hub.unlocked ? ' checked' : ''}> Unlock</label>${partial}
      </div>` : '<span class="no">—</span>';
    return `
    <tr data-search="${escapeHtml((j.address || '') + ' ' + j.jobId + ' ' + j.agents.join(' ')).toLowerCase()}">
      <td class="addr-cell"><a class="addr" href="${path}" target="_blank" rel="noopener">${escapeHtml(j.address || '(no address yet)')}</a><div class="jobid">${escapeHtml(j.jobId)}</div></td>
      <td class="agent">${escapeHtml(j.agents.join(' & ') || '—')}</td>
      <td data-label="All in One"><a class="open-link" href="${path}" target="_blank" rel="noopener">Open</a></td>
      <td data-label="Gallery"><a class="open-link${gPath ? '' : ' is-off'}"${gPath ? ` href="${escapeHtml(gPath)}" target="_blank" rel="noopener"` : ' aria-disabled="true"'}>Open</a></td>
      <td data-label="Delivery Page"${j.hub ? '' : ' class="is-empty"'}>${hubCell}</td>
      <td data-label="付款状态"${j.hub ? '' : ' class="is-empty"'}>${payCell}</td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>All Delivery Pages — FranVision</title>
<style>${CSS}</style></head>
<body>
<header>
  <h1>All Delivery Pages 交付页列表</h1>
  <span class="count">${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>
  <input id="q" type="search" placeholder="Filter by address / agent / Job ID 筛选…">
</header>
<main>
  ${jobs.length ? `<table>
    <thead><tr><th>地址</th><th>经纪</th><th>All in One</th><th>Gallery</th><th>Delivery Page</th><th>付款状态</th></tr></thead>
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
    var done = function () { flash(btn, 'Copied', 'done'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { prompt('Copy link:', link); });
    } else {
      prompt('Copy link:', link);
    }
  }
  // Payment switches: POST the flag with the same admin token this page was opened with.
  var adminToken = new URLSearchParams(location.search).get('admin') || '';
  document.querySelectorAll('input[data-hub]').forEach(function (box) {
    box.addEventListener('change', function () {
      var label = box.parentNode, body = {};
      body[box.dataset.flag] = box.checked;
      label.classList.remove('err');
      fetch('/admin/hub/' + encodeURIComponent(box.dataset.hub), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) throw new Error(r.status);
      }).catch(function () {
        box.checked = !box.checked;  // did not save -- put the switch back
        label.classList.add('err');
      });
    });
  });
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { if (btn.dataset.link) copy(btn, btn.dataset.link); });
  });
</script>
</body></html>`;
}
