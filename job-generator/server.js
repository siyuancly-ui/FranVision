// FranVision Job Generator -- local server (module 7).
//
// Zero dependencies: Node's built-in http module only. Serves the UI
// (public/index.html) and a small JSON API that wires together the
// already-built modules:
//   pricing-adapter.js  -- pricing (delegates to pricing/engine.js, no 2nd logic)
//   id-generator.js     -- Job ID
//   folder-builder.js   -- folder structure
//   sanitize.js          -- safe folder names
//   job-files.js         -- Job Info.txt + job.json
//   config-store.js      -- Job Root Folder persistence (module 6)
//   dropbox-sync.js      -- optional, best-effort Dropbox mirror + jobId tag
//   commission-engine.js -- Photographer Commission (independent of pricing)
//   file-sync.js         -- one-way local -> Dropbox FILE sync for an existing job

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const sanitize = require('./sanitize.js');
const validate = require('./validate.js');
const idGenerator = require('./id-generator.js');
const folderBuilder = require('./folder-builder.js');
const pricingAdapter = require('./pricing-adapter.js');
const jobFiles = require('./job-files.js');
const configStore = require('./config-store.js');
const dropboxSync = require('./dropbox-sync.js');
const commissionEngine = require('./commission-engine.js');
const commissionConfig = require('./commission-config.js');
const fileSync = require('./file-sync.js');

const PORT = 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_ROOT_FOLDER = path.join(__dirname, 'test-output');

// Modules in job-generator/ that also need to run client-side (browser
// <script> tag), so validation/formatting logic has exactly one
// implementation instead of a copy drifting in index.html. Whitelisted
// explicitly rather than serving the whole job-generator/ directory.
const SHARED_FILES = {
  '/shared/sanitize.js': path.join(__dirname, 'sanitize.js'),
  '/shared/validate.js': path.join(__dirname, 'validate.js'),
};

// In-memory for this process, but backed by config-store.js on disk --
// loaded once at startup, and every assignment below is paired with a
// setRootFolder() call so it survives quitting and reopening the launcher.
let rootFolder = configStore.getRootFolder(DEFAULT_ROOT_FOLDER);

function setAndPersistRootFolder(newRootFolder) {
  rootFolder = newRootFolder;
  configStore.setRootFolder(newRootFolder);
}

// Native macOS "choose folder" dialog via AppleScript -- no dependencies,
// same spirit as the .command launcher already used in this project.
// Resolves { cancelled: true } if the user dismisses the dialog rather
// than rejecting, since that's a normal outcome, not an error.
function pickFolderNative() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select Job Root Folder:")'], (err, stdout) => {
        if (err) return resolve({ cancelled: true });
        resolve({ cancelled: false, path: stdout.trim() });
      });
      return;
    }

    resolve({ cancelled: true, unsupported: true });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(req, res, urlPath) {
  if (SHARED_FILES[urlPath]) {
    return fs.readFile(SHARED_FILES[urlPath], (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
      res.end(data);
    });
  }

  const filePath = urlPath === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, urlPath);
  // Prevent escaping PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(req, res, urlPath) {
  try {
    if (urlPath === '/api/root-folder' && req.method === 'GET') {
      return sendJson(res, 200, { rootFolder, persisted: true });
    }

    if (urlPath === '/api/root-folder' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.rootFolder || typeof body.rootFolder !== 'string') {
        return sendJson(res, 400, { error: 'rootFolder (string) is required.' });
      }
      setAndPersistRootFolder(body.rootFolder);
      return sendJson(res, 200, { rootFolder, persisted: true });
    }

    if (urlPath === '/api/pick-folder' && req.method === 'POST') {
      // Just returns the picked path -- does NOT persist it. Saving as the
      // default is opt-in via the UI's "Save as default path" checkbox,
      // which calls POST /api/root-folder itself when checked.
      const result = await pickFolderNative();
      return sendJson(res, 200, result);
    }

    if (urlPath === '/api/price' && req.method === 'POST') {
      const order = await readJsonBody(req);
      const result = pricingAdapter.calculatePrice(order);
      return sendJson(res, 200, result);
    }

    // Live Commission Breakdown preview -- entirely independent of
    // /api/price above (commission-engine.js never imports pricing/).
    // checkedItemIds is optional: omit it (or send null) to get the
    // computed defaults for the current order, e.g. on first load or
    // right after Property/Service Selection changes; send the UI's
    // current checkbox state on every subsequent edit (checkbox toggle,
    // Travel amount) so the server always re-prices from the real,
    // possibly user-overridden, selection -- same "server recomputes,
    // never trusts a client total" rule /api/create-job applies to price.
    if (urlPath === '/api/commission' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = commissionEngine.computeCommission({
        photographerName: body.photographerName,
        order: body.order || {},
        checkedItemIds: body.checkedItemIds,
        travelCents: body.travelCents,
        config: commissionConfig,
      });
      return sendJson(res, 200, result);
    }

    if (urlPath === '/api/plan' && req.method === 'POST') {
      const body = await readJsonBody(req);
      // The client's Job Root Folder field is authoritative for its own
      // requests (whether typed or set via Browse) -- the in-memory
      // `rootFolder` is only the fallback default for a blank field.
      const effectiveRootFolder = body.rootFolder || rootFolder;
      const folderName = sanitize.buildJobFolderName({
        shootDate: body.shootDate, address: body.address, clientName: body.clientName,
      });
      const componentFolders = folderBuilder.getComponentFolders(body.order || {});
      const jobIdPreview = idGenerator.getNextJobId(effectiveRootFolder);
      return sendJson(res, 200, { folderName, componentFolders, jobIdPreview, rootFolder: effectiveRootFolder });
    }

    if (urlPath === '/api/create-job' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const order = body.order || {};
      const effectiveRootFolder = body.rootFolder || rootFolder;

      if (!effectiveRootFolder) {
        return sendJson(res, 400, { error: 'Job Root Folder is required.' });
      }
      if (!validate.isValidShootDate(body.shootDate)) {
        return sendJson(res, 400, { error: 'Shoot Date must be a valid calendar date in yyyy/mm/dd format (e.g. 2026/08/27).' });
      }

      // Recompute price server-side -- never trust a client-supplied total.
      // Same algorithm as pricing/tester.html: 'ok' is used as-is; when
      // 'ambiguous', the client already showed the same candidate cards
      // tester.html shows and picked one by index -- we just re-select
      // that exact candidate here rather than guessing server-side.
      const rawPrice = pricingAdapter.calculatePrice(order);
      let price;
      if (rawPrice.status === 'ok') {
        price = rawPrice;
      } else if (rawPrice.status === 'ambiguous') {
        const idx = Number(body.chosenCandidateIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= rawPrice.candidates.length) {
          return sendJson(res, 400, { error: 'Ambiguous pricing -- chosenCandidateIndex is required.', price: rawPrice });
        }
        price = Object.assign({ status: 'ok' }, rawPrice.candidates[idx]);
      } else {
        return sendJson(res, 400, { error: 'Pricing is not valid for this selection.', price: rawPrice });
      }

      // Recompute commission server-side too -- same "never trust a
      // client-supplied total" rule as price above, and entirely
      // independent from it (commission-engine.js never touches
      // pricingAdapter/rawPrice). Photographer Name is optional (see
      // Client Information panel / pendingConfirmation) -- when it's
      // still blank, commission is left undefined rather than computed as
      // an all-zero breakdown, so Job Info.txt correctly says "not
      // calculated yet" instead of implying $0 commission was decided.
      const commission = body.photographerName && String(body.photographerName).trim()
        ? commissionEngine.computeCommission({
            photographerName: body.photographerName,
            order,
            checkedItemIds: (body.commission && body.commission.checkedItemIds) || [],
            travelCents: body.commission && body.commission.travelCents,
            config: commissionConfig,
          })
        : undefined;

      const jobId = idGenerator.getNextJobId(effectiveRootFolder);
      const folderName = sanitize.buildJobFolderName({
        shootDate: body.shootDate, address: body.address, clientName: body.clientName,
      });
      const jobFolderPath = path.join(effectiveRootFolder, folderName);
      // Deliberately does NOT persist effectiveRootFolder as the default --
      // that's opt-in via the UI's "Save as default path" checkbox
      // (POST /api/root-folder), so a one-off job elsewhere never
      // silently changes what the next job defaults to.
      const componentFolders = folderBuilder.createJobFolders(jobFolderPath, order).slice(1)
        .map((abs) => path.relative(jobFolderPath, abs));

      // Local job creation above is the critical path and has already
      // succeeded by this point. Dropbox is mirrored best-effort from here
      // on -- syncJobFolderToDropbox() is designed to never throw, but it's
      // wrapped in try/catch anyway (belt and suspenders) so absolutely
      // nothing about this step can turn a successful local job creation
      // into a failed API response. A failed/skipped sync is recorded in
      // job.json/Job Info.txt via pendingConfirmation instead, for manual
      // retry later.
      let dropboxResult;
      try {
        dropboxResult = await dropboxSync.syncJobFolderToDropbox({ folderName, componentFolders, jobId });
      } catch (err) {
        dropboxResult = { attempted: true, success: false, error: 'Unexpected Dropbox sync failure: ' + err.message };
      }

      const jobData = {
        jobId,
        createdAt: new Date().toISOString(),
        clientName: body.clientName,
        photographerName: body.photographerName,
        address: body.address,
        propertyType: body.propertyType,
        shootDate: body.shootDate,
        order,
        price,
        folderName,
        componentFolders,
        dropboxResult,
        commission,
      };
      const written = jobFiles.writeJobFiles(jobFolderPath, jobData);
      const pendingConfirmation = jobFiles.computePendingConfirmation(jobData);

      return sendJson(res, 200, {
        success: true,
        jobId,
        jobFolderPath,
        componentFolders,
        jobInfoPath: written.infoPath,
        jobJsonPath: written.jsonPath,
        price,
        commission,
        dropbox: dropboxResult,
        pendingConfirmation,
      });
    }

    // Two-way file sync for an EXISTING job folder -- separate from job
    // creation above, and separate from dropbox-sync.js (which only
    // builds the empty folder skeleton once, at creation time). Two
    // explicit directions, matching the two buttons in the UI -- there is
    // no single "auto-merge both ways" action (see file-sync.js's header
    // for why: silently merging both directions risks quietly clobbering
    // someone's edit). A file changed on both sides since the last sync
    // is reported as a conflict and left untouched on both sides rather
    // than guessed at. Can take a long time for a large first-time sync
    // (many/large files); these requests simply run to completion and
    // return one final summary rather than streaming progress -- there is
    // no progress UI yet.
    if (urlPath === '/api/push-job-files' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.jobFolderPath || typeof body.jobFolderPath !== 'string') {
        return sendJson(res, 400, { error: 'jobFolderPath (string) is required.' });
      }
      const dropboxJobFolderName = path.basename(body.jobFolderPath);
      const result = await fileSync.pushJobFilesToDropbox({ jobFolderPath: body.jobFolderPath, dropboxJobFolderName });
      return sendJson(res, 200, result);
    }

    if (urlPath === '/api/pull-job-files' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.jobFolderPath || typeof body.jobFolderPath !== 'string') {
        return sendJson(res, 400, { error: 'jobFolderPath (string) is required.' });
      }
      const dropboxJobFolderName = path.basename(body.jobFolderPath);
      const result = await fileSync.pullJobFilesFromDropbox({ jobFolderPath: body.jobFolderPath, dropboxJobFolderName });
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: 'Unknown API route: ' + urlPath });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath);
  } else {
    serveStatic(req, res, urlPath);
  }
});

server.listen(PORT, () => {
  console.log('FranVision Job Generator running at http://localhost:' + PORT);
  console.log('Job Root Folder (remembered from ' + configStore.DEFAULT_CONFIG_PATH + '): ' + rootFolder);
});
