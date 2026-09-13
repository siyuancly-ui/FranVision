// FranVision Job Generator -- Delivery Email generator (module 8).
//
// Interim, transitional form of the "client delivery" concept -- the
// long-term plan (see root CLAUDE.md) is a standalone delivery page
// (photos + Feature Sheet + video + invoice + payment gate). Until that
// exists, Create/Update Job writes two plain .txt files -- one Chinese,
// one English -- into the job folder: the studio's existing delivery
// email wording (see "deliverable email template.docx" at the repo root,
// the human-readable reference this was transcribed from) with the
// client name / address / total / Dropbox download links filled in, and
// any deliverable line the order didn't include removed entirely.
//
// Same "which deliverables were ordered" question folder-builder.js /
// pricing-adapter.js / commission-engine.js already answer from the one
// shared `order` shape -- this reuses that, it does not invent a fourth
// parallel selection model.
//
// Link sourcing, by design (2026-09-11):
//   - Each per-deliverable line's link is a Dropbox SHARED LINK for that
//     job's corresponding component folder, generated automatically at
//     Create/Update Job time via dropbox-sync.js#createSharedLink().
//   - All-in-One (Zenfolio/CloudPano-style) and the Wave payment link
//     have no system generating them yet -- they stay as literal
//     placeholder tokens for manual fill-in until that catches up.
//   - Any Dropbox link that can't be generated (Dropbox not configured,
//     network/API failure, missing 'sharing.write' scope, etc.) falls back
//     to a placeholder token too -- same "best-effort, never block job
//     creation" contract as dropbox-sync.js. This module never throws.
//
// Home Report note: order/pricing-config.js has no toggle for Home Report
// yet -- folder-builder.js currently creates its folder unconditionally
// (a known bug, to be fixed separately, not in this module). Until that
// fix lands, this keys the Home Report line off whether 'Home Report' is
// present in the job's componentFolders -- so the line is effectively
// ALWAYS included for now, and will become correctly conditional the
// moment folder-builder.js's rule is fixed, with no change needed here.
//
// Wording revision (2026-09-12, from real first use): the payment
// paragraph now shows pre-tax + HST separately ("{{PRETAX_AMOUNT}}+HST=
// {{TOTAL_AMOUNT}}") instead of just the total; the E-Transfer email was
// corrected (frankystudio@, not frankstudio@) with a "(Not Gmail!!)" note
// added underneath it; and each download line is now its own
// label-then-link-then-blank-line block (was one single line) for
// legibility. See delivery-email-template.{zh,en}.txt directly for the
// exact wording -- those two files are the source of truth, not this file.

const fs = require('fs');
const path = require('path');
const dropboxSync = require('./dropbox-sync.js');
const { centsToDisplay } = require('./pricing-adapter.js');

const TEMPLATE_ZH_PATH = path.join(__dirname, 'delivery-email-template.zh.txt');
const TEMPLATE_EN_PATH = path.join(__dirname, 'delivery-email-template.en.txt');

const OUTPUT_FILENAME_ZH = 'Delivery Email (中文).txt';
const OUTPUT_FILENAME_EN = 'Delivery Email (EN).txt';

const PLACEHOLDERS = {
  zh: {
    ALL_IN_ONE_LINK: '[请手动填入 All-in-One 链接]',
    WAVE_LINK: '[请手动填入 Wave 付款链接]',
    linkUnavailable: '[链接暂未生成 -- 请手动填入或稍后重试]',
  },
  en: {
    ALL_IN_ONE_LINK: '[fill in the All-in-One link manually]',
    WAVE_LINK: '[fill in the Wave payment link manually]',
    linkUnavailable: '[link not available yet -- fill in manually or retry later]',
  },
};

// ---- Pure: which deliverable lines belong in this job's email, and which
// Dropbox folder (relative to the job's top-level folder) each line's
// link should point at. See the Home Report note in the header comment. ----
function getDeliverableLines(order, componentFolders) {
  const addons = (order && order.addons) || {};
  const folders = new Set(componentFolders || []);

  const wantsWalkthrough = !!addons.walkthrough_video;
  const wantsVlog = !!addons.vlog_video;
  const wantsFloorplan = !!(addons.floor_plan || addons.site_plan);

  let video = { key: 'VIDEO', include: false, dropboxFolder: null };
  // Walkthrough and Vlog Video are never ordered together on one job --
  // if that ever changes, revisit this (it would need two lines or one
  // combined link).
  if (wantsWalkthrough) video = { key: 'VIDEO', include: true, dropboxFolder: 'Video' };
  else if (wantsVlog) video = { key: 'VIDEO', include: true, dropboxFolder: 'VLOG' };

  return [
    // Every job delivers HD photos and MLS-sized photos.
    // 'HDR Photos' was named 'MLS' until 2026-09-12 -- pure rename, see
    // folder-builder.js's header comment. A job created before that
    // rename still has this content under 'MLS' on disk/Dropbox; this
    // module doesn't special-case that (Update on such a job would link
    // to the new, still-empty 'HDR Photos' folder rather than the old
    // one with real photos in it -- a known, accepted gap, not silently
    // "fixed" here).
    { key: 'HDR', include: true, dropboxFolder: 'HDR Photos' },
    { key: 'MLS', include: true, dropboxFolder: dropboxSync.MLS_FOR_DOWNLOAD_SUBFOLDER },
    video,
    { key: 'FLOORPLAN', include: wantsFloorplan, dropboxFolder: 'Floorplan' },
    // Local Report is an always-present folder (folder-builder.js) -- always included.
    { key: 'LOCAL_REPORT', include: true, dropboxFolder: 'Local Report' },
    { key: 'HOME_REPORT', include: folders.has('Home Report'), dropboxFolder: 'Home Report' },
  ];
}

// ---- Pure: fill in a template. `{{LINE:KEY}}` at the start of a line is
// a marker, not literal text -- the whole line is dropped unless KEY is
// in includedKeys, otherwise the marker is stripped and the rest of the
// line has its own {{TOKEN}}s substituted normally. ----
function renderTemplate(templateSource, tokens, includedKeys) {
  const lineMarker = /^\{\{LINE:([A-Z_]+)\}\}(.*)$/;
  const out = [];
  for (const rawLine of templateSource.split('\n')) {
    const m = rawLine.match(lineMarker);
    if (m) {
      if (!includedKeys.has(m[1])) continue;
      out.push(substituteTokens(m[2], tokens));
    } else {
      out.push(substituteTokens(rawLine, tokens));
    }
  }
  return out.join('\n');
}

function substituteTokens(str, tokens) {
  return str.replace(/\{\{([A-Z_]+)\}\}/g, (full, key) => (key in tokens ? tokens[key] : full));
}

// Pre-tax amounts are always whole dollars in practice -- every
// pricing-config.js price and manual-adjustment/override entry Franky
// actually uses is a round dollar figure; HST is what introduces cents.
// So PRETAX_AMOUNT drops the decimals ("$599") rather than always showing
// ".00" (2026-09-12 request). Falls back to full cents display (still via
// centsToDisplay) on the rare/unexpected case a pre-tax amount does carry
// cents (the manual-adjustment UI fields are `step="0.01"`, so this isn't
// actually unreachable) -- so this never silently truncates real money.
function formatPreTaxAmount(cents) {
  const c = Number(cents) || 0;
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  if (abs % 100 === 0) return sign + '$' + (abs / 100).toFixed(0);
  return centsToDisplay(c);
}

// ---- Pure: builds the {{TOKEN}} -> value map for one language, given the
// already-resolved links (linkByKey: {HDR: 'https://...'|null, ...}) and
// the manual-fill-in fields, which are always the placeholder for now. ----
function buildTokens({ lang, clientName, address, totalCents, preTaxCents, linkByKey }) {
  const ph = PLACEHOLDERS[lang];
  const tokens = {
    CLIENT_NAME: clientName || '',
    PROPERTY_ADDRESS: address || '',
    // Shown together in the payment paragraph as "{{PRETAX_AMOUNT}}+HST=
    // {{TOTAL_AMOUNT}}" (2026-09-12, real-use request) -- pre-tax and
    // total, not just the total alone, so the HST portion is legible at a
    // glance instead of a single opaque number.
    PRETAX_AMOUNT: formatPreTaxAmount(preTaxCents || 0),
    TOTAL_AMOUNT: centsToDisplay(totalCents || 0),
    ALL_IN_ONE_LINK: ph.ALL_IN_ONE_LINK,
    WAVE_LINK: ph.WAVE_LINK,
  };
  for (const [key, url] of Object.entries(linkByKey || {})) {
    tokens[key + '_LINK'] = url || ph.linkUnavailable;
  }
  return tokens;
}

function writeDeliveryEmailFiles(jobFolderAbsolutePath, { zhContent, enContent }) {
  const zhPath = path.join(jobFolderAbsolutePath, OUTPUT_FILENAME_ZH);
  const enPath = path.join(jobFolderAbsolutePath, OUTPUT_FILENAME_EN);
  fs.writeFileSync(zhPath, zhContent, 'utf8');
  fs.writeFileSync(enPath, enContent, 'utf8');
  return { zhPath, enPath };
}

// ---- The one function server.js calls. NEVER throws -- same contract as
// dropbox-sync.js. `client` is a test-only seam (delivery-email.test.js
// injects a fake Dropbox client so the suite never hits the real API). ----
async function generateDeliveryEmails({ jobFolderPath, folderName, clientName, address, order, componentFolders, totalCents, preTaxCents, client }) {
  try {
    const lines = getDeliverableLines(order, componentFolders);
    const includedKeys = new Set(lines.filter((l) => l.include).map((l) => l.key));

    const linkByKey = {};
    const linkErrors = [];
    for (const line of lines) {
      if (!line.include) continue;
      const dropboxPath = '/' + folderName + '/' + line.dropboxFolder;
      const result = await dropboxSync.createSharedLink({ dropboxPath, client });
      linkByKey[line.key] = result.success ? result.url : null;
      if (!result.success) linkErrors.push({ key: line.key, dropboxPath, error: result.error });
    }

    const zhTemplate = fs.readFileSync(TEMPLATE_ZH_PATH, 'utf8');
    const enTemplate = fs.readFileSync(TEMPLATE_EN_PATH, 'utf8');
    const zhContent = renderTemplate(zhTemplate, buildTokens({ lang: 'zh', clientName, address, totalCents, preTaxCents, linkByKey }), includedKeys);
    const enContent = renderTemplate(enTemplate, buildTokens({ lang: 'en', clientName, address, totalCents, preTaxCents, linkByKey }), includedKeys);

    const written = writeDeliveryEmailFiles(jobFolderPath, { zhContent, enContent });
    return { attempted: true, success: linkErrors.length === 0, ...written, linkByKey, linkErrors };
  } catch (err) {
    return { attempted: true, success: false, error: 'Unexpected delivery-email generation failure: ' + err.message };
  }
}

module.exports = {
  OUTPUT_FILENAME_ZH,
  OUTPUT_FILENAME_EN,
  getDeliverableLines,
  renderTemplate,
  buildTokens,
  formatPreTaxAmount,
  writeDeliveryEmailFiles,
  generateDeliveryEmails,
};
