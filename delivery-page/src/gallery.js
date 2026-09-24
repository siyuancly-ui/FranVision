// The standalone Gallery page: /delivery/<address-slug>/<token>.
//
// A separate page from the delivery page ("All in One") -- that page does not
// link here; the link only goes into the post-payment part of the Delivery
// Email (job-generator/delivery-email.js). Delivery is gated on payment, so the
// URL must not be guessable from the sequential jobId (FVS-YYYYMMDD-NNN):
// `token` is a random 128-bit value (32 hex) minted server-side, once per Job,
// by Supabase's jg_gallery_token() (job-generator/supabase/gallery.sql) and
// resolved back to the jobId here via the gallery_tokens table
// (supabase.js#getGalleryJobId). Nothing is derived from the jobId, and no
// signing secret exists on any machine. The address slug is cosmetic only and
// never inspected, same as the delivery page's pretty URL.
//
// Pure like render.js: index.js hands in the raw `projects` row, everything
// here is string building, unit-tested without a network.

import { buildDeliveryModel, creditHtml, escapeHtml, heroHtml, page, slugifyAddress } from './render.js';

// Cheap shape check before any database lookup (rejects raw jobIds, junk, and
// anything that could be a query-string injection attempt).
export function isGalleryToken(token) {
  return typeof token === 'string' && /^[0-9a-f]{32}$/.test(token);
}

// "/delivery/<address-slug>/<token>" -- what the Delivery Email links to.
export function galleryPath(address, token) {
  return `/delivery/${slugifyAddress(address) || 'photos'}/${token}`;
}

const DEFAULT_ASPECT = 1.5;

// opts = the same folder config buildDeliveryModel takes (hero/address/photo
// selection are reused as-is, so the Gallery hero always matches the delivery
// page's), plus jobId/supabaseUrl.
export function buildGalleryModel(project, opts) {
  const base = buildDeliveryModel(project, opts);
  const raw = (project && project.data && project.data.photos) || [];
  const byId = new Map(raw.map((p) => [p.photoId, p]));
  const inGrid = base.gallery.map((g) => byId.get(g.photoId)).filter(Boolean);
  return {
    found: base.found,
    jobId: opts.jobId,
    address: base.address,
    hero: base.hero,
    photos: base.gallery.map((g) => ({
      photoId: g.photoId,
      url: g.url,
      aspect: g.width > 0 && g.height > 0 ? g.width / g.height : DEFAULT_ASPECT,
      hasWeb: Boolean((byId.get(g.photoId) || {}).downloadDropboxPath),
    })),
    // The grid IS the source of truth for the ZIPs: the download route sends
    // exactly these ids to photo-sync-worker, so a ZIP can never disagree with
    // what the page shows (no second folder list to keep in sync).
    photoIds: base.gallery.map((g) => g.photoId),
    // A ZIP is offered only when EVERY photo in the grid can go into it -- never
    // a silently smaller archive. Originals need just the synced file; the MLS
    // ZIP also needs each photo's 2048px copy (written a little after the photo
    // syncs, self-healing via photo-sync-worker's retry cron), so right after an
    // upload the MLS button shows "preparing" and turns on by itself.
    originalReady: inGrid.length > 0 && inGrid.every((p) => p.dropboxPath),
    mlsReady: inGrid.length > 0 && inGrid.every((p) => p.downloadDropboxPath),
  };
}

export function zipFilename(address, jobId, kind) {
  const slug = slugifyAddress(address) || jobId;
  return `${slug}-${kind === 'mls' ? 'mls' : 'original'}-photos.zip`;
}

export function renderGalleryNotFoundPage() {
  return page('Gallery', `
<div class="notfound">
  <p class="eyebrow">FranVision Media</p>
  <h1>This gallery link isn't valid</h1>
  <p>Please use the link from your delivery email, or reach out to Franky directly.</p>
</div>`, { bare: true });
}

// Shown instead of a download when the photos/ZIP aren't ready (or a lookup
// hiccuped). Deliberately plain and reassuring -- clients are not technical.
export function renderGalleryPreparingPage(backHref) {
  return page('Gallery', `
<div class="notfound">
  <p class="eyebrow">Photos</p>
  <h1>Your download is still being prepared</h1>
  <p>This usually takes just a few minutes after your photos are uploaded. Please try again shortly.</p>
  ${backHref ? `<p><a href="${escapeHtml(backHref)}">&larr; Back to the gallery</a></p>` : ''}
</div>`, { bare: true });
}

// Button/photo URLs hang off this page's own path (`base`, i.e.
// galleryPath(address, token)), so the token travels in the URL, never a query.
export function renderGalleryPage(model, { base }) {
  const buttons = [];
  if (model.photos.length > 0) {
    buttons.push(model.originalReady
      ? `<a class="dl-btn" href="${base}/zip/original" data-dl>Download All Original Photos (ZIP)</a>`
      : '<span class="dl-btn is-disabled" title="Still preparing -- please check back in a few minutes">Preparing Original Photos&hellip;</span>');
    buttons.push(model.mlsReady
      ? `<a class="dl-btn" href="${base}/zip/mls" data-dl>Download All MLS Photos (ZIP)</a>`
      : '<span class="dl-btn is-disabled" title="Still preparing -- please check back in a few minutes">Preparing MLS Photos&hellip;</span>');
  }

  // Layout follows the Zenfolio sample the studio already uses: full-height
  // hero (big serif address bottom-right, scroll chevron; no brand text up here;
  // the "Photos by" credit is the page footer), then a sticky bar -- address left, the
  // download buttons right (where the sample has its icons).
  const heroExtra = `<a class="hero-chevron" href="#photos" aria-label="Scroll to photos"><svg viewBox="0 0 56 24" width="56" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3l26 17L54 3"/></svg></a>`;
  const bar = `<header class="g-bar">
  <div class="g-bar-inner">
    <div class="g-bar-title">${model.address ? `<div class="g-bar-addr">${escapeHtml(model.address)}</div>` : ''}</div>
    ${buttons.length ? `<div class="g-bar-actions">${buttons.join('')}</div>` : ''}
  </div>
</header>`;

  const figures = model.photos.map((p, i) =>
    `<figure class="g-item" data-i="${i}" style="aspect-ratio:${p.aspect.toFixed(4)}"><img src="${escapeHtml(p.url)}" alt="" loading="${i < 9 ? 'eager' : 'lazy'}" decoding="async"></figure>`,
  ).join('\n');

  // Lightbox data: thumb shows instantly, the 2048 web copy loads over it.
  const data = model.photos.map((p) => ({ t: p.url, w: p.hasWeb ? `${base}/photo/${p.photoId}` : null }));

  const body = `
${heroHtml(model, heroExtra)}
${bar}
<main class="g-wrap" id="photos">
  ${model.photos.length ? `<div class="g-masonry" id="masonry">\n${figures}\n</div>` : '<p class="g-empty">Photos are still being prepared — please check back shortly.</p>'}
</main>
${creditHtml()}
<div class="lb" id="lb" hidden>
  <button class="lb-close" id="lbClose" aria-label="Close">&times;</button>
  <button class="lb-nav lb-prev" id="lbPrev" aria-label="Previous photo">&#8249;</button>
  <img id="lbImg" src="" alt="">
  <button class="lb-nav lb-next" id="lbNext" aria-label="Next photo">&#8250;</button>
  <div class="lb-count" id="lbCount"></div>
</div>`;

  return page(model.address ? `${model.address} — Photos` : 'Photos', body, {
    bare: true,
    extraHead: GALLERY_HEAD,
    extraCss: GALLERY_CSS,
    extraBody: `<script>window.__GALLERY__=${JSON.stringify(data).replace(/</g, '\\u003c')};</script>\n<script>${GALLERY_SCRIPT}</script>`,
  });
}

const GALLERY_HEAD = '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Montserrat:wght@300;400;500&display=swap" rel="stylesheet">';

const GALLERY_CSS = `
  html{scroll-behavior:smooth;}
  .hero{height:85vh;height:85svh;min-height:420px;}
  .hero-address{font-family:Fraunces,Georgia,"Times New Roman",serif;font-weight:400;font-size:clamp(26px,3.2vw,56px);line-height:1.15;right:9%;bottom:12%;left:9%;text-align:right;text-shadow:0 2px 16px rgba(0,0,0,0.4);}
  .hero-chevron{position:absolute;left:50%;bottom:22px;z-index:2;transform:translateX(-50%);color:#fff;opacity:.9;line-height:0;}
  .hero-chevron:hover{opacity:1;}
  .g-bar{position:sticky;top:0;z-index:20;background:rgba(251,251,253,0.96);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-bottom:1px solid rgba(35,33,28,0.10);}
  .g-bar-inner{max-width:1180px;margin:0 auto;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:20px;}
  .g-bar-addr{font-family:Montserrat,-apple-system,sans-serif;font-weight:300;font-size:clamp(15px,1.6vw,22px);letter-spacing:.02em;text-transform:uppercase;color:#4a473f;line-height:1.25;}
  .g-bar-actions{display:flex;gap:10px;flex-shrink:0;}
  .dl-btn{display:inline-block;padding:10px 18px;border:1px solid #5b574d;border-radius:999px;background:transparent;color:#3a372f;font-family:Montserrat,-apple-system,sans-serif;font-size:13px;font-weight:500;letter-spacing:.01em;text-decoration:none;white-space:nowrap;transition:background .15s,color .15s;}
  .dl-btn:hover{background:#3a372f;color:#fff;}
  .dl-btn.is-busy{opacity:.6;pointer-events:none;}
  .dl-btn.is-disabled{opacity:.45;cursor:default;pointer-events:none;}
  #photos{scroll-margin-top:84px;}
  .g-wrap{max-width:1180px;margin:0 auto;padding:8px 8px 48px;}
  .g-masonry{column-count:3;column-gap:8px;}
  .g-masonry.is-laid-out{display:flex;gap:8px;align-items:flex-start;column-count:auto;}
  .g-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:8px;}
  .g-item{margin:0 0 8px;break-inside:avoid;background:#e6e4dc;cursor:zoom-in;overflow:hidden;}
  .is-laid-out .g-item{margin:0;}
  .g-item img{width:100%;height:100%;object-fit:cover;transition:opacity .2s;}
  .g-item:hover img{opacity:.92;}
  .g-empty{text-align:center;color:#6b665b;padding:64px 0;}
  .lb{position:fixed;inset:0;z-index:50;background:rgba(10,9,8,0.94);display:flex;align-items:center;justify-content:center;}
  .lb[hidden]{display:none;}
  .lb img{max-width:100vw;max-height:100vh;object-fit:contain;user-select:none;-webkit-user-drag:none;}
  .lb-close,.lb-nav{position:absolute;border:none;background:rgba(255,255,255,0.14);color:#fff;cursor:pointer;line-height:1;border-radius:50%;}
  .lb-close{top:18px;right:20px;width:42px;height:42px;font-size:26px;}
  .lb-nav{top:50%;transform:translateY(-50%);width:52px;height:52px;font-size:36px;padding-bottom:4px;}
  .lb-prev{left:18px;} .lb-next{right:18px;}
  .lb-close:hover,.lb-nav:hover{background:rgba(255,255,255,0.26);}
  .lb-count{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:rgba(255,255,255,0.7);font-size:13px;letter-spacing:.08em;}
  @media (max-width:900px){
    .g-bar-inner{flex-direction:column;align-items:flex-start;gap:12px;padding:14px 16px;}
    .g-bar-actions{width:100%;}
    .dl-btn{flex:1 1 0;text-align:center;white-space:normal;padding:9px 10px;font-size:12px;line-height:1.3;}
    #photos{scroll-margin-top:120px;}
  }
  @media (max-width:640px){
    .hero-address{right:6%;left:6%;bottom:14%;}
    .g-wrap{padding-inline:4px;}
    .lb-nav{width:40px;height:40px;font-size:28px;} .lb-prev{left:8px;} .lb-next{right:8px;}
  }
`;

// Masonry: photos go into the currently-shortest column (using each photo's
// known aspect ratio, so no layout shift as images load) -- keeps the shoot
// order reading left-to-right instead of CSS columns' top-to-bottom. Without
// JS the CSS `column-count` version above is the fallback.
const GALLERY_SCRIPT = `
(function(){
  var data = window.__GALLERY__ || [];
  var grid = document.getElementById('masonry');
  var items = grid ? Array.prototype.slice.call(grid.children) : [];
  var cols = 0;
  function colCount(){ var w = window.innerWidth; return w < 640 ? 2 : w < 1500 ? 3 : 4; }
  function layout(){
    if (!grid) return;
    var n = colCount();
    if (n === cols) return;
    cols = n;
    var heights = [], cs = [];
    for (var i = 0; i < n; i++) { heights.push(0); var c = document.createElement('div'); c.className = 'g-col'; cs.push(c); }
    items.forEach(function(el){
      var ar = parseFloat(el.style.aspectRatio) || 1.5, m = 0;
      for (var j = 1; j < n; j++) if (heights[j] < heights[m]) m = j;
      cs[m].appendChild(el); heights[m] += 1 / ar;
    });
    grid.textContent = '';
    cs.forEach(function(c){ grid.appendChild(c); });
    grid.classList.add('is-laid-out');
  }
  layout();
  var rt; window.addEventListener('resize', function(){ clearTimeout(rt); rt = setTimeout(layout, 120); });

  // Lightbox
  var lb = document.getElementById('lb'), img = document.getElementById('lbImg'), count = document.getElementById('lbCount');
  var cur = -1;
  function show(i){
    if (!data.length) return;
    cur = (i + data.length) % data.length;
    var d = data[cur];
    img.src = d.t; // thumb right away, sharper copy replaces it once loaded
    if (d.w) {
      var big = new Image(), at = cur;
      big.onload = function(){ if (cur === at) img.src = d.w; };
      big.src = d.w;
    }
    count.textContent = (cur + 1) + ' / ' + data.length;
    [cur + 1, cur - 1].forEach(function(k){ var n = data[(k + data.length) % data.length]; if (n && n.w) new Image().src = n.w; });
  }
  function open(i){ lb.hidden = false; document.body.style.overflow = 'hidden'; show(i); }
  function close(){ lb.hidden = true; document.body.style.overflow = ''; img.src = ''; cur = -1; }
  if (grid) grid.addEventListener('click', function(e){
    var f = e.target.closest ? e.target.closest('.g-item') : null;
    if (f) open(parseInt(f.getAttribute('data-i'), 10));
  });
  document.getElementById('lbClose').onclick = close;
  document.getElementById('lbPrev').onclick = function(e){ e.stopPropagation(); show(cur - 1); };
  document.getElementById('lbNext').onclick = function(e){ e.stopPropagation(); show(cur + 1); };
  lb.addEventListener('click', function(e){ if (e.target === lb) close(); });
  document.addEventListener('keydown', function(e){
    if (lb.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(cur - 1);
    else if (e.key === 'ArrowRight') show(cur + 1);
  });
  var x0 = null;
  lb.addEventListener('touchstart', function(e){ x0 = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', function(e){
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) show(cur + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // Download buttons: the zip streams from Dropbox so it can take a few
  // seconds to start -- give the click visible feedback.
  Array.prototype.forEach.call(document.querySelectorAll('[data-dl]'), function(a){
    a.addEventListener('click', function(){
      var t = a.textContent; a.classList.add('is-busy'); a.textContent = 'Preparing your download…';
      setTimeout(function(){ a.classList.remove('is-busy'); a.textContent = t; }, 6000);
    });
  });
})();
`;
