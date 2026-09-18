# CLAUDE.md

This file provides guidance to Claude Code when working in this directory (`delivery-page/`). See the repo-root `CLAUDE.md` for how this module fits into the rest of FranVision, and `franvision-delivery-page-design-spec.md` (repo root) for the target visual design this module is working toward.

## What this is

A standalone **Cloudflare Worker** (`franvision-delivery-page`) that renders the client-facing per-Job delivery page at `/delivery/<jobId>`, reading the **same Supabase project** [[photo-sync-worker]] writes to. It is read-mostly: photos/videos are entirely photo-sync-worker's to write; this Worker only writes the small set of delivery-specific fields (`address`, `tourUrl`, `tourType`) via its own admin endpoint.

Independent service, own repo-in-waiting, same shape as `photo-sync-worker/` — self-contained, free Cloudflare plan (no Queues, no cron).

## Running it

```bash
cd delivery-page
npm install                     # devDependency: wrangler only, zero runtime deps
cp .dev.vars.example .dev.vars  # fill in with the SAME SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
                                 # photo-sync-worker/.dev.vars uses, plus a new ADMIN_TOKEN
npx wrangler dev                # GET /, GET /delivery/<jobId> or /<slug>/<jobId>, GET /admin, POST /admin/jobs/<jobId>
```

## Tests

```bash
cd delivery-page
npm test    # node --test, 40 cases, NO network
```

`src/render.js` is pure (`buildDeliveryModel` shapes a Supabase `projects` row into a template model; `renderDeliveryPage`/`renderNotFoundPage` are string-building functions) — fully unit-tested without touching Supabase. `src/index.js` (the Worker's `fetch` handler) and `src/supabase.js` (raw-fetch client) are thin and untested directly, same division of labor as photo-sync-worker.

## Deploy

```bash
cd delivery-page
npx wrangler secret put SUPABASE_URL              # + SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN
npx wrangler deploy
# supabase/schema.sql (project_set_delivery_info()) already applied in the
# SQL editor as of 2026-09-15 -- no need to re-run unless working against a
# different Supabase project.
```

### Custom domain: `realgta.ca` (registered + bound 2026-09-17, supersedes the abandoned `real.gta3d.ca` plan)

**The `real.gta3d.ca` subdomain-delegation plan is dead — do not attempt it.** It looked correct on paper (Cloudflare's own docs confirm "delegate a subdomain to Cloudflare while the parent domain stays on a different DNS provider" is a real, supported pattern) but Cloudflare's dashboard "Add a site" flow rejects it outright with "Please ensure you are providing the root domain and not any subdomains" — hit that exact error 2026-09-17. It may still be possible via Cloudflare's API or support, but wasn't pursued once a simpler option existed.

**What was done instead: registered a brand-new root domain, `realgta.ca`, directly through Cloudflare Registrar** ($9.19/year, no markup, confirmed available via direct CIRA WHOIS before buying). Registering through Cloudflare Registrar makes Cloudflare the DNS authority automatically — no delegation dance, and `gta3d.ca`'s existing DNS surface (Wix's own site, Zenfolio's `realimage(s).gta3d.ca`, a large number of legacy per-listing subdomains, MX/email) stays completely untouched, since it's not being used for this at all anymore.

Bound as the **root domain**, no subdomain prefix (Cloudflare dashboard → `franvision-delivery-page` Worker → Domains → Add Domain → `realgta.ca`, subdomain field left blank). **Live at `https://realgta.ca`**, both URL shapes work (see Architecture below for the pretty-URL format, added 2026-09-17).

**Feature Sheet Builder is NOT a usable template for domain setups in this repo** — checked directly (2026-09-16): the `franvision` Worker (FSB) has no Cloudflare Custom Domain bound at all; it's only reachable via `franvision.frankystudio-6f3.workers.dev`.

**Deployed to production 2026-09-17**: `wrangler secret put` for `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`ADMIN_TOKEN` (reused the same values already in local `.dev.vars` — same Supabase project, no new token minted) + `wrangler deploy`. Version ID `350e5fba-0607-4dbe-a9b1-bfc3e97256d8` at deploy time (a later push may have superseded it — check the dashboard for current). Verified against production immediately after deploy: `/delivery/FVS-20260915-001` returns 200 with real Supabase-hosted photo URLs rendered in the page (a 404 on the very first request right after deploy was a one-off cold-start blip — retried clean).

**Earlier, local end-to-end verification (2026-09-15, before this deploy)**: created a real test Job (`FVS-20260915-001`) via job-generator, uploaded real HDR/Floorplan/Local Report photos + a video, confirmed photo-sync-worker synced them into Supabase, ran `wrangler dev` here with real `.dev.vars`, set `address` via `POST /admin/jobs/<jobId>`, and viewed `/delivery/FVS-20260915-001` in an actual browser. All data-backed sections rendered correctly: hero photo + Arima Madurai address overlay, Cloudflare Stream video iframe, full gallery slider, the Local Report image (real HoodQ screenshot) in the neighborhood section, closing photo, and the Google Maps embed (correctly geocoded a real address; the fake test address predictably landed on an unrelated nearby result — expected, not a bug). Tour section correctly stayed hidden (no `tourUrl` set for this test job). Test job left in place (not cleaned up — reusable for future local/production testing, unlike the disposable test jobs used elsewhere in this project).

## Architecture

```
GET /delivery/<jobId>            -- original path, still works
GET /<address-slug>/<jobId>      -- pretty path (2026-09-17), e.g.
                                     /1371-kestell-blvd-oakville/FVS-20260917-003
  Both -> supabase.getProject(jobId)         (raw fetch, service-role key --
                                               the address-slug segment is
                                               NEVER inspected, purely
                                               cosmetic; only the jobId
                                               segment does the lookup)
       -> render.buildDeliveryModel(project, ...) (pure: pick hero/gallery/closing
                                               photos, video, tour, local report)
       -> render.renderDeliveryPage(model)        (pure: HTML string, sections
                                               omitted when their data is absent)

POST /admin/jobs/<jobId>   (bearer ADMIN_TOKEN)
  body: { address?, tourUrl?, tourType? }
  -> supabase.setDeliveryInfo(jobId, fields) -> project_set_delivery_info() RPC
     (merges into projects.data, creates the row if it doesn't exist yet)

GET /admin?admin=<ADMIN_TOKEN>
  -> supabase.listProjects()          (every projects row, newest-updated first)
  -> admin.buildAdminModel(rows)      (pure: address/agents/photoCount/hasVideo/hasTour per
                                        Job, sorted like FSB's admin -- see below)
  -> admin.renderAdminPage(model)     (pure: HTML directory table, client-side filter)
```

### Module map

| File | Role |
|---|---|
| `src/index.js` | Worker `fetch` handler: routes `GET /`, `GET /delivery/<jobId>`, `GET /<address-slug>/<jobId>`, `GET /admin`, `POST /admin/jobs/<jobId>` |
| `src/supabase.js` | Raw-fetch client: `getProject(jobId)` (read-only), `listProjects()` (read-only, admin directory), `setDeliveryInfo(jobId, fields)` (the one write this Worker does), generic `rpc()` |
| `src/render.js` | All pure logic: photo/video/tour selection (`buildDeliveryModel`), HTML template (`renderDeliveryPage`, `renderNotFoundPage`), `escapeHtml`, `slugifyAddress`/`deliveryPath` (pretty-URL builder) |
| `src/admin.js` | Pure logic for the admin directory: `buildAdminModel(rows)`, `renderAdminPage(model, {origin})` (imports `escapeHtml` from `render.js`) |
| `supabase/schema.sql` | Run once — adds `project_set_delivery_info()` |

## Confirmed design decisions

- **Admin directory at `GET /admin?admin=<ADMIN_TOKEN>` (2026-09-17), same query-param-token shape as Feature Sheet Builder's own admin page** — a bookmarkable-but-secret link Franky keeps, not a curl-only bearer endpoint like `POST /admin/jobs/<jobId>` above. Lists every `projects` row with address, agent(s), photo count, video/tour presence, updated time, and a "Copy agent link" button (writes the full absolute delivery-page URL to the clipboard via `render.js#deliveryPath` — the pretty `/<address-slug>/<jobId>` form when an address is known, else `/delivery/<jobId>` — `navigator.clipboard.writeText` + a `prompt()` fallback — same pattern as FSB admin.js's own copy-link button); a plain client-side filter box, no build step. **Deliberately read-only, no create/duplicate/delete/recycle-bin unlike FSB's admin** — a delivery page exists because a Job exists, it isn't a separate thing to manage the lifecycle of from here.
- **Pretty URL `/<address-slug>/<jobId>` added 2026-09-17** (`render.js#slugifyAddress`/`deliveryPath`, routed in `index.js`) — e.g. `realgta.ca/1371-kestell-blvd-oakville/FVS-20260917-003`. The address segment is generated purely for readability and is **never read back** on the request path — the jobId segment alone does the lookup (`getProject(jobId)`, unchanged) — so a stale/edited/oddly-punctuated/even-empty address slug can never break a link, only make it less pretty. The original `/delivery/<jobId>` path keeps working unconditionally (already-sent links, e.g. from before this existed, don't break). No address yet -> `deliveryPath` falls back to `/delivery/<jobId>` since there's nothing to slug.
- **`listProjects()` filters to `id=like.FVS-*` server-side (2026-09-17).** `projects` is shared with Feature Sheet Builder, whose own projects today use a random hex id (its `templateSystem`/`agentInfo`/`confirmed` shape, not a Job at all), not `FVS-YYYYMMDD-NNN` -- 34 of an early 47-row sample were FSB drafts (some already in its own recycle bin) with no address/photos/tourUrl, cluttering what's supposed to be a directory of delivery pages. Job Generator's jobIds are always `FVS-`-prefixed (id-generator.js), so this is a permanent filter, not a today-only workaround: once FSB's own projects move onto the same shared jobId scheme (planned, see [[franvision-custom-system-buildout]]), they'll already satisfy it and start appearing here with no code change.
- **Agent column and sort order match Feature Sheet Builder's own admin page exactly, for the same forward-compatible reason as the filter above.** `agents` reads `data.agentInfo.name`/`data.agentInfo2.name` -- FSB's own fields, mirroring `storage.js#listProjects`' derivation (`[agentInfo.name, agentInfo2.name].filter(Boolean)`) -- not populated by anything for a Job Generator jobId today, but will be the moment FSB's projects share this jobId scheme. Sort order matches FSB admin.js#sortRows() exactly: primary agent's first name A-Z (no-agent jobs sink to the bottom), then newest-updated first within the same name -- computed once in `buildAdminModel`, not client-side, since this page is server-rendered rather than an SPA.
- **Section visibility is data-presence-driven for v1, not purchased-services-driven.** A section renders iff its underlying data exists (a hero photo, a video, a `tourUrl`, gallery photos, a Local Report photo, an address) — see `franvision-delivery-page-design-spec.md`'s "Section visibility is service-driven, not fixed" note for the eventual target (which services/packages a Job's client purchased) and why v1 doesn't attempt that yet (job-generator/pricing data isn't in Supabase at all today).
- **Floor Tour and 3D Tour share one field pair** (`tourUrl` + `tourType`), not two separate fields — confirmed mutually exclusive, same visual slot, no per-provider frontend difference (design-spec item 4).
- **The neighborhood report (item 7) renders as a plain image for v1**, not the structured color-coded Schools/Parks/Transit/Safety layout from the visual mockup (see the separate Artifact draft) — the real content is a manually cropped HoodQ screenshot living in each Job's `Local Report` Dropbox folder, already synced by photo-sync-worker as an ordinary photo (folder `Local Report` was already in `SYNC_FOLDERS`). Rebuilding the structured layout needs real per-category data, not an image — only worth doing if/when a HoodQ API (or similar) is found (design-spec "Future automation goal").
- **Map provider is Google Maps** (confirmed 2026-09-15) — the closing section embeds `https://www.google.com/maps?q=<address>&output=embed` in an iframe. No API key needed for this static single-pin embed form; if a future need calls for something the no-key embed can't do (custom pin styling, directions, etc.) that's when an API key / the JS Maps SDK would actually become necessary.
- **No header, no logo, no section titles, no footer credit line (confirmed 2026-09-15) — a deliberately wordless/brandless page.** The only visible text is actual content: the hero address overlay, the closing card's plain address line, and whatever the synced photos/Local-Report screenshot themselves contain. `headerHtml()` and the `<footer>` were removed outright (not hidden); every section that previously had an eyebrow+title (`<div class="section-head">`) lost it too. `renderNotFoundPage`'s "FranVision Media" branding is unaffected — that's a utility error page, not the client-facing display page this rule is about. Don't reintroduce section headers/branding without asking — this was an explicit user instruction, not a placeholder omission.
- **Video autoplays, muted, looping (confirmed 2026-09-15)** — `?autoplay=true&muted=true&loop=true` appended to the Cloudflare Stream iframe src (muted is required for browsers to allow autoplay at all).
- **Callout supports more than one photo (confirmed 2026-09-15) — `model.aerial` is an array, not a single photo.** One photo renders as a static image (unchanged); more than one reuses the gallery's exact track markup/CSS (`trackHtml()` is now shared by both), auto-advancing the same way but with its own element ids (`aerialTrack`/`aerialPrev`/`aerialNext`) and its auto-advance start staggered 1s after the main gallery's (`SCRIPT`'s `setupTrack(..., phaseOffsetMs)`) so the two tracks never visibly scroll at the same moment.
- **Gallery auto-advances every 2 seconds** (confirmed 2026-09-15, matches the Zenfolio reference), looping back to the first slide at the end. Manual prev/next clicks still work and reset the 2s timer so a manual interaction doesn't get immediately undone by the next auto-tick. Respects `prefers-reduced-motion` (auto-advance simply doesn't start; arrows still work).
- **Closing section is one composited photo+card, not two stacked blocks (fixed 2026-09-15).** The map+address card (`.closing-card`) floats over the closing photo — matches the Zenfolio reference. An earlier version rendered the photo and a separate map/address section back to back; the address column there had no distinct background, so it visually blended into the page and made the map look off-center.
- **Full-bleed sections (hero, closing, Local Report, Callout) use a `_large.jpg` (w2048h1536) render when available, `_thumb.jpg` (w1024h768) otherwise (2026-09-15).** A real-reference-site pixel comparison showed our full-width sections were visibly softer than the 77-Mossgrove Zenfolio sample (which serves ~1300-1900px for similar slots) while the ~900px-capped gallery slider was already fine at 1024. `render.js#toImgLarge` picks the variant off the photo record's `hasLarge` flag, set by [[franvision-photo-sync-worker]]'s `LARGE_THUMB_FOLDERS` for `Cover&Closing`/`Callout`/`Local Report` — and, as of 2026-09-17, ALSO for whichever 1-2 main-gallery photos are the current 3rd/5th-by-filename hero/closing fallback (`pickGalleryFallbackTargets` there mirrors this file's `pickPhotos`/`fallbackPhoto`/dedup logic exactly, so it's always large-rendering the SAME photo this file would actually pick) — never the rest of the gallery, on purpose, so the fallback no longer looks softer than a `Cover&Closing` override would. `.gallery-slide` images always stay on `_thumb.jpg` regardless.
- **Floor Plan / Site Plan section added 2026-09-18, positioned right above the neighborhood report (order: Hero → video → Tour → gallery → aerial → Floor Plan → Local Report → closing).** Same "drop file(s) in `Floorplan` Dropbox folder, no data entry" shape as Drone Callout, `model.floorplan` an array for the same reason (a Job can have more than one page — main floor, second floor, basement) — one page renders as a static image, more than one reuses the gallery's auto-advancing track (`floorplanTrack`/`floorplanPrev`/`floorplanNext`, staggered 2s after the main gallery, 1s after aerial, via `SCRIPT`'s `setupTrack`). Uses `toImgLarge` like the other full-bleed sections — [[franvision-photo-sync-worker]]'s `LARGE_THUMB_FOLDERS` now includes `Floorplan` too, since a floor plan's room labels/measurements benefit from the large render even more than a regular photo does. This had been an actual gap, not a deliberate omission: `Floorplan` was already in `SYNC_FOLDERS` (thumbnails were already synced to Supabase) but nothing on this page ever read or displayed them — the original design spec (modeled on the Zenfolio reference, which has no floor-plan section either) never called for one.
- **Manual photo overrides are Dropbox folders, not a picker UI (decided 2026-09-15; folder names shortened to `Cover`/`Closing`/`Callout` on 2026-09-16, were `Cover Photo`/`Closing Photo`/`Drone Callout`; `Cover`+`Closing` MERGED into one `Cover&Closing` folder on 2026-09-17).** `Cover&Closing` holds up to two photos: sorted by filename, the lowest becomes the cover/hero override, the highest becomes the closing override (`coverClosingPhotos[0]` / `coverClosingPhotos[coverClosingPhotos.length - 1]` in `buildDeliveryModel`) — a single photo is cover-only (closing still falls back normally), more than two just leaves the middle ones unused. `Callout` is expected to usually be nested under `HDR Photos` rather than a top-level sibling like `Cover&Closing` — see [[franvision-photo-sync-worker]]'s nested-folder matching (`matchAncestorFolder`). `buildDeliveryModel` prefers the override(s) over the automatic pick, no data-entry or admin call needed. Rejected building a web picker page for this: same functional outcome, but a folder-drop matches how the studio already works entirely in Dropbox (Local Report is the same shape), and adds no new UI/auth surface to build or secure. Job Generator doesn't create this folder by default yet (deferred on purpose — see [[franvision-job-generator]]); until it does, it only exists if someone manually creates it in Dropbox. [[franvision-photo-sync-worker]]'s `SYNC_FOLDERS` already includes it, so this works today without waiting on that.

## Known limitations

- **`tourUrl` is now set automatically (2026-09-16), same Dropbox-folder shape as the photo overrides above.** [[franvision-photo-sync-worker]]'s `tour-link-sync.js` watches for one well-known `Tour Link.txt` file at a job folder's root, downloads its text, and writes it as `tourUrl` via `project_set_delivery_info` — no staff-facing form or admin call needed for this field anymore. Deliberately does not set `tourType` (Floor Tour and 3D Tour render identically here — `tourHtml()` never reads `tour.type` — so there's nothing for a type distinction to change). `address` still has no dedicated staff-facing entry point beyond photo-sync-worker's own interim folder-name parsing (see that module's CLAUDE.md) and `POST /admin/jobs/<jobId>` by hand.
- **Hero/closing photo curation beyond the folder override is still just a fallback** — the **3rd and 5th gallery photo by filename** (confirmed 2026-09-15, changed from the original 1st/last — the very first or last shot in a folder is often an awkward establishing angle) when no `Cover&Closing` folder is used. Clamped to whatever's available in a small gallery and kept distinct from each other when possible (`fallbackPhoto`/the collision-avoidance check in `buildDeliveryModel`) — but that distinctness check only applies when BOTH slots are actually using the fallback; a `Cover&Closing` override never gets bumped by it. **The bigger aspiration (design-spec's "Future automation goal") is an agent that learns Franky's/the photographers' own selection judgment** and populates this folder automatically — unscoped, the folder mechanism is a real interim answer either way (manual today, could be filled by an agent later without changing this Worker at all).
- **Deployed to production, live at `https://realgta.ca`** — see "Deploy" above for the domain history.
