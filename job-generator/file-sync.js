// FranVision Job Generator -- two-way local <-> Dropbox FILE sync for an
// EXISTING job folder, via two explicit directional actions: Push (local
// -> Dropbox) and Pull (Dropbox -> local). There is no single "auto-merge
// both ways" action -- the user picks a direction each time (two buttons
// in the UI), because auto-merging silently in both directions at once is
// exactly the kind of thing that quietly destroys someone's edit.
//
// Distinct from dropbox-sync.js: that module only creates the FOLDER
// skeleton (and tags the top-level folder with jobId) once, at job
// creation time. This module moves actual file CONTENTS -- raw photos,
// video, anything else in the job folder -- any time after that, as many
// times as needed in either direction.
//
// Conflict handling (explicit user requirement, not guessed): a file is a
// CONFLICT -- left untouched on both sides and reported, never
// auto-resolved -- when it changed on BOTH sides since the last confirmed
// sync. Deletions are mirrored too (a file removed on one side gets
// removed on the other next Push/Pull) UNLESS the side being deleted FROM
// changed since the last sync, which is also a conflict rather than a
// silent delete of someone's new edit.
//
// This all rests on a per-job manifest file (see MANIFEST_FILENAME) that
// records, per relative path, the LAST CONFIRMED STATE ON BOTH SIDES:
//   { "<relativePath>": { local: {size, mtimeMs}, dropbox: {rev, size} } }
// A side's current state is compared against what the manifest last
// recorded for THAT side to decide "did this side change since we last
// agreed they matched" -- this is what makes conflict detection possible
// instead of just "whichever side ran last wins". The manifest lives
// inside the job folder itself (travels with it) but is excluded from
// what gets walked/synced, same as .DS_Store.
//
// job.json and Job Info.txt (see job-files.js) are LOCAL-ONLY (see
// LOCAL_ONLY_FILENAMES) -- explicit user requirement that these two stay
// only in the local job folder, never on Dropbox at all, regardless of
// what Push/Pull does to everything else in the tree.

const fs = require('fs');
const path = require('path');
const { downloadFile: sdkDownloadFile } = require('dropbox');
const dropboxSync = require('./dropbox-sync.js');

// Names folder-builder.js can produce as a job's OWN top-level component
// folder (the first path segment of getComponentFolders()' output --
// nested ones like '0 RAW/1 Raws' still start with '0 RAW'). A genuine
// job folder is always named "<date> <address>_<client>", so if Push/Pull
// is pointed at a folder whose name is literally one of THESE instead,
// that's almost certainly a mis-click (a job's own subfolder, e.g. "0 RAW"
// or "MLS", picked instead of the job folder itself) -- found the hard
// way (2026-09-08): doing this creates an unrelated, disconnected
// top-level folder in Dropbox named "0 RAW" or "MLS", sitting among every
// other real job folder with nothing tying it back to the actual job.
const KNOWN_COMPONENT_FOLDER_NAMES = new Set([
  '0 RAW', 'Revisions', 'Home Report', 'Local Report', 'MLS',
  'Floorplan', 'Virtual Staging', 'Feature Sheets', 'Video', 'VLOG',
]);

function looksLikeAComponentFolderNotAJobFolder(jobFolderPath) {
  return KNOWN_COMPONENT_FOLDER_NAMES.has(path.basename(jobFolderPath));
}

const MANIFEST_FILENAME = '.dropbox-sync-manifest.json';

// job.json / Job Info.txt (job-files.js) and Shoot Schedule.ics
// (calendar-file.js -- the generated calendar event, with any images
// embedded as base64 ATTACH) are deliberately LOCAL-ONLY -- never pushed,
// pulled, or deleted on either side by this module. Explicit user
// requirement: these must exist only in the local job folder, regardless
// of what Push/Pull does to everything else in the tree.
const LOCAL_ONLY_FILENAMES = new Set(['job.json', 'Job Info.txt', 'Shoot Schedule.ics']);

// Pre-2026-09-10, calendar-file.js wrote a "Shoot Info" folder (holding
// the .ics plus loose image files) instead of a single root-level .ics.
// Still excluded here so any lingering old folder never syncs.
const LOCAL_ONLY_FOLDER_NAMES = new Set(['Shoot Info']);

// Dropbox limits: a single files/upload call must be under 150 MiB; above
// that, an upload session (start/append/finish) is required, and each
// append (except the final one) must be a multiple of 4 MiB. Kept well
// under the hard cap as a safety margin, and both are overridable per-call
// (see push/pull's `thresholds` param) so tests can exercise the chunked
// path against tiny fixture files instead of real 150MB+ ones.
const DEFAULT_SINGLE_SHOT_MAX_BYTES = 140 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // multiple of 4 MiB

function isExcludedName(name) {
  return name === '.DS_Store' || name === MANIFEST_FILENAME || name.startsWith('~$') ||
    LOCAL_ONLY_FILENAMES.has(name) || LOCAL_ONLY_FOLDER_NAMES.has(name);
}

// Recursively lists every real file under jobFolderPath (skipping
// isExcludedName() matches). Returns { relativePath, absolutePath, size,
// mtimeMs } for each, with relativePath always '/'-joined (POSIX-style)
// regardless of host OS, so it can be appended directly to a Dropbox path
// -- same convention as sanitize.js/folder-builder.js.
function walkFiles(jobFolderPath) {
  const results = [];

  function walk(absDir, relParts) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      return; // unreadable directory -- skip rather than throw
    }
    for (const entry of entries) {
      if (isExcludedName(entry.name)) continue;
      const absPath = path.join(absDir, entry.name);
      const relPath = [...relParts, entry.name];
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absPath);
        results.push({ relativePath: relPath.join('/'), absolutePath: absPath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }

  walk(jobFolderPath, []);
  return results;
}

// Recursively lists every real file currently on Dropbox under
// /dropboxJobFolderName, paginating through filesListFolderContinue as
// needed. Returns { relativePath, size, rev }[] -- relativePath uses the
// same '/'-joined convention as walkFiles() so the two can be compared
// directly. A job folder that doesn't exist yet on Dropbox (e.g. Pull
// attempted before any Push ever happened) is treated as empty, not an
// error.
async function listDropboxFiles(dbx, dropboxJobFolderName) {
  const basePath = '/' + dropboxJobFolderName;
  const prefix = basePath + '/';

  let page;
  try {
    page = await dbx.filesListFolder({ path: basePath, recursive: true });
  } catch (err) {
    if (dropboxSync.extractDropboxErrorMessage(err).indexOf('not_found') !== -1) return [];
    throw err;
  }

  const entries = page.result.entries.slice();
  while (page.result.has_more) {
    page = await dbx.filesListFolderContinue({ cursor: page.result.cursor });
    entries.push(...page.result.entries);
  }

  return entries
    .filter((e) => e['.tag'] === 'file')
    .map((e) => ({ relativePath: e.path_display.slice(prefix.length), size: e.size, rev: e.rev }))
    .filter((e) => !isExcludedName(path.basename(e.relativePath)));
}

function readManifest(jobFolderPath) {
  try {
    const raw = fs.readFileSync(path.join(jobFolderPath, MANIFEST_FILENAME), 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch (err) {
    return {}; // missing, unreadable, or malformed -- start fresh rather than throw
  }
}

function writeManifest(jobFolderPath, manifest) {
  fs.writeFileSync(path.join(jobFolderPath, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');
}

// ---- Pure planning logic (no I/O) -- given the current state of both
// sides plus the manifest's last-confirmed state, decide what a Push (or
// Pull) should actually do. Kept separate from the orchestrators below so
// this can be tested without any fake Dropbox client at all. ----

// Push = make Dropbox match local. Only files that changed ON THE LOCAL
// SIDE since the last sync are candidates to upload; a file that also
// changed on Dropbox in the meantime is a conflict, not an overwrite.
function planPush(localFiles, remoteFiles, manifest) {
  const localByPath = new Map(localFiles.map((f) => [f.relativePath, f]));
  const remoteByPath = new Map(remoteFiles.map((f) => [f.relativePath, f]));
  const toUpload = [];
  const toDeleteRemote = [];
  const conflicts = [];

  for (const local of localFiles) {
    const recorded = manifest[local.relativePath];
    const remote = remoteByPath.get(local.relativePath);
    const localChanged = !recorded || !recorded.local || recorded.local.size !== local.size || recorded.local.mtimeMs !== local.mtimeMs;
    if (!localChanged) continue; // nothing new to push for this file

    const remoteChanged = !!remote && (!recorded || !recorded.dropbox || recorded.dropbox.rev !== remote.rev);
    if (remote && remoteChanged) {
      conflicts.push({ relativePath: local.relativePath, reason: 'Changed both locally and on Dropbox since the last sync.' });
      continue;
    }
    toUpload.push(local);
  }

  // Local deletions -- mirror them to Dropbox, unless Dropbox's copy
  // changed since the last sync (then it's a conflict, not a delete).
  for (const relativePath of Object.keys(manifest)) {
    if (localByPath.has(relativePath)) continue; // still exists locally
    const recorded = manifest[relativePath];
    if (!recorded.local) continue; // was never actually confirmed local in the first place
    const remote = remoteByPath.get(relativePath);
    if (!remote) continue; // already gone on both sides -- stale manifest entry, nothing to do
    const remoteChanged = !recorded.dropbox || recorded.dropbox.rev !== remote.rev;
    if (remoteChanged) {
      conflicts.push({ relativePath, reason: 'Deleted locally, but changed on Dropbox since the last sync.' });
    } else {
      toDeleteRemote.push(relativePath);
    }
  }

  return { toUpload, toDeleteRemote, conflicts };
}

// Pull = make local match Dropbox. Exact mirror of planPush with the two
// sides swapped.
function planPull(remoteFiles, localFiles, manifest) {
  const localByPath = new Map(localFiles.map((f) => [f.relativePath, f]));
  const remoteByPath = new Map(remoteFiles.map((f) => [f.relativePath, f]));
  const toDownload = [];
  const toDeleteLocal = [];
  const conflicts = [];

  for (const remote of remoteFiles) {
    const recorded = manifest[remote.relativePath];
    const local = localByPath.get(remote.relativePath);
    const remoteChanged = !recorded || !recorded.dropbox || recorded.dropbox.rev !== remote.rev;
    if (!remoteChanged) continue;

    const localChanged = !!local && (!recorded || !recorded.local || recorded.local.size !== local.size || recorded.local.mtimeMs !== local.mtimeMs);
    if (local && localChanged) {
      conflicts.push({ relativePath: remote.relativePath, reason: 'Changed both locally and on Dropbox since the last sync.' });
      continue;
    }
    toDownload.push(remote);
  }

  for (const relativePath of Object.keys(manifest)) {
    if (remoteByPath.has(relativePath)) continue; // still exists on Dropbox
    const recorded = manifest[relativePath];
    if (!recorded.dropbox) continue; // was never actually confirmed on Dropbox in the first place
    const local = localByPath.get(relativePath);
    if (!local) continue; // already gone on both sides -- stale manifest entry, nothing to do
    const localChanged = !recorded.local || recorded.local.size !== local.size || recorded.local.mtimeMs !== local.mtimeMs;
    if (localChanged) {
      conflicts.push({ relativePath, reason: 'Deleted on Dropbox, but changed locally since the last sync.' });
    } else {
      toDeleteLocal.push(relativePath);
    }
  }

  return { toDownload, toDeleteLocal, conflicts };
}

function readChunkSync(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// Uploads one file to one Dropbox path, picking single-shot vs. chunked
// upload-session based on size. Always overwrites. Returns the resulting
// { rev, size } so the caller can record the new Dropbox-side state in
// the manifest.
async function uploadFile(dbx, entry, dropboxPath, thresholds) {
  const singleShotMaxBytes = (thresholds && thresholds.singleShotMaxBytes) || DEFAULT_SINGLE_SHOT_MAX_BYTES;
  const chunkSize = (thresholds && thresholds.chunkSize) || DEFAULT_CHUNK_SIZE;

  if (entry.size <= singleShotMaxBytes) {
    const result = await dbx.filesUpload({
      path: dropboxPath,
      mode: { '.tag': 'overwrite' },
      mute: true,
      contents: fs.createReadStream(entry.absolutePath),
    });
    return { rev: result.result.rev, size: result.result.size };
  }

  const fd = fs.openSync(entry.absolutePath, 'r');
  try {
    let offset = 0;
    const firstChunk = readChunkSync(fd, offset, Math.min(chunkSize, entry.size));
    const startResult = await dbx.filesUploadSessionStart({ close: false, contents: firstChunk });
    const sessionId = startResult.result.session_id;
    offset += firstChunk.length;

    while (entry.size - offset > chunkSize) {
      const chunk = readChunkSync(fd, offset, chunkSize);
      await dbx.filesUploadSessionAppendV2({ cursor: { session_id: sessionId, offset }, close: false, contents: chunk });
      offset += chunk.length;
    }

    const lastChunk = readChunkSync(fd, offset, entry.size - offset);
    const finishResult = await dbx.filesUploadSessionFinish({
      cursor: { session_id: sessionId, offset },
      commit: { path: dropboxPath, mode: { '.tag': 'overwrite' }, mute: true },
      contents: lastChunk,
    });
    return { rev: finishResult.result.rev, size: finishResult.result.size };
  } finally {
    fs.closeSync(fd);
  }
}

// Downloads one Dropbox file straight to disk. Delegates to the `dropbox`
// package's own downloadFile() helper (streamed, resumable, Node-only --
// see node_modules/dropbox/.../filedownload.js) rather than reimplementing
// chunked downloading -- unlike uploads, Dropbox's SDK already provides
// this for the download direction. `downloadImpl` is a test-only seam
// (defaults to the real SDK function) so tests never hit the real
// download machinery.
async function downloadFile(dbx, dropboxPath, localAbsolutePath, downloadImpl) {
  const impl = downloadImpl || sdkDownloadFile;
  fs.mkdirSync(path.dirname(localAbsolutePath), { recursive: true });
  await impl(dbx, dropboxPath, localAbsolutePath);
}

// ---- The two functions server.js calls ----
//
// Both share the same fault-tolerance contract as dropbox-sync.js: never
// throw (not-configured or an unexpected error both come back as a
// result object instead), and a single file's failure doesn't abort the
// rest of the batch. The manifest is written after every successful
// upload/download/delete (not batched at the end) so a killed/crashed
// process doesn't lose already-completed progress.
//
// `client` and `thresholds`/`downloadImpl` are test-only seams (see
// dropbox-sync.js's `client` param for the same pattern) -- production
// callers never pass them.

async function pushJobFilesToDropbox({ jobFolderPath, dropboxJobFolderName, client, thresholds }) {
  if (!dropboxSync.isConfigured()) {
    return { attempted: false, success: false, skipped: true, error: 'Dropbox is not configured (see job-generator/.env.example). Nothing was pushed.' };
  }
  if (looksLikeAComponentFolderNotAJobFolder(jobFolderPath)) {
    return {
      attempted: false, success: false,
      error: 'This looks like one of a job\'s OWN subfolders ("' + path.basename(jobFolderPath) + '"), not the job\'s top-level folder. Pick the job folder itself (named "<date> <address>_<client>", containing job.json) -- pushing a subfolder like this would create an unrelated top-level folder in Dropbox with no connection to the actual job.',
    };
  }

  try {
    const dbx = client || dropboxSync.getClient();
    const localFiles = walkFiles(jobFolderPath);
    const remoteFiles = await listDropboxFiles(dbx, dropboxJobFolderName);
    const manifest = readManifest(jobFolderPath);
    const { toUpload, toDeleteRemote, conflicts } = planPush(localFiles, remoteFiles, manifest);

    let uploadedCount = 0;
    let deletedCount = 0;
    const failed = [];

    for (const entry of toUpload) {
      const dropboxPath = '/' + dropboxJobFolderName + '/' + entry.relativePath;
      try {
        const { rev, size } = await uploadFile(dbx, entry, dropboxPath, thresholds);
        manifest[entry.relativePath] = { local: { size: entry.size, mtimeMs: entry.mtimeMs }, dropbox: { rev, size } };
        writeManifest(jobFolderPath, manifest);
        uploadedCount++;
      } catch (err) {
        failed.push({ relativePath: entry.relativePath, error: dropboxSync.extractDropboxErrorMessage(err) });
      }
    }

    for (const relativePath of toDeleteRemote) {
      const dropboxPath = '/' + dropboxJobFolderName + '/' + relativePath;
      try {
        await dbx.filesDeleteV2({ path: dropboxPath });
        delete manifest[relativePath];
        writeManifest(jobFolderPath, manifest);
        deletedCount++;
      } catch (err) {
        failed.push({ relativePath, error: dropboxSync.extractDropboxErrorMessage(err) });
      }
    }

    return {
      attempted: true,
      success: failed.length === 0,
      direction: 'push',
      totalLocalFiles: localFiles.length,
      totalRemoteFiles: remoteFiles.length,
      uploadedCount,
      deletedCount,
      conflicts,
      failed,
      error: failed.length ? failed.length + ' file(s) failed -- see `failed` for details.' : null,
    };
  } catch (err) {
    return {
      attempted: true, success: false, direction: 'push',
      totalLocalFiles: 0, totalRemoteFiles: 0, uploadedCount: 0, deletedCount: 0, conflicts: [], failed: [],
      error: 'Unexpected push failure: ' + dropboxSync.extractDropboxErrorMessage(err),
    };
  }
}

async function pullJobFilesFromDropbox({ jobFolderPath, dropboxJobFolderName, client, downloadImpl }) {
  if (!dropboxSync.isConfigured()) {
    return { attempted: false, success: false, skipped: true, error: 'Dropbox is not configured (see job-generator/.env.example). Nothing was pulled.' };
  }
  if (looksLikeAComponentFolderNotAJobFolder(jobFolderPath)) {
    return {
      attempted: false, success: false,
      error: 'This looks like one of a job\'s OWN subfolders ("' + path.basename(jobFolderPath) + '"), not the job\'s top-level folder. Pick the job folder itself (named "<date> <address>_<client>", containing job.json) -- pulling into a subfolder like this would create an unrelated top-level folder in Dropbox with no connection to the actual job.',
    };
  }

  try {
    const dbx = client || dropboxSync.getClient();
    const localFiles = walkFiles(jobFolderPath);
    const remoteFiles = await listDropboxFiles(dbx, dropboxJobFolderName);
    const manifest = readManifest(jobFolderPath);
    const { toDownload, toDeleteLocal, conflicts } = planPull(remoteFiles, localFiles, manifest);

    let downloadedCount = 0;
    let deletedCount = 0;
    const failed = [];

    for (const remote of toDownload) {
      const dropboxPath = '/' + dropboxJobFolderName + '/' + remote.relativePath;
      const localAbsolutePath = path.join(jobFolderPath, ...remote.relativePath.split('/'));
      try {
        await downloadFile(dbx, dropboxPath, localAbsolutePath, downloadImpl);
        const stat = fs.statSync(localAbsolutePath);
        manifest[remote.relativePath] = { local: { size: stat.size, mtimeMs: stat.mtimeMs }, dropbox: { rev: remote.rev, size: remote.size } };
        writeManifest(jobFolderPath, manifest);
        downloadedCount++;
      } catch (err) {
        failed.push({ relativePath: remote.relativePath, error: dropboxSync.extractDropboxErrorMessage(err) });
      }
    }

    for (const relativePath of toDeleteLocal) {
      const localAbsolutePath = path.join(jobFolderPath, ...relativePath.split('/'));
      try {
        fs.rmSync(localAbsolutePath, { force: true });
        delete manifest[relativePath];
        writeManifest(jobFolderPath, manifest);
        deletedCount++;
      } catch (err) {
        failed.push({ relativePath, error: err.message });
      }
    }

    return {
      attempted: true,
      success: failed.length === 0,
      direction: 'pull',
      totalLocalFiles: localFiles.length,
      totalRemoteFiles: remoteFiles.length,
      downloadedCount,
      deletedCount,
      conflicts,
      failed,
      error: failed.length ? failed.length + ' file(s) failed -- see `failed` for details.' : null,
    };
  } catch (err) {
    return {
      attempted: true, success: false, direction: 'pull',
      totalLocalFiles: 0, totalRemoteFiles: 0, downloadedCount: 0, deletedCount: 0, conflicts: [], failed: [],
      error: 'Unexpected pull failure: ' + dropboxSync.extractDropboxErrorMessage(err),
    };
  }
}

module.exports = {
  MANIFEST_FILENAME,
  LOCAL_ONLY_FILENAMES,
  LOCAL_ONLY_FOLDER_NAMES,
  KNOWN_COMPONENT_FOLDER_NAMES,
  DEFAULT_SINGLE_SHOT_MAX_BYTES,
  DEFAULT_CHUNK_SIZE,
  isExcludedName,
  looksLikeAComponentFolderNotAJobFolder,
  walkFiles,
  listDropboxFiles,
  readManifest,
  writeManifest,
  planPush,
  planPull,
  uploadFile,
  downloadFile,
  pushJobFilesToDropbox,
  pullJobFilesFromDropbox,
};
