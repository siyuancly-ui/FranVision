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
npm test    # node --test, 12 cases, NO network
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

## Known limitations

- **No curated hero/closing photo field yet.** `buildDeliveryModel` falls back to "first gallery photo, sorted by filename" for hero and "last gallery photo" for closing — there is no per-photo `role` (e.g. `"hero"`) a human can set. **The actual target here (confirmed 2026-09-15, see design-spec's "Future automation goal") is bigger than a manual flag** — an agent that learns Franky's/the photographers' own selection judgment and auto-picks hero/closing shots, not a field someone fills in by hand. Unscoped; the filename-sort fallback stays until that exists.
- **Annotated aerial photo (design-spec item 6) has no data source at all** — no Dropbox folder is assigned to it in the confirmed folder structure ([[franvision-folder-structure-v2]]). **Direction confirmed 2026-09-15: it will likely get its own dedicated folder eventually**, but that folder doesn't exist yet, so this Worker still never renders that section. Don't build the read side until the folder is created and named.
- **`project_set_delivery_info` is the only way to set `address`/`tourUrl`/`tourType` today** — via `POST /admin/jobs/<jobId>`, by hand (curl, or a future admin UI). No staff-facing form exists yet.
- **Not deployed yet** — see "Deploy" above.
