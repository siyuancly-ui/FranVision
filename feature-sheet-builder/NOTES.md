# Template fidelity — items to confirm

The template `jason-fs-v1` is reproduced from `../Jason FS.pdf` rendered at
4970×3234. It is close but **not yet pixel-perfect**. When the original design
file arrives, only `templates/jason-fs-v1/template-config.js` (and maybe a few
`assets/`) change — no other code.

## 1. Fonts (approximate)
`Jason FS.pdf` uses two faces I could not identify with certainty from a raster:

| Where | Used now (Google Fonts) | Notes |
|---|---|---|
| Cover: address, chevron name, italic phone, "SMART SOLD REALTY" | **Chivo Mono** (300/400) | PDF face is a light, wide, monospaced-feeling geometric sans |
| Back cover: description + contact block | **PT Sans** (400/700) | PDF face is a rounder humanist sans |

→ Send the font names (or the source file) for an exact match. Change
`fonts.display` / `fonts.body` in the config.

## 2. Background / metal / chevron are CSS-recreated
The navy velvet background, the brushed-metal contact bar, and the downward
metal chevron on the cover are rebuilt with CSS gradients + an SVG-noise
overlay. They read right but are not the exact PDF artwork.
→ If you want 1:1, export those as flat PNGs from the source file and set
`overlays[].asset` / `backgrounds.pageN.asset` in the config. Hook is already there.

## 3. Slot & text coordinates are measured, not authoritative
Every rectangle in the config is eyeballed off the render (grid overlay).
Expect small offsets vs. the real InDesign/Canva positions. Easiest fix loop:
open a page, compare to the PDF, tell me "slot p2R-3 is ~2% too low" etc.

## 4. Assets extracted from the PDF (in `assets/`)
- `brokerage-logo.png` — the Smart Sold logo in its white rounded plate, cropped
  from the render. Slightly soft; replace with the real logo when available.
- `agent-headshot.png` — Jason Gao's headshot, cropped to the circle. This is a
  **default**; the info form can override headshot & logo per project.

## 5. Behaviour choices baked in (change if wrong)
- **Description text is auto Title-Cased** (`transform: 'capitalize'`) to match the
  PDF look. Set `transform: 'none'` on the `description` field to keep whatever
  the client types.
- **Brokerage name** drives the cover footer line (the PDF's "SMART SOLD REALTY"),
  uppercased. If the `Brokerage` field is left blank the footer is empty in the
  export (placeholder "SMART SOLD REALTY" shows only in the editor). Want it in a
  second spot (e.g. the back-cover contact plate) too? Say so.
- **Phone numbers** print as `000-000-0000` on the sheet regardless of how they
  are typed (digits are extracted; 11-digit `1…` is trimmed). Applies to the
  cover phone and the back-cover Bus/Cell line.
- **Address + city** are centred on the cover (matches the PDF). The back-cover
  contact block is left-aligned; a missing field never indents the ones after it.
- **QR code** is generated live from the "Online Tour URL" field. Empty field →
  faint placeholder box, nothing in the export.
- **Editor affordances** (not printed): every photo slot is outlined so the
  client can see all 16 zones; empty ones are blue-dashed. Hovering a filled slot
  shows a **⠿ Move** handle — drag it onto another slot to move (empty target) or
  swap (filled target); the crop travels with the photo. Wheel over a photo only
  zooms with a trackpad pinch or Ctrl/⌘+wheel, otherwise the page scrolls.
- Cover-photo zoom is capped at 4×. Pan is constrained so a photo can never
  uncover its slot.

## 6. PDF export
- Each page is rasterised at ~2480px wide (≈3×) then placed on a jsPDF page of
  the exact template size (1242.57 × 808.87 pt). Two pages, landscape.
- Output is a high-quality **screen** PDF, ~4–6 MB. Not print-ready yet
  (no CMYK, no crop/bleed marks, text is rasterised). The renderer is isolated
  behind `exportPdf.renderPageToImage()` so a vector/print path can replace it
  later without touching the rest.
- Uses CDN libs (`jspdf`, `html-to-image`, `qrcodejs`). Needs internet on first load.

## 7. Supabase backend

`public/js/store.js` runs against Supabase when `public/js/config.js` has the
project URL + anon (publishable) key; otherwise it uses the local Node server.

One-time schema setup (Supabase Dashboard -> SQL Editor -> run):

```sql
create table if not exists public.projects (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant usage on schema public to anon;
grant select, insert, update on public.projects to anon;

insert into storage.buckets (id, name, public)
values ('photos', 'photos', true) on conflict (id) do nothing;

alter table public.projects enable row level security;
drop policy if exists "open projects read"   on public.projects;
drop policy if exists "open projects insert" on public.projects;
drop policy if exists "open projects update" on public.projects;
create policy "open projects read"   on public.projects for select to anon using (true);
create policy "open projects insert" on public.projects for insert to anon with check (true);
create policy "open projects update" on public.projects for update to anon using (true) with check (true);
drop policy if exists "open photos read"   on storage.objects;
drop policy if exists "open photos insert" on storage.objects;
drop policy if exists "open photos delete" on storage.objects;
create policy "open photos read"   on storage.objects for select to anon using (bucket_id = 'photos');
create policy "open photos insert" on storage.objects for insert to anon with check (bucket_id = 'photos');
create policy "open photos delete" on storage.objects for delete to anon using (bucket_id = 'photos');
```

### Confirm & Submit -> email the studio

"Confirm & Submit" builds the print PDF in the browser, uploads it to a
private `submissions` bucket, then calls the `notify-submission` Edge
Function which emails the studio (Resend). One-time setup:

1. **Bucket + policies** -- SQL Editor:
   ```sql
   insert into storage.buckets (id, name, public)
   values ('submissions', 'submissions', false) on conflict (id) do nothing;

   drop policy if exists "submissions anon insert" on storage.objects;
   drop policy if exists "submissions anon update" on storage.objects;
   create policy "submissions anon insert" on storage.objects
     for insert to anon with check (bucket_id = 'submissions');
   create policy "submissions anon update" on storage.objects
     for update to anon using (bucket_id = 'submissions') with check (bucket_id = 'submissions');
   ```
   (No select policy -- agents can't download each other's submissions;
   the function makes short-lived signed links via the service role.)

2. **Deploy the function** -- `supabase/functions/notify-submission/index.ts`.
   CLI: `supabase functions deploy notify-submission`
   or Dashboard -> Edge Functions -> Deploy a new function -> paste the file.

3. **Secrets** -- Dashboard -> Edge Functions -> Secrets, add:
   `RESEND_API_KEY` = your Resend key (secret; never committed).
   Optional overrides: `SUBMIT_TO`, `SUBMIT_FROM`, `APP_BASE_URL`.

Until this is set up, Confirm & Submit still saves + locks the design but
the email step fails (agent sees an error and can retry).

### Behaviour / limits of the v1 backend
- **No auth** (matches the brief): anyone with the app URL can create/read/edit/
  delete any project. Project ids are random 12-hex so not guessable, and there's
  no sensitive data, but the RLS policies are deliberately wide open.
- **Concurrent editing** = last-save-wins on the whole project document. Fine for
  one client at a time; two people editing the same link simultaneously can clobber
  each other. Add optimistic concurrency later if needed.
- **Thumbnails** are generated in the browser (canvas) and uploaded alongside the
  original, so no Supabase image-transform (Pro-only) is required.
- **Deleting a photo** frees it from Storage immediately, but Supabase's public CDN
  may keep serving the old URL for up to ~1h. Harmless -- nothing references it.
- Free tier: 500 MB DB / 1 GB storage / project pauses after ~1 week idle. A few
  dozen projects of 30-80 photos will fill 1 GB -- upgrade to Pro ($25/mo) when it
  becomes real volume.

## 8. Not done in this MVP (by design)
- Second/third templates (architecture is ready — `templates/<id>/`).
- Real "delivered assets" photo source (abstraction is in `photo-source.js`).
- Auto-send to print shop (you open confirmed projects manually).
- Accounts / permissions.
