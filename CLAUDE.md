# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

FranVision is a real estate photography studio's internal tooling, being built module-by-module toward a Wix-hosted client delivery platform (one Job → one client delivery page with photos, Feature Sheet, video, invoice/payment). See `FranVision_整体架构总览.md` for the long-term vision, Wix/Velo migration plan, and cross-module storage decisions (Dropbox = raw file storage, Supabase = lightweight display data, Wix CMS = business/payment state) — **that document records decision background and may lag behind actual code; where it conflicts with a module's own CLAUDE.md, the module's CLAUDE.md wins.**

There is no root build system (no root `package.json`) — each module below is independently run, tested, and (where applicable) deployed.

## Modules

- **`job-generator/`** — local Node tool that creates a Job's folder structure, computes pricing/commission, and syncs files with Dropbox. See **`job-generator/CLAUDE.md`** for full detail. Quick start: double-click `Job Generator.command`, or `cd job-generator && node server.js` → http://localhost:4173. Tests: `cd job-generator && for f in *.test.js; do node "$f" || exit 1; done` (plain `node --test`-free, hand-rolled runner per file — no test framework).

- **`pricing/`** — the pricing calculation engine (`engine.js` + `pricing-config.js`), zero dependencies, UMD (works via `require()` in Node and a plain `<script>` tag in the browser). This is the **single source of truth for pricing logic** — `job-generator/pricing-adapter.js` wraps it directly rather than reimplementing anything; do not duplicate pricing rules elsewhere. `pricing-config.js` is the only file that should need editing when prices/packages change — never hardcode prices in `engine.js` or any UI. Manual interactive tester: open `pricing/tester.html` directly in a browser. Tests: `node pricing/engine.test.js`. `engine.esm.js`/`pricingconfig.esm.js` at the repo root are hand-kept ES Module ports of the same two files (for Wix Velo, which requires ESM) — logic must stay identical to the UMD originals; see the files' own header comments before editing either version.

- **`feature-sheet-builder/`** — client-facing self-serve tool for building a 2-page real estate Feature Sheet PDF from a fixed template. See `feature-sheet-builder/README.md` for the full local-run/deploy/backend-switch instructions (local disk vs. Supabase, keyed off `public/js/config.js`). Tests: `cd feature-sheet-builder && npm test`. Deploys to Cloudflare Workers (assets-only) via `wrangler.jsonc` at the repo root — either through the Cloudflare dashboard's auto-build on push to `main`, or manually via `bash deploy.sh` from the repo root.

- **`photo-sync-worker/`** — a standalone Cloudflare Worker (`franvision-photo-sync`, **needs the Workers Paid plan** for Queues) that mirrors compressed thumbnails of Dropbox job-folder photos into the Feature Sheet Builder's Supabase project (`projects` table + `photos` bucket, plus a new `photo_sync_state` table and two atomic RPCs), and writes a larger `w2048h1536` delivery render back into Dropbox at `<job>/MLS for download/`. Dropbox webhook + a 2-min reconciliation cron → Cloudflare Queue → per-job thumbnail/upsert, with a delete→`pending_review`→same-name-re-upload self-heal. Thumbnails are produced by **Dropbox's own thumbnail API**, not Cloudflare Image Resizing. Reuses the Job Generator's Dropbox app + the `jobId` PropertyGroupTemplate; secrets via `wrangler secret put`, never a file. See **`photo-sync-worker/CLAUDE.md`** (plus `DESIGN.md` / `README.md` there). Tests: `cd photo-sync-worker && npm test` (`node --test`, no network). Currently on the `photo-sync-worker` branch — deployed and acceptance-tested, not yet merged to `main`.

- **Wix/Velo integration** (in the Wix Studio site itself, not this repo) — `pricing/engine.js` + `pricing-config.js` have been ported into a Velo backend module (`backend/pricingEngine.web.js`) exposing `getPriceQuote`/`getPricingConfig`; `job-generator/` and `feature-sheet-builder/` have not yet been ported.

## Cross-module conventions worth knowing before editing any module

- **Server-authoritative pricing**: a client (browser) always sends its current selection, and the server always recomputes the price from scratch before doing anything consequential (creating a job, unlocking a download) — never trust a client-computed total. Applies in `job-generator/server.js` and is the intended pattern for the future Wix Gallery/PaymentGate work too.
- **Zero-dependency-by-default philosophy**: `pricing/` and (until 2026-09-06) `job-generator/` had no npm dependencies at all — plain Node built-ins only, UMD modules loadable by both Node and a browser `<script>` tag. `job-generator/` broke this once, deliberately, to add the `dropbox` SDK (no reasonable way to drive Dropbox's chunked-upload API without it) — see `job-generator/CLAUDE.md`.
- **Real credentials never enter this repo.** `.gitignore` excludes every module's `.env`; each module that needs secrets ships a `.env.example` documenting the required keys with no real values.
