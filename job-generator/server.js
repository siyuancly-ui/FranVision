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
//   form-state.js         -- per-job sidecar so a Draft/Recent Job reloads fully into the form
//   job-list.js           -- Drafts panel + Recent Jobs panel listings (scans job.json files)

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
const formState = require('./form-state.js');
const jobList = require('./job-list.js');
const deliveryEmail = require('./delivery-email.js');

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
// missing picker must never be fatal. (Re-added 2026-09-13 on the
// `windows-package` branch, built for Franky's Windows test package --
// was written and tested on macOS only in September, never verified on a
// real Windows box, and had been deliberately kept off `main`/
// `combined-test` since; see `job-generator-delivery-email-followup` for
// the original commit if this needs picking back up again later.)
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
      //
      // Writes the path as raw UTF-8 BYTES directly to the process's
      // stdout stream ([Console]::OpenStandardOutput(), bypassing
      // [Console]::Out entirely) rather than `[Console]::Out.Write(...)`
      // (found in real use, 2026-09-15: a Chinese client name round-tripped
      // through Browse came back as replacement-character mojibake, which
      // then made file-sync's Push/Pull silently no-op against a folder
      // that doesn't actually exist on disk under that mangled name).
      // `[Console]::Out`'s text encoding, when stdout is redirected to a
      // pipe (as it always is here, captured by Node's execFile) rather
      // than a real console window, defaults to the OS's OEM/ANSI code
      // page (e.g. GBK on a Simplified Chinese Windows install) -- NOT
      // UTF-8 -- regardless of what `[Console]::OutputEncoding` is set to
      // (that setter can also throw outright when stdout isn't a real
      // console, so it's not a fix either). Writing raw bytes through the
      // underlying stream sidesteps that encoding entirely: we choose the
      // bytes, Node (which defaults execFile's stdout decoding to UTF-8)
      // reads them back correctly regardless of the Windows machine's
      // locale/OEM code page.
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        "$d.Description = 'Select Job Root Folder:';",
        '$d.ShowNewFolderButton = $true;',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '$bytes = [System.Text.Encoding]::UTF8.GetBytes($d.SelectedPath);',
        '$stream = [Console]::OpenStandardOutput();',
        '$stream.Write($bytes, 0, $bytes.Length);',
        '$stream.Flush();',
        '}',
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
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
    // Collect raw Buffer chunks and only decode to a string ONCE, after
    // concatenating them all (Buffer.concat). Chinese (and any other
    // multi-byte UTF-8) client/address names would otherwise come out as
    // mojibake intermittently: appending each chunk with `data += chunk`
    // implicitly calls that chunk's OWN `.toString('utf8')` in isolation,
    // and a multi-byte character split across a TCP chunk boundary (which
    // happens on some requests and not others, depending on where the
    // split happens to land -- this payload can be large, e.g. a Shoot
    // Notes image) decodes as U+FFFD replacement characters on each side
    // of the cut instead of the original character. Found in real use,
    // 2026-09-14.
    const chunks = [];
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
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!bytes) return resolve({});
      const data = Buffer.concat(chunks, bytes).toString('utf8');
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Windows transiently locks a folder's handle while Explorer has it open,
// Dropbox/OneDrive's desktop client is scanning it, or antivirus is
// indexing it -- fs.renameSync then throws EPERM (found in real use,
// 2026-09-14, renaming a folder right after creating it, where the
// client-side desktop sync app was still touching it). A few retries with
// a short delay clears the transient case; a real, lasting lock (the
// folder genuinely open in another program) still surfaces, but as a
// clear, actionable message instead of a raw Node stack trace.
async function renameFolderWithRetry(oldPath, newPath, { attempts = 5, delayMs = 300 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fs.promises.rename(oldPath, newPath);
      return;
    } catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EBUSY';
      if (!transient || i === attempts) {
        const wrapped = new Error(
          'Could not rename the folder on disk (' + err.code + '). It may be open in File Explorer/Finder, '
            + 'a cloud-sync app (Dropbox/OneDrive), or another program -- close anything using it and try again.',
        );
        wrapped.statusCode = 409;
        throw wrapped;
      }
      await sleep(delayMs);
    }
  }
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
      // relabel the button to "Update FVS-…" before the click. A folder
      // that exists but has no real Job ID yet (jobId: null) is a
      // Save-Draft'd job (see id-generator.js / root CLAUDE.md's
      // "Draft/Job unification", 2026-09-13) -- also surfaced, so the UI
      // can relabel Create Job to "assign an ID to this draft" instead of
      // "brand new job" or "update".
      const existing = idGenerator.findExistingJob(effectiveRootFolder, folderName);
      const folderExists = !!existing && !existing.unreadable;
      const hasRealId = folderExists && typeof existing.jobId === 'string';
      const jobIdPreview = hasRealId ? null : idGenerator.getNextJobId(effectiveRootFolder);
      return sendJson(res, 200, {
        folderName,
        componentFolders,
        jobIdPreview,
        matchesExistingJob: hasRealId ? existing.jobId : null,
        matchesExistingDraft: folderExists && !hasRealId,
        // The saved total of the job/draft this would update -- so the UI
        // can show "was $X" next to the current selection's total.
        existingTotalCents: folderExists ? existing.previousTotalCents : null,
        existingFolderUnreadable: !!(existing && existing.unreadable),
        rootFolder: effectiveRootFolder,
      });
    }

    // Drafts panel + Recent Jobs panel -- see job-list.js. Both just scan
    // the Job Root Folder's job.json files; a "Draft" IS a real job folder
    // (jobId: null), not a separate storage tier -- see root CLAUDE.md's
    // "Draft/Job unification" note (2026-09-13).
    if (urlPath === '/api/drafts' && req.method === 'GET') {
      return sendJson(res, 200, { drafts: jobList.listDrafts(rootFolder) });
    }

    if (urlPath === '/api/recent-jobs' && req.method === 'GET') {
      return sendJson(res, 200, { jobs: jobList.listRecentJobs(rootFolder) });
    }

    // Loads a job folder's full record back into the Create Job form --
    // for re-opening a Draft OR a Recent Job (neither had this before
    // 2026-09-13; Drafts had their own separate loader, Recent Jobs is
    // brand new -- see form-state.js for why job.json alone isn't enough).
    if (urlPath === '/api/job-detail' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const effectiveRootFolder = body.rootFolder || rootFolder;
      const jobFolderPath = path.join(effectiveRootFolder, body.folderName || '');
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(jobFolderPath, 'job.json'), 'utf8'));
      } catch (err) {
        return sendJson(res, 404, { error: 'Job not found (or its job.json is unreadable).' });
      }
      const saved = formState.readFormState(jobFolderPath);
      return sendJson(res, 200, {
        found: true,
        folderName: body.folderName,
        jobId: data.jobId,
        createdAt: data.createdAt,
        clientName: (data.client && data.client.name) || '',
        photographerName: data.photographer || '',
        address: (data.property && data.property.address) || '',
        propertyType: (data.property && data.property.propertyType) || '',
        shootDate: data.shootDate || '',
        order: data.services || {},
        shootTime: saved.shootTime,
        notes: saved.notes,
        chosenCandidateIndex: saved.chosenCandidateIndex,
        commission: saved.commission,
        images: calendarFile.readExistingImages(jobFolderPath),
      });
    }

    // Deletes a Save-Draft'd job (local folder + best-effort Dropbox
    // mirror) -- explicit user requirement, 2026-09-13: a draft can be
    // deleted outright, unlike a real job (no delete/undo for those, see
    // DESIGN-job-update.md). Refuses anything that already has a real Job
    // ID as a safety guard -- this must never be a way to delete a job.
    if (urlPath === '/api/drafts' && req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const effectiveRootFolder = body.rootFolder || rootFolder;
      const folderName = body.folderName || '';
      const jobFolderPath = path.join(effectiveRootFolder, folderName);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(jobFolderPath, 'job.json'), 'utf8'));
      } catch (err) {
        return sendJson(res, 404, { error: 'Draft not found (or its job.json is unreadable).' });
      }
      if (!data || (typeof data.jobId !== 'string' && data.jobId !== null)) {
        return sendJson(res, 400, { error: 'This folder\'s job.json is corrupted -- resolve it by hand before deleting.' });
      }
      if (data.jobId !== null) {
        return sendJson(res, 409, { error: 'This is already a real job (' + data.jobId + '), not a draft -- it can\'t be deleted this way.' });
      }
      fs.rmSync(jobFolderPath, { recursive: true, force: true });
      let dropboxDelete;
      try {
        dropboxDelete = await dropboxSync.deleteJobFolderFromDropbox({ folderName });
      } catch (err) {
        dropboxDelete = { attempted: true, success: false, error: 'Unexpected Dropbox delete failure: ' + err.message };
      }
      return sendJson(res, 200, { success: true, dropboxDelete });
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

      // Does a job/draft with this exact canonical name already exist? If
      // so this is an UPDATE (keep its Job ID, or keep it a Draft) rather
      // than a new folder -- see DESIGN-job-update.md, extended 2026-09-13
      // (root CLAUDE.md's "Draft/Job unification" note) to also cover a
      // Save-Draft'd job (jobId: null). A folder with the name but no
      // readable job.json is refused rather than adopted as a second
      // identity.
      const folderName = sanitize.buildJobFolderName({
        shootDate: body.shootDate, address: body.address, clientName: body.clientName,
      });
      const jobFolderPath = path.join(effectiveRootFolder, folderName);

      // "Unlock identity fields" escape hatch for a Recent Job (2026-09-13,
      // see root CLAUDE.md's "Draft/Job unification" note). Normally,
      // editing Shoot Date/Address/Client Name on an already-real job
      // mints a NEW Job ID and orphans the old folder (DESIGN-job-update.md,
      // accepted 2026-09-10) -- public/index.html locks those 3 fields once
      // a Recent Job is loaded specifically to prevent that by accident,
      // but offers an explicit "unlock, this renames the folder in place"
      // checkbox for the one legitimate case: fixing a typo. When used,
      // the client sends `renameFromFolderName` (+ `renameFromJobId` as a
      // same-folder safety cross-check, in case the on-disk job changed
      // since it was loaded) -- this renames the ORIGINAL folder (local,
      // then best-effort Dropbox) to the new canonical name BEFORE the
      // findExistingJob() lookup below, so everything downstream (folder
      // diff, calendar regen, job.json rewrite, Dropbox resync) just finds
      // the already-renamed folder and proceeds as an ordinary update --
      // same Job ID, no new one minted, nothing orphaned.
      let renamedFrom = null;
      let dropboxRenameResult = null;
      if (body.renameFromFolderName && body.renameFromFolderName !== folderName) {
        const oldFolderPath = path.join(effectiveRootFolder, body.renameFromFolderName);
        let oldData;
        try {
          oldData = JSON.parse(fs.readFileSync(path.join(oldFolderPath, 'job.json'), 'utf8'));
        } catch (err) {
          return sendJson(res, 409, { error: 'Cannot rename -- the original job folder ("' + body.renameFromFolderName + '") has no readable job.json.' });
        }
        if (!oldData || typeof oldData.jobId !== 'string') {
          return sendJson(res, 409, {
            error: 'Cannot rename -- the original folder has no Job ID yet (it\'s a Draft, not a real job). '
              + 'A Draft with a changed identity just creates/updates a differently-named draft; no rename is needed for that case.',
          });
        }
        if (body.renameFromJobId && body.renameFromJobId !== oldData.jobId) {
          return sendJson(res, 409, {
            error: 'Cannot rename -- the job you loaded (' + body.renameFromJobId + ') no longer matches what\'s on disk '
              + '(' + oldData.jobId + '). Reload it and try again.',
          });
        }
        if (fs.existsSync(jobFolderPath)) {
          return sendJson(res, 409, {
            error: 'Cannot rename to "' + folderName + '" -- a folder with that name already exists. Resolve the collision by hand before retrying.',
          });
        }
        await renameFolderWithRetry(oldFolderPath, jobFolderPath);
        renamedFrom = body.renameFromFolderName;
        try {
          dropboxRenameResult = await dropboxSync.renameJobFolderOnDropbox({ oldFolderName: body.renameFromFolderName, newFolderName: folderName });
        } catch (err) {
          dropboxRenameResult = { attempted: true, success: false, error: 'Unexpected Dropbox rename failure: ' + err.message };
        }
      }

      const existing = idGenerator.findExistingJob(effectiveRootFolder, folderName);
      if (existing && existing.unreadable) {
        return sendJson(res, 409, {
          error: 'A folder named "' + folderName + '" already exists but has no readable job.json. '
            + 'Delete or fix it by hand before creating/updating this job.',
        });
      }
      const folderExists = !!existing;
      const hasRealId = folderExists && typeof existing.jobId === 'string';
      const saveAsDraft = !!body.saveAsDraft;
      // Save Draft can never strip an ID a job already has -- once a job
      // is real, the only way to change it is Update (assignId, below).
      if (saveAsDraft && hasRealId) {
        return sendJson(res, 409, {
          error: 'This job already has an ID (' + existing.jobId + ') -- Save Draft can\'t remove it. Click Create Job to update it instead.',
        });
      }

      // For an update (real job OR an already-Save-Draft'd folder), the
      // calendar file is regenerated from scratch -- so any images already
      // attached would be lost unless we carry them forward (the "load
      // existing job/draft into the form" step -- see /api/job-detail --
      // still re-sends whatever it read, but a caller that skips it, e.g.
      // re-submitting the form after a create, would otherwise lose them).
      // Merge here (a fresh upload with the same name replaces the old
      // one) and re-check the combined total BEFORE any folder side effects.
      let effectiveImages = body.images || [];
      if (folderExists && shootTimeGiven) {
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
      // Job ID: kept as-is if the folder already has a real one (ordinary
      // update); left null if this call is Save Draft; otherwise minted
      // fresh -- whether that's a brand-new job OR a Save-Draft'd folder
      // finally being turned into a real one by clicking Create Job. In
      // every case the ID's own embedded date (see id-generator.js) is
      // TODAY, i.e. the moment this call happens -- for a promoted draft
      // that's normally the shoot day (or just after), not whenever the
      // draft was first saved, which is exactly the "assign the real
      // sequence number after the shoot" behavior this was built for.
      // createdAt is preserved from the existing folder either way (real
      // job or draft) -- jobFolderPath / folderName were computed up above
      // (needed for findExistingJob).
      // getNextJobIdChecked (not the plain local-only getNextJobId) --
      // guards against the cross-machine collision id-generator.js's own
      // comment documents (2026-09-15 incident). Only applied at the
      // actual finalization point, not /api/plan's live preview above --
      // that stays local-only/instant so a Dropbox round-trip doesn't add
      // latency to every keystroke; a preview ID occasionally bumping by
      // one at real creation time is an acceptable cosmetic tradeoff.
      const jobId = saveAsDraft
        ? null
        : (hasRealId ? existing.jobId : await idGenerator.getNextJobIdChecked(effectiveRootFolder, undefined, dropboxSync.jobIdExistsOnDropbox));
      const createdAt = folderExists ? (existing.createdAt || nowIso) : nowIso;
      // True only on the one call that actually turns a Save-Draft'd
      // folder into a real job -- lets the response (and the UI) say
      // something more specific than the generic "updated".
      const finalizedFromDraft = folderExists && !hasRealId && !!jobId;

      // Deliberately does NOT persist effectiveRootFolder as the default --
      // that's opt-in via the UI's "Save as default path" checkbox
      // (POST /api/root-folder), so a one-off job elsewhere never
      // silently changes what the next job defaults to.
      // createJobFolders is idempotent -- on an update it just tops up any
      // component folders the new service selection now needs. Its return
      // value (absolute filesystem paths) is used only for the mkdir side
      // effect here -- componentFolders itself comes straight from
      // getComponentFolders(order) instead of path.relative()-ing those
      // absolute paths back down. path.relative()/path.join() use the HOST
      // OS's native separator ('\' on Windows), but every downstream
      // consumer of componentFolders (dropbox-sync.js#expandFolderPaths,
      // delivery-email.js's folder-name Set, diffComponentFolders) expects
      // the canonical '/'-joined POSIX form folder-builder.js always
      // produces -- found in real use on Windows (2026-09-11): "0 RAW"'s
      // nested entries (e.g. "0 RAW\1 Raws") never split on '/', so
      // expandFolderPaths never emitted a separate "0 RAW" parent folder to
      // create on Dropbox at all, only oddly-named single folders with a
      // literal backslash in the name. Single-segment folders (Revisions,
      // MLS, ...) were unaffected, which is why only "0 RAW" looked missing.
      folderBuilder.createJobFolders(jobFolderPath, order);
      const componentFolders = folderBuilder.getComponentFolders(order);

      // Updating an existing folder (real job OR draft) only: prune
      // component folders that are no longer part of the selected
      // services -- but ONLY when they're empty (no real files). A folder
      // that still holds work is left alone and reported.
      let foldersAdded = [];
      let foldersRemoved = [];
      let foldersKeptWithFiles = [];
      if (folderExists) {
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

      // Calendar file. On an update (real job or draft) where Shoot Time
      // has been cleared, drop any previously-generated calendar folder.
      // Otherwise (re)generate it -- with `effectiveImages` (fresh +
      // preserved) on an update, or just the fresh images on a first save.
      let calendarResult;
      if (folderExists && !shootTimeGiven) {
        fs.rmSync(path.join(jobFolderPath, calendarFile.ICS_FILENAME), { force: true });
        fs.rmSync(path.join(jobFolderPath, calendarFile.LEGACY_FOLDER_NAME), { recursive: true, force: true });
        calendarResult = null;
      } else {
        calendarResult = calendarFile.writeCalendarFile(jobFolderPath, {
          jobId, clientName: body.clientName, address: body.address,
          shootDate: body.shootDate, shootTime: body.shootTime,
          notes: body.notes, images: effectiveImages,
          order: body.order, photographerName: body.photographerName,
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
      if (folderExists && (foldersRemoved.length || foldersKeptWithFiles.length)) {
        try {
          const diff = folderBuilder.diffComponentFolders(order, existing.order);
          dropboxPruneResult = await dropboxSync.updateJobFoldersOnDropbox({
            folderName, foldersToCreate: [], foldersToPrune: diff.toRemove,
          });
        } catch (err) {
          dropboxPruneResult = { attempted: true, success: false, error: 'Unexpected Dropbox prune failure: ' + err.message };
        }
      }

      // Delivery Email (see delivery-email.js) -- interim .txt form of the
      // eventual client delivery page. Best-effort, same as Dropbox above:
      // pre-create the Dropbox-only 'MLS for download' folder (so its
      // shared link can be generated immediately, before Photo Sync
      // Worker ever writes into it), then generate both language files.
      // Never blocks/fails job creation -- wrapped in try/catch on top of
      // both callees' own never-throw contract.
      //
      // Deliberately SKIPPED while this is still a Save-Draft'd job (no
      // jobId yet) -- explicit user decision, 2026-09-13: generating the
      // client-facing delivery text before the shoot has even happened
      // (with dead/placeholder Dropbox links, since there's nothing in
      // "MLS for download" yet) risks it being sent to a client by
      // accident before the job is ever finalized. Runs on the one call
      // that assigns the real ID (finalizedFromDraft) same as any other
      // create/update.
      let deliveryEmailResult = null;
      if (jobId) {
        try {
          await dropboxSync.ensureMlsForDownloadFolder({ folderName });
          deliveryEmailResult = await deliveryEmail.generateDeliveryEmails({
            jobFolderPath, folderName, clientName: body.clientName, address: body.address,
            order, componentFolders, totalCents: price.totalCents, preTaxCents: price.finalSubtotalCents,
          });
        } catch (err) {
          deliveryEmailResult = { attempted: true, success: false, error: 'Unexpected delivery-email failure: ' + err.message };
        }
      }

      // Form-reload sidecar (see form-state.js) -- written every call,
      // draft or real, so a Draft OR a Recent Job can be re-opened later
      // with Shoot Time/notes/the pricing candidate chosen/commission
      // checkboxes intact (none of which job.json itself carries).
      formState.writeFormState(jobFolderPath, {
        shootTime: body.shootTime,
        notes: body.notes,
        chosenCandidateIndex: Number.isInteger(Number(body.chosenCandidateIndex)) ? Number(body.chosenCandidateIndex) : null,
        commission: {
          checkedItemIds: (body.commission && body.commission.checkedItemIds) || [],
          travelCents: (body.commission && body.commission.travelCents) || 0,
        },
      });

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
      // A failed Dropbox-side rename leaves local and Dropbox folder names
      // mismatched (local already moved -- that's the critical path and
      // always succeeds first) -- flag it the same way any other Dropbox
      // sync problem is flagged, since the next Push would otherwise
      // silently create a duplicate folder on Dropbox under the new name.
      if (dropboxRenameResult && !dropboxRenameResult.success && !dropboxRenameResult.skipped) {
        pendingConfirmation.push(
          'Local folder renamed to "' + folderName + '", but the matching Dropbox rename failed: ' + dropboxRenameResult.error
          + ' -- rename it by hand in Dropbox (from "' + renamedFrom + '") before the next Sync to Dropbox, or it will create a duplicate.'
        );
      }

      return sendJson(res, 200, {
        success: true,
        mode: folderExists ? 'updated' : 'created',
        isDraft: !jobId,
        finalizedFromDraft,
        renamedFrom,
        dropboxRename: dropboxRenameResult,
        jobId,
        folderName,
        jobFolderPath,
        componentFolders,
        calendar: calendarResult ? { icsPath: calendarResult.icsPath, imageCount: calendarResult.attachedImages.length } : null,
        jobInfoPath: written.infoPath,
        jobJsonPath: written.jsonPath,
        price,
        previousTotalCents: folderExists ? existing.previousTotalCents : null,
        foldersAdded,
        foldersRemoved,
        foldersKeptWithFiles,
        commission,
        dropbox: dropboxResult,
        dropboxPrune: dropboxPruneResult || null,
        deliveryEmail: deliveryEmailResult,
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
