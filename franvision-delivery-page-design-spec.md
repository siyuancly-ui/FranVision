# FranVision Delivery Page — Design Spec (reference: Zenfolio "All in One", 77 Mossgrove Tr sample)

Reference sample: https://realimage.gta3d.ca/77-mossgrove-tr-north-york-1 (Zenfolio, FranVision Media)

This spec describes the page **as it should be rebuilt in custom code** (not on Wix Velo), based on a working Zenfolio delivery page Franky already uses and likes. Goal: reproduce the visual result and section set, not the underlying Zenfolio implementation.

## Global style

- Page background: near-white, warm off-white — `rgb(251, 251, 253)` in the header/nav area, shifting to a slightly warmer cream (`~#FAFAF0`–`#FBFBF5` range) in content sections. Confirm exact section-by-section tone against screenshots.
- Body/UI font: system sans-serif stack (`-apple-system, "system-ui", "Segoe UI", Roboto, ...`) for all body copy, labels, and section headers.
- **Accent/display font: "Arima Madurai"** (Google Font, cursive/handwritten-style serif) — used specifically for the property address overlay on the hero image. Confirmed via computed style: 24px, white, weight 400, normal letter-spacing. Import this exact font for that one element; don't substitute a generic script font.
- Section header color coding appears topic-based (e.g., blue for "SCHOOLS", green for "PARKS & REC", purple for "TRANSIT", orange/red for "SAFETY") — treat these as a small fixed palette per section type, not a single accent color.
- No visible drop shadows/heavy skeuomorphism — flat, editorial, lots of whitespace between sections.

## Section order (top to bottom)

1. **Header/nav** — centered circular logo (FranVision Media camera-mark logo) on transparent/off-white bar.
   - **Change from sample: remove the account and cart icons entirely** — not needed for this use case (no e-commerce/login on the delivery page).
2. **Hero** — full-bleed, full-viewport-height property photo (dusk/twilight exterior shot performs well here). Address text ("[Street Address], [City]") overlaid bottom-right in Arima Madurai, white, 24px. Small "Using Zenfolio"-style platform credit in bottom-right corner in the original — drop this (no platform credit needed) or replace with FranVision's own mark if desired.
3. **Video/drone teaser** — large image/video thumbnail, centered circular play button, duration badge (e.g., "1:05") bottom-right. Clicking plays an embedded video (in the sample this is an aerial drone clip).
4. **Interactive floor plan + synced photo viewer** — two-panel layout: left panel shows a top-down floor plan with numbered/circular hotspots per room; right panel shows a photo carousel (prev/next arrows) with a room label + approximate dimensions overlay (e.g., "Foyer — Approximately 13'12" x 9'7"") and a photo counter ("1 of 40"). Floor selector dropdown (e.g., "2nd floor") and a "Measurements" toggle sit in a dark bottom bar along with "Results Reliable But Not Guaranteed" disclaimer text and Privacy/Terms links. This is the most complex interactive component — treat as its own component with room-hotspot data driving both the floor plan and the photo viewer in sync.
5. **3D virtual tour** — **not present in this sample, but implementation is already known:** Franky currently uses **Matterport or CubiCasa**, both of which generate a shareable tour URL that gets embedded via `<iframe src="...">` (this is exactly the pattern already used for `tourUrl` in the existing Wix backend code — one URL field per listing, dropped straight into an iframe, no custom logic needed). Visually, give it the same full-width embed treatment as the video section — same padding/frame, no special design beyond fitting the iframe responsively. No per-provider difference needed on the frontend: both Matterport and CubiCasa tours are just an embeddable URL.
6. **Full-bleed photo gallery** — horizontal slider, current image full width, faint peeks of previous/next images visible at the left/right edges to hint at swipe/navigation. Circular prev/next arrow buttons at left and right screen edges.
7. **Annotated aerial photo** — a large aerial/drone still of the neighborhood with **manually placed** callout cards (white rounded-rectangle labels with connector lines, e.g., "Havergal College", "Crescent School") pointing to specific buildings, plus a red pin-drop marker on the subject property.
   - **Important: this is a static, manually pre-built image asset (e.g., composited in Photoshop/Canva per listing), not a dynamic/interactive map component.** Build it as: one image upload field per listing, already annotated by Franky's team before upload. No need to build annotation/label-placement logic.
8. **Neighborhood report** (Schools / Parks & Rec / Transit / Safety) — four content blocks, each with a colored section header, icon, short intro paragraph, and a structured list of nearby amenities with distances/walk times.
   - **This content is sourced from a third-party neighborhood-data provider that Franky already has a relationship with — it is independent of Zenfolio.** Whatever that data/embed/report looks like from that provider should be reused directly (embed their widget, or drop in the content they deliver) rather than rebuilt from scratch. Confirm with Franky which provider this is and what format they deliver in (embeddable widget vs. static content/API).
9. **Closing photo + simple location map** — one more full-bleed property photo, followed by a plain embedded map (looks like a standard Leaflet/Mapbox/Google Maps embed, zoom controls, single pin) with the plain-text address beside it.

## Notes / open items

- Confirm exact hex values for section background tones and the small color-coded header palette (blue/green/purple/orange) by re-inspecting the live sample once more sections are visible in-viewport (some content is lazy-loaded and only renders once scrolled into view, which blocked automated style extraction for those blocks).
- Room-hotspot ↔ photo-carousel sync (item 4) and the neighborhood-data integration (item 8) are the two pieces with real logic behind them — everything else is closer to a static template with per-listing data (photos, video, address, floor plan image, annotated aerial image) swapped in.
