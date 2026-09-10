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
//   file-sync.js         -- two-way (Push/Pull) local <-> Dropbox FILE sync for an existing job
//   calendar-file.js     -- optional .ics calendar file (Shoot Time + notes + images)
//   draft-store.js       -- Job Drafts (save/load/delete before a shoot is finalized)

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
const calendarFile = require('./calendar-file.js');
const draftStore = require('./draft-store.js');

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

// Native "choose folder" dialog -- AppleScript on macOS, a PowerShell
// FolderBrowserDialog on Windows. No npm dependency either way. Resolves
// { cancelled: true } (not a rejection) whenever the user dismisses the
// dialog, the tool isn't available, or anything else goes wrong -- the
// UI's Job Root Folder field is always typeable as a fallback, so a
// missing picker must never be fatal.
function pickFolderNative() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select Job Root Folder:")'], (err, stdout) => {
        if (err) return resolve({ cancelled: true });
        resolve({ cancelled: false, path: stdout.trim() });
      });
      return;
    }

    if (process.platform === 'win32') {
      // -STA is required for FolderBrowserDialog (PowerShell 7 defaults to
      // MTA and would throw); Windows PowerShell 5.1 -- present on every
      // Win10/11 box -- honours it. Prints the chosen path on OK, nothing
      // on Cancel.
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        "$d.Description = 'Select Job Root Folder:';",
        '$d.ShowNewFolderButton = $true;',
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ cancelled: true });
        const picked = String(stdout).replace(/^﻿/, '').trim();
        resolve(picked ? { cancelled: false, path: picked } : { cancelled: true });
      });
      return;
    }

    resolve({ cancelled: true, unsupported: true });
  });
}

// Generous enough for /api/create-job's calendar-file.js images
// (base64-encoded, up to calendar-file.js's own MAX_TOTAL_BYTES cap, plus
// headroom for base64's ~4/3 inflation and the rest of the JSON payload)
// while still bounding the worst case for this single-threaded local server.
const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024; // 100MB

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        const err = new Error('Request body too large (max ' + (MAX_REQUEST_BODY_BYTES / (1024 * 1024)) + 'MB).');
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
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
      // If a job folder with this exact canonical name already exists,
      // Create Job will UPDATE it (keep its Job ID) rather than mint a new
      // one -- see DESIGN-job-update.md. Surfaced here so the UI can
      // relabel the button to "Update FVS-…" before the click.
      const existing = idGenerator.findExistingJob(effectiveRootFolder, folderName);
      const jobIdPreview = existing && existing.jobId ? null : idGenerator.getNextJobId(effectiveRootFolder);
      return sendJson(res, 200, {
        folderName,
        componentFolders,
        jobIdPreview,
        matchesExistingJob: existing && existing.jobId ? existing.jobId : null,
        // The saved total of the job this would update -- so the UI can
        // show "was $X" next to the current selection's total.
        existingTotalCents: existing && existing.jobId ? existing.previousTotalCents : null,
        existingFolderUnreadable: !!(existing && existing.unreadable),
        rootFolder: effectiveRootFolder,
      });
    }

    // Job Drafts -- see draft-store.js. Kept separate from /api/create-job:
    // a draft never creates a folder, job.json, or a Dropbox mirror, only
    // its own local Shoot Info (calendar + images) inside job-generator/drafts/.
    if (urlPath === '/api/drafts' && req.method === 'GET') {
      return sendJson(res, 200, { drafts: draftStore.listDrafts() });
    }

    if (urlPath === '/api/drafts' && req.method === 'POST') {
      const body = await readJsonBody(req);
      // Shoot Time (if given) and images are validated the same as
      // /api/create-job -- Shoot Date's FORMAT is deliberately NOT
      // validated here, a draft exists specifically for "the date isn't
      // locked in yet". It's still required, though, the moment Shoot
      // Time is also given -- there's no calendar event without a real
      // date to put it on (calendar-file.js#writeCalendarFile enforces
      // this too; checked here first for a clean 400 instead of a 500).
      const shootTimeGiven = body.shootTime && String(body.shootTime).trim();
      if (shootTimeGiven && !validate.isValidShootTime(body.shootTime)) {
        return sendJson(res, 400, { error: 'Shoot Time must be in HH:MM 24-hour format (e.g. 14:30).' });
      }
      if (shootTimeGiven && !validate.isValidShootDate(body.shootDate)) {
        return sendJson(res, 400, { error: 'Shoot Date must be set (valid yyyy/mm/dd) before a calendar file can be generated -- leave Shoot Time blank if the date isn\'t decided yet.' });
      }
      const imageProblems = calendarFile.validateImages(body.images);
      if (imageProblems.length) {
        return sendJson(res, 400, { error: 'Invalid image(s): ' + imageProblems.join(' ') });
      }
      const saved = draftStore.saveDraft(body.draftId, body);
      return sendJson(res, 200, {
        draftId: saved.draftId,
        updatedAt: saved.record.updatedAt,
        calendar: saved.calendarResult ? { icsPath: saved.calendarResult.icsPath, imageCount: saved.calendarResult.attachedImages.length } : null,
      });
    }

    if (urlPath.startsWith('/api/drafts/') && req.method === 'GET') {
      const draft = draftStore.getDraft(urlPath.slice('/api/drafts/'.length));
      if (!draft) return sendJson(res, 404, { error: 'Draft not found.' });
      return sendJson(res, 200, draft);
    }

    if (urlPath.startsWith('/api/drafts/') && req.method === 'DELETE') {
      draftStore.deleteDraft(urlPath.slice('/api/drafts/'.length));
      return sendJson(res, 200, { success: true });
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
      // Shoot Time is optional (unlike Shoot Date) -- blank means "don't
      // generate a calendar file", checked separately in calendar-file.js.
      // If it IS given, it must be well-formed.
      const shootTimeGiven = !!(body.shootTime && String(body.shootTime).trim());
      if (shootTimeGiven && !validate.isValidShootTime(body.shootTime)) {
        return sendJson(res, 400, { error: 'Shoot Time must be in HH:MM 24-hour format (e.g. 14:30).' });
      }

      // Validate the calendar file's images BEFORE creating
      // anything -- same "fail before any side effect" pattern as the
      // checks above.
      const calendarImageProblems = calendarFile.validateImages(body.images);
      if (calendarImageProblems.length) {
        return sendJson(res, 400, { error: 'Invalid image(s): ' + calendarImageProblems.join(' ') });
      }

      // Does a job with this exact canonical name already exist? If so
      // this is an UPDATE (keep its Job ID), not a new job -- see
      // DESIGN-job-update.md. A folder with the name but no readable
      // job.json is refused rather than adopted as a second identity.
      const folderName = sanitize.buildJobFolderName({
        shootDate: body.shootDate, address: body.address, clientName: body.clientName,
      });
      const jobFolderPath = path.join(effectiveRootFolder, folderName);
      const existing = idGenerator.findExistingJob(effectiveRootFolder, folderName);
      if (existing && existing.unreadable) {
        return sendJson(res, 409, {
          error: 'A folder named "' + folderName + '" already exists but has no readable job.json. '
            + 'Delete or fix it by hand before creating/updating this job.',
        });
      }
      const isUpdate = !!(existing && existing.jobId);

      // For an update, the calendar file is regenerated from scratch -- so
      // any images the job already had would be lost unless we carry them
      // forward (the update form has no "load existing job" step). Merge
      // them here (a fresh upload with the same name replaces the old one)
      // and re-check the combined total BEFORE any folder side effects.
      let effectiveImages = body.images || [];
      if (isUpdate && shootTimeGiven) {
        effectiveImages = calendarFile.mergeImages(calendarFile.readExistingImages(jobFolderPath), body.images);
        const mergedProblems = calendarFile.validateImages(effectiveImages);
        if (mergedProblems.length) {
          return sendJson(res, 400, { error: 'The images this job already has, plus the new ones, exceed the limit: ' + mergedProblems.join(' ') });
        }
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

      const nowIso = new Date().toISOString();
      // UPDATE reuses the existing Job ID and preserves the original
      // createdAt; a fresh job mints a new ID. jobFolderPath / folderName
      // were computed up above (needed for findExistingJob).
      const jobId = isUpdate ? existing.jobId : idGenerator.getNextJobId(effectiveRootFolder);
      const createdAt = isUpdate ? (existing.createdAt || nowIso) : nowIso;

      // Deliberately does NOT persist effectiveRootFolder as the default --
      // that's opt-in via the UI's "Save as default path" checkbox
      // (POST /api/root-folder), so a one-off job elsewhere never
      // silently changes what the next job defaults to.
      // createJobFolders is idempotent -- on an update it just tops up any
      // component folders the new service selection now needs.
      const componentFolders = folderBuilder.createJobFolders(jobFolderPath, order).slice(1)
        .map((abs) => path.relative(jobFolderPath, abs));

      // UPDATE only: prune component folders that are no longer part of the
      // selected services -- but ONLY when they're empty (no real files).
      // A folder that still holds work is left alone and reported.
      let foldersAdded = [];
      let foldersRemoved = [];
      let foldersKeptWithFiles = [];
      if (isUpdate) {
        const diff = folderBuilder.diffComponentFolders(order, existing.order);
        foldersAdded = diff.toCreate;
        for (const rel of diff.toRemove) {
          const abs = path.join(jobFolderPath, ...rel.split('/'));
          if (!fs.existsSync(abs)) continue;
          if (folderBuilder.folderHasRealFiles(abs)) {
            foldersKeptWithFiles.push(rel);
          } else {
            fs.rmSync(abs, { recursive: true, force: true });
            foldersRemoved.push(rel);
          }
        }
      }

      // Calendar file. On an update where Shoot Time has been cleared,
      // drop any previously-generated calendar folder. Otherwise
      // (re)generate it -- with `effectiveImages` (fresh + preserved) on
      // an update, or just the fresh images on a first create.
      let calendarResult;
      if (isUpdate && !shootTimeGiven) {
        fs.rmSync(path.join(jobFolderPath, calendarFile.ICS_FILENAME), { force: true });
        fs.rmSync(path.join(jobFolderPath, calendarFile.LEGACY_FOLDER_NAME), { recursive: true, force: true });
        calendarResult = null;
      } else {
        calendarResult = calendarFile.writeCalendarFile(jobFolderPath, {
          jobId, clientName: body.clientName, address: body.address,
          shootDate: body.shootDate, shootTime: body.shootTime,
          notes: body.notes, images: effectiveImages,
        });
      }

      // Local job creation/update above is the critical path and has
      // already succeeded by this point. Dropbox is mirrored best-effort
      // from here on -- these calls are designed to never throw, but are
      // wrapped in try/catch anyway so nothing about Dropbox can turn a
      // successful local operation into a failed API response.
      let dropboxResult;
      try {
        dropboxResult = await dropboxSync.syncJobFolderToDropbox({ folderName, componentFolders, jobId });
      } catch (err) {
        dropboxResult = { attempted: true, success: false, error: 'Unexpected Dropbox sync failure: ' + err.message };
      }
      let dropboxPruneResult;
      if (isUpdate && (foldersRemoved.length || foldersKeptWithFiles.length)) {
        try {
          const diff = folderBuilder.diffComponentFolders(order, existing.order);
          dropboxPruneResult = await dropboxSync.updateJobFoldersOnDropbox({
            folderName, foldersToCreate: [], foldersToPrune: diff.toRemove,
          });
        } catch (err) {
          dropboxPruneResult = { attempted: true, success: false, error: 'Unexpected Dropbox prune failure: ' + err.message };
        }
      }

      const jobData = {
        jobId,
        createdAt,
        updatedAt: nowIso,
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

      // Finalizing a Draft into a real job means the draft has done its
      // job -- Job Info.txt/job.json above already hold whatever was true
      // at the end, and no separate draft history is kept (explicit user
      // decision, 2026-09-09). Best-effort: a failure to delete the local
      // draft folder should never fail an otherwise-successful job creation.
      if (body.draftId) {
        try { draftStore.deleteDraft(body.draftId); } catch (err) { /* leftover draft folder, harmless */ }
      }

      return sendJson(res, 200, {
        success: true,
        mode: isUpdate ? 'updated' : 'created',
        jobId,
        jobFolderPath,
        componentFolders,
        calendar: calendarResult ? { icsPath: calendarResult.icsPath, imageCount: calendarResult.attachedImages.length } : null,
        jobInfoPath: written.infoPath,
        jobJsonPath: written.jsonPath,
        price,
        previousTotalCents: isUpdate ? existing.previousTotalCents : null,
        foldersAdded,
        foldersRemoved,
        foldersKeptWithFiles,
        commission,
        dropbox: dropboxResult,
        dropboxPrune: dropboxPruneResult || null,
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
    sendJson(res, err.statusCode || 500, { error: err.message });
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
