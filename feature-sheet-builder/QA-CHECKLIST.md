# Feature Sheet Builder — manual QA checklist (fsb-v2)

Run this after any change to the template geometry, the renderer, the editor,
the admin view, or the export. Each line is one thing to do + what you should
see. Test in **both** roles unless noted: agent = `?p=<id>&local=1`,
admin = `?p=<id>&admin=dev-admin&local=1`. Test with a real project that has
photos + full agent info, and once with a brand-new blank one.

Areas marked **★** are where visible bugs have actually happened — check these
first.

---

## 1. Project lifecycle (admin list — `?admin=dev-admin&local=1`)

- [ ] **+ New feature sheet** → jumps into a fresh editor, URL gets `?p=`.
- [ ] **Duplicate 复制新建** on a filled sheet → new sheet: agent name / phone /
      email / brokerage / theme carried; **property address + city + description
      empty**; photo library empty except the headshot + brokerage logo; not
      confirmed; jumps straight in.
- [ ] **Delete 删除** → row disappears, toast "Moved to bin". Sheet still opens
      by its `?p=` link is NOT expected — it's soft-deleted.
- [ ] **Recycle bin 回收站** toggle → shows deleted sheets with a "Deleted" time.
- [ ] **Restore 恢复** in the bin → sheet returns to the active list.
- [ ] **Delete forever 彻底删除** (two-step) → gone; `GET` the id → 404.
- [ ] **Empty bin 清空回收站** (two-step) → bin empties.
- [ ] Wrong `?admin=` token → "Wrong admin token" message, no list.

## 2. Admin list — display & sort  ★

- [ ] Rows sorted by **agent first name A→Z**, then **newest-updated first**
      within the same first name. Empty-agent sheets last.
- [ ] Filter box narrows by address / city / agent.
- [ ] Row buttons are colour-coded: Open (grey) · Copy agent link (blue) ·
      Duplicate (green) · Delete (red) — Copy-link and Duplicate look different.
- [ ] "Copy agent link" copies a bare `?p=<id>` (no `&admin=`).

## 3. Photo library + slots (editor)  ★

- [ ] Agent view: **no left photo-library panel at all** (upload is admin-only).
- [ ] Admin view: library panel with Upload button + thumbnail grid.
- [ ] Admin: **drag a thumbnail onto a slot** → photo lands / replaces.
- [ ] Any role: **click a slot** (empty or filled) → picker modal opens; pick a
      photo → it fills the slot. There is **no ⇄ button** on filled slots.
- [ ] Filled slot: **drag on the image** pans it; a plain **click** opens the
      picker (does not pan).
- [ ] Slot toolbar (filled): − / + zoom, ↺ reset framing, ✕ clear — all work.
- [ ] Drag the **Move** handle from one slot onto another → photos swap.
- [ ] Photo always covers its slot (no white edges) after any pan/zoom.

## 4. Info form → live update  ★

- [ ] Type a **description** → left column switches from the 6-photo collage to
      the **5-photo collage + description**; text **auto-fits to fill the box**
      (font + line-spacing grow/shrink).
- [ ] Clear the description → back to the 6-photo collage.
- [ ] Fill **bedrooms / bathrooms / garage** (accept "4+1") → icon row appears;
      each icon hides on its own if its value is blank; all blank → row hidden,
      agent block reflows up.
- [ ] Fill **agent 2 name** → agent card switches to the **dual** layout;
      clear it → back to **single**.
- [ ] **Brokerage address** renders on **exactly 2 lines**: street (+ unit) on
      line 1, "City, PROV Postal" on line 2. Test all of:
      `333 Denison St, Unit 2, Markham, ON L3R 2Z4`,
      `333 Denison St, Unit 2 Markham, ON L3R 2Z4` (no comma before city),
      `500 Yonge Street, Toronto, ON M5B 2H1` (no unit).
- [ ] Upload a **headshot** and a **brokerage logo** → both show in the card
      (headshot cover-fit, logo contain-fit).

## 5. Agent card layout  ★

- [ ] **Single**: logo top-left, brokerage name under it, brokerage address
      bottom-left, name + Broker + Mobile/Office/Email centred, QR lower-right,
      headshot far right.
- [ ] **Dual**: `[headshot] [name + Tel/Email] [logo / address / QR] [name +
      Tel/Email] [headshot]` — **symmetric about the centre line**: the two
      headshots / names / contacts are the same size and equidistant from
      centre; logo, address and QR sit on the centre line.
- [ ] **Headshots are 3:4 portrait** (both, same size), regardless of whether
      the icon row is shown.
- [ ] The left agent's Tel/Email does **not** overlap the left headshot.
- [ ] Fonts: agent name / title / contact / brokerage address =
      **Cormorant Garamond**; brokerage NAME line (single only) = Source Sans 3.
- [ ] **Numbers are lining figures** — phone numbers / postal code / bed-bath
      counts are all cap-height and evenly aligned, no drop-below-baseline digits.
- [ ] Long email → shrinks to stay on **one line**, never wraps, never clipped.
- [ ] **ONLINE TOUR** caption under the QR shows in full (not "ONLINE TO").

## 6. Agent card box drag / resize — ADMIN ONLY  ★

- [ ] Agent view: agent-card modules are **not** draggable (no dashed outlines).
- [ ] Admin view: dashed outlines; drag a box to move it; corner grip to resize.
- [ ] **Double-click a box → it snaps back** to its template position + size.
- [ ] After dragging / resetting a box, **Save**, then **reload as the agent** →
      the agent sees the **same** position (the reset actually persisted; no
      stale offset resurrecting).
- [ ] Drag a box all the way to the card edge — it should not hit an invisible
      wall partway.

## 7. Address block (top of page-1 right)

- [ ] Street address in **TeX Gyre Chorus** (calligraphic), city below it.
- [ ] Both lines **centred**.
- [ ] A city with a descender (e.g. "Maple", "Vaughan") is **not clipped** at
      the bottom.

## 8. Photo frame proportions

- [ ] Page-2 slots: 8 small (~1.74:1) + 2 hero (~1.5:1); page-1 hero ~1.5:1.
- [ ] Page-1 left, no description: 6-photo collage — 1 wide top + 2 mid + small
      stack + 1 larger.
- [ ] Page-1 left, with description: 5-photo staggered collage in the top ~60%,
      description filling the rest, evenly.
- [ ] Placing a 6000×4000 photo never distorts it (only crops).

## 9. Icon row glyphs

- [ ] bed = front-view double bed w/ two pillows; bath = clawfoot tub w/
      gooseneck shower; garage = pitched-roof house w/ a car inside.

## 10. Preview modal  ★

- [ ] "Preview 预览" → 2 pages, watermarked.
- [ ] The **description fills its box** exactly as in the editor (not collapsed).
- [ ] Everything else matches the editor render.

## 11. Export PDF — ADMIN ONLY  ★

- [ ] "Export PDF 导出" button only shows in the admin view.
- [ ] Click → (Chrome) a "choose location" dialog; other browsers → download.
- [ ] Open the PDF: **2 pages**, page size = **1224 × 792 pt** (17×11" trim,
      no bleed).
- [ ] **No crop / fold marks**, no bleed — the page is exactly the trim box,
      art placed edge to edge.
- [ ] Text in the PDF **matches the editor**: agent names in Cormorant Garamond
      (not a bold system serif), no mid-word breaks ("Franky Chen" on one line,
      "Broker" on one line), description shows in full (last line not cut).
- [ ] Description in the PDF fills its box.
- [ ] First export of a session may take ~15-25 s (cold fonts); later ones ~4 s.

## 12. Confirm & Submit / lock  ★

- [ ] "Confirm & Submit 确认提交" → dialog. Agent wording says changes go through
      Franky (no self re-open); admin wording keeps the re-open note.
- [ ] After confirm: badge "SUBMITTED 已提交 · <time>"; stage locked.
- [ ] Locked sheet: **no slot toolbars, no agent-box drag/resize** (even for
      admin), photos can't be swapped.
- [ ] Agent view of a confirmed sheet: **no "Re-open" button**.
- [ ] Admin view of a confirmed sheet: "Re-open 重新打开" button present; click →
      unlocks.
- [ ] Export PDF still works on a confirmed sheet (admin).

## 13. Themes

- [ ] Colour-theme picker at the top of the info form: navy / white-marble /
      burgundy — background, gold keylines, agent-text colour all switch;
      marble keeps enough contrast.

## 14. Cross-role consistency  ★

- [ ] Admin makes a change (photo, info, box position, description) → Save →
      open the same `?p=` link **without** `&admin=` → the agent sees exactly
      the same result. No drift between what admin saved and what the agent
      loads.
- [ ] Reload the admin view too → the same (no state that only survives until
      the next edit).

---

### Known-good escape hatches (if something looks wrong)

- Description collapsed on load → it self-corrects on any edit; if it persists,
  the cold-load refit (`refitAll`) regressed.
- A box in the wrong place → double-click it to reset; if that doesn't stick
  after save + reload, the `applyPatch` replace-vs-merge fix regressed.
- PDF fonts look wrong → a self-hosted `@font-face` in `app.css` is out of sync
  with `themes.js`, or a cross-origin font link crept back into `index.html`.
