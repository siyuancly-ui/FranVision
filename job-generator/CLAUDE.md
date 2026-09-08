# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory (`job-generator/`). See the repo-root `CLAUDE.md` for how this module fits into the rest of FranVision.

## What this is

A local, double-click-to-run tool for a real estate photography studio. Given a client/property/shoot-date/service selection, it:
1. Computes pricing via `pricing/engine.js` + `pricing/pricing-config.js` (never reimplemented here — see `pricing-adapter.js`)
2. Computes a photographer commission via an independent rate engine (never touches pricing)
3. Generates a unique Job ID (`FVS-YYYYMMDD-XXX`, increments per day)
4. Creates a standardized local folder structure
5. Writes `Job Info.txt` (human-readable) and `job.json` (machine-readable, integer cents)
6. Optionally mirrors the folder skeleton + files to Dropbox, and can later push/pull local ↔ Dropbox two-way for an existing job

## Running it

```bash
cd job-generator
npm install          # only needed once, or after pulling changes to package.json
node server.js        # -> http://localhost:4173
```

Or double-click `Job Generator.command` (macOS) / `Job Generator (Windows).bat` (Windows, on the local-only `windows-support` branch — **never verified on a real Windows machine**, treat with suspicion if debugging a Windows report) at the repo root.

## Tests

No test framework — each `*.test.js` file is a self-contained script using plain Node `assert` + a hand-rolled pass/fail runner (`node <name>.test.js`). Run the whole suite:

```bash
cd job-generator
for f in *.test.js; do node "$f" || echo "FAILED: $f"; done
```

As of 2026-09-08 this is 161 tests across 10 files, all passing. Dropbox-touching modules (`dropbox-sync.js`, `file-sync.js`) never hit the real API in tests — every async orchestrator function accepts an injectable `client` (and `downloadImpl`/`thresholds` where relevant) so tests supply a fake Dropbox client object instead. **When verifying Dropbox behavior beyond what the fake-client tests cover, you are testing against the studio's real, live production Dropbox account** (confirmed directly — hundreds of real client job folders live at the account root) — always use an obviously-fake job name, and always clean up (`filesDeleteV2`) whatever you create before finishing.

## Architecture: module map

Every module below is plain Node (`module.exports`), most also loadable as a browser `<script>` (UMD pattern, `window.X`) for the ones the client-side UI needs directly — those are whitelisted in `server.js`'s `SHARED_FILES` map and served at `/shared/*.js`.

| File | Role |
|---|---|
| `sanitize.js` | Cross-platform-safe folder/file names; `buildJobFolderName()` — the one place the top-level job folder name is constructed |
| `validate.js` | `isValidShootDate()` — strict `yyyy/mm/dd`, real calendar validation |
| `id-generator.js` | `FVS-YYYYMMDD-XXX`, source of truth is scanning each job folder's `job.json` (not folder names) for today's max sequence |
| `folder-builder.js` | `getComponentFolders(order)` (pure) + `createJobFolders()` (fs) — the **single source of truth** for "what folders a job needs"; both local creation and the Dropbox mirror consume its output |
| `pricing-adapter.js` | Thin wrapper around `pricing/engine.js` + `pricing/pricing-config.js` — never reimplements pricing |
| `commission-config.js` / `commission-engine.js` | Photographer commission — **entirely independent from pricing**, no shared code or state |
| `job-files.js` | Writes `Job Info.txt` + `job.json`; owns `computePendingConfirmation()` |
| `config-store.js` | Persists the default Job Root Folder to `.config.json` |
| `dropbox-sync.js` | Best-effort: creates the empty Dropbox folder skeleton + tags it with a hidden `jobId` property, **once, at job creation** |
| `file-sync.js` | Two-way Push/Pull of actual file *contents* for an **existing** job, any time after creation, as many times as needed |
| `server.js` | Node `http`, zero framework, wires all of the above into a small JSON API |
| `public/index.html` | The UI — plain JS, no framework, no build step |

All of `folder-builder.js`, `pricing-adapter.js`, and `commission-engine.js` are driven by the **same `order` shape** (`{propertyType, photography, addons}`) — this is deliberate: one selection model feeds folders, pricing, and commission defaults instead of three parallel ones.

## Confirmed design decisions (do not "fix" without re-reading this — several of these were tried the "obvious" way first and explicitly reverted)

- **Photographer Name is optional at job creation.** Client Name, Address, Shoot Date, Job Root Folder, and a valid service selection block the Create button; Photographer Name does not.
- **Virtual Staging folder creation is decoupled from its pricing qty.** Checking the box creates the folder immediately even at qty 0 (photo count often isn't known until after the shoot) — `folder-builder.js`'s rule is `!!addons.virtual_staging || stagingQty > 0`, not `stagingQty > 0` alone.
- **`pendingConfirmation`** (`job-files.js#computePendingConfirmation`) is the single mechanism for "allowed to be incomplete now, must be caught before invoicing" — currently covers: missing Photographer Name, unconfirmed Virtual Staging qty, and a failed/skipped Dropbox sync. Surfaced in `job.json`, `Job Info.txt`, and the UI's success panel. There is intentionally **no** separate "mark job complete" workflow yet.
- **Twilight and 3D Tour have no dedicated folder** (removed 2026-09-06) — Luxury tier still gets `0 RAW/4 Raw HDR`, `three_d_tour` is still a real priced pricing-config.js addon, neither gets a folder anymore.
- **`Local Report`** is an always-present, empty, top-level folder (added 2026-09-07), same treatment as `Revisions`/`Home Report`.
- **Folder-name date has no leading zero** (`sanitize.js#formatDateForFolderName`, added 2026-09-08): `"2026.9.8 Address_Client"`, not `"2026.09.08 ..."` — matches the studio's existing real-folder naming habit. The Shoot Date **input field** still requires strict zero-padded `yyyy/mm/dd` (unrelated — that's for unambiguous validation, not display).
- **`job.json` and `Job Info.txt` are local-only, never synced to Dropbox** (`file-sync.js`'s `LOCAL_ONLY_FILENAMES`) — explicit requirement, found because they were initially reaching Dropbox incidentally via a later Push.
- **Photographer Commission**: config is keyed **per photographer** (`commission-config.js`), not a single shared rate + one exempt name — a future photographer can get their own rate table, not just an exempt flag. Franky is `{exempt: true}` in config, never a hardcoded name check in the engine. Video (Walkthrough and/or Vlog) always maps to ONE `$50` line item, never doubled. Defaults auto-derive from the order but the user can freely override every checkbox before Create Job.
- **Dropbox sync is always best-effort and must never block local job creation.** `dropbox-sync.js` and `file-sync.js` are designed to never throw — every failure mode comes back as a result object (`{success:false, error, ...}`), never a rejected promise, and callers in `server.js` wrap the calls in try/catch anyway as a second layer.
- **File sync is two explicit directions (Push / Pull), never a single auto-merging action.** A file changed on both sides since the last confirmed sync is a **conflict** — left untouched on both sides and reported, never auto-resolved (not "newer timestamp wins"). Deletions mirror to the other side too, unless the side being deleted *from* also changed since the last sync, which is likewise a conflict rather than a silent delete. This rests on a per-job manifest (`.dropbox-sync-manifest.json`, lives inside the job folder, itself excluded from syncing) recording the **last confirmed state on both sides** per file (`{local: {size, mtimeMs}, dropbox: {rev, size}}`) — the decision logic (`planPush`/`planPull`) is pure and fully unit-tested without any Dropbox client.
- **Push/Pull refuse a job's own subfolder.** Pointing the Job Folder field at `0 RAW`, `MLS`, etc. instead of the job's top-level folder used to silently create a disconnected top-level Dropbox folder literally named `"0 RAW"`/`"MLS"` (found in real use, 2026-09-08 — this actually happened in the studio's live Dropbox). `looksLikeAComponentFolderNotAJobFolder()` checks the selected folder's name against `folder-builder.js`'s known component-folder names and refuses with an explanation instead. Deliberately **not** implemented as "require `job.json` to exist" — that would break the legitimate case of Pulling into a freshly-created empty folder to bootstrap a job onto a new machine.
- **Deferred, not yet built**: a `jobStatus` field + auto-triggering a final sync when a job's status changes. The user wants this but said the field design itself is still TBD — do not invent either the field or an auto-trigger mechanism until that design is given.

## Environment / secrets

Dropbox features (`dropbox-sync.js`, `file-sync.js`) need `job-generator/.env` (gitignored; copy from `.env.example`): `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` (long-lived; the SDK mints short-lived access tokens itself — never hardcode a short-lived token), `DROPBOX_TEMPLATE_ID` (printed once by `scripts/setup-dropbox-template.js` — re-running that script is safe, it detects and reuses an existing "FranVision Job" template rather than duplicating it). All Dropbox calls go through `dropbox-sync.js#getClient()`/`isConfigured()` — don't construct a second `Dropbox` client elsewhere. `dotenv.config()` is always called with `quiet:true` (dotenv 17.x otherwise prints a self-promotional console line on every load).

`scripts/check-job-properties.js <dropbox-path>` is a standalone debug utility — reads back a folder's hidden `jobId` property via the real API, useful for manually confirming a specific job's Dropbox state.

## Known limitations

- Push/Pull run synchronously within one HTTP request and return one final summary — no progress streaming for a large first-time sync of many/large files.
- The chunked-upload-session path (files >140MB) is unit-tested only against a fake client (exact byte-offset/sequence assertions) — never verified against a real 140MB+ file (deliberate, to avoid burning real time/bandwidth on an expensive test).
- Windows support (`windows-support` branch, unmerged) has never been run on an actual Windows machine.
