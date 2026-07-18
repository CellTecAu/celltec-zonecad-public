# ZoneCAD Corrections & Additions Plan

A prioritized plan to bring **zonecad**'s component data and 2D top-down representations
into line with **zoneforge**, the authoritative source of truth for the CellTec Zone
safety-fencing catalogue. This is an analysis/planning document only — no zonecad or
zoneforge source is changed by it.

---

## 1. Context

**zoneforge** (`C:\celltecau\celltec-zoneforge`) is the authoritative parametric CAD
generator for the CellTec Zone catalogue — measured geometry, dimensions, materials and
BOMs. **zonecad** (`C:\celltecau\celltec-zonecad`) is the in-browser 2D plan-view layout
tool (vanilla JS + Canvas 2D, no build). zonecad carries its own older, minimalist
product constants and symbolic 2D drawings; several are now provably wrong or incomplete
against zoneforge.

**Where zonecad's product data lives**
- `js/model.js` — `POST_PROFILE`, `FOOTPLATE`, `HOLE_DIA`/`HOLE_INSET`,
  `BRACKET_CLEARANCE`, `PANEL_FRAME_SHS`, `HINGE_PIN_OD`, `FLOOR_CLEARANCE`, `BOLLARD`,
  factories (`createPost`, `createSpan`, …).
- `js/spans.js` — hinge/pin geometry, panel width math, bay-split (ghost posts), sliding
  leaf line, cantilever hit shapes.
- `js/render.js` — all 2D drawing: `drawAluminiumSHS`, `drawPost`, `drawBollard`,
  `drawFootplate`/`footplateHoles`, `drawPanelBracket`, `drawHingeBracket`, `drawSpan`,
  `drawDoorLeaf`, `drawSlidingDoor`, `drawCantileverGate`, `drawMeshTicks`.
- `zonecad-spec.md` §8 — the product catalogue as documented.

**Where zoneforge's authority lives**
- `data/product-rules.json`, `data/parts.json`, `data/materials.json`,
  `catalogue/index.json`.
- `generator/*.py` — `post.py`, `panel.py`, `bay.py`, `door.py`, `bollard.py`, `lcp.py`,
  `hrk.py`, `slider.py` (SDK-F/S/DT/C).

**Key modelling reconciliation that IS already correct in zonecad:**
zonecad computes panel width = pin-to-pin + 25 mm SHS overhang. For an aluminium post the
pin offset is 43 + 19.5 = 62.5 from centre, so panel = C-C − 125 + 25 = **C-C − 100**,
which exactly matches zoneforge's "panel = bay − 100" (`bay.py`). The core fence math is
sound; the errors are in constants, footplates, bollards, mesh, cantilever, and the
sliding-door family breadth.

---

## 2. Component-by-component discrepancy analysis

| Component | zonecad current (file:line) | zoneforge authoritative (file) | Fix needed |
|---|---|---|---|
| **Aluminium post** | 86×86 T-slot, detailed section `drawAluminiumSHS` (render.js:448) | Zone 86×86 profile (post.py, product-rules) | ✅ Correct. Keep. |
| **Steel post wall** | `steel {w:75,h:75,wall:3}` (model.js:5) | `75×75×5 SHS` (post.py:30,62,257; z65_bom) | Wall **3 → 5**. |
| **Z65 post wall** | `z65 {w:65,h:65,wall:2}` (model.js:6) | `65×65×2.5 SHS` (post.py:186; product-rules Z65) | Wall **2.0 → 2.5**. |
| **FPM4** | 180×180, 4×Ø13, inset 20 (model.js:10) | 180×180×8, 4×D13 (parts.json, product-rules) | ✅ Correct. |
| **FPM2** | 100×180, 2×Ø13 (model.js:11) | 100×180×8, 2×D13 (product-rules) | ✅ Correct. |
| **FPC** | 180×180, 3 holes, post offset (43,−43), holes D13 (model.js:12; render.js:848) | 180×180×8, post offset (43,−43), **3×D14** (post.py:21; product-rules anchorHoles) | Offset ✅. Hole Ø **13 → 14**. |
| **FPO** | 180×180, 4 holes, **offset (43,0)** (model.js:13) | post offset **(0,−43)** (post.py:21 POST_OFFSET) | Offset axis wrong: **(43,0) → (0,−43)**. |
| **FPZ (Z65 base)** | 150×150, 4×Ø12, flagged GUESSTIMATE (model.js:14) | Z65 has an **integral welded flat foot 75×180×8, 2×D14** (post.py:173,198; product-rules Z65) | Replace: **75×180, 2 holes Ø14**, welded foot (not a 4-hole 150 plate). |
| **Panel frame** | 25×1.6 SHS, 2 vert + 3 horiz @ W−50 (spans.js:474; spec §8) | 25×25×1.6 SHS, 2 vert + horiz @ W−50, midbar if H≥1000 (panel.py) | ✅ Correct. |
| **Panel mesh** | "25×1.2 mesh" (spec §8; drawMeshTicks) | Weldmesh 25×25, **3.0 mm wire**; overall 28 mm (panel.py WIRE=3.0; product-rules) | Mesh spec **1.2 → 3.0 mm wire**; note 28 mm overall thickness. |
| **Hinge pin OD** | `HINGE_PIN_OD = 17` (model.js:24; spec §7) | PB **20 mm spigot** into 25 SHS bore (bay.py:9,32) | Pin **17 → 20 mm** (bore of 25×1.6 = 21.8, 20 fits). |
| **Panel floor clearance** | default `175` on every span (model.js:26,128; spec §7) | fence **bay GC = 100** (bay.py:27); door 170; slider 174/175 (slider.py) | 175 gives the right 1825 height for a 2000 post but mislabels the **ground gap** (really 100 for fences). Split "post-top drop" (175) from "ground clearance" (100/170/174) per span kind. |
| **Bollard** | ONE type: 165 CHS ×3.2, **round** 220 plate, 4×Ø17 @ 192.5 PCD, H1000 (model.js:105; drawBollard render.js:633) | **NB family** NB65/NB100/NB150: pipe OD 76.1/114.3/168.3, **square** plates 200/250/300×10, 4×D18 @ inset 30 + centre D20, cap OD+14; std H 900/1000/1200 (bollard.py) | Replace single round bollard with **NB65/100/150**, **square** baseplates, D18 anchors, per-size heights. |
| **Hinged door (PNLD)** | leaf + 45° swing arc, handle dot, hinge at ±29.5 slot (render.js:1033); C-C from posts | PNLD: post C-C = W+100; hinge pin x=61.5; leaf edge x=49; GC 170; DH handle centred on latch vert; HDDB drop bolt; 2×HDS stops @1/3,2/3 (door.py) | Largely OK for plan view. GC 175→170; optionally mark drop-bolt / strike side. |
| **Cantilever gate** | 40×40 frame; **len = 1.5×opening**; 2 double-wheel rollers near **front** of opening; **steel 75×3** support posts w/ 180×180 4×Ø17 plate; 75×75 endstop post (render.js:1263; spec §8) | SDK-C25/C40: 25 **or** 40 RHS leaf; **leaf = opening+550** (tail past support); **2× SDC5W five-wheel carriages at the SUPPORT post** (200 & 700 from trailing end); leading **guide post** SDCCP+SDSTG (no load); **SDCT track welded under leaf**; PSTM4 **aluminium** posts; SDCEND endstop; 1250 parking bay (slider.py CantileverSpec/build_cantilever) | Major rework — see §3 Stage 2. |
| **Sliding door** | ONE generic `slidingDoor`; leaf = **post c-c**; generic 40-deep top track, len 2×len+200 (render.js:1144; spans.js slidingLeafLine) | Full **SDK family**: SDK-F floor, SDK-S single-track, SDK-DT2/3/4 double-track, SDK-C25/C40 cantilever; leaf = opening+100 (F/S) or =O (DT); distinct tracks (SDFT floor / 80×40 / 80×80) (slider.py) | Default leaf **c-c → c-c+100**; then build out the family — see §3 Stage 4. |
| **LCP light-curtain post** | **absent** | 125×125 folded C-section ×3 mm, 200×200×10 footplate (4×D15), 30×30 T-slot, EC-125 cap (lcp.py) | **Add** as a component (square 125 footprint + 200 plate). |
| **HRK handrail kit** | **absent** | 2× PSTM4 posts + 50×50×1.6 upper rail (bay−65) + 30×30×1.6 lower rail (bay−58) (hrk.py) | **Add** as a span kind (rail run between two posts). |
| **Z65BAY** | z65 material exists but no distinct bay/bracket | Z65-PST posts + PNL{bay−100} + 4× Z65-PB corner brackets (bay.py) | Panel math already ~works; fix FPZ + bracket note. |
| **Steel post footplate offsets** | single offset scheme regardless of material | steel PSTO (−48.5,0), PSTC (−48.5,−48.5) (post.py:30-31 STEEL) | Low priority; note the steel offsets differ from aluminium. |

---

## 3. Prioritized action plan (staged)

### Stage 1 — Correct existing component geometry (data-only, low risk)
Mostly constant edits in `js/model.js` (+ a couple of render tweaks). No architecture
change; verify by loading a doc and eyeballing posts/panels/bollards.

1. **Steel/Z65 wall thickness** — `POST_PROFILE.steel.wall 3 → 5`,
   `POST_PROFILE.z65.wall 2 → 2.5` (`model.js:5-6`). (Wall isn't drawn in the square
   footprint but feeds BOM/labels/DXF — correct for truth.)
2. **FPO offset** — `FOOTPLATE.FPO {offsetX:43,offsetY:0} → {offsetX:0,offsetY:-43}`
   (`model.js:13`) to match `post.py` POST_OFFSET. Confirm `footplateHoles('FPO')`
   still yields the 4-corner pattern (render.js:849 — it does).
3. **FPC hole size** — FPC anchors are **Ø14**, not Ø13. Add `holeDia:14` to
   `FOOTPLATE.FPC` (`model.js:12`); `drawFootplate` already honours `fp.holeDia`
   (render.js:834).
4. **FPZ → real Z65 foot** — replace `FOOTPLATE.FPZ` with a **75×180, 2-hole (Ø14)**
   welded flat foot (`model.js:14`); add an `FPZ` branch to `footplateHoles`
   (render.js:842-852) mirroring `FPM2`'s 2-hole centreline pattern (currently FPZ falls
   into the FPM4 4-corner branch — wrong).
5. **Hinge pin OD** — `HINGE_PIN_OD 17 → 20` (`model.js:24`); update spec §7 wording.
   (Bracket pin glyph radii in render.js PB_PR/HB_PR are separate as-built numbers — leave
   unless re-measuring.)
6. **Mesh wire** — correct "25×1.2 mesh" to **weldmesh 3.0 mm wire, 25×25 grid, 28 mm
   overall** in `zonecad-spec.md` §8 and any BOM/label strings (`ui/bom.js`,
   `spans.js panelCutList` meshArea text). Rendering ticks unaffected.
7. **Floor clearance semantics** — keep 175 as the post-top-to-panel-top drop (it yields
   the correct 1825), but introduce per-kind ground clearances so heights/labels read
   true: fence **100**, door **170**, slider **174/175** (`model.js` FLOOR_CLEARANCE +
   `createSpan` defaults, `spans.js spanHeight`). Document that 175 ≠ ground gap.
8. **Bollards = NB family** — replace the single `BOLLARD` const (`model.js:105-112`)
   with an `NB` table keyed 65/100/150: `{od, wall, plate (square), plateT:10,
   anchorDia:18, anchorInset:30, centreDia:20, capOverhang:14, stdH}` from `bollard.py`.
   Add a size field to bollard creation (`createPost` bollard branch, `model.js:89-102`).
   Rewrite `drawBollard` (render.js:633) to draw a **square** baseplate with 4 anchors
   inset 30 from the edges + a centre hole, and the correct pipe OD per size. Update
   `drawAccessory` bollard (render.js:1638, hard-coded 164 OD) similarly.

### Stage 2 — Cantilever gates (correctness rebuild)
Rework `drawCantileverGate` (render.js:1263) and its hit shape (`spans.js
spanHitShapes` cantilever branch, spans.js:149) to the SDK-C model in `slider.py`:

1. **Leaf length rule** — replace `1.5 × opening` with **opening + 550 mm** counterbalance
   tail (CantileverSpec.leaf_width). Expose 25 vs 40 RHS frame as a `kindProps.rhs`
   (SDK-C25/C40).
2. **Carriages at the support post, not the front** — draw **two five-wheel carriages
   (SDC5W)** on the **support/retract side**, at **200 & 700 mm from the trailing
   (counterbalance) end** — not near the opening. This is the defining cantilever geometry
   (fixed support end, gate cantilevers over the opening).
3. **Leading guide post** — mark an SDCCP bottom bracket + SDSTG top guide on the leading
   post (carries no load), distinct from the load-bearing support post.
4. **Under-leaf track** — indicate the **SDCT track welded under the leaf**, full leaf
   length (cantilever has no ground track but does have this beam).
5. **Posts** — support/guide/parking posts are **PSTM4 aluminium**, not steel 75×3. Drop
   the steel-75×3 + 180×180-4×Ø17 assumption; a **1250 mm parking bay** sits past the
   support post with an **SDCEND** endstop beyond the parking post.
6. Update `zonecad-spec.md` §8 "Cantilever sliding gate" to this model, and the BOM
   breakdown in `ui/bom.js` (Cantilever Gates section) to SDK-C parts (leaf, SDCT, 2×
   SDC5W, SDCCP, 2× SDSTG, EC-SDCT, SDCEND, parking panel).

### Stage 3 — Improved lightweight 2D top-down rendering (still Canvas-2D-cheap)
Now that footprints are authoritative, upgrade the plan symbols without heavy geometry.
All in `js/render.js` (+ small helpers in `spans.js`).

1. **Accurate footplate outlines** — already offset per type; after Stage 1 the FPO/FPZ
   outlines and hole patterns will be correct. Add a thin **anchor-hole dot** legend size
   tied to real Ø (13/14/18) rather than a single HOLE_DIA.
2. **True bollard footprint** — square plates + real OD circles per NB size (Stage 1.8).
3. **Post-position & panel-span clarity** — keep the double-line panel + SHS end bars
   (render.js:930-975); ensure ghost-post spans read as equal bays (already via
   `bayLayout`). Add an optional faint **mesh-side hatch band** (short parallel ticks are
   already there via `drawMeshTicks`; a light fill on the mesh side improves legibility at
   low zoom) gated by `settings.layers.mesh`.
4. **Door swing** — the 45° leaf arc + handle is good; after Stage 1.7 the leaf length
   equals the true leaf width. Optionally draw the **strike-side stop** tick and
   drop-bolt dot from `door.py` positions.
5. **Slide travel** — for sliding doors draw the **parked leaf at the track far end** plus
   a light **travel arrow** along the track (leaf → open position), and dimension leaf
   width = opening + 100. Distinguish **floor track** (drawn 100 mm in front of the fence
   line, DOOR_OFFSET) from **overhead track** (over the posts) visually.
6. **Track widths by type** — floor SDFT vs 80×40 (single) vs 80×80 (double): drive track
   depth from the span kind instead of a fixed 40 (render.js:1199 trackDepth).
7. **New component glyphs** — LCP (125 square + 200 plate + inner T-slot tick) and HRK
   (two posts + double rail line) glyphs.
Keep everything as strokes/fills at `1/scale` line widths (the existing lightweight
convention) — no images, no per-wire mesh.

### Stage 4 — FULL sliding-door family (HEAVY — final stage)
The big one. zonecad today has a **single** generic `slidingDoor` spanKind; zoneforge has
a whole SDK family. Introduce sliding-door **forms** (e.g. `kindProps.form`) and build
each. Touches `model.js` (kindProps schema), `spans.js` (leaf/track geometry per form),
`render.js` (`drawSlidingDoor` dispatch), `dxf.js`, `ui/bom.js`, `ui/properties.js`
(form + hand + door-count selectors), and `zonecad-spec.md` §8.

Forms and status vs zoneforge (`slider.py`):
- **SDK-F floor track** — leaf = opening+100, SDFT floor track 100 mm in front of the
  fence, 2× SDFW floor wheels, 2× SDSTG top guides, 2× SDS parking stops. *(missing)*
- **SDK-S single track** — leaf = opening+100, 80×40 overhead track on 3× SDSTB, 2× SDT
  trolleys, 2× SDSG guides, cushioned end stops. *(missing — closest to today's generic)*
- **SDK-DT2 / DT3 / DT4 double track** — N leaves (=doors) each = one opening on a single
  80×80 track, adjacent leaves on opposite grooves so they pass/stack; N+1 posts. *(missing)*
- **SDK-C25 / C40 cantilever** — delivered in **Stage 2** (already the `cantileverGate`
  kind); fold naming into the SDK-C family here. *(Stage 2)*
- **SDK-ST2 two-door single track** — bi-parting on one 80×40 track. *(not built in
  zoneforge either — future)*
- **SDK-U underslung** — *(not built in zoneforge — future)*
- **SDK-T2D telescopic** — *(not built in zoneforge — future)*

Recommended order within Stage 4: SDK-S (reuse today's generic as the base) → SDK-F
(floor-offset variant) → SDK-DT2/3/4 (multi-leaf, the most new geometry) → ST2/U/T2D as
placeholders once zoneforge builds them.

---

## 4. Concrete landing points (quick index)

- **Constants / data:** `js/model.js` — `POST_PROFILE` (5-7), `FOOTPLATE` (9-15),
  `HOLE_DIA/HOLE_INSET` (17-18), `BRACKET_CLEARANCE` (23), `HINGE_PIN_OD` (24),
  `FLOOR_CLEARANCE` (26), `BOLLARD` (105-112), `createPost` (89), `createSpan` (118).
- **Geometry math:** `js/spans.js` — `pinOffset`/`bayPitch` (22-33), `spanHeight` (248),
  `slidingLeafLine` (193), `spanHitShapes` cantilever (149) & sliding (129),
  `panelCutList` (468).
- **Rendering:** `js/render.js` — `drawFootplate`/`footplateHoles` (815-852),
  `drawBollard` (633), `drawSpan` (883), `drawDoorLeaf` (1033), `drawSlidingDoor` (1144),
  `drawCantileverGate` (1263), `drawMeshTicks` (1010), `drawAccessory` (1636).
- **BOM / DXF / UI:** `js/ui/bom.js` (Posts / Panels / Cantilever / Panel Cut List
  sections), `js/dxf.js` (`eSlidingDoor`, panel dimensions), `js/ui/properties.js`
  (span-kind + kindProps editors), `js/ui/toolbox.js` (component palette for new LCP/HRK).
- **Spec:** `zonecad-spec.md` §8 (catalogue) and §7 (hinge/clearance) — update text to
  match corrected data.

---

## 5. Top findings (summary)

1. **Bollards are wrong and under-modelled** — one round-plate 165 CHS vs the real
   **NB65/NB100/NB150 with square plates** (200/250/300), D18 anchors, per-size heights.
2. **Cantilever gate geometry is materially wrong** — leaf length should be **opening+550**
   (not 1.5×opening); carriages are **five-wheel SDC5W at the support post** (not double
   wheels at the opening front); posts are **aluminium PSTM4** (not steel 75×3); there's an
   **SDCT under-leaf track**, a leading **guide post**, and a **1250 parking bay + SDCEND**.
3. **Sliding doors: only 1 of the SDK family exists** — missing SDK-F floor, SDK-DT2/3/4
   double-track, and (as future) SDK-ST2/-U/-T2D; the default leaf should be **opening+100**,
   not just post c-c.
4. **FPZ (Z65 base) is a guess and wrong** — Z65 uses an **integral welded 75×180×8
   flat foot with 2×D14**, not a 150×150 4-hole plate.
5. **Mesh wire spec wrong** — documented **1.2 mm**; real weldmesh is **3.0 mm wire**
   (28 mm overall panel thickness).
6. **Post wall thicknesses wrong** — steel **3→5 mm**, Z65 **2.0→2.5 mm**.
7. **FPO offset on the wrong axis** — zonecad (43,0) vs zoneforge (0,−43); **FPC anchors
   Ø14 not Ø13**.
8. **Hinge pin OD 17 → 20 mm** (PB spigot into the 25 SHS bore).
9. **Two whole components are absent** — **LCP** light-curtain post and **HRK** handrail
   kit.
10. **Floor-clearance is conflated** — 175 (post-top drop, gives 1825) vs the true ground
    gap (fence **100**, door 170, slider ~174).
11. **ADB (adjustable door brace) is a new component** — over-doorway post tie (25 SHS + fixed
    leg + movable slide plate, 8× M8×12 BHCS, black); **hinged doorways only, never over a slider
    track**. Added this pass; see §6.
12. **Door-hardware rules corrected** — double gates have **no HDS stops** (drop bolt closes);
    a single door's **drop bolt/SDFW appear only when the leaf is wide (≈1200 mm+)**; sliding
    **SDS stops mount ON posts** in a parking-side pair + an opposing closing-side pair. See §6.

**Applied status (2026-07-18):** Stage 1 constants + the ADB feature are **APPLIED**; Stage 2
(cantilever rebuild) and Stage 4 (full SDK sliding family) remain **PENDING** — see §6.

**Stage breakdown:** Stage 1 correct existing geometry (constants in `model.js` + a few
render tweaks; bollards, footplates, walls, mesh, pin) → Stage 2 cantilever gate rebuild
(`render.js`/`spans.js` to the SDK-C model) → Stage 3 lightweight 2D upgrades (accurate
footprints, slide travel, mesh band, LCP/HRK glyphs) → **Stage 4 (heavy, last)** the full
SDK sliding-door family (floor/single/double-2-3-4; ST2/U/T2D as placeholders).

---

## 6. Applied 2026-07-18 (Stage 1 + ADB) & new learnings from the zoneforge layout composer

### 6.1 What was applied this pass
**Stage 1** constant/geometry corrections were **APPLIED** to zonecad this pass by parallel
agents (`js/model.js`, `js/render.js`, `js/ui/properties.js`, `js/ui/bom.js`), together with a
new **ADB** (adjustable door brace) feature. Applied:

- Steel post wall **3 → 5 mm**; Z65 wall **2.0 → 2.5 mm**.
- FPO offset **(43,0) → (0,−43)**; **FPC anchors Ø13 → Ø14**.
- **FPZ** replaced with the real Z65 **integral welded 75×180×8 foot, 2×Ø14** (no longer a
  150×150 4-hole plate).
- Mesh corrected to **weldmesh 3.0 mm wire, 25×25 grid, 28 mm overall** (was "1.2 mm").
- **Hinge pin OD 17 → 20 mm**.
- Bollards replaced with the **NB65/NB100/NB150** family (pipe OD 76.1/114.3/168.3, **square**
  plates 200/250/300×10, 4×D18 @ inset 30 + centre D20, cap +14, std H 900/1000/1200).
- Floor clearance semantics split: **175 = post-top-to-panel-top drop**; true ground gap is
  fence **100**, door **170**, slider **174**.
- **ADB feature** added (see 6.2.1) — new component + per-door toggle (`kindProps.adb`).

`zonecad-spec.md` §7 (hinge/clearance) and §8 (catalogue) were updated to match all of the above.

### 6.2 Still PENDING
- **Stage 2 — cantilever gate rebuild** (SDK-C model: leaf = opening+550, SDC5W five-wheel
  carriages at the support post, aluminium PSTM4 posts, SDCT under-leaf track, leading guide
  post, 1250 parking bay + SDCEND). **Not applied** — `zonecad-spec.md` §8 "Cantilever sliding
  gate" still carries the old (wrong) 1.5×opening / steel-75×3 model as a known-stale placeholder.
- **Stage 4 — full SDK sliding-door family** (SDK-F / S / DT2-3-4; ST2/U/T2D placeholders).
  **Not applied.**
- Stage 3 lightweight 2D upgrades and the absent LCP / HRK components also remain pending.

### 6.2.1 New hardware rules learned building the zoneforge interactive layout composer
Authoritative — fold into the spec and all future zonecad work.

1. **ADB — Adjustable Door Brace** (new component; `zoneforge/zone_components/ADB.step`,
   `zoneforge/generator/brace.py`). A horizontal brace fitted **over a hinged doorway in lieu of
   the two post caps**, tying the strike + hinge posts together so the opening can't spread. Built
   from a **25 SHS span member** cut to the door-post centre-to-centre **+ a bit extra** (stock is
   long), a **fixed-leg bracket** at one post and a **movable slide plate** at the other (slides on
   the SHS, tek-screwed in its final position). Each end bolts down into the post top with **4×
   M8×12 button-head capscrews (8 total)**. **All painted black.** Goes on **hinged doorways only —
   NEVER over sliding-door floor tracks** (those are deliberately open-top). Toggleable per door
   (`kindProps.adb`).
2. **Double hinged gate** — has **NO HDS strike door-stops** (nothing mid-span to mount them to).
   The **drop bolt** on the holding leaf is the closure: one leaf holds via drop bolt, the other
   latches to it.
3. **Single hinged door** — the **drop bolt appears only when the leaf is quite wide** (zoneforge
   threshold ≈ **1200 mm**); wide leaves also get a **floor wheel / track roller (SDFW)** under the
   latch edge to carry the span. Narrow doors have neither.
4. **Sliding-door SDS stops** — must **mount ON a post** (not float in the bay). There is a
   **parking-side pair** (leaf fully open) AND an **opposing closing-side pair** on the post the
   leaf shuts against (mirrored, rotor facing outward toward the leaf).
