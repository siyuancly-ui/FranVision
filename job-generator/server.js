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
const crypto = require('crypto');
const jobBackend = require('./job-backend.js');
const jobSync = require('./job-sync.js');

// Windows can reserve whole port ranges (Hyper-V / WSL / Docker), which makes
// listen() fail with EACCES on a port nothing is using -- so on EACCES we try
// the next few ports and report which one we got. JG_PORT overrides the start.
const BASE_PORT = Number(process.env.JG_PORT) || 4173;
const PORT_TRIES = 20;
let PORT = BASE_PORT;
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

// Native "choose folder" dialog -- AppleScript on macOS. No npm
// dependency. Resolves { cancelled: true } (not a rejection) whenever the
// user dismisses the dialog, the tool isn't available, or anything else
// goes wrong -- the UI's Job Root Folder field is always typeable as a
// fallback, so a missing picker must never be fatal. (Windows support --
// a PowerShell FolderBrowserDialog branch here plus Job Generator.bat --
// was written and tested on macOS only, never verified on a real Windows
// box, and is intentionally kept off main for now; see the
// job-generator-delivery-email-followup branch if picking it back up.)
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

// The shared job backend (job-backend.js) is the authority for Job IDs and
// job/draft metadata once configured. Creating/updating a job while it can't
// be reached is REFUSED rather than worked around with a local/temporary ID
// (explicit decision 2026-09-19) -- Dropbox needs the network anyway.
// Save as Draft: turn the request's images into links. Entries that already
// carry a `url` (re-saved draft) are kept as-is; fresh / legacy base64 ones are
// uploaded to the job server's public bucket under an unguessable path (random
// 128-bit hex -- the link IS the access control, see supabase/storage.sql).
// Throws BackendError on failure so the caller can refuse the save: a calendar
// event that silently lost its screenshots would be worse than an error.
async function uploadDraftImages(images) {
  const out = [];
  for (const img of images || []) {
    if (img && img.url) { out.push({ filename: img.filename, url: img.url }); continue; }
    const ext = String(img.filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    const objectPath = crypto.randomBytes(16).toString('hex') + '.' + (ext ? ext[1] : 'jpg');
    const url = await jobBackend.uploadImage({
      objectPath,
      contentType: calendarFile.EXT_MIME[ext ? ext[1] : 'jpg'] || 'application/octet-stream',
      buffer: Buffer.from(img.dataBase64 || '', 'base64'),
    });
    out.push({ filename: img.filename, url });
  }
  return out;
}

function sendBackendError(res, err) {
  const offline = !!(err && err.unreachable);
  return sendJson(res, offline ? 503 : 502, {
    error: (offline
      ? 'Can\'t reach the job server -- creating or updating a job needs an internet connection. '
      : 'The job server refused the request. ') + '(' + (err && err.message || err) + ')',
    backendError: true,
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
      // relabel the button to "Update FVS-…" before the click. A folder
      // that exists but has no real Job ID yet (jobId: null) is a
      // Save-Draft'd job (see id-generator.js / root CLAUDE.md's
      // "Draft/Job unification", 2026-09-13) -- also surfaced, so the UI
      // can relabel Create Job to "assign an ID to this draft" instead of
      // "brand new job" or "update".
      // With the shared job backend configured, "exists" also means "exists on
      // the server" (a job made on the other machine). This is a live
      // preview, so an unreachable server degrades to the local view + a
      // flag instead of an error -- Create Job itself is the one that refuses.
      let existing;
      let serverUnreachable = false;
      let jobConflict = null;
      try {
        const resolved = await jobSync.resolveExisting(effectiveRootFolder, folderName, jobBackend);
        existing = resolved.existing;
        jobConflict = resolved.conflict;
      } catch (err) {
        serverUnreachable = true;
        existing = idGenerator.findExistingJob(effectiveRootFolder, folderName);
      }
      const folderExists = !!existing && !existing.unreadable;
      const hasRealId = folderExists && typeof existing.jobId === 'string';
      let jobIdPreview = null;
      if (!hasRealId) {
        if (jobBackend.isConfigured() && !serverUnreachable) {
          try { jobIdPreview = await jobSync.previewJobId({ rootFolder: effectiveRootFolder, backend: jobBackend }); }
          catch (err) { serverUnreachable = true; }
        }
        if (!jobIdPreview && !jobBackend.isConfigured()) jobIdPreview = idGenerator.getNextJobId(effectiveRootFolder);
      }
      return sendJson(res, 200, {
        serverUnreachable,
        jobConflict,
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
    // With the shared job backend configured both lists come from the
    // SERVER (so a draft saved on the Mac shows on the Windows desktop);
    // an unreachable server falls back to this machine's own folders.
    if (urlPath === '/api/drafts' && req.method === 'GET') {
      if (jobBackend.isConfigured()) {
        try {
          const rows = await jobBackend.listDrafts();
          const fromServer = (rows || []).map(jobSync.summaryFromRow);
          // Old-style drafts (a real folder made before drafts moved to the
          // server) that the server never heard about stay visible.
          const known = new Set(fromServer.map((d) => d.folderName));
          const legacy = jobList.listDrafts(rootFolder).filter((d) => !known.has(d.folderName));
          return sendJson(res, 200, { drafts: fromServer.concat(legacy), source: 'server' });
        } catch (err) {
          return sendJson(res, 200, { drafts: jobList.listDrafts(rootFolder), source: 'local', serverError: err.message });
        }
      }
      return sendJson(res, 200, { drafts: jobList.listDrafts(rootFolder) });
    }

    if (urlPath === '/api/recent-jobs' && req.method === 'GET') {
      if (jobBackend.isConfigured()) {
        try {
          const since = new Date(Date.now() - jobList.RECENT_JOBS_WINDOW_MS).toISOString();
          const rows = await jobBackend.listRecentJobs(since);
          const fromServer = (rows || []).map(jobSync.summaryFromRow);
          const known = new Set(fromServer.map((j) => j.folderName));
          const legacy = jobList.listRecentJobs(rootFolder).filter((j) => !known.has(j.folderName));
          return sendJson(res, 200, { jobs: fromServer.concat(legacy), source: 'server' });
        } catch (err) {
          return sendJson(res, 200, { jobs: jobList.listRecentJobs(rootFolder), source: 'local', serverError: err.message });
        }
      }
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
      // Server row first (authoritative, and the only copy when the job was
      // made on the other machine); images still come from THIS machine's
      // folder when it has one (they're not on the server yet).
      if (jobBackend.isConfigured()) {
        try {
          const row = await jobBackend.getJob(body.folderName || '');
          if (row) {
            const detail = jobSync.detailFromRow(row);
            // New-style drafts keep their screenshots as LINKS in the row
            // (detail.images from detailFromRow) -- works on any machine.
            // Older ones: base64 in this machine's folder / calendar file.
            if (!detail.images.length) detail.images = fs.existsSync(jobFolderPath) ? calendarFile.readExistingImages(jobFolderPath) : [];
            if (!detail.images.length && detail.calendarFile) {
              detail.images = calendarFile.readImagesFromIcsFile(path.join(effectiveRootFolder, detail.calendarFile));
            }
            return sendJson(res, 200, detail);
          }
        } catch (err) { /* unreachable -> fall through to this machine's own copy */ }
      }
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
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(path.join(jobFolderPath, 'job.json'), 'utf8'));
      } catch (err) { /* no local copy on this machine -- fine if the server has the draft */ }
      if (data && (typeof data.jobId !== 'string' && data.jobId !== null)) {
        return sendJson(res, 400, { error: 'This folder\'s job.json is corrupted -- resolve it by hand before deleting.' });
      }
      if (data && data.jobId !== null) {
        return sendJson(res, 409, { error: 'This is already a real job (' + data.jobId + '), not a draft -- it can\'t be deleted this way.' });
      }
      // The server row goes too (it refuses a real job itself -- same guard,
      // enforced where the ID actually lives).
      let serverDeleted = false;
      if (jobBackend.isConfigured()) {
        try {
          const r = await jobBackend.deleteDraft(folderName);
          if (r && r.reason === 'real_job') {
            return sendJson(res, 409, { error: 'This is already a real job (' + r.job_id + '), not a draft -- it can\'t be deleted this way.' });
          }
          serverDeleted = !!(r && r.deleted);
        } catch (err) {
          return sendBackendError(res, err);
        }
      }
      if (!data && !serverDeleted) {
        return sendJson(res, 404, { error: 'Draft not found (or its job.json is unreadable).' });
      }
      fs.rmSync(jobFolderPath, { recursive: true, force: true });
      let dropboxDelete;
      try {
        // A new-style draft never had a Dropbox folder -- deleting one by that
        // name could wipe an unrelated folder someone made by hand. Only an
        // old-style draft (it had a local folder, hence a Dropbox mirror) gets it.
        dropboxDelete = data
          ? await dropboxSync.deleteJobFolderFromDropbox({ folderName })
          : { attempted: false, success: true, skipped: true, note: 'no folder was ever created for this draft' };
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
      let renamedRemoteRow = null; // server row under the OLD name, when the job has no folder on this machine
      let dropboxRenameResult = null;
      if (body.renameFromFolderName && body.renameFromFolderName !== folderName) {
        const oldFolderPath = path.join(effectiveRootFolder, body.renameFromFolderName);
        let oldData;
        try {
          oldData = JSON.parse(fs.readFileSync(path.join(oldFolderPath, 'job.json'), 'utf8'));
        } catch (err) {
          // A job made on the OTHER machine has no folder here -- the server
          // row still identifies it, and the rename applies to that (and
          // Dropbox); this machine just builds the folder under the new name.
          if (jobBackend.isConfigured()) {
            try {
              const row = await jobBackend.getJob(body.renameFromFolderName);
              if (row) { oldData = { jobId: row.job_id }; renamedRemoteRow = row; }
            } catch (e2) { return sendBackendError(res, e2); }
          }
          if (!oldData) return sendJson(res, 409, { error: 'Cannot rename -- the original job folder ("' + body.renameFromFolderName + '") has no readable job.json.' });
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
        if (fs.existsSync(oldFolderPath)) await renameFolderWithRetry(oldFolderPath, jobFolderPath);
        renamedFrom = body.renameFromFolderName;
        try {
          dropboxRenameResult = await dropboxSync.renameJobFolderOnDropbox({ oldFolderName: body.renameFromFolderName, newFolderName: folderName });
        } catch (err) {
          dropboxRenameResult = { attempted: true, success: false, error: 'Unexpected Dropbox rename failure: ' + err.message };
        }
      }

      let existing;
      try {
        const resolved = await jobSync.resolveExisting(effectiveRootFolder, folderName, jobBackend);
        existing = resolved.existing;
        if (resolved.conflict) {
          return sendJson(res, 409, {
            error: 'This job exists under two different IDs -- here as ' + resolved.conflict.local + ' but on the job server as '
              + resolved.conflict.remote + '. Resolve it by hand before continuing.',
          });
        }
      } catch (err) {
        return sendBackendError(res, err); // nothing has been created yet
      }
      // Renaming a job that only exists on the server (made on the other
      // machine): the row is still filed under the OLD name until the upsert
      // at the end, so pick it up from there -- otherwise this looked like a
      // brand-new job and minted a second Job ID.
      if (renamedRemoteRow && (!existing || existing.jobId == null)) {
        existing = jobSync.existingFromRow(Object.assign({}, renamedRemoteRow, { folder_name: folderName }), effectiveRootFolder);
      }
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

      // Save as Draft creates NO folder (2026-09-19) -- the draft's data lives
      // on the shared job server, so without it there's nowhere to keep one.
      if (saveAsDraft && !jobBackend.isConfigured()) {
        return sendJson(res, 400, {
          error: 'Save as Draft needs the job server (JG_SUPABASE_URL / JG_SUPABASE_ANON_KEY / JG_TOKEN in job-generator/.env) -- drafts no longer create a folder, so they are stored on the server.',
        });
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
      // With the shared job backend configured the SERVER assigns the ID
      // (atomic per day, never handed out twice -- the real fix for the
      // cross-machine collisions); the Dropbox check above stays as a
      // best-effort extra for IDs minted before the backend existed.
      let jobId;
      if (saveAsDraft) jobId = null;
      else if (hasRealId) jobId = existing.jobId;
      else if (jobBackend.isConfigured()) {
        try {
          jobId = await jobSync.allocateJobId({ rootFolder: effectiveRootFolder, backend: jobBackend, checkFn: dropboxSync.jobIdExistsOnDropbox });
        } catch (err) { return sendBackendError(res, err); }
      } else {
        jobId = await idGenerator.getNextJobIdChecked(effectiveRootFolder, undefined, dropboxSync.jobIdExistsOnDropbox);
      }
      const createdAt = folderExists ? (existing.createdAt || nowIso) : nowIso;
      // True only on the one call that actually turns a Save-Draft'd
      // folder into a real job -- lets the response (and the UI) say
      // something more specific than the generic "updated".
      const finalizedFromDraft = folderExists && !hasRealId && !!jobId;

      // ---- Save as Draft: NO folder, NO Dropbox, NO job.json (2026-09-19,
      // supersedes the 2026-09-13 "a draft is a real job folder" model).
      // The draft's data goes to the job server; the ONLY thing written to
      // disk is one calendar .ics dropped straight into the Job Root Folder
      // (named by calendar-file.js#buildDraftCalendarFilename), and only when
      // a Shoot Time was given. Folders (local + Dropbox) come into existence
      // at Create Job. An old-style draft that already has a real folder is
      // left untouched here -- Create Job just reuses it.
      if (saveAsDraft) {
        const draftComponentFolders = folderBuilder.getComponentFolders(order);
        const calendarFilename = shootTimeGiven
          ? calendarFile.buildDraftCalendarFilename({
              order, clientName: body.clientName, photographerName: body.photographerName,
              shootDate: body.shootDate, address: body.address,
            })
          : null;
        const draftForm = {
          shootTime: body.shootTime || '',
          notes: body.notes || '',
          chosenCandidateIndex: Number.isInteger(Number(body.chosenCandidateIndex)) ? Number(body.chosenCandidateIndex) : null,
          commission: {
            checkedItemIds: (body.commission && body.commission.checkedItemIds) || [],
            travelCents: (body.commission && body.commission.travelCents) || 0,
          },
          calendarFile: calendarFilename,
        };
        const draftJobData = {
          jobId: null, createdAt, updatedAt: nowIso,
          clientName: body.clientName, photographerName: body.photographerName, address: body.address,
          propertyType: body.propertyType, shootDate: body.shootDate, order, price,
          folderName, componentFolders: draftComponentFolders, commission,
        };
        try {
          // Upload the screenshots first: their links go into the draft row
          // (so any machine can re-show them) and into the calendar file.
          draftForm.images = await uploadDraftImages(body.images);
          await jobBackend.upsertJob(jobSync.buildRow({ folderName, job: jobFiles.buildJobJson(draftJobData), form: draftForm }));
        } catch (err) {
          return sendBackendError(res, err); // nothing has been written anywhere yet
        }
        let draftCalendar = null;
        if (calendarFilename) {
          const written = calendarFile.writeCalendarFile(effectiveRootFolder, {
            // Stable per draft identity, so re-importing an updated draft file
            // updates the same calendar event instead of adding a second one.
            jobId: 'draft-' + crypto.createHash('sha1').update(folderName).digest('hex').slice(0, 16),
            clientName: body.clientName, address: body.address,
            shootDate: body.shootDate, shootTime: body.shootTime,
            notes: body.notes, images: draftForm.images,
            order: body.order, photographerName: body.photographerName,
          }, { filename: calendarFilename });
          draftCalendar = { icsPath: written.icsPath, icsFilename: written.icsFilename, imageCount: written.attachedImages.length };
        }
        return sendJson(res, 200, {
          success: true,
          mode: folderExists ? 'updated' : 'created',
          isDraft: true,
          finalizedFromDraft: false,
          renamedFrom: null,
          jobId: null,
          folderName,
          jobFolderPath: null,
          componentFolders: draftComponentFolders,
          calendar: draftCalendar,
          price,
          previousTotalCents: folderExists ? existing.previousTotalCents : null,
          commission,
          backendSync: { success: true },
          pendingConfirmation: jobFiles.computePendingConfirmation(draftJobData),
        });
      }

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

      // Create Job no longer writes a calendar file (2026-09-19) -- the
      // calendar event comes from Save as Draft (one .ics dropped in the Job
      // Root Folder). An existing Shoot Schedule.ics in an older job's folder
      // is left exactly as it is.
      const calendarResult = null;

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
      let coverClosingResult = null;
      let tourLinkResult = null;
      if (jobId) {
        // Dropbox-only 'Cover&Closing' (delivery page's cover/closing photo
        // picks, see dropbox-sync.js) -- same real-ID-only timing and
        // best-effort contract as 'MLS for download' right below.
        try {
          coverClosingResult = await dropboxSync.ensureCoverClosingFolder({ folderName });
        } catch (err) {
          coverClosingResult = { attempted: true, success: false, error: 'Unexpected Cover&Closing failure: ' + err.message };
        }
        // Tour Link.txt (Dropbox-only, see dropbox-sync.js): created when 3D
        // Virtual Tour is ordered, removed when it was on before and is now
        // unchecked (an Update). Only ever removed on that transition -- a
        // Tour Link.txt on a job that never had 3D (e.g. a Floor Tour link
        // pasted by hand) is left alone.
        const wants3d = !!(order.addons && order.addons.three_d_tour);
        const had3d = !!(folderExists && existing.order && existing.order.addons && existing.order.addons.three_d_tour);
        try {
          if (wants3d) tourLinkResult = await dropboxSync.ensureTourLinkFile({ folderName });
          else if (had3d) tourLinkResult = await dropboxSync.removeTourLinkFile({ folderName });
        } catch (err) {
          tourLinkResult = { attempted: true, success: false, error: 'Unexpected Tour Link failure: ' + err.message };
        }
        try {
          await dropboxSync.ensureMlsForDownloadFolder({ folderName });
          deliveryEmailResult = await deliveryEmail.generateDeliveryEmails({
            jobId, jobFolderPath, folderName, clientName: body.clientName, address: body.address,
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
      const formRecord = formState.writeFormState(jobFolderPath, {
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

      // Register/refresh this job on the shared backend (the local job.json
      // above stays -- it's still the per-machine record). A failure here is
      // NOT fatal (the ID is already allocated and in the local job.json, and
      // the next Update re-registers it) but is flagged like any other sync
      // problem, since until it succeeds the OTHER machine can't see this job.
      let backendSync = null;
      if (jobBackend.isConfigured()) {
        try {
          await jobBackend.upsertJob(jobSync.buildRow({
            folderName, previousFolderName: renamedFrom,
            job: jobFiles.buildJobJson(jobData), form: formRecord,
          }));
          backendSync = { success: true };
        } catch (err) {
          backendSync = { success: false, error: err.message };
          pendingConfirmation.push('Job server not updated (' + err.message + ') -- the other machine won\'t see this job/draft until you click Update/Save again with a connection.');
        }
      }
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
        coverClosing: coverClosingResult,
        tourLink: tourLinkResult,
        backendSync,
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

function openBrowser(url) {
  // Only when the launcher asks (JG_OPEN_BROWSER=1), so the browser opens on
  // whatever port we actually got.
  if (!process.env.JG_OPEN_BROWSER) return;
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}

// Bound to 127.0.0.1 only: this tool can create jobs and touch Dropbox, so it
// must not be reachable from other machines on the LAN (and Windows policies
// that block "listen on all interfaces" don't apply to loopback).
const HOST = '127.0.0.1';

function listenOn(port, triesLeft) {
  const onError = (err) => {
    server.removeListener('error', onError);
    if (err.code === 'EACCES' || (err.code === 'EADDRINUSE' && port === 0)) {
      // Reserved range: try the next port; after PORT_TRIES, let the OS pick
      // any free one (port 0), which Windows never reserves.
      if (triesLeft > 0) return listenOn(port + 1, triesLeft - 1);
      if (port !== 0) return listenOn(0, 0);
    }
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' is already in use -- is Job Generator already running in another window?');
      process.exit(1);
    }
    throw err;
  };
  server.once('error', onError);
  // No callback here: every failed listen() would leave its callback queued
  // and they'd all fire on the one that finally succeeds (once per retry --
  // that opened ~20 browser tabs on Windows). 'listening' is handled once below.
  server.listen(port, HOST);
}

server.on('listening', () => {
  PORT = server.address().port;
  const url = 'http://localhost:' + PORT;
  console.log('FranVision Job Generator running at ' + url);
  console.log('Job Root Folder (remembered from ' + configStore.DEFAULT_CONFIG_PATH + '): ' + rootFolder);
  openBrowser(url);
});

listenOn(BASE_PORT, PORT_TRIES);
