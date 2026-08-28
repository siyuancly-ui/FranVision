# FranVision Feature Sheet Builder (MVP)

Client self-serve tool: the client picks from a set of property photos, drags them
into the fixed 2-page Feature Sheet template, adjusts each crop, previews both
pages, confirms, and exports a PDF. No login — a project is a shareable URL.

## Run locally

```
node server.js            # -> http://localhost:4180
npm test                  # node --test
```

or double-click **`../Feature Sheet Builder.command`** in Finder.

`?p=<projectId>` in the URL identifies the project; opening `/` with no `p`
creates one and rewrites the URL.

## Backend: Supabase (production) or local disk (dev)

`public/js/config.js` decides:
- **has `supabaseUrl` + `supabaseAnonKey`** -> the browser talks straight to
  Supabase (Postgres `projects` row + `photos` storage bucket). No server needed;
  `node server.js` is then only a convenient static file host.
- **blank** -> the app uses the local Node server API, storing under `./data/`
  (git-ignored). Useful offline.

Supabase schema (run once in the SQL Editor): see `NOTES.md`.

## Deploy the frontend (Cloudflare Pages)

1. Cloudflare dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git ->
   pick this repo.
2. Build settings:
   - **Production branch**: `feature-sheet-builder` (or `main` after merge)
   - **Framework preset**: None
   - **Build command**: `node feature-sheet-builder/prepare-static.js`
   - **Build output directory**: `feature-sheet-builder/public`
3. Save and Deploy -> `https://<name>.pages.dev`.

`prepare-static.js` copies `/shared/*` and `/template-assets/*` (served
dynamically by `server.js` in dev) into `public/` so it works as pure static.

## Layout

| Path | Role |
|---|---|
| `server.js` | zero-dep HTTP server + JSON/binary API + image serving |
| `storage.js` | persistence interface + `LocalDiskStorage` (per-project write lock) |
| `thumbnailer.js` | `sips` shell-out for thumbnails + dimensions (degrades off-macOS) |
| `crop-math.js` | "photo always covers its slot" math — pan/zoom clamping (shared with browser) |
| `templates/registry.js` | template lookup — add templates here |
| `templates/jason-fs-v1/template-config.js` | **all geometry/type/field definitions for template #1** |
| `templates/jason-fs-v1/assets/` | extracted brand assets (logo, default headshot) |
| `public/js/store.js` | the only client↔backend seam — swap this for Supabase/Wix |
| `public/js/photo-source.js` | where the Photo Library's list comes from (v1 = uploads) |
| `public/js/template-render.js` | template-config + project → DOM (used by editor, preview, export) |
| `public/js/editor.js` | drag/drop into slots + in-slot pan & zoom |
| `public/js/{photo-library,info-form,preview,export-pdf,qr,app}.js` | the rest of the UI |

## Moving to Supabase (next step)

1. Add `SupabaseStorage` in `storage.js` implementing the same 8 methods; select it
   with `FSB_STORAGE=supabase` in `server.js`. **or**
2. Point `public/js/store.js` straight at Supabase (Postgres row for the project
   JSON, Storage bucket for originals) and drop the Node server entirely.

Either way the editor, template, crop math and PDF export are untouched.

## Embedding in Wix (later)

Host `public/` (Netlify/Vercel/Cloudflare Pages) and add a single HTML-embed
element on a Wix page pointing at it. Pass `?p=` through from the Wix page URL to
the iframe so the shareable link is `yoursite.com/feature-sheet?p=<id>`.

See `NOTES.md` for template-fidelity items still pending Franny's confirmation.
