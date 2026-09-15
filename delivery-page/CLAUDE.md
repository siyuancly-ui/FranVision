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
npm test    # node --test, 11 cases, NO network
```

`src/render.js` is pure (`buildDeliveryModel` shapes a Supabase `projects` row into a template model; `renderDeliveryPage`/`renderNotFoundPage` are string-building functions) — fully unit-tested without touching Supabase. `src/index.js` (the Worker's `fetch` handler) and `src/supabase.js` (raw-fetch client) are thin and untested directly, same division of labor as photo-sync-worker.

## Deploy

```bash
cd delivery-page
npx wrangler secret put SUPABASE_URL              # + SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN
npx wrangler deploy
# then run supabase/schema.sql once in the Supabase SQL editor (adds
# project_set_delivery_info()) if not already applied.
```

Not yet deployed to production as of 2026-09-15 — this module was just scaffolded and unit-tested; no real Job has been rendered against live Supabase yet. Do the first real end-to-end test (real `jobId`, real photos/video already synced by photo-sync-worker) before trusting this in front of a client.

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
- **No map component for v1** — design-spec item 8 wants an embedded map; no provider (Google/Mapbox/Leaflet) has been chosen yet, so the closing section shows the address as plain text only. Revisit once a provider is picked.

## Known limitations

- **No curated hero/closing photo field yet.** `buildDeliveryModel` falls back to "first gallery photo, sorted by filename" for hero and "last gallery photo" for closing — there is no per-photo `role` (e.g. `"hero"`) a human can set. Whichever photo happens to sort first/last is what shows. Revisit once there's a real curation mechanism (an admin field, or a staff-facing picker) — don't just add an arbitrary `role` key without deciding where it's set from.
- **Annotated aerial photo (design-spec item 6) has no data source at all** — no Dropbox folder is assigned to it in the confirmed folder structure ([[franvision-folder-structure-v2]]), so this Worker never renders that section. Needs a decision (new folder? reuse an existing one?) before it can be built, not just wired up.
- **`project_set_delivery_info` is the only way to set `address`/`tourUrl`/`tourType` today** — via `POST /admin/jobs/<jobId>`, by hand (curl, or a future admin UI). No staff-facing form exists yet.
- **Not deployed yet** — see "Deploy" above.
