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
npm test    # node --test, 22 cases, NO network
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

### Custom domain: `real.gta3d.ca` (confirmed plan 2026-09-16/17, not yet executed)

The live page is meant to be reachable at `real.gta3d.ca`, not the raw `*.workers.dev` URL. **`gta3d.ca` is a domain the studio already owns**, but its DNS is fully delegated to Wix (nameservers `ns2/ns3.wixdns.net` — confirmed via CIRA WHOIS and by logging into the Wix dashboard directly), and `gta3d.ca` is **not** added as a zone in this Cloudflare account. That combination means a plain CNAME from Wix's DNS to this Worker's `*.workers.dev` hostname will NOT get a valid HTTPS certificate — Cloudflare only issues a matching cert for a custom hostname when it actually controls that DNS zone.

**Decided approach: delegate ONLY the `real.gta3d.ca` subdomain to Cloudflare via NS records — do not touch the rest of `gta3d.ca`.** Rejected alternatives: moving the whole `gta3d.ca` zone to Cloudflare (too much blast radius — Wix's own site, Zenfolio's `realimage(s).gta3d.ca` delivery pages, a large number of legacy per-listing subdomains, and MX/email all live on that zone today) and Cloudflare for SaaS / Custom Hostnames (unnecessary complexity/cost for one subdomain — that product targets multi-tenant SaaS, not this case).

Steps to execute when ready to go live:
1. In the Cloudflare dashboard, add `real.gta3d.ca` as its own zone (Cloudflare supports adding a subdomain as a zone, not just a root domain) — this gives it its own assigned nameservers.
2. In Wix's DNS panel (Wix Studio account → 網域 → `gta3d.ca` → 管理 DNS 記錄 → NS section), add NS records for the `real` label pointing at those Cloudflare-assigned nameservers. This delegates only `real.gta3d.ca`; every other record on `gta3d.ca` is untouched.
3. Once that zone is active on Cloudflare (propagation can take a few hours), add `real.gta3d.ca` as a Custom Domain on the `franvision-delivery-page` Worker in the Cloudflare dashboard (Workers & Pages → franvision-delivery-page → Domains → Add Domain) — this is the same flow Cloudflare uses for any domain it owns outright, since it now genuinely owns this one subdomain.

**Feature Sheet Builder is NOT a usable template for this** — checked directly (2026-09-16): the `franvision` Worker (FSB) has no Cloudflare Custom Domain bound at all today; it's only reachable via `franvision.frankystudio-6f3.workers.dev`. Whatever fronts FSB with a friendlier URL (if anything), it isn't a Cloudflare Custom Domain/Route, so don't go looking for one to copy.

**Deployed to production 2026-09-17**: `wrangler secret put` for `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`ADMIN_TOKEN` (reused the same values already in local `.dev.vars` — same Supabase project, no new token minted) + `wrangler deploy`. Live at `https://franvision-delivery-page.frankystudio-6f3.workers.dev` (Version ID `350e5fba-0607-4dbe-a9b1-bfc3e97256d8`). Verified against production immediately after deploy: `/delivery/FVS-20260915-001` returns 200 with real Supabase-hosted photo URLs rendered in the page (a 404 on the very first request right after deploy was a one-off cold-start blip — retried clean). **Custom domain (`real.gta3d.ca`) not bound yet** — see the subdomain-delegation steps above; the Worker is only reachable at its `*.workers.dev` URL until that's done.

**Earlier, local end-to-end verification (2026-09-15, before this deploy)**: created a real test Job (`FVS-20260915-001`) via job-generator, uploaded real HDR/Floorplan/Local Report photos + a video, confirmed photo-sync-worker synced them into Supabase, ran `wrangler dev` here with real `.dev.vars`, set `address` via `POST /admin/jobs/<jobId>`, and viewed `/delivery/FVS-20260915-001` in an actual browser. All data-backed sections rendered correctly: hero photo + Arima Madurai address overlay, Cloudflare Stream video iframe, full gallery slider, the Local Report image (real HoodQ screenshot) in the neighborhood section, closing photo, and the Google Maps embed (correctly geocoded a real address; the fake test address predictably landed on an unrelated nearby result — expected, not a bug). Tour section correctly stayed hidden (no `tourUrl` set for this test job). Test job left in place (not cleaned up — reusable for future local/production testing, unlike the disposable test jobs used elsewhere in this project).

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
- **No header, no logo, no section titles, no footer credit line (confirmed 2026-09-15) — a deliberately wordless/brandless page.** The only visible text is actual content: the hero address overlay, the closing card's plain address line, and whatever the synced photos/Local-Report screenshot themselves contain. `headerHtml()` and the `<footer>` were removed outright (not hidden); every section that previously had an eyebrow+title (`<div class="section-head">`) lost it too. `renderNotFoundPage`'s "FranVision Media" branding is unaffected — that's a utility error page, not the client-facing display page this rule is about. Don't reintroduce section headers/branding without asking — this was an explicit user instruction, not a placeholder omission.
- **Video autoplays, muted, looping (confirmed 2026-09-15)** — `?autoplay=true&muted=true&loop=true` appended to the Cloudflare Stream iframe src (muted is required for browsers to allow autoplay at all).
- **Callout supports more than one photo (confirmed 2026-09-15) — `model.aerial` is an array, not a single photo.** One photo renders as a static image (unchanged); more than one reuses the gallery's exact track markup/CSS (`trackHtml()` is now shared by both), auto-advancing the same way but with its own element ids (`aerialTrack`/`aerialPrev`/`aerialNext`) and its auto-advance start staggered 1s after the main gallery's (`SCRIPT`'s `setupTrack(..., phaseOffsetMs)`) so the two tracks never visibly scroll at the same moment.
- **Gallery auto-advances every 2 seconds** (confirmed 2026-09-15, matches the Zenfolio reference), looping back to the first slide at the end. Manual prev/next clicks still work and reset the 2s timer so a manual interaction doesn't get immediately undone by the next auto-tick. Respects `prefers-reduced-motion` (auto-advance simply doesn't start; arrows still work).
- **Closing section is one composited photo+card, not two stacked blocks (fixed 2026-09-15).** The map+address card (`.closing-card`) floats over the closing photo — matches the Zenfolio reference. An earlier version rendered the photo and a separate map/address section back to back; the address column there had no distinct background, so it visually blended into the page and made the map look off-center.
- **Full-bleed sections (hero, closing, Local Report, Callout) use a `_large.jpg` (w2048h1536) render when available, `_thumb.jpg` (w1024h768) otherwise (2026-09-15).** A real-reference-site pixel comparison showed our full-width sections were visibly softer than the 77-Mossgrove Zenfolio sample (which serves ~1300-1900px for similar slots) while the ~900px-capped gallery slider was already fine at 1024. `render.js#toImgLarge` picks the variant off the photo record's `hasLarge` flag (set by [[franvision-photo-sync-worker]]'s `LARGE_THUMB_FOLDERS`, only for `Cover`/`Closing`/`Callout`/`Local Report` — never the main gallery, on purpose). **Consequence**: the hero/closing AUTO fallback (no `Cover`/`Closing` override) still uses the small gallery thumb, since main-gallery photos never get `hasLarge:true` — this is accepted, not a bug, see photo-sync-worker/CLAUDE.md's reasoning. `.gallery-slide` images always stay on `_thumb.jpg` regardless.
- **Manual photo overrides are Dropbox folders, not a picker UI (decided 2026-09-15; folder names shortened to `Cover`/`Closing`/`Callout` on 2026-09-16, were `Cover Photo`/`Closing Photo`/`Drone Callout`).** `Callout` is expected to usually be nested under `HDR Photos` rather than a top-level sibling like `Cover`/`Closing` — see [[franvision-photo-sync-worker]]'s nested-folder matching (`matchAncestorFolder`). A human drops ONE photo in, `buildDeliveryModel` prefers it over the automatic pick, no data-entry or admin call needed. Rejected building a web picker page for this: same functional outcome, but a folder-drop matches how the studio already works entirely in Dropbox (Local Report is the same shape), and adds no new UI/auth surface to build or secure. Job Generator doesn't create these folders by default yet (deferred on purpose — see [[franvision-job-generator]]); until it does, they only exist if someone manually creates them in Dropbox. [[franvision-photo-sync-worker]]'s `SYNC_FOLDERS` already includes all three, so this works today without waiting on that.

## Known limitations

- **`tourUrl` is now set automatically (2026-09-16), same Dropbox-folder shape as the photo overrides above.** [[franvision-photo-sync-worker]]'s `tour-link-sync.js` watches for one well-known `Tour Link.txt` file at a job folder's root, downloads its text, and writes it as `tourUrl` via `project_set_delivery_info` — no staff-facing form or admin call needed for this field anymore. Deliberately does not set `tourType` (Floor Tour and 3D Tour render identically here — `tourHtml()` never reads `tour.type` — so there's nothing for a type distinction to change). `address` still has no dedicated staff-facing entry point beyond photo-sync-worker's own interim folder-name parsing (see that module's CLAUDE.md) and `POST /admin/jobs/<jobId>` by hand.
- **Hero/closing photo curation beyond the folder override is still just a fallback** — the **3rd and 5th gallery photo by filename** (confirmed 2026-09-15, changed from the original 1st/last — the very first or last shot in a folder is often an awkward establishing angle) when no `Cover`/`Closing` folder is used. Clamped to whatever's available in a small gallery and kept distinct from each other when possible (`fallbackPhoto`/the collision-avoidance check in `buildDeliveryModel`) — but that distinctness check only applies when BOTH slots are actually using the fallback; a `Cover` override never gets bumped by it. **The bigger aspiration (design-spec's "Future automation goal") is an agent that learns Franky's/the photographers' own selection judgment** and populates these folders automatically — unscoped, the folder mechanism is a real interim answer either way (manual today, could be filled by an agent later without changing this Worker at all).
- **Not deployed to production yet** — see "Deploy" above.
