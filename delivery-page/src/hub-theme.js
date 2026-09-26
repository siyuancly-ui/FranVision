// Look of the Delivery Hub (2026-09-25 redesign from the approved mockup): warm off-white page, a soft
// staircase-and-brass hero under the logo, serif headings, white rounded cards with a beige icon disc, champagne-gold
// gradient buttons. Colours / fonts are the brand notes' suggestions (FranVision_web_assets/BRAND-NOTES.txt):
// champagne gold #AD8854, deeper gold #926B38, ink #282B2E, off-white #FAF8F4, button gradient #B99A69 -> #A47D47;
// Playfair Display for headings (the original typeface is unknown). LIGHT ONLY -- the design has no dark mode.
//
// Brand assets are static files in ../public/brand (served by the Worker's assets binding, see wrangler.jsonc):
//   franvision-logo.webp, staircase-hero.webp, capture-signature.webp
// The forwardable client view (?for=client) uses the same cards but NONE of the brand pieces (no logo, tagline,
// hero image, sign-off, signature) -- see hub.js#renderClientView.

export const BRAND_ASSETS = {
  logo: '/brand/franvision-logo.webp',
  hero: '/brand/staircase-hero.webp',
  signature: '/brand/capture-signature.webp',
};

export const HUB_HEAD = '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet">';

const svg = (inner, size = 26) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// Line icons in one style (Lucide-like), drawn here so nothing external is needed.
export const ICONS = {
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 3.5 3.5 3-3L20 17"/>'),
  video: svg('<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="m15.5 11 5-3v8l-5-3"/>'),
  doc: svg('<path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M14 3.5V8h4M9 12.5h6M9 16h6"/>'),
  cube: svg('<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
  home: svg('<path d="M4 11 12 4l8 7"/><path d="M6 9.8V20h12V9.8"/><path d="M10 20v-5h4v5"/>'),
  download: svg('<path d="M12 4v11m0 0-4.2-4.2M12 15l4.2-4.2"/><path d="M4.5 16.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5"/>', 24),
  arrow: svg('<path d="M4.5 12h15m0 0-5.5-5.5M19.5 12 14 17.5"/>', 24),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', 24),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 22),
  checkBold: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 12.5 4 4 8-9"/></svg>',
};

// Which icon each deliverable gets (keys = getDeliverableLines() keys).
export const LINE_ICON = {
  HDR: 'image', MLS: 'image', VIDEO: 'video', FLOORPLAN: 'doc', THREE_D: 'cube', LOCAL_REPORT: 'doc', HOME_REPORT: 'home',
};

export const HUB_CSS = `
  :root{--gold:#AD8854;--gold-deep:#926B38;--ink:#282B2E;--cream:#FAF8F4;--sand:#F3ECE0;--muted:#7a766b;--card-line:rgba(146,107,56,.16);
    --btn:linear-gradient(180deg,#B99A69 0%,#A47D47 100%);--serif:"Playfair Display",Georgia,"Times New Roman",serif;--sans:Montserrat,-apple-system,"system-ui","Segoe UI",Roboto,sans-serif;}
  html{background:var(--cream);}
  body{margin:0;background:var(--cream);color:var(--ink);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased;}
  .stage{position:relative;overflow:hidden;}
  .hero-bg{position:absolute;top:0;left:0;right:0;height:min(760px,118vw);background:var(--cream) url(${BRAND_ASSETS.hero}) 68% 0/cover no-repeat;-webkit-mask-image:linear-gradient(#000 58%,transparent);mask-image:linear-gradient(#000 58%,transparent);}
  .wrap{position:relative;max-width:840px;margin:0 auto;padding:0 26px 44px;}
  .brand{text-align:center;padding:30px 0 6px;}
  .brand-logo{display:block;width:min(310px,64vw);height:auto;margin:0 auto;}
  .brand-tag{margin:8px 0 0;font-size:11.5px;font-weight:500;letter-spacing:.34em;text-indent:.34em;color:#5f5a4f;}
  .brand-tag-zh{margin:6px 0 0;font-size:12.5px;letter-spacing:.55em;text-indent:.55em;color:#5f5a4f;}
  .greet{font-family:var(--serif);font-weight:500;font-size:clamp(28px,5.4vw,38px);line-height:1.2;margin:34px 0 10px;}
  .lead{margin:0;font-size:17px;line-height:1.55;}
  .lead-addr{display:block;font-family:var(--serif);font-weight:500;font-size:clamp(28px,5.4vw,38px);line-height:1.2;margin:3px 0 4px;}
  .zh{font-size:14.5px;line-height:1.6;color:var(--muted);margin:10px 0 24px;}
  .notice{display:flex;gap:16px;align-items:center;margin:20px 0 6px;padding:16px 20px;border-radius:14px;border:1px solid rgba(46,125,72,.22);background:#F1F8F2;}
  .notice-ico{flex:0 0 auto;width:42px;height:42px;border-radius:50%;background:#2e7d48;display:flex;align-items:center;justify-content:center;}
  .notice p{margin:0;font-size:15px;line-height:1.5;color:#256b3c;}
  .notice p strong{font-weight:600;}
  .notice .notice-zh{margin-top:2px;font-size:14px;color:#3f7d55;}
  .notice.is-due{border-color:var(--card-line);background:#fff;}
  .notice.is-due p{color:var(--ink);} .notice.is-due .notice-zh{color:var(--muted);}
  .plain{margin:18px 0 4px;font-size:15.5px;line-height:1.55;}
  .plain .zh{margin:4px 0 0;}
  .mail-fee{margin:22px 0 14px;font-size:16px;}
  .mail-fee strong{font-weight:600;}
  .mail-partial{margin:0 0 16px;padding:14px 18px;border-radius:14px;background:#FFF6E8;border:1px solid #f0d9b0;font-size:14.5px;line-height:1.55;color:#7a4b00;}
  .mail-partial .mail-zh{display:block;margin:4px 0 0;color:#8a6a3a;font-size:13.5px;}
  .cta-row{display:flex;flex-wrap:wrap;gap:14px;margin:4px 0 0;}
  .hub-cta{display:inline-flex;align-items:center;justify-content:center;gap:12px;min-width:150px;box-sizing:border-box;padding:16px 30px;border:0;border-radius:10px;background:var(--btn);color:#fff;font-family:var(--serif);font-weight:500;font-size:clamp(17px,3.6vw,21px);letter-spacing:.01em;text-decoration:none;text-align:center;cursor:pointer;box-shadow:0 4px 12px rgba(146,107,56,.32),inset 0 1px 0 rgba(255,255,255,.28);transition:transform .12s,box-shadow .12s,filter .12s;}
  .hub-cta:hover{filter:brightness(1.05);box-shadow:0 7px 18px rgba(146,107,56,.38),inset 0 1px 0 rgba(255,255,255,.3);transform:translateY(-1px);}
  .hub-cta:active{transform:translateY(1px);}
  .hub-cta.is-paid{background:linear-gradient(180deg,#A98A5B 0%,#926B38 100%);}
  .hub-cta svg{flex:0 0 auto;}
  .mail-rule{border:0;border-top:1px solid rgba(146,107,56,.24);margin:34px 0 30px;}
  .mail-addr{font-family:var(--serif);font-weight:500;font-size:clamp(30px,6.4vw,46px);line-height:1.15;margin:0 0 14px;color:var(--ink);}
  .mail-note{font-size:15px;line-height:1.55;color:#55524a;margin:0 0 6px;}
  .mail-zh{display:block;font-size:14px;line-height:1.55;color:var(--muted);margin:2px 0 0;}
  .hub-list{display:flex;flex-direction:column;gap:14px;margin-top:20px;}
  .hub-list + .mail-note{margin-top:18px;}
  .hub-btn{display:flex;align-items:center;gap:18px;width:100%;box-sizing:border-box;padding:15px 22px 15px 16px;border:1px solid var(--card-line);border-radius:14px;background:#fff;color:var(--ink);font:inherit;text-align:left;text-decoration:none;cursor:pointer;box-shadow:0 2px 12px rgba(80,60,30,.08);transition:transform .12s,box-shadow .12s;}
  .hub-btn:hover{box-shadow:0 8px 22px rgba(80,60,30,.15);transform:translateY(-1px);}
  .hub-btn:active{transform:translateY(0);}
  .hub-ico{flex:0 0 auto;width:54px;height:54px;border-radius:50%;background:var(--sand);color:var(--gold-deep);display:flex;align-items:center;justify-content:center;}
  .hub-label{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;font-family:var(--serif);font-weight:500;font-size:clamp(18px,3.8vw,22px);line-height:1.25;}
  .hub-zh{font-family:var(--sans);font-size:13.5px;font-weight:400;color:var(--muted);}
  .hub-note{font-family:var(--sans);font-weight:400;font-size:12.5px;color:#8a867b;}
  .hub-go{flex:0 0 auto;color:var(--gold-deep);display:flex;}
  .hub-tag{flex:0 0 auto;font-size:13px;color:#8a867b;}
  .hub-preview{border-color:rgba(173,136,84,.65);margin:0 0 4px;}
  .hub-btn.is-locked .hub-go{color:#9a8a6e;}
  .hub-btn.is-disabled{opacity:.55;cursor:default;pointer-events:none;box-shadow:none;background:#fdfcf9;}
  .hub-empty{color:#8a867b;text-align:center;margin-top:28px;}
  .sign{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin:34px 0 0;padding-top:22px;border-top:1px solid rgba(146,107,56,.24);}
  .sign-text{font-size:16px;line-height:1.55;}
  .sign-img{width:min(240px,46vw);height:auto;display:block;}
  .mail-share{margin:26px 0 0;text-align:center;}
  .hub-share{border:1px solid rgba(146,107,56,.45);background:#fff;color:var(--gold-deep);border-radius:10px;padding:11px 18px;font:inherit;font-size:13.5px;cursor:pointer;}
  .hub-share:hover{background:var(--sand);}
  .hub-modal{position:fixed;inset:0;z-index:60;background:rgba(40,43,46,.5);display:flex;align-items:center;justify-content:center;padding:20px;font-family:var(--sans);}
  .hub-modal[hidden]{display:none;}
  .hub-modal-card{position:relative;background:var(--cream);color:var(--ink);border-radius:18px;max-width:420px;width:100%;padding:32px 24px 22px;box-shadow:0 24px 60px rgba(40,30,10,.35);text-align:center;border:1px solid var(--card-line);}
  .hub-modal-card h2{margin:0 0 6px;font-family:var(--serif);font-weight:500;font-size:24px;}
  .hub-modal-card h2 span{display:block;font-family:var(--sans);font-size:13.5px;font-weight:400;color:var(--muted);margin-top:3px;}
  .hub-fee{margin:14px 0 18px;font-family:var(--serif);font-size:32px;font-weight:600;letter-spacing:.01em;}
  .hub-fee span{font-family:var(--sans);font-size:12.5px;font-weight:400;color:#8a867b;}
  .hub-pay{display:block;width:100%;box-sizing:border-box;margin:0 0 11px;padding:15px 16px;border:0;border-radius:11px;background:var(--btn);color:#fff;font-family:var(--serif);font-weight:500;font-size:18px;text-decoration:none;text-align:center;cursor:pointer;box-shadow:0 3px 10px rgba(146,107,56,.28),inset 0 1px 0 rgba(255,255,255,.28);}
  .hub-pay span{font-family:var(--sans);font-weight:400;font-size:12.5px;opacity:.9;margin-left:6px;}
  .hub-pay:hover{filter:brightness(1.05);}
  .hub-pay.is-ghost{background:#fff;color:var(--gold-deep);border:1px solid rgba(146,107,56,.45);box-shadow:none;}
  .hub-pay.is-ghost:hover{background:var(--sand);filter:none;}
  .hub-pay.is-alt{background:var(--ink);box-shadow:0 3px 10px rgba(40,43,46,.25);}
  .hub-emt-to{margin:8px 0 2px;font-size:12.5px;color:#8a867b;}
  .hub-emt-mail{margin:0;font-family:var(--serif);font-size:22px;font-weight:600;word-break:break-all;}
  .hub-emt-note{margin:2px 0 14px;font-size:12.5px;color:#b3541e;}
  .hub-copy,.hub-back{border:1px solid rgba(146,107,56,.4);background:#fff;color:var(--ink);border-radius:10px;padding:10px 18px;font:inherit;font-size:13.5px;cursor:pointer;}
  .hub-back{border:0;background:none;color:var(--muted);margin-top:6px;}
  .hub-after{font-size:12.5px;line-height:1.55;color:#8a867b;margin:14px 0 4px;}
  .hub-close{position:absolute;top:8px;right:14px;border:0;background:none;color:#8a867b;font-size:28px;line-height:1;cursor:pointer;}
  .wrap.is-plain{padding-top:36px;}
  .wrap.is-plain .mail-addr{margin-top:30px;}
  .notice.is-due .notice-ico{background:var(--gold);}
  .inv-logo{display:block;width:150px;height:auto;margin:0 auto 16px;}
  @media (max-width:520px){
    .wrap{padding:0 20px 36px;}
    .hub-ico{width:48px;height:48px;}
    .hub-btn{gap:14px;padding:13px 16px 13px 12px;}
    .sign{align-items:center;}
  }
`;

export const INVOICE_CSS = `
  .inv{max-width:860px;margin:0 auto;padding:20px 16px 36px;font-family:var(--sans);color:var(--ink);}
  .inv-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px;}
  .inv-back{color:var(--gold-deep);text-decoration:none;font-size:14.5px;}
  .inv-title{flex:1;font-family:var(--serif);font-size:24px;font-weight:500;}
  .inv-dl{min-width:0;padding:11px 20px;font-size:16px;}
  .inv-frame{display:block;width:100%;height:82vh;min-height:520px;border:1px solid var(--card-line);border-radius:12px;background:#fff;box-shadow:0 2px 12px rgba(80,60,30,.08);}
  .inv-fallback{text-align:center;font-size:13px;color:var(--muted);margin:12px 0 0;}
  .inv-fallback a{color:var(--gold-deep);}
  .inv-pay{max-width:420px;margin:24px auto 0;text-align:center;}
  .inv-emt{margin-top:6px;}
`;
