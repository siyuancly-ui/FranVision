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
npx wrangler dev                # GET /, GET /delivery/<jobId>, POST /admin/jobs/<jobId>
```

## Tests

```bash
cd delivery-page
npm test    # node --test, 19 cases, NO network
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

**Not yet deployed to production as of 2026-09-15**, but **local end-to-end verified against real data the same day**: created a real test Job (`FVS-20260915-001`) via job-generator, uploaded real HDR/Floorplan/Local Report photos + a video, confirmed photo-sync-worker synced them into Supabase, ran `wrangler dev` here with real `.dev.vars`, set `address` via `POST /admin/jobs/<jobId>`, and viewed `/delivery/FVS-20260915-001` in an actual browser. All data-backed sections rendered correctly: hero photo + Arima Madurai address overlay, Cloudflare Stream video iframe, full gallery slider, the Local Report image (real HoodQ screenshot) in the neighborhood section, closing photo, and the Google Maps embed (correctly geocoded a real address; the fake test address predictably landed on an unrelated nearby result — expected, not a bug). Tour section correctly stayed hidden (no `tourUrl` set for this test job). Test job left in place (not cleaned up — reusable for future local testing, unlike the disposable test jobs used elsewhere in this project).

## Architecture

```
GET /delivery/<jobId>
  -> supabase.getProject(jobId)              (raw fetch, service-role key)
  -> render.buildDeliveryModel(project, ...) (pure: pick hero/gallery/closing
                                               photos, video, tour, local report)
  -> render.renderDeliveryPage(model)        (pure: HTML string, sections
                                               omitted when their data is absent)

POST /admin/jobs/<jobId>   (bearer ADMIN_TOKEN)
  body: { address?, tourUrl?, tourType? }
  -> supabase.setDeliveryInfo(jobId, fields) -> project_set_delivery_info() RPC
     (merges into projects.data, creates the row if it doesn't exist yet)
```

### Module map

| File | Role |
|---|---|
| `src/index.js` | Worker `fetch` handler: routes `GET /`, `GET /delivery/<jobId>`, `POST /admin/jobs/<jobId>` |
| `src/supabase.js` | Raw-fetch client: `getProject(jobId)` (read-only), `setDeliveryInfo(jobId, fields)` (the one write this Worker does), generic `rpc()` |
| `src/render.js` | All pure logic: photo/video/tour selection (`buildDeliveryModel`), HTML template (`renderDeliveryPage`, `renderNotFoundPage`), `escapeHtml` |
| `supabase/schema.sql` | Run once — adds `project_set_delivery_info()` |

## Confirmed design decisions

- **Section visibility is data-presence-driven for v1, not purchased-services-driven.** A section renders iff its underlying data exists (a hero photo, a video, a `tourUrl`, gallery photos, a Local Report photo, an address) — see `franvision-delivery-page-design-spec.md`'s "Section visibility is service-driven, not fixed" note for the eventual target (which services/packages a Job's client purchased) and why v1 doesn't attempt that yet (job-generator/pricing data isn't in Supabase at all today).
- **Floor Tour and 3D Tour share one field pair** (`tourUrl` + `tourType`), not two separate fields — confirmed mutually exclusive, same visual slot, no per-provider frontend difference (design-spec item 4).
- **The neighborhood report (item 7) renders as a plain image for v1**, not the structured color-coded Schools/Parks/Transit/Safety layout from the visual mockup (see the separate Artifact draft) — the real content is a manually cropped HoodQ screenshot living in each Job's `Local Report` Dropbox folder, already synced by photo-sync-worker as an ordinary photo (folder `Local Report` was already in `SYNC_FOLDERS`). Rebuilding the structured layout needs real per-category data, not an image — only worth doing if/when a HoodQ API (or similar) is found (design-spec "Future automation goal").
- **Map provider is Google Maps** (confirmed 2026-09-15) — the closing section embeds `https://www.google.com/maps?q=<address>&output=embed` in an iframe. No API key needed for this static single-pin embed form; if a future need calls for something the no-key embed can't do (custom pin styling, directions, etc.) that's when an API key / the JS Maps SDK would actually become necessary.
- **Closing section is one composited photo+card, not two stacked blocks (fixed 2026-09-15).** The map+address card (`.closing-card`) floats over the closing photo — matches the Zenfolio reference. An earlier version rendered the photo and a separate map/address section back to back; the address column there had no distinct background, so it visually blended into the page and made the map look off-center.
- **Full-bleed sections (hero, closing, Local Report, Drone Callout) use a `_large.jpg` (w2048h1536) render when available, `_thumb.jpg` (w1024h768) otherwise (2026-09-15).** A real-reference-site pixel comparison showed our full-width sections were visibly softer than the 77-Mossgrove Zenfolio sample (which serves ~1300-1900px for similar slots) while the ~900px-capped gallery slider was already fine at 1024. `render.js#toImgLarge` picks the variant off the photo record's `hasLarge` flag (set by [[franvision-photo-sync-worker]]'s `LARGE_THUMB_FOLDERS`, only for `Cover Photo`/`Closing Photo`/`Drone Callout`/`Local Report` — never the main gallery, on purpose). **Consequence**: the hero/closing AUTO fallback (no `Cover Photo`/`Closing Photo` override) still uses the small gallery thumb, since main-gallery photos never get `hasLarge:true` — this is accepted, not a bug, see photo-sync-worker/CLAUDE.md's reasoning. `.gallery-slide` images always stay on `_thumb.jpg` regardless.
- **Manual photo overrides are Dropbox folders, not a picker UI (decided 2026-09-15).** `Cover Photo` / `Closing Photo` / `Drone Callout` — a human drops ONE photo in, `buildDeliveryModel` prefers it over the automatic pick, no data-entry or admin call needed. Rejected building a web picker page for this: same functional outcome, but a folder-drop matches how the studio already works entirely in Dropbox (Local Report is the same shape), and adds no new UI/auth surface to build or secure. Job Generator doesn't create these folders by default yet (deferred on purpose — see [[franvision-job-generator]]); until it does, they only exist if someone manually creates them in Dropbox. [[franvision-photo-sync-worker]]'s `SYNC_FOLDERS` already includes all three, so this works today without waiting on that.

## Known limitations

- **`project_set_delivery_info` is the only way to set `address`/`tourUrl`/`tourType` today** — via `POST /admin/jobs/<jobId>`, by hand (curl, or a future admin UI). No staff-facing form exists yet. (Hero/closing/aerial photo selection, by contrast, is now handled via Dropbox folders — see above, not this endpoint.)
- **Hero/closing photo curation beyond the folder override is still just a fallback** — the **3rd and 5th gallery photo by filename** (confirmed 2026-09-15, changed from the original 1st/last — the very first or last shot in a folder is often an awkward establishing angle) when no `Cover Photo`/`Closing Photo` folder is used. Clamped to whatever's available in a small gallery and kept distinct from each other when possible (`fallbackPhoto`/the collision-avoidance check in `buildDeliveryModel`) — but that distinctness check only applies when BOTH slots are actually using the fallback; a `Cover Photo` override never gets bumped by it. **The bigger aspiration (design-spec's "Future automation goal") is an agent that learns Franky's/the photographers' own selection judgment** and populates these folders automatically — unscoped, the folder mechanism is a real interim answer either way (manual today, could be filled by an agent later without changing this Worker at all).
- **Not deployed to production yet** — see "Deploy" above.
