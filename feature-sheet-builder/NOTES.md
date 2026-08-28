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

## 7. Not done in this MVP (by design)
- Second/third templates (architecture is ready — `templates/<id>/`).
- Real "delivered assets" photo source (abstraction is in `photo-source.js`).
- Auto-send to print shop (you open confirmed projects manually).
- Accounts / permissions.
