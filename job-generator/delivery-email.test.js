// Run with: node delivery-email.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner (same
// pattern as dropbox-sync.test.js etc).
//
// getDeliverableLines/renderTemplate/buildTokens are pure and tested
// directly. generateDeliveryEmails is exercised end-to-end against a real
// temp directory (so the actual template files on disk are read) but with
// a fake Dropbox client injected via createSharedLink's `client` param --
// no real Dropbox or network call happens in this suite.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deliveryEmail = require('./delivery-email.js');
const {
  getDeliverableLines,
  renderTemplate,
  buildTokens,
  formatPreTaxAmount,
  generateDeliveryEmails,
  OUTPUT_FILENAME_ZH,
  OUTPUT_FILENAME_EN,
} = deliveryEmail;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

function keysOf(lines) {
  return lines.filter((l) => l.include).map((l) => l.key);
}

// ---- getDeliverableLines ----

test('getDeliverableLines: bare standard job -- HDR/MLS/Local Report always, nothing else', () => {
  const lines = getDeliverableLines({ addons: {} }, ['0 RAW/1 Raws', 'Revisions', 'Local Report', 'HDR Photos']);
  assert.deepStrictEqual(keysOf(lines).sort(), ['HDR', 'LOCAL_REPORT', 'MLS']);
});

test('getDeliverableLines: walkthrough video adds the VIDEO line pointed at "Video"', () => {
  const lines = getDeliverableLines({ addons: { walkthrough_video: true } }, []);
  const video = lines.find((l) => l.key === 'VIDEO');
  assert.strictEqual(video.include, true);
  assert.strictEqual(video.dropboxFolder, 'Video');
});

test('getDeliverableLines: vlog video adds the VIDEO line pointed at "VLOG"', () => {
  const lines = getDeliverableLines({ addons: { vlog_video: true } }, []);
  const video = lines.find((l) => l.key === 'VIDEO');
  assert.strictEqual(video.include, true);
  assert.strictEqual(video.dropboxFolder, 'VLOG');
});

test('getDeliverableLines: floor_plan or site_plan includes the FLOORPLAN line', () => {
  assert.strictEqual(getDeliverableLines({ addons: { floor_plan: true } }, []).find((l) => l.key === 'FLOORPLAN').include, true);
  assert.strictEqual(getDeliverableLines({ addons: { site_plan: true } }, []).find((l) => l.key === 'FLOORPLAN').include, true);
  assert.strictEqual(getDeliverableLines({ addons: {} }, []).find((l) => l.key === 'FLOORPLAN').include, false);
});

test('getDeliverableLines: HOME_REPORT keys off componentFolders (folder-builder.js has no addon toggle for it yet)', () => {
  assert.strictEqual(getDeliverableLines({ addons: {} }, ['Home Report']).find((l) => l.key === 'HOME_REPORT').include, true);
  assert.strictEqual(getDeliverableLines({ addons: {} }, []).find((l) => l.key === 'HOME_REPORT').include, false);
});

test('getDeliverableLines: three_d_tour addon includes the THREE_D line, with no Dropbox folder to auto-resolve (2026-09-16, always a manual link)', () => {
  const withIt = getDeliverableLines({ addons: { three_d_tour: true } }, []).find((l) => l.key === 'THREE_D');
  assert.strictEqual(withIt.include, true);
  assert.strictEqual(withIt.dropboxFolder, null);
  assert.strictEqual(getDeliverableLines({ addons: {} }, []).find((l) => l.key === 'THREE_D').include, false);
});

test('getDeliverableLines: MLS line points at the Dropbox-only MLS-for-download subfolder', () => {
  const dropboxSync = require('./dropbox-sync.js');
  const mls = getDeliverableLines({ addons: {} }, []).find((l) => l.key === 'MLS');
  assert.strictEqual(mls.dropboxFolder, dropboxSync.MLS_FOR_DOWNLOAD_SUBFOLDER);
});

test('getDeliverableLines: HDR line points at "HDR Photos" (renamed from "MLS" 2026-09-12)', () => {
  const hdr = getDeliverableLines({ addons: {} }, []).find((l) => l.key === 'HDR');
  assert.strictEqual(hdr.dropboxFolder, 'HDR Photos');
});

// ---- renderTemplate ----

test('renderTemplate: substitutes plain tokens', () => {
  const out = renderTemplate('Hi {{NAME}}, total {{TOTAL}}.', { NAME: 'Cindy', TOTAL: '$100.00' }, new Set());
  assert.strictEqual(out, 'Hi Cindy, total $100.00.');
});

test('renderTemplate: drops a {{LINE:KEY}} line entirely when KEY is not included', () => {
  const template = 'Header\n{{LINE:VIDEO}}Video: {{VIDEO_LINK}}\nFooter';
  const out = renderTemplate(template, {}, new Set());
  assert.strictEqual(out, 'Header\nFooter');
});

test('renderTemplate: keeps a {{LINE:KEY}} line (marker stripped) when KEY is included', () => {
  const template = '{{LINE:MLS}}MLS: {{MLS_LINK}}';
  const out = renderTemplate(template, { MLS_LINK: 'https://x' }, new Set(['MLS']));
  assert.strictEqual(out, 'MLS: https://x');
});

test('renderTemplate: an unknown {{TOKEN}} is left as-is rather than silently blanked', () => {
  const out = renderTemplate('{{MYSTERY}}', {}, new Set());
  assert.strictEqual(out, '{{MYSTERY}}');
});

// ---- buildTokens ----

test('buildTokens: All-in-One stays a placeholder without a Job ID; Wave is a placeholder without waveViewUrl', () => {
  const tokens = buildTokens({ lang: 'en', clientName: 'Cindy', address: '1 Main St', totalCents: 10000, preTaxCents: 8850, linkByKey: {} });
  assert.ok(tokens.ALL_IN_ONE_LINK.toLowerCase().includes('fill in'));
  assert.ok(tokens.WAVE_LINK.toLowerCase().includes('fill in'));
});

test('buildTokens: WAVE_LINK is auto-filled from waveViewUrl when given (2026-09-23)', () => {
  const tokens = buildTokens({ lang: 'zh', clientName: 'Cindy', address: '1 Main St', totalCents: 10000, preTaxCents: 8850, linkByKey: {}, waveViewUrl: 'https://next.waveapps.com/x' });
  assert.strictEqual(tokens.WAVE_LINK, 'https://next.waveapps.com/x');
});

test('buildTokens: All-in-One link is built from address slug + Job ID (both languages)', () => {
  for (const lang of ['en', 'zh']) {
    const tokens = buildTokens({ lang, clientName: 'C', address: '1371 Kestell Blvd, Oakville', totalCents: 1, preTaxCents: 1, linkByKey: {}, jobId: 'FVS-20260917-003' });
    assert.strictEqual(tokens.ALL_IN_ONE_LINK, 'https://realgta.ca/1371-kestell-blvd-oakville/FVS-20260917-003');
  }
});

test('buildAllInOneLink: no address slug -> /delivery/<id>; no Job ID -> null', () => {
  assert.strictEqual(deliveryEmail.buildAllInOneLink('FVS-1', '  ,, '), 'https://realgta.ca/delivery/FVS-1');
  assert.strictEqual(deliveryEmail.buildAllInOneLink('', '1 Main St'), null);
  assert.strictEqual(deliveryEmail.buildAllInOneLink(null, '1 Main St'), null);
});

test('buildTokens: resolved links are used as-is; unresolved ones fall back to a placeholder', () => {
  const tokens = buildTokens({
    lang: 'en', clientName: 'Cindy', address: '1 Main St', totalCents: 10000, preTaxCents: 8850,
    linkByKey: { MLS: 'https://dropbox.com/mls', HDR: null },
  });
  assert.strictEqual(tokens.MLS_LINK, 'https://dropbox.com/mls');
  assert.ok(tokens.HDR_LINK.toLowerCase().includes('not available'));
});

test('buildTokens: total keeps 2 decimals; pre-tax drops them when it\'s a whole dollar (2026-09-12: payment paragraph shows both, not just the total)', () => {
  const tokens = buildTokens({ lang: 'en', clientName: 'Cindy', address: '1 Main St', totalCents: 17854, preTaxCents: 15800, linkByKey: {} });
  assert.strictEqual(tokens.TOTAL_AMOUNT, '$178.54');
  assert.strictEqual(tokens.PRETAX_AMOUNT, '$158');
});

// ---- formatPreTaxAmount ----
// Pre-tax amounts are always whole dollars in practice (every
// pricing-config.js price and manual-adjustment/override Franky actually
// uses is round) -- so no ".00" clutter. But the manual-adjustment UI
// fields are `step="0.01"`, so a pre-tax amount WITH cents isn't actually
// unreachable -- this must never silently truncate real money in that case.

test('formatPreTaxAmount: whole dollars drop the decimals', () => {
  assert.strictEqual(formatPreTaxAmount(59900), '$599');
  assert.strictEqual(formatPreTaxAmount(0), '$0');
});

test('formatPreTaxAmount: a non-round amount still shows full cents rather than truncating', () => {
  assert.strictEqual(formatPreTaxAmount(15850), '$158.50');
});

test('formatPreTaxAmount: negative amounts keep the sign in either format', () => {
  assert.strictEqual(formatPreTaxAmount(-5000), '-$50');
  assert.strictEqual(formatPreTaxAmount(-5050), '-$50.50');
});

// ---- generateDeliveryEmails (end-to-end, fake Dropbox client) ----

function withFakeCredentials(fn) {
  const saved = {
    DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
    DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
    DROPBOX_REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN,
    DROPBOX_TEMPLATE_ID: process.env.DROPBOX_TEMPLATE_ID,
  };
  process.env.DROPBOX_APP_KEY = 'fake';
  process.env.DROPBOX_APP_SECRET = 'fake';
  process.env.DROPBOX_REFRESH_TOKEN = 'fake';
  process.env.DROPBOX_TEMPLATE_ID = 'fake-template-id';
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

async function runAsyncTests() {

function en_count(s, sub) { return s.split(sub).length - 1; }

await testAsync('generateDeliveryEmails: writes both language files with links filled in and unordered lines dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-delivery-email-test-'));
  const fakeDbx = {
    sharingCreateSharedLinkWithSettings: async ({ path: p }) => ({ result: { url: 'https://dropbox.com/link' + p } }),
  };
  try {
    await withFakeCredentials(async () => {
      const result = await generateDeliveryEmails({
        jobId: 'FVS-20260920-001',
        jobFolderPath: dir,
        folderName: 'Job',
        clientName: 'Cindy Lu',
        address: '6-260 Eagle St, Newmarket',
        order: { addons: { floor_plan: true } },
        componentFolders: ['0 RAW/1 Raws', 'Revisions', 'Home Report', 'Local Report', 'HDR Photos', 'Floorplan'],
        totalCents: 17854,
        preTaxCents: 15800,
        client: fakeDbx,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.existsSync(path.join(dir, OUTPUT_FILENAME_ZH)), true);
      assert.strictEqual(fs.existsSync(path.join(dir, OUTPUT_FILENAME_EN)), true);

      const zh = fs.readFileSync(path.join(dir, OUTPUT_FILENAME_ZH), 'utf8');
      const en = fs.readFileSync(path.join(dir, OUTPUT_FILENAME_EN), 'utf8');
      assert.ok(zh.includes('Cindy Lu'));
      assert.ok(zh.includes('6-260 Eagle St, Newmarket'));
      // All-in-One link is generated from address slug + Job ID (both
      // places it appears in the template), not left as a placeholder.
      const aio = 'https://realgta.ca/6-260-eagle-st-newmarket/FVS-20260920-001';
      assert.strictEqual(zh.split(aio).length - 1, 2);
      assert.strictEqual(en_count(fs.readFileSync(path.join(dir, OUTPUT_FILENAME_EN), 'utf8'), aio), 2);
      // Payment paragraph shows pre-tax + HST, not just the total (2026-09-12);
      // pre-tax drops its decimals here since 15800 cents is a whole dollar.
      assert.ok(zh.includes('$158+HST= $178.54'));
      assert.ok(zh.includes('https://dropbox.com/link/Job/HDR Photos')); // the renamed HDR line target
      assert.ok(zh.includes('https://dropbox.com/link/Job/MLS for download'));
      assert.ok(zh.includes('https://dropbox.com/link/Job/Floorplan'));
      // Corrected E-Transfer address + the "not Gmail" note (2026-09-12).
      assert.ok(zh.includes('frankystudio@mail.com'));
      assert.ok(zh.includes('(Not Gmail!!)'));
      // No video was ordered -- the whole Video block (label+link+blank
      // line) must be gone, not just blanked.
      assert.ok(!zh.includes('Video 视频'));
      assert.ok(!en.includes('Video ('));
      assert.ok(!zh.includes('24小时内完成') && !en.includes('ready in 24 hours'));
      // 2026-09-16: a "-----" divider separates what's visible before
      // payment from the (gated) download content, and no 3D Tour line
      // appears since three_d_tour wasn't ordered on this job.
      assert.ok(zh.includes('-----'));
      assert.ok(en.includes('-----'));
      assert.ok(!zh.includes('3D Tour'));
      assert.ok(!en.includes('3D Tour'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('generateDeliveryEmails: the "-----" divider falls between the payment paragraph and the download section', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-delivery-email-test-'));
  const fakeDbx = {
    sharingCreateSharedLinkWithSettings: async ({ path: p }) => ({ result: { url: 'https://dropbox.com/link' + p } }),
  };
  try {
    await withFakeCredentials(async () => {
      const result = await generateDeliveryEmails({
        jobFolderPath: dir,
        folderName: 'Job',
        clientName: 'Cindy Lu',
        address: '6-260 Eagle St, Newmarket',
        order: { addons: {} },
        componentFolders: ['0 RAW/1 Raws', 'Revisions', 'Local Report', 'HDR Photos'],
        totalCents: 17854,
        preTaxCents: 15800,
        client: fakeDbx,
      });
      assert.strictEqual(result.success, true);
      const zh = fs.readFileSync(path.join(dir, OUTPUT_FILENAME_ZH), 'utf8');
      const lines = zh.split('\n');
      const dividerIndex = lines.indexOf('-----');
      const paymentIndex = lines.findIndex((l) => l.includes('支付完成后请告知'));
      const downloadHeadingIndex = lines.findIndex((l) => l.includes('6-260 Eagle St, Newmarket：'));
      assert.notStrictEqual(dividerIndex, -1);
      assert.ok(paymentIndex < dividerIndex && dividerIndex < downloadHeadingIndex, 'divider must sit between the payment paragraph and the download section');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('generateDeliveryEmails: THREE_D is always the manual placeholder, never auto-resolved via Dropbox even when ordered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-delivery-email-test-'));
  const requestedPaths = [];
  const fakeDbx = {
    sharingCreateSharedLinkWithSettings: async ({ path: p }) => { requestedPaths.push(p); return { result: { url: 'https://dropbox.com/link' + p } }; },
  };
  try {
    await withFakeCredentials(async () => {
      const result = await generateDeliveryEmails({
        jobFolderPath: dir,
        folderName: 'Job',
        clientName: 'Cindy Lu',
        address: '6-260 Eagle St, Newmarket',
        order: { addons: { three_d_tour: true } },
        componentFolders: ['0 RAW/1 Raws', 'Revisions', 'Local Report', 'HDR Photos'],
        totalCents: 17854,
        preTaxCents: 15800,
        client: fakeDbx,
      });
      assert.strictEqual(result.success, true);
      const zh = fs.readFileSync(path.join(dir, OUTPUT_FILENAME_ZH), 'utf8');
      const en = fs.readFileSync(path.join(dir, OUTPUT_FILENAME_EN), 'utf8');
      assert.ok(zh.includes('3D Tour/Floor Tour：'));
      assert.ok(zh.includes('[请手动填入 3D Tour/Floor Tour 链接]'));
      assert.ok(en.includes('3D Tour/Floor Tour:'));
      assert.ok(en.includes('[fill in the 3D Tour/Floor Tour link manually]'));
      // Never asked Dropbox for a link under a folder named "null" or
      // anything else -- THREE_D is skipped by the resolution loop entirely.
      assert.ok(!requestedPaths.some((p) => p.includes('null')));
      assert.strictEqual(requestedPaths.length, 3); // HDR, MLS, Local Report -- always-included lines on this bare-ish order
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('generateDeliveryEmails: a link that fails to generate falls back to a placeholder, never blocks the write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-delivery-email-test-'));
  const fakeDbx = {
    sharingCreateSharedLinkWithSettings: async () => { throw new Error('network down'); },
  };
  try {
    await withFakeCredentials(async () => {
      const result = await generateDeliveryEmails({
        jobFolderPath: dir, folderName: 'Job', clientName: 'Cindy Lu', address: 'Addr',
        order: { addons: {} }, componentFolders: [], totalCents: 10000, client: fakeDbx,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.linkErrors.length > 0);
      assert.strictEqual(fs.existsSync(path.join(dir, OUTPUT_FILENAME_ZH)), true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('generateDeliveryEmails: never throws even on a totally broken client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-delivery-email-test-'));
  try {
    await withFakeCredentials(async () => {
      const result = await generateDeliveryEmails({
        jobFolderPath: dir, folderName: 'Job', clientName: 'Cindy', address: 'Addr',
        order: { addons: {} }, componentFolders: [], totalCents: 10000,
        client: { sharingCreateSharedLinkWithSettings: async () => { throw { weird: true }; } },
      });
      assert.strictEqual(result.attempted, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

}

runAsyncTests().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
});

// ---- Gallery link (2026-09-24) ----

test('buildGalleryLink: /delivery/<address-slug>/<token>; no token -> null; no address -> /photos/', () => {
  assert.strictEqual(deliveryEmail.buildGalleryLink('513-872 Sheppard Ave W, North York', '8779efe254f329f0766d73328550ae62'),
    'https://realgta.ca/delivery/513-872-sheppard-ave-w-north-york/8779efe254f329f0766d73328550ae62');
  assert.strictEqual(deliveryEmail.buildGalleryLink('', 'abc'), 'https://realgta.ca/delivery/photos/abc');
  assert.strictEqual(deliveryEmail.buildGalleryLink('1 Main St', null), null);
  assert.strictEqual(deliveryEmail.buildGalleryLink('1 Main St', ''), null);
});

test('buildTokens: the HDR line becomes the Gallery link when a token exists; other lines keep their Dropbox links', () => {
  for (const lang of ['en', 'zh']) {
    const t = buildTokens({ lang, clientName: 'C', address: '1 Main St', totalCents: 1, preTaxCents: 1, jobId: 'FVS-20260924-001', galleryToken: 'tok123',
      linkByKey: { HDR: 'https://dropbox.com/hdr', MLS: 'https://dropbox.com/mls' } });
    assert.strictEqual(t.HDR_LINK, 'https://realgta.ca/delivery/1-main-st/tok123');
    assert.strictEqual(t.MLS_LINK, 'https://dropbox.com/mls');
    assert.ok(!t.HDR_LINK.includes('FVS-'), 'the raw Job ID must not appear in the URL');
  }
});

test('buildTokens: no Gallery token -> the HDR line keeps its Dropbox link (or the usual placeholder), never a broken Gallery link', () => {
  const withDropbox = buildTokens({ lang: 'en', clientName: 'C', address: '1 Main St', totalCents: 1, preTaxCents: 1, jobId: 'FVS-1', linkByKey: { HDR: 'https://dropbox.com/hdr' } });
  assert.strictEqual(withDropbox.HDR_LINK, 'https://dropbox.com/hdr');
  const neither = buildTokens({ lang: 'en', clientName: 'C', address: '1 Main St', totalCents: 1, preTaxCents: 1, jobId: 'FVS-1', linkByKey: { HDR: null } });
  assert.ok(neither.HDR_LINK.includes('not available'));
});

test('generateDeliveryEmails: HDR line uses the job server token; failure/absence/draft falls back safely, never throws', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-gallery-'));
  const base = { jobId: 'FVS-20260924-001', jobFolderPath: tmp, folderName: 'x', clientName: 'C', address: '1 Main St', order: { addons: {} }, componentFolders: [], totalCents: 1000, preTaxCents: 885 };
  const read = () => fs.readFileSync(path.join(tmp, deliveryEmail.OUTPUT_FILENAME_EN), 'utf8');

  const seen = [];
  const ok = await deliveryEmail.generateDeliveryEmails({ ...base, getGalleryToken: async (id) => { seen.push(id); return 'tok123'; } });
  assert.strictEqual(ok.galleryLink, true);
  assert.deepStrictEqual(seen, ['FVS-20260924-001']);
  const text = read();
  assert.ok(text.includes('High-Resolution Photos:\nhttps://realgta.ca/delivery/1-main-st/tok123'));
  assert.strictEqual((text.match(/realgta\.ca\/delivery\/1-main-st\/tok123/g) || []).length, 1, 'only the HDR line, no separate Gallery block');

  const failed = await deliveryEmail.generateDeliveryEmails({ ...base, getGalleryToken: async () => { throw new Error('unreachable'); } });
  assert.strictEqual(failed.galleryLink, false);
  assert.ok(!read().includes('/delivery/1-main-st/'));
  assert.ok(read().includes('High-Resolution Photos:'));

  assert.strictEqual((await deliveryEmail.generateDeliveryEmails({ ...base })).galleryLink, false);

  let called = false;
  await deliveryEmail.generateDeliveryEmails({ ...base, jobId: null, getGalleryToken: async () => { called = true; return 't'; } });
  assert.strictEqual(called, false, 'no token request without a real Job ID');
});

test('templates no longer carry a separate Gallery block (the HDR line is the Gallery link)', () => {
  for (const f of ['delivery-email-template.zh.txt', 'delivery-email-template.en.txt']) {
    assert.ok(!fs.readFileSync(path.join(__dirname, f), 'utf8').includes('GALLERY_LINK'));
  }
});

// ---- Video line note (2026-09-24): each language in its OWN language ----

test('the Video line carries the 24-hour note -- Chinese in the Chinese email, English in the English email (never mixed) -- only when video was ordered', () => {
  const tokens = (lang) => buildTokens({ lang, clientName: 'C', address: '1 Main St', totalCents: 1, preTaxCents: 1, jobId: 'FVS-20260924-001', linkByKey: { VIDEO: 'https://dropbox.com/v', HDR: 'https://dropbox.com/h' } });
  const zh = fs.readFileSync(path.join(__dirname, 'delivery-email-template.zh.txt'), 'utf8');
  const en = fs.readFileSync(path.join(__dirname, 'delivery-email-template.en.txt'), 'utf8');
  const withVideo = new Set(['HDR', 'VIDEO']);
  const zhOut = renderTemplate(zh, tokens('zh'), withVideo);
  const enOut = renderTemplate(en, tokens('en'), withVideo);
  assert.ok(zhOut.includes('Video 视频（24小时内完成）：\nhttps://dropbox.com/v'));
  assert.ok(enOut.includes('Video (ready in 24 hours):\nhttps://dropbox.com/v'));
  assert.ok(!zhOut.includes('ready in 24 hours'), 'no English note in the Chinese email');
  assert.ok(!enOut.includes('24小时'), 'no Chinese note in the English email');
  for (const [t, lang] of [[zh, 'zh'], [en, 'en']]) {
    const out = renderTemplate(t, tokens(lang), new Set(['HDR']));           // no video ordered -> whole block gone
    assert.ok(!out.includes('ready in 24 hours') && !out.includes('24小时内完成'));
    assert.ok(!out.includes('https://dropbox.com/v'));
  }
});
