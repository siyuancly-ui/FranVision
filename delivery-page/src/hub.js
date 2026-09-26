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

import { escapeHtml, page, slugifyAddress, deliveryPath } from './render.js';
import { BRAND_ASSETS, HUB_HEAD, HUB_CSS, INVOICE_CSS, ICONS, LINE_ICON } from './hub-theme.js';
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

// The invoice PDF we are willing to fetch on the visitor's behalf: https, and only from Wave's own PDF host
// (the value comes from the database, never from the request, and this keeps it from ever being an open fetch).
export function pdfSourceUrl(row) {
  const u = safeUrl(row && row.wave_pdf_url);
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'accounting.waveapps.com' ? u : '';
  } catch {
    return '';
  }
}

export function isUnlocked(row) {
  return Boolean(row && (row.paid || row.unlocked));
}

// What is still owed after a PARTIAL Wave payment (from the last partially_paid webhook), in cents; null when
// there is no partial payment on record or the Job is already unlocked/paid.
export function remainingCents(row) {
  if (!row || isUnlocked(row)) return null;
  return Number.isFinite(row.wave_remaining_cents) && row.wave_remaining_cents > 0 ? row.wave_remaining_cents : null;
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
    // Really paid (not merely unlocked for a deliver-first client): decides the invoice/receipt button and copy.
    paid: Boolean(row.paid),
    payUrl: safeUrl(row.wave_view_url),
    // The invoice on its own (PDF export, no payment page); falls back to Wave's combined page.
    invoiceUrl: safeUrl(row.wave_pdf_url) || safeUrl(row.wave_view_url),
    hasInvoicePdf: Boolean(pdfSourceUrl(row)),
    totalCents: Number.isFinite(row.total_cents) ? row.total_cents : null,
    preTaxCents: Number.isFinite(row.pretax_cents) ? row.pretax_cents : null,
    remainingCents: remainingCents(row),
    partialPaidCents: remainingCents(row) != null && Number.isFinite(row.wave_paid_cents) ? row.wave_paid_cents : null,
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

const disc = (name) => `<span class="hub-ico">${ICONS[name]}</span>`;
const go = (name) => `<span class="hub-go">${ICONS[name]}</span>`;

// What to ask for: after a PARTIAL Wave payment the remainder, otherwise the invoice total.
function amountHtml(model) {
  return model.remainingCents != null
    ? `<p class="hub-fee">${money(model.remainingCents)} <span>remaining 剩余未付</span></p>`
    : (model.totalCents != null ? `<p class="hub-fee">${money(model.totalCents)} <span>incl. HST</span></p>` : '');
}

// The e-Transfer instructions, shared by the pay dialog and the invoice page.
function emtDetailsHtml() {
  return `<p class="hub-emt-to">Send to</p>
      <p class="hub-emt-mail" id="hubMail">frankystudio@mail.com</p>
      <p class="hub-emt-note">Not Gmail 不是 Gmail</p>
      <button class="hub-copy" id="hubCopy" type="button">Copy email 复制邮箱</button>
      <p class="hub-after">Then let Franky know or send a screenshot — we'll unlock this page. 付款后请告知 Franky 或发截图。</p>`;
}

// The invoice on its own page: the PDF shown inline (served through our Worker, see index.js) with a Download
// button, and -- while unpaid -- a way back to the payment choices.
export function renderInvoicePage(model, { base }) {
  // While unpaid, the payment entry sits at the TOP (a Pay button next to Download that opens a small panel right
  // under the bar) and nowhere else on the page: credit card goes straight to Wave's pay page, e-Transfer unfolds
  // the instructions in place (no trip back to the hub, nothing repeated at the bottom).
  const payBtn = model.paid ? '' : `<button class="hub-cta inv-paybtn" id="invPayBtn" type="button">Pay 付款</button>`;
  const panel = model.paid ? '' : `
  <div class="inv-pay" id="invPayPanel" hidden>
    ${amountHtml(model)}
    <div class="inv-pay-btns">
      ${model.payUrl ? `<a class="hub-pay" id="hubCard" href="${escapeHtml(model.payUrl)}" target="_blank" rel="noopener">Pay by credit card <span>信用卡</span></a>` : ''}
      <button class="hub-pay is-alt" id="hubEmt" type="button">Pay by e-Transfer <span>EMT 转账</span></button>
    </div>
    <div class="inv-emt" id="hubEmtPanel" hidden>
      ${emtDetailsHtml()}
    </div>
  </div>`;
  const title = model.address ? `Invoice — ${model.address}` : 'Invoice';
  const body = `
<main class="inv">
  <img class="inv-logo" src="${BRAND_ASSETS.logo}" alt="FranVision Media 法兰视觉" width="960" height="616">
  <div class="inv-bar">
    <a class="inv-back" href="${escapeHtml(base)}">&larr; Back 返回</a>
    <span class="inv-title">Invoice 发票</span>
    ${payBtn}
    <a class="hub-cta inv-dl${model.paid ? '' : ' is-ghost'}" href="${escapeHtml(base)}/invoice.pdf?download=1">Download PDF 下载</a>
  </div>
  ${panel}
  <iframe class="inv-frame" title="Invoice" src="${escapeHtml(base)}/invoice.pdf#view=FitH"></iframe>
  <p class="inv-fallback">Can't see the invoice? <a href="${escapeHtml(base)}/invoice.pdf?download=1">Download it 下载发票</a></p>
</main>`;
  return page(title, body, { bare: true, extraHead: HUB_HEAD, extraCss: HUB_CSS + INVOICE_CSS, extraBody: model.paid ? '' : `<script>${invoiceScript(base)}</script>` });
}



// Small themed message pages (no brand marks: they are also what a bad/forwarded client link lands on).
// heading/text are fixed strings written in this file, so they are not escaped.
function messagePage(title, heading, text, backHref) {
  return page(title, `
<main class="nf">
  <h1>${heading}</h1>
  <p>${text}</p>
  ${backHref ? `<p><a href="${escapeHtml(backHref)}">&larr; Back</a></p>` : ''}
</main>`, { bare: true, extraHead: HUB_HEAD, extraCss: HUB_CSS + NF_CSS });
}

const NF_CSS = `
  .nf{max-width:520px;margin:18vh auto 0;padding:0 24px;text-align:center;font-family:var(--sans);color:var(--ink);}
  .nf h1{font-family:var(--serif);font-weight:500;font-size:28px;margin:0 0 12px;}
  .nf p{margin:0 0 10px;color:#55524a;line-height:1.6;}
  .nf a{color:var(--gold-deep);}
`;

export function renderNotFoundHub() {
  return messagePage('Delivery', "This delivery link isn't valid", 'Please use the link from your delivery email, or reach out to Franky directly.');
}

export function renderNotReadyHub(backHref) {
  return messagePage('Delivery', "This item isn't ready yet", "It's still being prepared. Please try again shortly, or reach out to Franky.", backHref);
}

// The forwardable "client view" (?for=client on the same hub URL): ONLY the part below the divider -- the
// All in One button, the address and the download buttons. No greeting, fee, invoice, payment, dialog, brand
// mark, sign-off or credit line (the agent forwards this link to their own client and it must not show what the
// agent paid). While the Job is not unlocked the download buttons are inert with a "contact your agent" note --
// never the pay dialog, which would expose the price. Every link on it carries ?for=client, and nothing on it
// links to the full page. (Anyone who deletes the parameter gets the full page: this is a convenience view, not
// a security boundary -- decided 2026-09-25.)
const CLIENT_QS = '?for=client';

export function renderClientView(model, { base }) {
  const buttons = model.lines.map((l) => {
    const note = l.noteEn ? ` <span class="hub-note">(${escapeHtml(l.noteEn)} ${escapeHtml(l.noteZh)})</span>` : '';
    const label = `<span class="hub-label">${escapeHtml(l.en)}${note}<span class="hub-zh">${escapeHtml(l.zh)}</span></span>`;
    const ico = disc(LINE_ICON[l.key] || 'doc');
    if (!model.unlocked) return `<span class="hub-btn is-disabled">${ico}${label}${go('lock')}</span>`;
    if (!l.ready) return `<span class="hub-btn is-disabled" title="Still being prepared">${ico}${label}<span class="hub-tag">Preparing&hellip;</span></span>`;
    return `<a class="hub-btn" href="${base}/go/${l.key}${CLIENT_QS}" target="_blank" rel="noopener">${ico}${label}${go('download')}</a>`;
  });
  // The virtual tour link is one more item in the same (gated) list, after the downloads.
  const tourLabel = `<span class="hub-label">All in One Virtual Tour URL<span class="hub-zh">在线浏览</span></span>`;
  buttons.push(model.unlocked
    ? `<a class="hub-btn" href="${escapeHtml(model.allInOnePath)}" target="_blank" rel="noopener">${disc('eye')}${tourLabel}${go('arrow')}</a>`
    : `<span class="hub-btn is-disabled">${disc('eye')}${tourLabel}${go('lock')}</span>`);

  // Same cards as the full page, but none of the brand pieces (no logo, tagline, hero image, sign-off, signature).
  const body = `
<main class="wrap is-plain">
  ${model.address ? `<h1 class="mail-addr">${escapeHtml(model.address)}</h1>` : ''}
  <p class="mail-note">For the best experience, please open in a browser on PC or Mac.<span class="mail-zh">请在 PC 或 Mac 上使用浏览器打开效果最佳。</span></p>
  ${model.lines.length ? `<div class="hub-list">\n${buttons.join('\n')}\n</div>` : '<p class="hub-empty">Nothing to download yet.</p>'}
  ${model.unlocked || !model.lines.length ? '' : '<p class="mail-note">Downloads are not available yet — please contact your agent.<span class="mail-zh">下载暂未开放，请联系您的经纪。</span></p>'}
</main>`;
  return page(model.address || 'Downloads', body, { bare: true, extraHead: HUB_HEAD, extraCss: HUB_CSS });
}

// base = "/deliver/<slug>/<token>" (already encoded); openKey = a locked key to
// open the dialog for right away (arrives via /go/<KEY> hit while locked).
export function renderHubPage(model, { base, openKey = '' }) {
  const buttons = model.lines.map((l) => {
    const note = l.noteEn ? ` <span class="hub-note">(${escapeHtml(l.noteEn)} ${escapeHtml(l.noteZh)})</span>` : '';
    const label = `<span class="hub-label">${escapeHtml(l.en)}${note}<span class="hub-zh">${escapeHtml(l.zh)}</span></span>`;
    const ico = disc(LINE_ICON[l.key] || 'doc');
    if (!l.ready && model.unlocked) {
      return `<span class="hub-btn is-disabled" title="Still being prepared">${ico}${label}<span class="hub-tag">Preparing&hellip;</span></span>`;
    }
    if (model.unlocked) {
      return `<a class="hub-btn" href="${base}/go/${l.key}" target="_blank" rel="noopener">${ico}${label}${go('download')}</a>`;
    }
    return `<button class="hub-btn is-locked" type="button" data-key="${l.key}">${ico}${label}${go('lock')}</button>`;
  });
  // The free preview at the top stays; the same page is repeated last in the list, locked with the rest.
  if (model.lines.length) {
    const tourLabel = `<span class="hub-label">All in One Virtual Tour URL<span class="hub-zh">在线浏览</span></span>`;
    buttons.push(model.unlocked
      ? `<a class="hub-btn" href="${escapeHtml(model.allInOnePath)}" target="_blank" rel="noopener">${disc('eye')}${tourLabel}${go('arrow')}</a>`
      : `<button class="hub-btn is-locked" type="button" data-key="ALLINONE">${disc('eye')}${tourLabel}${go('lock')}</button>`);
  }

  // After a partial payment the dialog asks for what is STILL owed, not the full total again.
  const amount = amountHtml(model);
  const cardBtn = model.payUrl
    ? `<a class="hub-pay" id="hubCard" href="${escapeHtml(model.payUrl)}" target="_blank" rel="noopener">Pay by credit card <span>信用卡</span></a>`
    : '';
  // The invoice can be read on its own first (PDF), whichever way the client then pays.
  // Our own invoice page (shows the PDF, with a Download button) when we hold Wave's PDF link; otherwise Wave's page.
  const viewHref = model.hasInvoicePdf ? `${base}/invoice` : model.invoiceUrl;
  const viewBtn = viewHref
    ? `<a class="hub-pay is-ghost" id="hubView" href="${escapeHtml(viewHref)}" target="_blank" rel="noopener">View invoice <span>查看发票</span></a>`
    : '';
  const dialog = model.paid ? '' : `
<div class="hub-modal" id="hubModal" hidden role="dialog" aria-modal="true" aria-labelledby="hubModalTitle">
  <div class="hub-modal-card">
    <div id="hubChoose">
      <h2 id="hubModalTitle">Invoice &amp; payment <span>发票与付款</span></h2>
      ${amount}
      ${viewBtn}
      ${cardBtn}
      <button class="hub-pay is-alt" id="hubEmt" type="button">Pay by e-Transfer <span>EMT 转账</span></button>
    </div>
    <div id="hubEmtPanel" hidden>
      <h2>Pay by e-Transfer <span>EMT 转账</span></h2>
      ${amount}
      ${emtDetailsHtml()}
      <button class="hub-back" id="hubBack" type="button">&larr; Back 返回</button>
    </div>
    <button class="hub-close" id="hubClose" type="button" aria-label="Close">&times;</button>
  </div>
</div>`;

  const who = model.clientName ? escapeHtml(model.clientName) : '';
  const addr = model.address ? escapeHtml(model.address) : 'your property';
  const fee = model.totalCents != null && model.preTaxCents != null
    ? `<p class="mail-fee">Fee 费用: <strong>${preTaxMoney(model.preTaxCents)} + HST = ${money(model.totalCents)}</strong></p>` : '';
  // A partial Wave payment does NOT unlock; the page says what came in and what is still owed.
  const partial = model.remainingCents != null
    ? `<p class="mail-partial">${model.partialPaidCents != null ? `Paid ${money(model.partialPaidCents)}, ` : ''}<strong>${money(model.remainingCents)} more</strong> to unlock downloads.<span class="mail-zh">${model.partialPaidCents != null ? `已付 ${money(model.partialPaidCents)}，` : ''}还需支付 <strong>${money(model.remainingCents)}</strong> 才能解锁下载。</span></p>` : '';

  // ONE blue button for everything money-related. Until the Job is PAID it opens the dialog where the client
  // can read the invoice (PDF, no payment page) and then choose Wave credit card or Interac e-Transfer (Wave's
  // own page has no Interac, and its bank-EFT option is not used). Once PAID it becomes a green link to Wave's
  // public invoice page (`wave_view_url`), which for a paid invoice offers Print / Download PDF (marked paid) /
  // a Receipts menu -- for card payments AND for payments Franky records by hand in Wave (e-Transfer) -- so the
  // client saves their own invoice and receipt without asking Franky. (A deliver-first "unlocked" but unpaid Job
  // still gets the pay button.)
  const paidLink = model.payUrl || model.invoiceUrl;
  const payBtn = model.paid
    ? (paidLink ? `<a class="hub-cta is-paid" href="${escapeHtml(paidLink)}" target="_blank" rel="noopener">${ICONS.doc}Invoice &amp; receipt 发票与收据 ${ICONS.check}</a>` : '')
    : `<button class="hub-cta" id="hubPayNow" type="button">${ICONS.doc}View invoice &amp; pay 查看发票并付款</button>`;

  // The wording is the Delivery Email's own (job-generator/delivery-email-template.{en,zh}.txt), so the page
  // reads like the email it replaces -- keep the two in step if the email's wording changes.
  const status = model.paid
    ? `<div class="notice"><span class="notice-ico">${ICONS.checkBold}</span><div><p><strong>Payment received — thank you!</strong> Your files are ready below, and you can save your invoice and receipt with the button.</p><p class="notice-zh">已收到付款，谢谢！下面的文件都可以下载了，发票和收据可以通过按钮自行保存。</p></div></div>`
    : (model.unlocked
      ? `<div class="notice is-due"><span class="notice-ico">${ICONS.checkBold}</span><div><p>Your files are ready below. Payment is still due — thank you!</p><p class="notice-zh">下面的文件已可下载，请尽快完成付款，谢谢！</p></div></div>`
      : '<p class="plain">You can preview the photos above. To download the files, please complete payment first.<span class="mail-zh">您可以先预览照片；需要下载文件的话，请先支付费用。</span></p>');

  const body = `
<div class="stage">
  <div class="hero-bg" aria-hidden="true"></div>
  <main class="wrap">
    <header class="brand">
      <img class="brand-logo" src="${BRAND_ASSETS.logo}" alt="FranVision Media 法兰视觉" width="960" height="616">
      <p class="brand-tag">PREMIUM REAL ESTATE MEDIA</p>
      <p class="brand-tag-zh">专业房产影像服务</p>
    </header>
    <h1 class="greet">Hello${who ? ` ${who}` : ''},</h1>
    <p class="lead">Your photos for <strong class="lead-addr">${addr}</strong> are ready — thank you for your patience.</p>
    <p class="zh">${model.address ? `${escapeHtml(model.address)} 的` : ''}照片已经制作完成，感谢您的耐心等待。</p>
    <a class="hub-btn hub-preview" href="${escapeHtml(model.allInOnePath)}" target="_blank" rel="noopener">${disc('eye')}<span class="hub-label">Preview All in One<span class="hub-zh">在线预览</span></span>${go('arrow')}</a>
    ${status}
    ${fee}
    ${partial}
    <div class="cta-row">${payBtn}</div>
    <hr class="mail-rule">
    ${model.address ? `<h1 class="mail-addr">${escapeHtml(model.address)}</h1>` : ''}
    <p class="mail-note">For the best experience, please open in a browser on PC or Mac. Thank you so much for your support!<span class="mail-zh">请在 PC 或 Mac 上使用浏览器打开效果最佳，感谢您的支持与厚爱！</span></p>
    ${model.lines.length ? `<div class="hub-list">\n${buttons.join('\n')}\n</div>` : '<p class="hub-empty">Nothing to download yet.</p>'}
    <footer class="sign">
      <p class="sign-text">Thank you!<br>Franky<br>FranVision Media</p>
      <img class="sign-img" src="${BRAND_ASSETS.signature}" alt="Capture More Than a Home" width="700" height="237">
    </footer>
    <div class="mail-share"><button class="hub-share" id="hubShare" type="button">${ICONS.share}Share downloads with your client (no prices) 分享给客户（不含价格）</button></div>
  </main>
</div>
${dialog}`;

  return page(model.address ? `${model.address} — Delivery` : 'Delivery', body, {
    bare: true,
    extraHead: HUB_HEAD,
    extraCss: HUB_CSS,
    extraBody: `<script>${shareScript(base)}</script>` + (model.paid ? '' : `<script>${hubScript(openKey, base, model.remainingCents, model.unlocked)}</script>`),
  });
}

// "Share downloads with your client": copies THIS hub's URL with ?for=client (the client view above) -- built from
// the address bar, so it is the real absolute link.
function shareScript(base) {
  return `
(function(){
  var b=document.getElementById('hubShare'); if(!b){ return; }
  b.addEventListener('click', function(){
    var url=location.origin+${JSON.stringify(base).replace(/</g, '\\u003c')}+'?for=client', done=function(){ b.textContent='Link copied 已复制链接'; };
    if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(url).then(done,function(){ prompt('Copy link:', url); }); } else { prompt('Copy link:', url); }
  });
})();`;
}

// Invoice page: e-Transfer unfolds in place, and once the visitor has clicked "Pay by credit card" the page asks
// OUR server every 5s (and on tab focus) whether the Job is paid -- when it is, it goes to the hub (now unlocked).
function invoiceScript(base) {
  return `
(function(){
  var pay=document.getElementById('invPayPanel');
  document.getElementById('invPayBtn').addEventListener('click', function(){ pay.hidden=!pay.hidden; });
  var panel=document.getElementById('hubEmtPanel');
  document.getElementById('hubEmt').addEventListener('click', function(){ panel.hidden=!panel.hidden; });
  var copy=document.getElementById('hubCopy');
  copy.addEventListener('click', function(){
    var t=document.getElementById('hubMail').textContent, done=function(){ copy.textContent='Copied 已复制'; };
    if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(done,function(){}); }
  });
  var hub=${JSON.stringify(base).replace(/</g, '\\u003c')}, statusUrl=hub+'/status', timer=null;
  function check(){
    fetch(statusUrl,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){ if(j&&j.paid) location.replace(hub); }).catch(function(){});
  }
  function watch(){ if(!timer){ timer=setInterval(check,5000); } check(); }
  var card=document.getElementById('hubCard'); if(card){ card.addEventListener('click', watch); }
  document.addEventListener('visibilitychange', function(){ if(!document.hidden && timer) check(); });
  window.addEventListener('focus', function(){ if(timer) check(); });
})();`;
}

function hubScript(openKey, base, remaining, unlockedNow) {
  return `
(function(){
  var modal=document.getElementById('hubModal'), choose=document.getElementById('hubChoose'), emt=document.getElementById('hubEmtPanel');
  function show(panel){ choose.hidden=panel!=='choose'; emt.hidden=panel!=='emt'; }
  function open(){ show('choose'); modal.hidden=false; }
  function close(){ modal.hidden=true; }
  document.querySelectorAll('.hub-btn.is-locked').forEach(function(b){ b.addEventListener('click', open); });
  var pn=document.getElementById('hubPayNow'); if(pn){ pn.addEventListener('click', open); }
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
    fetch(statusUrl,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){ if(j&&!j.unlocked&&(j.remainingCents||null)!==${JSON.stringify(remaining == null ? null : remaining)}){ location.reload(); return; } if(j&&(j.paid||(j.unlocked&&!${unlockedNow ? 'true' : 'false'}))) location.replace(${JSON.stringify(base).replace(/</g, '\\u003c')}); }).catch(function(){});
  }
  function watch(){ if(!timer){ timer=setInterval(check,5000); } check(); }
  var card=document.getElementById('hubCard'); if(card){ card.addEventListener('click', watch); }
  var vw=document.getElementById('hubView'); if(vw){ vw.addEventListener('click', watch); }
  document.addEventListener('visibilitychange', function(){ if(!document.hidden && timer) check(); });
  window.addEventListener('focus', function(){ if(timer) check(); });
  modal.addEventListener('click', function(e){ if(e.target===modal) close(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
  ${openKey ? 'open();' : ''}
})();`;
}
