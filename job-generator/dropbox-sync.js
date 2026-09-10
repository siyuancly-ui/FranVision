// FranVision Job Generator -- Dropbox cloud sync (optional, best-effort).
//
// Mirrors the exact same job folder tree that folder-builder.js creates
// locally into Dropbox: same top-level folder name ("<Shoot Date>
// <Address>_<Client>", built by sanitize.js#buildJobFolderName -- the Job
// ID is deliberately NOT part of any folder name) plus every component
// subfolder folder-builder.js's getComponentFolders(order) returns. That
// function stays the single source of truth for "what folders this job
// needs" -- this module does not re-derive the folder list itself, the
// caller (server.js) passes it in.
//
// The Job ID is instead attached as a HIDDEN Dropbox file-property (not
// visible anywhere in the folder name) on the top-level folder only, via
// the file_properties API. That requires a PropertyGroupTemplate to exist
// first -- see scripts/setup-dropbox-template.js, a one-time setup script.
//
// Auth: refresh-token based. A short-lived access token is never stored or
// hardcoded -- the official `dropbox` SDK is handed clientId/clientSecret/
// refreshToken and mints a fresh access token itself on every call. All
// four Dropbox values (app key, app secret, refresh token, template id)
// come from environment variables loaded from job-generator/.env (see
// .env.example for the required keys) -- this file must never contain a
// real credential.
//
// Fault tolerance: every exported async function here is designed to
// NEVER throw. Dropbox being unreachable, misconfigured, or erroring is a
// normal, expected outcome (network issues, Dropbox-side errors, or the
// user simply hasn't set up .env yet) and must never block local job
// creation, which is the critical path. Callers get back a result object
// with `success: false` and a human-readable `error` instead of a
// rejected promise.

const path = require('path');
// quiet:true -- dotenv 17.x otherwise prints a random self-promotional
// "tip" line to the console on every load; suppressed since this runs on
// every server start and shouldn't clutter the Job Generator's console.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const { Dropbox } = require('dropbox');

const TEMPLATE_NAME = 'FranVision Job';

function isConfigured() {
  return !!(
    process.env.DROPBOX_APP_KEY &&
    process.env.DROPBOX_APP_SECRET &&
    process.env.DROPBOX_REFRESH_TOKEN &&
    process.env.DROPBOX_TEMPLATE_ID
  );
}

// Returns a Dropbox client, or null if credentials are missing. Kept
// separate from isConfigured() (which also requires DROPBOX_TEMPLATE_ID)
// because the one-time setup script needs a client to CREATE that
// template, before it exists.
function getClient() {
  const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN } = process.env;
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN) return null;
  return new Dropbox({
    clientId: DROPBOX_APP_KEY,
    clientSecret: DROPBOX_APP_SECRET,
    refreshToken: DROPBOX_REFRESH_TOKEN,
    fetch,
  });
}

// ---- Pure helpers (no network) -- testable without touching Dropbox ----

// Given the top-level folder name and the list of '/'-joined component
// folder paths (same shape folder-builder.js#getComponentFolders returns,
// e.g. ['0 RAW/1 Raws', 'MLS']), returns every directory that needs to
// exist in Dropbox -- INCLUDING intermediate directories folder-builder.js
// never lists explicitly (e.g. '0 RAW' itself), because unlike
// fs.mkdirSync(..., {recursive:true}), Dropbox's create_folder does not
// create missing parents on its own. Ordered shallowest-first so parents
// are always created before their children.
function expandFolderPaths(folderName, componentFolders) {
  const depthOf = new Map(); // relPath ('/' joined, no leading slash) -> depth
  function add(parts) {
    const rel = parts.join('/');
    if (!depthOf.has(rel)) depthOf.set(rel, parts.length);
  }

  add([folderName]);
  for (const relPath of componentFolders || []) {
    const parts = String(relPath).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      add([folderName, ...parts.slice(0, i)]);
    }
  }

  return Array.from(depthOf.keys()).sort((a, b) => depthOf.get(a) - depthOf.get(b));
}

// Dropbox SDK rejections carry the full parsed error response body as
// `.error` (see node_modules/dropbox/cjs/src/response.js) -- which itself
// has an `error_summary` string. Network-level failures (DNS, offline)
// instead throw a plain Error with `.message`. This normalizes both (and
// anything else) down to one readable string.
function extractDropboxErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (err.error && typeof err.error.error_summary === 'string') return err.error.error_summary;
  if (typeof err.error === 'string') return err.error;
  if (typeof err.message === 'string') return err.message;
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

// True when create_folder_v2 failed because the folder is already there --
// treated as success (idempotent), not a real failure, so re-running job
// creation (or a retry after a partial failure) doesn't error out on
// folders it already made.
function isFolderAlreadyExistsError(err) {
  const msg = extractDropboxErrorMessage(err);
  return typeof msg === 'string' && msg.indexOf('conflict') !== -1;
}

// True when properties/add failed because this file/folder already has a
// property group for our template -- same idempotency reasoning as above.
function isPropertyGroupAlreadyExistsError(err) {
  const msg = extractDropboxErrorMessage(err);
  return typeof msg === 'string' && msg.indexOf('property_group_already_exists') !== -1;
}

// ---- The one function server.js calls ----

// Creates the full folder tree in Dropbox and tags the top-level folder
// with the hidden jobId property. NEVER throws -- see file header. Return
// shape:
//   { attempted, success, skipped?, dropboxPath, jobId,
//     foldersCreated, folderErrors, propertiesTagged, propertyError, error }
// `client` is a test-only seam (dropbox-sync.test.js injects a fake
// Dropbox client so the test suite never makes a real network call) --
// production callers never pass it, and it defaults to the real thing.
async function syncJobFolderToDropbox({ folderName, componentFolders, jobId, client }) {
  if (!isConfigured()) {
    return {
      attempted: false,
      success: false,
      skipped: true,
      error: 'Dropbox is not configured (missing one of DROPBOX_APP_KEY / '
        + 'DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN / DROPBOX_TEMPLATE_ID '
        + 'in job-generator/.env -- see .env.example). Local job creation is unaffected.',
    };
  }

  const topLevelPath = '/' + folderName;

  try {
    const dbx = client || getClient();
    const dirs = expandFolderPaths(folderName, componentFolders);

    const foldersCreated = [];
    const folderErrors = [];
    for (const relDir of dirs) {
      const dropboxPath = '/' + relDir;
      try {
        await dbx.filesCreateFolderV2({ path: dropboxPath });
        foldersCreated.push(dropboxPath);
      } catch (err) {
        if (isFolderAlreadyExistsError(err)) {
          foldersCreated.push(dropboxPath);
        } else {
          folderErrors.push({ path: dropboxPath, error: extractDropboxErrorMessage(err) });
        }
      }
    }

    const topLevelFailed = folderErrors.some((e) => e.path === topLevelPath);

    let propertiesTagged = false;
    let propertyError = null;
    if (!topLevelFailed) {
      try {
        await dbx.filePropertiesPropertiesAdd({
          path: topLevelPath,
          property_groups: [{
            template_id: process.env.DROPBOX_TEMPLATE_ID,
            fields: [{ name: 'jobId', value: jobId }],
          }],
        });
        propertiesTagged = true;
      } catch (err) {
        if (isPropertyGroupAlreadyExistsError(err)) {
          propertiesTagged = true;
        } else {
          propertyError = extractDropboxErrorMessage(err);
        }
      }
    }

    const success = !topLevelFailed && folderErrors.length === 0 && propertiesTagged;
    let error = null;
    if (!success) {
      if (topLevelFailed) {
        error = 'Failed to create the top-level Dropbox folder: ' + folderErrors.find((e) => e.path === topLevelPath).error;
      } else if (folderErrors.length) {
        error = folderErrors.length + ' Dropbox subfolder(s) failed to create (top-level folder is OK).';
      } else {
        error = 'Dropbox folder created, but tagging it with the Job ID failed: ' + propertyError;
      }
    }

    return { attempted: true, success, dropboxPath: topLevelPath, jobId, foldersCreated, folderErrors, propertiesTagged, propertyError, error };
  } catch (err) {
    // Belt-and-suspenders: nothing above should throw past its own
    // try/catch, but if it somehow does (bad config shape, SDK bug, etc.)
    // this still guarantees the promise never rejects.
    return {
      attempted: true,
      success: false,
      dropboxPath: topLevelPath,
      jobId,
      foldersCreated: [],
      folderErrors: [],
      propertiesTagged: false,
      propertyError: null,
      error: 'Unexpected Dropbox sync failure: ' + extractDropboxErrorMessage(err),
    };
  }
}

// ---- Job UPDATE: add newly-needed folders, prune no-longer-needed EMPTY
// ones (see DESIGN-job-update.md) ----
//
// Only touches folder structure -- the hidden jobId property tag is left
// alone (the Job ID never changes on an update). Same never-throw
// contract as syncJobFolderToDropbox. A folder that is no longer part of
// the selected services but still has files ON DROPBOX is left in place
// and reported in `foldersKeptWithFiles` -- Dropbox emptiness is judged
// independently from local emptiness (the caller checks local itself).
async function updateJobFoldersOnDropbox({ folderName, foldersToCreate, foldersToPrune, client }) {
  if (!isConfigured()) {
    return { attempted: false, success: false, skipped: true, error: 'Dropbox is not configured -- local update is unaffected.' };
  }

  const topLevelPath = '/' + folderName;
  try {
    const dbx = client || getClient();

    // Create: expand to include any missing intermediate dirs, shallow-first.
    const createDirs = expandFolderPaths(folderName, foldersToCreate || [])
      .filter((rel) => rel !== folderName); // the job folder itself already exists
    const foldersCreated = [];
    const errors = [];
    for (const rel of createDirs) {
      try {
        await dbx.filesCreateFolderV2({ path: '/' + rel });
        foldersCreated.push('/' + rel);
      } catch (err) {
        if (isFolderAlreadyExistsError(err)) foldersCreated.push('/' + rel);
        else errors.push({ path: '/' + rel, error: extractDropboxErrorMessage(err) });
      }
    }

    // Prune: delete each no-longer-wanted component folder, but only if
    // it has no entries on Dropbox.
    const foldersRemoved = [];
    const foldersKeptWithFiles = [];
    for (const rel of foldersToPrune || []) {
      const dropboxPath = topLevelPath + '/' + rel;
      try {
        const listing = await dbx.filesListFolder({ path: dropboxPath });
        const isEmpty = !listing.result || !listing.result.entries || listing.result.entries.length === 0;
        if (!isEmpty) { foldersKeptWithFiles.push(dropboxPath); continue; }
        await dbx.filesDeleteV2({ path: dropboxPath });
        foldersRemoved.push(dropboxPath);
      } catch (err) {
        // path_not_found -> nothing to prune, not an error.
        const msg = extractDropboxErrorMessage(err);
        if (typeof msg === 'string' && msg.indexOf('not_found') !== -1) continue;
        errors.push({ path: dropboxPath, error: msg });
      }
    }

    const success = errors.length === 0;
    return {
      attempted: true,
      success,
      foldersCreated,
      foldersRemoved,
      foldersKeptWithFiles,
      errors,
      error: success ? null : errors.length + ' Dropbox folder operation(s) failed during update.',
    };
  } catch (err) {
    return {
      attempted: true,
      success: false,
      foldersCreated: [],
      foldersRemoved: [],
      foldersKeptWithFiles: [],
      errors: [],
      error: 'Unexpected Dropbox update failure: ' + extractDropboxErrorMessage(err),
    };
  }
}

module.exports = {
  TEMPLATE_NAME,
  isConfigured,
  getClient,
  expandFolderPaths,
  extractDropboxErrorMessage,
  isFolderAlreadyExistsError,
  isPropertyGroupAlreadyExistsError,
  syncJobFolderToDropbox,
  updateJobFoldersOnDropbox,
};
