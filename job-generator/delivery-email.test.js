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
  const lines = getDeliverableLines({ addons: {} }, ['0 RAW/1 Raws', 'Revisions', 'Local Report', 'MLS']);
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

test('getDeliverableLines: MLS line points at the Dropbox-only MLS-for-download subfolder', () => {
  const dropboxSync = require('./dropbox-sync.js');
  const mls = getDeliverableLines({ addons: {} }, []).find((l) => l.key === 'MLS');
  assert.strictEqual(mls.dropboxFolder, dropboxSync.MLS_FOR_DOWNLOAD_SUBFOLDER);
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

test('buildTokens: All-in-One / Wave stay literal placeholders (no system generates those links yet)', () => {
  const tokens = buildTokens({ lang: 'en', clientName: 'Cindy', address: '1 Main St', totalCents: 10000, linkByKey: {} });
  assert.ok(tokens.ALL_IN_ONE_LINK.toLowerCase().includes('fill in'));
  assert.ok(tokens.WAVE_LINK.toLowerCase().includes('fill in'));
});

test('buildTokens: resolved links are used as-is; unresolved ones fall back to a placeholder', () => {
  const tokens = buildTokens({
    lang: 'en', clientName: 'Cindy', address: '1 Main St', totalCents: 10000,
    linkByKey: { MLS: 'https://dropbox.com/mls', HDR: null },
  });
  assert.strictEqual(tokens.MLS_LINK, 'https://dropbox.com/mls');
  assert.ok(tokens.HDR_LINK.toLowerCase().includes('not available'));
});

test('buildTokens: total formatted via pricing-adapter\'s centsToDisplay', () => {
  const tokens = buildTokens({ lang: 'en', clientName: 'Cindy', address: '1 Main St', totalCents: 17854, linkByKey: {} });
  assert.strictEqual(tokens.TOTAL_AMOUNT, '$178.54');
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

await testAsync('generateDeliveryEmails: writes both language files with links filled in and unordered lines dropped', async () => {
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
        order: { addons: { floor_plan: true } },
        componentFolders: ['0 RAW/1 Raws', 'Revisions', 'Home Report', 'Local Report', 'MLS', 'Floorplan'],
        totalCents: 17854,
        client: fakeDbx,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.existsSync(path.join(dir, OUTPUT_FILENAME_ZH)), true);
      assert.strictEqual(fs.existsSync(path.join(dir, OUTPUT_FILENAME_EN)), true);

      const zh = fs.readFileSync(path.join(dir, OUTPUT_FILENAME_ZH), 'utf8');
      const en = fs.readFileSync(path.join(dir, OUTPUT_FILENAME_EN), 'utf8');
      assert.ok(zh.includes('Cindy Lu'));
      assert.ok(zh.includes('6-260 Eagle St, Newmarket'));
      assert.ok(zh.includes('$178.54'));
      assert.ok(zh.includes('https://dropbox.com/link/Job/MLS for download'));
      assert.ok(zh.includes('https://dropbox.com/link/Job/Floorplan'));
      // No video was ordered -- the whole Video line must be gone, not just blanked.
      assert.ok(!zh.includes('Video 视频'));
      assert.ok(!en.includes('Video:'));
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
