// The Delivery Hub page: /deliver/<address-slug>/<token>[/go/<KEY>].
//
// What the Delivery Email links to for everything below its "-----" line. One
// button per deliverable -- the SAME set the email used to list line by line
// (job-generator/delivery-email.js#getDeliverableLines, stored per Job in the
// delivery_hub table by Job Generator at Create/Update Job). While the Job is
// unpaid a click opens a "please pay first" dialog (credit card -> the Wave invoice page, or e-Transfer instructions);
// once paid (or unlocked by Franky for a deliver-first client) the same button
// goes straight to the deliverable.
//
// The gate is SERVER-side: a locked button is rendered WITHOUT any target, and
// /go/<KEY> re-checks paid/unlocked before it redirects, so a locked page never
// contains a Dropbox link. Targets:
//   HDR          -> the Gallery page (its own random URL token, gallery_tokens)
//   THREE_D      -> projects.data.tourUrl
//   everything else -> the Dropbox link stored in delivery_hub.lines[].url
// The All in One page is not gated and not part of this (the hub just links to it).
//
// Pure like gallery.js/render.js: index.js hands in the rows, everything here is
// string building, unit-tested without a network.

import { escapeHtml, page, slugifyAddress, creditHtml, deliveryPath } from './render.js';
import { galleryPath } from './gallery.js';

// Same shape check as the gallery token: cheap, rejects junk before any lookup.
export function isHubToken(token) {
  return typeof token === 'string' && /^[0-9a-f]{32}$/.test(token);
}

// "/deliver/<address-slug>/<token>" -- what the Delivery Email links to.
export function hubPath(address, token) {
  return `/deliver/${slugifyAddress(address) || 'delivery'}/${token}`;
}

// Order = the email's order. Labels are the email's own wording (EN + 中文).
const LINE_DEFS = {
  HDR: { en: 'High-Resolution Photos', zh: '高清照片' },
  MLS: { en: 'MLS Photos', zh: 'MLS 照片' },
  VIDEO: { en: 'Video', zh: '视频', noteEn: 'ready within 24 hours', noteZh: '24小时内完成' },
  FLOORPLAN: { en: 'Floor Plan / Site Plan', zh: '平面图' },
  THREE_D: { en: '3D Tour / Floor Tour', zh: '3D 全景' },
  LOCAL_REPORT: { en: 'Local Report', zh: '社区报告' },
  HOME_REPORT: { en: 'Home Report', zh: '房屋报告' },
};
const LINE_ORDER = Object.keys(LINE_DEFS);

export function isLineKey(key) {
  return Object.prototype.hasOwnProperty.call(LINE_DEFS, key);
}

// Only ever redirect to a plain web URL (a stored value is data, never trusted to
// be a safe scheme).
// Takes the FIRST non-empty line, so a Tour Link.txt with a note or a second line under the
// link still yields just the link; anything with whitespace left in it is rejected rather
// than sent to a Location header.
function safeUrl(u) {
  const first = typeof u === 'string' ? (u.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '') : '';
  return /^https?:\/\/\S+$/i.test(first) ? first : '';
}

export function isUnlocked(row) {
  return Boolean(row && (row.paid || row.unlocked));
}

// row = delivery_hub row; project = projects row (or null); galleryToken = this
// Job's gallery_tokens token (or null).
export function buildHubModel(row, project, galleryToken) {
  const data = (project && project.data) || {};
  const address = (typeof data.address === 'string' && data.address.trim()) || '';
  const tourUrl = safeUrl(data.tourUrl);
  const stored = new Map((Array.isArray(row.lines) ? row.lines : []).filter((l) => l && isLineKey(l.key)).map((l) => [l.key, l]));

  const lines = LINE_ORDER.filter((k) => stored.has(k)).map((key) => {
    const line = stored.get(key);
    const ready = key === 'HDR' ? Boolean(galleryToken) : key === 'THREE_D' ? Boolean(tourUrl) : Boolean(safeUrl(line.url));
    return { key, en: LINE_DEFS[key].en, zh: LINE_DEFS[key].zh, noteEn: LINE_DEFS[key].noteEn || '', noteZh: LINE_DEFS[key].noteZh || '', ready };
  });

  return {
    jobId: row.job_id,
    address,
    unlocked: isUnlocked(row),
    payUrl: safeUrl(row.wave_view_url),
    totalCents: Number.isFinite(row.total_cents) ? row.total_cents : null,
    preTaxCents: Number.isFinite(row.pretax_cents) ? row.pretax_cents : null,
    clientName: typeof row.client_name === 'string' ? row.client_name.trim() : '',
    allInOnePath: deliveryPath(row.job_id, address),
    lines,
  };
}

// Where /go/<KEY> sends a paid visitor, or null when that deliverable isn't ready.
export function resolveTarget(key, row, project, galleryToken) {
  if (!isLineKey(key)) return null;
  const line = (Array.isArray(row.lines) ? row.lines : []).find((l) => l && l.key === key);
  if (!line) return null;
  const data = (project && project.data) || {};
  if (key === 'HDR') return galleryToken ? galleryPath(data.address, galleryToken) : null;
  if (key === 'THREE_D') return safeUrl(data.tourUrl) || null;
  return safeUrl(line.url) || null;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Same rule as the email's PRETAX_AMOUNT: whole dollars drop the decimals, otherwise full cents.
function preTaxMoney(cents) {
  return cents % 100 === 0 ? `$${cents / 100}` : money(cents);
}

const LOCK_ICON = '<svg class="hub-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ARROW_ICON = '<svg class="hub-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 3.5v11m0 0-4.4-4.4M12 14.5l4.4-4.4M4 15.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EYE_ICON = '<svg class="hub-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

export function renderNotFoundHub() {
  return page('Delivery', `
<div class="notfound">
  <p class="eyebrow">FranVision Media</p>
  <h1>This delivery link isn't valid</h1>
  <p>Please use the link from your delivery email, or reach out to Franky directly.</p>
</div>`, { bare: true });
}

export function renderNotReadyHub(backHref) {
  return page('Delivery', `
<div class="notfound">
  <p class="eyebrow">Delivery</p>
  <h1>This item isn't ready yet</h1>
  <p>It's still being prepared. Please try again shortly, or reach out to Franky.</p>
  ${backHref ? `<p><a href="${escapeHtml(backHref)}">&larr; Back</a></p>` : ''}
</div>`, { bare: true });
}

// base = "/deliver/<slug>/<token>" (already encoded); openKey = a locked key to
// open the dialog for right away (arrives via /go/<KEY> hit while locked).
export function renderHubPage(model, { base, openKey = '' }) {
  const buttons = model.lines.map((l) => {
    const note = l.noteEn ? ` <span class="hub-note">(${escapeHtml(l.noteEn)} ${escapeHtml(l.noteZh)})</span>` : '';
    const label = `<span class="hub-label">${escapeHtml(l.en)}${note}<span class="hub-zh">${escapeHtml(l.zh)}</span></span>`;
    if (!l.ready && model.unlocked) {
      return `<span class="hub-btn is-disabled" title="Still being prepared">${ARROW_ICON}${label}<span class="hub-tag">Preparing&hellip;</span></span>`;
    }
    if (model.unlocked) {
      return `<a class="hub-btn" href="${base}/go/${l.key}" target="_blank" rel="noopener">${ARROW_ICON}${label}</a>`;
    }
    return `<button class="hub-btn is-locked" type="button" data-key="${l.key}">${LOCK_ICON}${label}</button>`;
  }).join('\n');

  const amount = model.totalCents != null ? `<p class="hub-fee">${money(model.totalCents)} <span>incl. HST</span></p>` : '';
  const cardBtn = model.payUrl
    ? `<a class="hub-pay" id="hubCard" href="${escapeHtml(model.payUrl)}" target="_blank" rel="noopener">Pay by credit card <span>信用卡</span></a>`
    : '';
  const dialog = model.unlocked ? '' : `
<div class="hub-modal" id="hubModal" hidden role="dialog" aria-modal="true" aria-labelledby="hubModalTitle">
  <div class="hub-modal-card">
    <div id="hubChoose">
      <h2 id="hubModalTitle">Please pay to unlock <span>请先付款解锁</span></h2>
      ${amount}
      ${cardBtn}
      <button class="hub-pay is-alt" id="hubEmt" type="button">Pay by e-Transfer <span>EMT 转账</span></button>
    </div>
    <div id="hubEmtPanel" hidden>
      <h2>Pay by e-Transfer <span>EMT 转账</span></h2>
      ${amount}
      <p class="hub-emt-to">Send to</p>
      <p class="hub-emt-mail" id="hubMail">frankystudio@mail.com</p>
      <p class="hub-emt-note">Not Gmail 不是 Gmail</p>
      <button class="hub-copy" id="hubCopy" type="button">Copy email 复制邮箱</button>
      <p class="hub-after">Then let Franky know or send a screenshot — we'll unlock this page. 付款后请告知 Franky 或发截图。</p>
      <button class="hub-back" id="hubBack" type="button">&larr; Back 返回</button>
    </div>
    <button class="hub-close" id="hubClose" type="button" aria-label="Close">&times;</button>
  </div>
</div>`;

  const who = model.clientName ? escapeHtml(model.clientName) : '';
  const addr = model.address ? escapeHtml(model.address) : 'your property';
  const fee = model.totalCents != null && model.preTaxCents != null
    ? `<p class="mail-fee">Fee 费用: <strong>${preTaxMoney(model.preTaxCents)} + HST = ${money(model.totalCents)}</strong></p>` : '';
  // ONE blue button for everything money-related: it opens the Wave invoice page (the customer link
  // `viewUrl`, which lands on Wave's public invoice page) where the client can pay by card / bank, print,
  // and download the PDF -- which shows "Paid" once it is. Clicking it while unpaid starts the auto-unlock
  // watch (see hubScript). Wave's page has no Interac e-Transfer, so while locked a small text link opens
  // the e-Transfer instructions. A Job with no Wave invoice gets a Pay now button that opens the dialog.
  const payLabel = model.unlocked ? 'Invoice (Paid) 发票 &#10003;' : 'Pay now / Invoice 付款 / 发票';
  const payBtn = model.payUrl
    ? `<a class="hub-cta${model.unlocked ? ' is-paid' : ''}" id="hubPayNow" href="${escapeHtml(model.payUrl)}" target="_blank" rel="noopener">${payLabel}</a>`
    : (model.unlocked ? '' : '<button class="hub-cta" id="hubPayNow" type="button">Pay now 付款</button>');
  const emtLink = !model.unlocked && model.payUrl
    ? '<p class="mail-emt">Prefer Interac e-Transfer? <button class="hub-link" id="hubEmtLink" type="button">Show e-Transfer details 使用 EMT 转账</button></p>' : '';

  // The wording is the Delivery Email's own (job-generator/delivery-email-template.{en,zh}.txt), so the page
  // reads like the email it replaces -- keep the two in step if the email's wording changes.
  const body = `
<main class="mail">
  <div class="mail-card">
    <p class="eyebrow">FranVision Media</p>
    <p class="mail-hello">Hello${who ? ` ${who}` : ''},</p>
    <p class="mail-p">Your photos for <strong>${addr}</strong> are ready — thank you for your patience.</p>
    <p class="mail-zh">${model.address ? `${escapeHtml(model.address)} 的` : ''}照片已经制作完成，感谢您的耐心等待。</p>
    <a class="hub-btn hub-preview" href="${escapeHtml(model.allInOnePath)}" target="_blank" rel="noopener">${EYE_ICON}<span class="hub-label">Preview All in One<span class="hub-zh">在线预览</span></span></a>
    ${model.unlocked
      ? '<p class="mail-p is-open">Payment received — thank you! Your files are ready below.<span class="mail-zh">已收到付款，谢谢！下面的文件都可以下载了。</span></p>'
      : '<p class="mail-p">You can preview the photos above. To download the files, please complete payment first.<span class="mail-zh">您可以先预览照片；需要下载文件的话，请先支付费用。</span></p>'}
    ${fee}
    <div class="cta-row">${payBtn}</div>
    ${emtLink}
    <hr class="mail-rule">
    ${model.address ? `<h1 class="mail-addr">${escapeHtml(model.address)}</h1>` : ''}
    <p class="mail-note">For the best experience, please open in a browser on PC or Mac. Thank you so much for your support!<span class="mail-zh">请在 PC 或 Mac 上使用浏览器打开效果最佳，感谢您的支持与厚爱！</span></p>
    ${model.lines.length ? `<div class="hub-list">\n${buttons}\n</div>` : '<p class="hub-empty">Nothing to download yet.</p>'}
    <p class="mail-sign">Thank you!<br>Franky<br>FranVision Media</p>
  </div>
</main>
${creditHtml()}
${dialog}`;

  return page(model.address ? `${model.address} — Delivery` : 'Delivery', body, {
    bare: true,
    extraHead: HUB_HEAD,
    extraCss: HUB_CSS,
    extraBody: model.unlocked ? '' : `<script>${hubScript(openKey, base)}</script>`,
  });
}

const HUB_HEAD = '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet">';

const HUB_CSS = `
  body{background:#eceef2;}
  .mail{padding:28px 14px 8px;font-family:Montserrat,-apple-system,"system-ui","Segoe UI",Roboto,sans-serif;color:#3a3a40;}
  .mail-card{max-width:600px;margin:0 auto;background:#fff;border-radius:14px;padding:40px 34px 34px;box-shadow:0 2px 14px rgba(30,30,40,0.10);}
  .mail-hello{font-size:17px;margin:0 0 14px;}
  .mail-p{font-size:15px;line-height:1.6;margin:0 0 4px;}
  .mail-p strong{font-weight:600;}
  .mail-p.is-open{color:#1f8b3a;margin:18px 0 4px;}
  .mail-zh{display:block;font-size:13px;line-height:1.55;color:#7a766b;margin:0 0 18px;}
  .mail-fee{margin:22px 0 14px;font-size:15px;}
  .mail-rule{border:0;border-top:1px solid #e3e3e8;margin:30px 0 26px;}
  .mail-addr{font-family:Fraunces,Georgia,"Times New Roman",serif;font-weight:400;font-size:clamp(22px,4.6vw,30px);line-height:1.2;margin:0 0 12px;color:#2b2b30;}
  .mail-note{font-size:13.5px;line-height:1.55;color:#55555c;margin:0 0 6px;}
  .mail-sign{margin:30px 0 0;font-size:14px;line-height:1.7;color:#55555c;}
  /* The two blue buttons (studio's usual delivery-page look). */
  .cta-row{display:flex;flex-wrap:wrap;gap:14px;margin:6px 0 0;}
  .hub-cta{display:inline-flex;align-items:center;justify-content:center;min-width:150px;box-sizing:border-box;padding:14px 26px;border:0;border-radius:8px;background:#467ab5;color:#fff;font:inherit;font-size:18px;text-decoration:none;cursor:pointer;}
  .hub-cta:hover{background:#3b6aa0;}
  .hub-cta.is-paid{background:#5f8f6b;}
  .mail-emt{margin:12px 0 0;font-size:12.5px;color:#7a766b;}
  .hub-link{border:0;background:none;padding:0;font:inherit;color:#467ab5;text-decoration:underline;cursor:pointer;}
  .hub-note{font-weight:400;font-size:12px;color:#8a867b;}
  .hub-list{display:flex;flex-direction:column;gap:12px;margin-top:18px;}
  /* Same raised grey button family as the Gallery page's download buttons, full width. */
  .hub-btn{display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;padding:15px 20px;border:1px solid #a9a9b0;border-radius:14px;background:linear-gradient(180deg,#fbfbfc 0%,#e3e3e7 55%,#d3d3d9 100%);color:#3a3a40;font:inherit;font-size:15px;font-weight:500;text-decoration:none;text-align:left;cursor:pointer;box-shadow:0 3px 7px rgba(30,30,40,0.2),0 1px 2px rgba(30,30,40,0.16),inset 0 1px 0 #fff;transition:transform .12s,box-shadow .12s;}
  .hub-btn:hover{background:linear-gradient(180deg,#ffffff 0%,#ececf0 55%,#dcdce2 100%);box-shadow:0 5px 11px rgba(30,30,40,0.26),0 1px 3px rgba(30,30,40,0.2),inset 0 1px 0 #fff;transform:translateY(-1px);}
  .hub-btn:active{transform:translateY(1px);box-shadow:inset 0 2px 4px rgba(30,30,40,0.3);}
  .hub-ico{flex-shrink:0;}
  .hub-label{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;}
  .hub-zh{font-size:12px;font-weight:400;color:#6b665b;}
  .hub-tag{font-size:12px;color:#8a867b;}
  .hub-btn.is-locked{color:#55555c;}
  .hub-btn.is-disabled{opacity:.55;cursor:default;pointer-events:none;box-shadow:0 1px 2px rgba(30,30,40,0.12);}
  .hub-preview{background:linear-gradient(180deg,#ffffff 0%,#f0f5fa 100%);border-color:#b7c4d6;margin:14px 0 16px;}
  .hub-empty{color:#8a867b;text-align:center;margin-top:28px;}
  .hub-modal{position:fixed;inset:0;z-index:60;background:rgba(20,20,26,0.55);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Montserrat,-apple-system,"system-ui","Segoe UI",Roboto,sans-serif;}
  .hub-modal[hidden]{display:none;}
  .hub-modal-card{position:relative;background:#fff;color:#2b2b30;border-radius:16px;max-width:400px;width:100%;padding:30px 24px 20px;box-shadow:0 20px 50px rgba(0,0,0,0.35);text-align:center;}
  .hub-modal-card h2{margin:0 0 6px;font-family:Fraunces,Georgia,serif;font-weight:500;font-size:22px;}
  .hub-modal-card h2 span{display:block;font-family:Montserrat,-apple-system,sans-serif;font-size:13px;font-weight:400;color:#8a867b;margin-top:2px;}
  .hub-fee{margin:14px 0 18px;font-size:26px;font-weight:600;letter-spacing:.01em;}
  .hub-fee span{font-size:12px;font-weight:400;color:#8a867b;}
  .hub-pay{display:block;width:100%;box-sizing:border-box;margin:0 0 10px;padding:14px 16px;border:0;border-radius:12px;background:#4a7ab5;color:#fff;font:inherit;font-weight:600;font-size:15px;text-decoration:none;cursor:pointer;}
  .hub-pay span{font-weight:400;font-size:12px;opacity:.85;margin-left:6px;}
  .hub-pay:hover{background:#3f6ba1;}
  .hub-pay.is-alt{background:#5f8f6b;}
  .hub-pay.is-alt:hover{background:#527d5d;}
  .hub-emt-to{margin:8px 0 2px;font-size:12px;color:#8a867b;}
  .hub-emt-mail{margin:0;font-size:18px;font-weight:600;word-break:break-all;}
  .hub-emt-note{margin:2px 0 14px;font-size:12px;color:#b3541e;}
  .hub-copy,.hub-back{border:1px solid #c9c9d0;background:#fff;color:#3a3a40;border-radius:10px;padding:9px 16px;font:inherit;font-size:13px;cursor:pointer;}
  .hub-back{border:0;color:#6b665b;margin-top:6px;}
  .hub-after{font-size:12px;line-height:1.5;color:#8a867b;margin:14px 0 4px;}
  .hub-close{position:absolute;top:8px;right:12px;border:0;background:none;color:#8a867b;font-size:26px;line-height:1;cursor:pointer;}
  @media (prefers-color-scheme: dark){
    body{background:#0d0d10;}
    .mail{color:#d7d7dc;}
    .mail-card{background:#1c1c20;box-shadow:none;}
    .mail-addr{color:#f2f2f7;}
    .mail-rule{border-color:#33333a;}
    .hub-modal-card{background:#1c1c20;color:#f2f2f7;}
    .hub-copy{background:#26262b;color:#f2f2f7;border-color:#3a3a40;}
  }
`;

function hubScript(openKey, base) {
  return `
(function(){
  var modal=document.getElementById('hubModal'), choose=document.getElementById('hubChoose'), emt=document.getElementById('hubEmtPanel');
  function show(panel){ choose.hidden=panel!=='choose'; emt.hidden=panel!=='emt'; }
  function open(){ show('choose'); modal.hidden=false; }
  function close(){ modal.hidden=true; }
  document.querySelectorAll('.hub-btn.is-locked').forEach(function(b){ b.addEventListener('click', open); });
  var pn=document.getElementById('hubPayNow'); if(pn){ pn.addEventListener('click', function(e){ if(pn.tagName==='A'){ watch(); } else { open(); } }); }
  var el=document.getElementById('hubEmtLink'); if(el){ el.addEventListener('click', function(){ show('emt'); modal.hidden=false; }); }
  document.getElementById('hubClose').addEventListener('click', close);
  document.getElementById('hubEmt').addEventListener('click', function(){ show('emt'); });
  document.getElementById('hubBack').addEventListener('click', function(){ show('choose'); });
  document.getElementById('hubCopy').addEventListener('click', function(){
    var b=this, t=document.getElementById('hubMail').textContent, done=function(){ b.textContent='Copied 已复制'; };
    if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(done,function(){}); }
  });
  // Auto-unlock: once the visitor has clicked "Pay by credit card" (Wave then tells our server the moment
  // it is paid), ask OUR server every 5s whether the Job is paid/unlocked, and check at once whenever they
  // switch back to this tab -- when it is, go to the hub itself (now unlocked). No manual refresh. Not
  // started for e-Transfer: that is confirmed by Franky by hand, possibly hours later.
  var statusUrl=${JSON.stringify(base + '/status').replace(/</g, '\\u003c')}, timer=null;
  function check(){
    fetch(statusUrl,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){ if(j&&j.unlocked) location.replace(${JSON.stringify(base).replace(/</g, '\\u003c')}); }).catch(function(){});
  }
  function watch(){ if(!timer){ timer=setInterval(check,5000); } check(); }
  var card=document.getElementById('hubCard'); if(card){ card.addEventListener('click', watch); }
  document.addEventListener('visibilitychange', function(){ if(!document.hidden && timer) check(); });
  window.addEventListener('focus', function(){ if(timer) check(); });
  modal.addEventListener('click', function(e){ if(e.target===modal) close(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
  ${openKey ? 'open();' : ''}
})();`;
}
