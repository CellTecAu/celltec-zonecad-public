// DXF R12 ASCII exporter — an accurate plan-view of the doc model that mirrors the
// on-screen render: posts (footplate + bolt holes + SHS body, rotated), panel brackets +
// pins, ghost (intermediate) posts on long runs, panels at their true 25 mm footprint,
// hinged-door / swing-gate leaves, sliding doors and cantilever gates.
//
// Layers: LAYOUT, POSTS, GHOSTS, BRACKETS, FENCE, GATES, GAPS, ZONES, LABELS, DIMS.
import { spanHinges, ghostPostCenters, doorHingePositions, autoFaceKey, panelConfig, dimensionSegments } from './spans.js';
import { PANEL_FRAME_SHS, FOOTPLATE, HOLE_DIA, HOLE_INSET, BRACKET_CLEARANCE, buildPostMap, postProfile, BOLLARD } from './model.js';

// ACI colour per layer, for the LAYER table.
const LAYERS = {
  LAYOUT: 8, POSTS: 7, GHOSTS: 8, BRACKETS: 3, FENCE: 5,
  GATES: 1, GAPS: 2, ZONES: 4, LABELS: 7, DIMS: 6,
};
const DIM_TXT = 60;   // dimension text height (mm) — DIMTXT
const DIM_ASZ = 30;   // arrowhead length (mm)     — DIMASZ

// Panel-bracket body (normalised: face at x=0, outward +x) — mirrors render.js PB_* constants.
const PB = { BW: 23.5, D: 36, BW2: 20.5, PX: 19.5, PR: 10.75 };
const FACE_MID  = { px: [1, 0], nx: [-1, 0], py: [0, 1], ny: [0, -1] }; // ×hw/hh
const FACE_ROT  = { px: 0, nx: Math.PI, py: Math.PI / 2, ny: -Math.PI / 2 };

export function exportDxf(doc) {
  const { layout, objects } = doc;
  const layoutW = layout.widthM  * 1000;
  const layoutH = layout.heightM * 1000;
  const postMap = buildPostMap(objects);

  const out = [];                     // final token stream
  const blocks = [];                  // { name, layer, ent:[…tokens], insert, anon } — one per object
  const dims  = [];                   // DIMENSION entity records (reference their picture block)
  let cur = null;                     // current entity buffer (the open block's body)
  let dimN = 0;
  const cfg = panelConfig(doc.settings);   // ghost splits must match the canvas + BOM
  const f = v => typeof v === 'number' ? v.toFixed(2) : String(v);

  // Unique, R12-legal block name (≤31 chars, no leading digit, alnum/_).
  const usedNames = new Set();
  function blockName(base) {
    let n = String(base).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase().slice(0, 26) || 'OBJ';
    if (/^[0-9]/.test(n)) n = 'B' + n;
    let name = n, k = 1;
    while (usedNames.has(name)) name = n + '_' + (k++);
    usedNames.add(name);
    return name;
  }
  // Collect everything draw() emits into one BLOCK → exported as a single INSERT, so the
  // whole post / panel / gate / zone selects as one object in CAD (not loose lines).
  function object(base, layer, draw) {
    const prev = cur;
    cur = [];
    draw();
    if (cur.length) blocks.push({ name: blockName(base), layer, ent: cur, insert: true });
    cur = prev;
  }

  function eLine(x1, y1, x2, y2, layer = 'FENCE') {
    cur.push('0', 'LINE', '8', layer,
      '10', f(x1), '20', f(y1), '30', '0.00',
      '11', f(x2), '21', f(y2), '31', '0.00');
  }
  function eText(x, y, h, str, layer = 'LABELS', rotDeg = 0) {
    cur.push('0', 'TEXT', '8', layer,
      '10', f(x), '20', f(y), '30', '0.00',
      '40', f(h), '1', String(str));
    if (rotDeg) cur.push('50', f(rotDeg));
    cur.push('72', '1', '11', f(x), '21', f(y), '31', '0.00');
  }

  // ── Aligned DIMENSION between two world points, dim line offset perpendicular (left of
  //    a→b). Emits a real DIMENSION entity plus the anonymous *D<n> block holding its
  //    picture (witness lines, dim line, arrowheads, text) — so CAD can select and edit it. ──
  function eDimension(ax, ay, bx, by, offsetMm, layer = 'DIMS') {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;                       // left-of-a→b unit normal
    const pa = { x: ax + nx * offsetMm, y: ay + ny * offsetMm };  // dim line start
    const pb = { x: bx + nx * offsetMm, y: by + ny * offsetMm };  // dim line end
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const txt = { x: mid.x + nx * (DIM_TXT * 0.7), y: mid.y + ny * (DIM_TXT * 0.7) };
    const text = String(Math.round(len));
    const name = `*D${++dimN}`;
    // Keep text upright: flip the along-run bearing into the readable half-turn.
    let rot = Math.atan2(uy, ux) * 180 / Math.PI;
    if (rot > 90 || rot <= -90) rot += 180;

    const prev = cur;
    cur = [];
    const ext = 20;                                 // witness overshoot past the dim line
    eLine(ax, ay, pa.x + nx * ext, pa.y + ny * ext, layer);   // witness line 1
    eLine(bx, by, pb.x + nx * ext, pb.y + ny * ext, layer);   // witness line 2
    eLine(pa.x, pa.y, pb.x, pb.y, layer);                     // dimension line
    eArrow(pa.x, pa.y,  ux,  uy, layer);                      // inward arrowheads
    eArrow(pb.x, pb.y, -ux, -uy, layer);
    eText(txt.x, txt.y, DIM_TXT, text, layer, rot);
    blocks.push({ name, layer, ent: cur, insert: false, anon: true });
    cur = prev;

    dims.push({ name, layer, text, def: pa, txt, a: { x: ax, y: ay }, b: { x: bx, y: by } });
  }

  // Open arrowhead pointing along (ux,uy) from the dimension-line end.
  function eArrow(x, y, ux, uy, layer) {
    const nx = -uy, ny = ux, w = DIM_ASZ / 3;
    eLine(x, y, x + ux * DIM_ASZ + nx * w, y + uy * DIM_ASZ + ny * w, layer);
    eLine(x, y, x + ux * DIM_ASZ - nx * w, y + uy * DIM_ASZ - ny * w, layer);
  }
  function ePoly(pts, layer, close = true) {          // pts: [{x,y},…]
    for (let i = 0; i < pts.length - 1; i++) eLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, layer);
    if (close && pts.length > 2) eLine(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y, layer);
  }
  // True DXF CIRCLE (centre + radius) so it can be dimensioned, not a faceted polyline.
  function eCircle(cx, cy, r, layer) {
    cur.push('0', 'CIRCLE', '8', layer, '10', f(cx), '20', f(cy), '30', '0.00', '40', f(r));
  }
  // True DXF ARC (degrees, always swept CCW from start → end).
  function eArc(cx, cy, r, startDeg, endDeg, layer) {
    cur.push('0', 'ARC', '8', layer, '10', f(cx), '20', f(cy), '30', '0.00',
      '40', f(r), '50', f(startDeg), '51', f(endDeg));
  }

  // ── Post-local → world. Mirrors the render transform ctx.rotate(-rad): a local
  //    point (lx,ly) maps to post + R(-rad)·(lx,ly). Same formula as hingePoint(). ──
  const placer = post => {
    const rad = (post.footplateRotationDeg ?? 0) * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    return (lx, ly) => ({ x: post.x + lx * c + ly * s, y: post.y - lx * s + ly * c });
  };
  const rot2 = (x, y, a) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });

  // ── Real post cross-section (mirrors render.js): aluminium 86×86 T-slot extrusion
  //    (outer square + 4 T-slot channels + central hollow + 4 M8 holes) or steel 75×3 SHS
  //    (outer + inner square). Drawn in post-local space then placed by post rotation. ──
  function ePostProfile(post, layer) {
    const P = placer(post);
    if (post.material === 'aluminium') {
      const F = 43, SO = 29, SB = 29.5, SN = 17, LE = 38.5, LS = 33.5, LI = 32.5, LY = 30,
            LW = 18, LX = 30, LIP = 17.5, EI = 41, EY = 27, LP = 39, LPY = 29.5,
            HW = 28, HN = 24.4, MH = 36, MR = 3.4;
      // Outer boundary as ONE closed outline: each face runs corner → into the T-slot
      // notch → out → next corner (no separate square). Notch walks CCW from (F,-SO) to
      // (F,SO) on the +X face; rotate 90° per face.
      const notch = [[F, -SO], [EI, -EY], [LP, -EY], [LP, -LPY], [LE, -LY], [LS, -LY],
        [LI, -SO], [LI, -LW], [LX, -LIP], [SB, -SN], [SB, SN], [LX, LIP], [LI, LW],
        [LI, SO], [LS, LY], [LE, LY], [LP, LPY], [LP, EY], [EI, EY], [F, SO]];
      const outline = [];
      for (let q = 0; q < 4; q++) {
        const a = q * Math.PI / 2;
        const c = rot2(F, -F, a); outline.push(P(c.x, c.y));           // face start corner
        for (const [x, y] of notch) { const r = rot2(x, y, a); outline.push(P(r.x, r.y)); }
      }
      ePoly(outline, layer);
      ePoly([P(HW, -HN), P(HW, HN), P(HN, HW), P(-HN, HW),            // central hollow octagon
        P(-HW, HN), P(-HW, -HN), P(-HN, -HW), P(HN, -HW)], layer);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {           // 4× Ø6.8 M8 holes
        const c = P(MH * sx, MH * sy); eCircle(c.x, c.y, MR, layer);
      }
    } else {
      // SHS: outer + inner square from the profile (steel 75×3, z65 65×2)
      const prof = postProfile(post.material);
      const ho = prof.w / 2, hi = ho - (prof.wall ?? 3);
      ePoly([P(-ho, -ho), P(ho, -ho), P(ho, ho), P(-ho, ho)], layer);
      ePoly([P(-hi, -hi), P(hi, -hi), P(hi, hi), P(-hi, hi)], layer);
    }
  }

  // ── Post: footplate outline + bolt holes + real profile + datum cross (+ optional label) ──
  function ePost(post, layer = 'POSTS', label = null) {
    const prof = postProfile(post.material);
    const hw = prof.w / 2, hh = prof.h / 2;
    const fp = FOOTPLATE[post.footplate] ?? { w: prof.w, h: prof.h, offsetX: 0, offsetY: 0 };
    const ox = fp.offsetX ?? 0, oy = fp.offsetY ?? 0;
    const P = placer(post);

    // Footplate rectangle (offset from post centre)
    ePoly([
      P(ox - fp.w / 2, oy - fp.h / 2), P(ox + fp.w / 2, oy - fp.h / 2),
      P(ox + fp.w / 2, oy + fp.h / 2), P(ox - fp.w / 2, oy + fp.h / 2),
    ], layer);
    // Footplate bolt holes
    for (const [hx, hy] of footplateHoles(post.footplate, fp)) {
      const w = P(hx, hy); eCircle(w.x, w.y, (fp.holeDia ?? HOLE_DIA) / 2, layer);
    }
    // Real post cross-section
    ePostProfile(post, layer);
    // Datum cross (setout centreline)
    const c0 = P(-20, 0), c1 = P(20, 0), c2 = P(0, -20), c3 = P(0, 20);
    eLine(c0.x, c0.y, c1.x, c1.y, layer); eLine(c2.x, c2.y, c3.x, c3.y, layer);
    if (label) eText(post.x, post.y + Math.max(hh, fp.h / 2) + 80, 60, label, 'LABELS');
  }

  // ── Panel bracket (aluminium only, matching render) — body trapezoid + pin collar ──
  function ePanelBracket(post, faceKey) {
    if (post.material !== 'aluminium') return;
    const prof = postProfile(post.material);
    const hw = prof.w / 2, hh = prof.h / 2;
    const [mx, my] = FACE_MID[faceKey] ?? FACE_MID.px;
    const ftx = mx * hw, fty = my * hh;
    const fr = FACE_ROT[faceKey] ?? 0;
    const P = placer(post);
    // Bracket-local (outward +x) → face-rotate → offset to face → post-place.
    const b = (bx, by) => { const r = rot2(bx, by, fr); return P(ftx + r.x, fty + r.y); };
    // Square body: parallel side walls (constant half-width), both edges square to the post.
    ePoly([b(0, -PB.BW), b(PB.D, -PB.BW), b(PB.D, PB.BW), b(0, PB.BW)], 'BRACKETS');
    const pin = b(PB.PX, 0); eCircle(pin.x, pin.y, PB.PR, 'BRACKETS');
  }

  // ── Oriented SHS end-bar (25×25) centred on a pin, aligned to the span ──
  function eShsBar(cx, cy, sdx, sdy, nx, ny, layer = 'FENCE') {
    const h = PANEL_FRAME_SHS.w / 2;
    ePoly([
      { x: cx + nx * h + sdx * h, y: cy + ny * h + sdy * h },
      { x: cx - nx * h + sdx * h, y: cy - ny * h + sdy * h },
      { x: cx - nx * h - sdx * h, y: cy - ny * h - sdy * h },
      { x: cx + nx * h - sdx * h, y: cy + ny * h - sdy * h },
    ], layer);
  }

  // ── Layout boundary (its own object) ──
  object('LAYOUT', 'LAYOUT', () => {
    ePoly([{ x: 0, y: 0 }, { x: layoutW, y: 0 }, { x: layoutW, y: layoutH }, { x: 0, y: layoutH }], 'LAYOUT');
  });

  // ── Real posts — one block per post ──
  for (const o of objects) {
    if (o.type !== 'post') continue;
    object('POST_' + o.id, 'POSTS', () => {
      if (o.kind === 'bollard') {
        eCircle(o.x, o.y, BOLLARD.od / 2, 'POSTS');
        eCircle(o.x, o.y, BOLLARD.plateOd / 2, 'POSTS');
        const rot = -(o.footplateRotationDeg ?? 0) * Math.PI / 180;
        for (let k = 0; k < BOLLARD.holes; k++) {
          const a = rot + Math.PI / 4 + k * Math.PI / 2;
          eCircle(o.x + Math.cos(a) * BOLLARD.pcd / 2, o.y + Math.sin(a) * BOLLARD.pcd / 2, BOLLARD.holeDia / 2, 'POSTS');
        }
        eText(o.x, o.y + BOLLARD.plateOd / 2 + 80, 60, o.id, 'LABELS');
      } else {
        ePost(o, 'POSTS', o.id);
      }
    });
  }

  // ── Spans — one block per span (panel + bars + brackets + ghost posts, or gate/gap) ──
  for (const o of objects) {
    if (o.type === 'span') {
      const h = spanHinges(o, postMap);
      if (!h) continue;
      const { hA, hB } = h;
      const dx = hB.x - hA.x, dy = hB.y - hA.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const sdx = dx / len, sdy = dy / len;
      const nx = -sdy, ny = sdx;
      const pA = postMap[o.postA], pB = postMap[o.postB];

      object('SPAN_' + o.id, o.spanKind === 'gap' ? 'GAPS'
        : (o.spanKind === 'panel' ? 'FENCE' : 'GATES'), () => {
        if (o.spanKind === 'slidingDoor') { eSlidingDoor(o, hA, hB, dx, dy, len, nx, ny, postMap, eLine, FOOTPLATE); return; }
        if (o.spanKind === 'cantileverGate') { eCantileverGate(o, hA, hB, dx, dy, len, nx, ny, postMap, eLine, FOOTPLATE); return; }

        if (o.spanKind === 'hingedDoor' || o.spanKind === 'swingGate') {
          eDoorLeaf(o, hA, hB, postMap);
          if (pA) ePanelBracket(pA, o.faceA ?? autoFaceKey(pA, pB ?? pA));
          if (pB) ePanelBracket(pB, o.faceB ?? autoFaceKey(pB, pA ?? pB));
          return;
        }

        if (o.spanKind === 'gap') {
          // Opening — dashed reference line only (mesh-free), on GAPS layer.
          eLine(hA.x, hA.y, hB.x, hB.y, 'GAPS');
          return;
        }

        // Panel: true 25 mm plan footprint (rails ±12.5 mm), continuous outer face to outer face.
        const rh = PANEL_FRAME_SHS.w / 2;
        const aoX = hA.x - sdx * rh, aoY = hA.y - sdy * rh;
        const boX = hB.x + sdx * rh, boY = hB.y + sdy * rh;
        eLine(aoX + nx * rh, aoY + ny * rh, boX + nx * rh, boY + ny * rh, 'FENCE');
        eLine(aoX - nx * rh, aoY - ny * rh, boX - nx * rh, boY - ny * rh, 'FENCE');
        eLine(aoX + nx * rh, aoY + ny * rh, aoX - nx * rh, aoY - ny * rh, 'FENCE');
        eLine(boX + nx * rh, boY + ny * rh, boX - nx * rh, boY - ny * rh, 'FENCE');
        // SHS end-bars at the two end pins
        eShsBar(hA.x, hA.y, sdx, sdy, nx, ny);
        eShsBar(hB.x, hB.y, sdx, sdy, nx, ny);
        // End-post brackets
        if (pA) ePanelBracket(pA, o.faceA ?? autoFaceKey(pA, pB ?? pA));
        if (pB) ePanelBracket(pB, o.faceB ?? autoFaceKey(pB, pA ?? pB));
        // Ghost (intermediate) posts on long runs: perpendicular, on the pin line, with brackets.
        const refPost = pA ?? pB;
        for (const g of ghostPostCenters(o, postMap, cfg)) {
          const ghost = {
            x: g.x, y: g.y,
            material: refPost?.material ?? 'aluminium',
            footplate: refPost?.footplate ?? 'FPM4',
            footplateRotationDeg: g.rotDeg ?? 0,
          };
          eShsBar(g.x, g.y, sdx, sdy, nx, ny);
          ePost(ghost, 'GHOSTS');
          ePanelBracket(ghost, 'px');
          ePanelBracket(ghost, 'nx');
        }
      });

    } else if (o.type === 'zone') {
      object('ZONE_' + o.id, 'ZONES', () => {
        if (o.shape === 'circle') {
          eCircle(o.x, o.y, o.radiusMm ?? o.widthMm / 2, 'ZONES');
        } else {
          ePoly([
            { x: o.x - o.widthMm / 2, y: o.y - o.heightMm / 2 }, { x: o.x + o.widthMm / 2, y: o.y - o.heightMm / 2 },
            { x: o.x + o.widthMm / 2, y: o.y + o.heightMm / 2 }, { x: o.x - o.widthMm / 2, y: o.y + o.heightMm / 2 },
          ], 'ZONES');
        }
        if (o.name) eText(o.x, o.y, 80, o.name, 'ZONES');
      });

    } else if (o.type === 'dim' || o.type === 'refdim') {
      // (dimensions/refdims are annotations — omitted from the fabrication DXF)
    }
  }

  // ── Panel dimensions (Settings → "Dimension all panels") — one aligned DIMENSION per
  //    PHYSICAL panel (ghost sub-panels included) and per hinged-door/swing-gate opening.
  //    Sliding/cantilever gate widths are itemised in the BOM, not dimensioned here. ──
  if (doc.settings?.dimensionPanels) {
    for (const o of objects) {
      if (o.type !== 'span') continue;
      for (const seg of dimensionSegments(o, postMap, cfg)) {
        eDimension(seg.ax, seg.ay, seg.bx, seg.by, seg.offset);
      }
    }
  }

  // ── Assemble ──
  // TABLES: layer table + a STANDARD text style and dimension style. Without a DIMSTYLE,
  // CAD re-renders the DIMENSION entities at its own (tiny) defaults instead of ours.
  out.push('0', 'SECTION', '2', 'TABLES');
  out.push('0', 'TABLE', '2', 'LTYPE', '70', '1');
  out.push('0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line',
    '72', '65', '73', '0', '40', '0.0');
  out.push('0', 'ENDTAB');
  const layerNames = Object.keys(LAYERS);
  out.push('0', 'TABLE', '2', 'LAYER', '70', String(layerNames.length));
  for (const name of layerNames) {
    out.push('0', 'LAYER', '2', name, '70', '0', '62', String(LAYERS[name]), '6', 'CONTINUOUS');
  }
  out.push('0', 'ENDTAB');
  out.push('0', 'TABLE', '2', 'STYLE', '70', '1');
  out.push('0', 'STYLE', '2', 'STANDARD', '70', '0', '40', '0.0', '41', '1.0',
    '50', '0.0', '71', '0', '42', f(DIM_TXT), '3', 'txt', '4', '');
  out.push('0', 'ENDTAB');
  out.push('0', 'TABLE', '2', 'DIMSTYLE', '70', '1');
  out.push('0', 'DIMSTYLE', '2', 'STANDARD', '70', '0',
    '40', '1.0',            // DIMSCALE
    '41', f(DIM_ASZ),       // DIMASZ  — arrow size
    '42', '10.0',           // DIMEXO  — extension line offset from the point
    '44', '20.0',           // DIMEXE  — extension line overshoot past the dim line
    '140', f(DIM_TXT),      // DIMTXT  — text height
    '147', '15.0',          // DIMGAP
    '73', '0',              // DIMTIH  — text aligned with the dim line (not always horizontal)
    '74', '0',              // DIMTOH
    '77', '1',              // DIMTAD  — text above the dimension line
    '3', '');               // DIMPOST — no suffix (values are plain mm)
  out.push('0', 'ENDTAB');
  out.push('0', 'ENDSEC');

  // BLOCKS: every object's geometry, plus the anonymous *D<n> dimension picture blocks.
  out.push('0', 'SECTION', '2', 'BLOCKS');
  for (const b of blocks) {
    out.push('0', 'BLOCK', '8', '0', '2', b.name, '70', b.anon ? '1' : '0',
      '10', '0.0', '20', '0.0', '30', '0.0', '3', b.name);
    out.push(...b.ent);
    out.push('0', 'ENDBLK', '8', '0');
  }
  out.push('0', 'ENDSEC');

  // ENTITIES: one INSERT per object (a single selectable thing), then the DIMENSIONs.
  out.push('0', 'SECTION', '2', 'ENTITIES');
  for (const b of blocks) {
    if (b.insert === false) continue;   // dimension picture blocks are placed by their DIMENSION
    out.push('0', 'INSERT', '8', b.layer, '2', b.name, '10', '0.0', '20', '0.0', '30', '0.0');
  }
  for (const d of dims) {
    out.push('0', 'DIMENSION', '8', d.layer, '2', d.name,
      '10', f(d.def.x), '20', f(d.def.y), '30', '0.00',   // dimension-line definition point
      '11', f(d.txt.x), '21', f(d.txt.y), '31', '0.00',   // text midpoint
      '70', '1',                                          // 1 = aligned
      '1', d.text,
      '13', f(d.a.x), '23', f(d.a.y), '33', '0.00',       // extension line 1 origin
      '14', f(d.b.x), '24', f(d.b.y), '34', '0.00',       // extension line 2 origin
      '3', 'STANDARD');
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n');

  // ── Hinged door / swing gate leaf — mirrors render.js drawDoorLeaf ──
  function eDoorLeaf(o, hA, hB) {
    const kp  = o.kindProps ?? {};
    const dv0 = { x: hB.x - hA.x, y: hB.y - hA.y };
    const len = Math.hypot(dv0.x, dv0.y);
    if (len < 1) return;
    // Closed reference line between bracket pins
    eLine(hA.x, hA.y, hB.x, hB.y, 'GATES');

    const hp       = kp.hingePos ?? ((kp.hingeEnd ?? 'A') + ((kp.swingSide ?? 'left') === 'left' ? 'l' : 'r'));
    const postChar = hp[0];
    const sideSign = hp[1] === 'l' ? 1 : -1;
    const swingSign = (postChar === 'A' ? 1 : -1) * sideSign;
    const openDeg  = kp.openAngleDeg ?? 45;

    const hinge = doorHingePositions(o, postMap).find(p => p.pos === hp) ?? (postChar === 'A' ? hA : hB);
    const free  = postChar === 'A' ? hB : hA;
    const dv    = { x: free.x - hinge.x, y: free.y - hinge.y };
    const dlen  = Math.hypot(dv.x, dv.y) || 1;
    const cdx = dv.x / dlen, cdy = dv.y / dlen;
    const rad = swingSign * openDeg * Math.PI / 180;
    const odx = cdx * Math.cos(rad) - cdy * Math.sin(rad);
    const ody = cdx * Math.sin(rad) + cdy * Math.cos(rad);
    const openTip = { x: hinge.x + odx * dlen, y: hinge.y + ody * dlen };

    const rh = PANEL_FRAME_SHS.w / 2;
    const lnx = -ody, lny = odx;                 // leaf normal
    const aoX = hinge.x - odx * rh, aoY = hinge.y - ody * rh;
    const boX = openTip.x + odx * rh, boY = openTip.y + ody * rh;
    // Leaf rails + end caps
    eLine(aoX + lnx * rh, aoY + lny * rh, boX + lnx * rh, boY + lny * rh, 'GATES');
    eLine(aoX - lnx * rh, aoY - lny * rh, boX - lnx * rh, boY - lny * rh, 'GATES');
    eLine(aoX + lnx * rh, aoY + lny * rh, aoX - lnx * rh, aoY - lny * rh, 'GATES');
    eLine(boX + lnx * rh, boY + lny * rh, boX - lnx * rh, boY - lny * rh, 'GATES');
    // SHS bars at hinge and open tip (aligned to the open leaf)
    eShsBar(hinge.x, hinge.y, odx, ody, lnx, lny, 'GATES');
    eShsBar(openTip.x, openTip.y, odx, ody, lnx, lny, 'GATES');
    // Swing arc from closed to open (true ARC, degrees, CCW start→end)
    const arcR = Math.min(dlen * 0.18, 100);
    const A0 = Math.atan2(cdy, cdx) * 180 / Math.PI, A1 = Math.atan2(ody, odx) * 180 / Math.PI;
    let sDeg = swingSign >= 0 ? A0 : A1, eDeg = swingSign >= 0 ? A1 : A0;
    while (eDeg < sDeg) eDeg += 360;
    eArc(hinge.x, hinge.y, arcR, sDeg, eDeg, 'GATES');
  }
}

// ── Sliding door plan footprint — track outline + parked panel (mirrors drawSlidingDoor) ──
function eSlidingDoor(o, hA, hB, dx, dy, len, nx, ny, postMap, eLine, FOOTPLATE) {
  const sdx = dx / len, sdy = dy / len;
  const kp        = o.kindProps ?? {};
  const slideEnd  = kp.slideEnd  ?? 'B';
  const tSide     = kp.trackSide === 'right' ? -1 : 1;
  const tnx = nx * tSide, tny = ny * tSide;
  const railHalf = PANEL_FRAME_SHS.w / 2;
  const shsH     = railHalf;

  const homePost = postMap[slideEnd === 'A' ? o.postA : o.postB];
  const material = homePost?.material ?? 'aluminium';
  const hw       = postProfile(material).w / 2;
  const brC      = BRACKET_CLEARANCE[material] ?? 19.5;
  const postReach = 2 * hw + brC;

  let thX, thY, dirX, dirY;
  if (slideEnd === 'A') { thX = hA.x; thY = hA.y; dirX =  sdx; dirY =  sdy; }
  else                  { thX = hB.x; thY = hB.y; dirX = -sdx; dirY = -sdy; }

  const trackExtend = Math.max(0, kp.trackExtendMm ?? 0);
  const gateExtend  = Math.max(0, kp.gateExtendMm  ?? 0);
  const trackLen = 2 * len + 200 + trackExtend;
  // Leaf covers at minimum the post centres (c-c), matching render.js drawSlidingDoor.
  const pA = postMap[o.postA], pB = postMap[o.postB];
  const c2c   = (pA && pB) ? Math.hypot(pB.x - pA.x, pB.y - pA.y) : len;
  const doorW = c2c + gateExtend;
  const tsX = thX - dirX * postReach, tsY = thY - dirY * postReach;
  const tfX = tsX + dirX * trackLen,  tfY = tsY + dirY * trackLen;

  const trackDepth = 40, trackGap = 10;
  const tNear = hw + trackGap, tFar = tNear + trackDepth;
  const tNX = tnx * tNear, tNY = tny * tNear;
  const tFX = tnx * tFar,  tFY = tny * tFar;
  eLine(tsX + tNX, tsY + tNY, tfX + tNX, tfY + tNY, 'GATES');
  eLine(tsX + tFX, tsY + tFY, tfX + tFX, tfY + tFY, 'GATES');
  eLine(tsX + tNX, tsY + tNY, tsX + tFX, tsY + tFY, 'GATES');
  eLine(tfX + tNX, tfY + tNY, tfX + tFX, tfY + tFY, 'GATES');

  const tCenX = tnx * (tNear + trackDepth / 2), tCenY = tny * (tNear + trackDepth / 2);
  const pBX = tsX + tCenX + dirX * (trackLen - shsH),         pBY = tsY + tCenY + dirY * (trackLen - shsH);
  const pAX = tsX + tCenX + dirX * (trackLen - doorW + shsH), pAY = tsY + tCenY + dirY * (trackLen - doorW + shsH);
  const paoX = pAX - dirX * shsH, paoY = pAY - dirY * shsH;
  const pboX = pBX + dirX * shsH, pboY = pBY + dirY * shsH;
  eLine(paoX + nx * railHalf, paoY + ny * railHalf, pboX + nx * railHalf, pboY + ny * railHalf, 'GATES');
  eLine(paoX - nx * railHalf, paoY - ny * railHalf, pboX - nx * railHalf, pboY - ny * railHalf, 'GATES');
  eLine(paoX + nx * railHalf, paoY + ny * railHalf, paoX - nx * railHalf, paoY - ny * railHalf, 'GATES');
  eLine(pboX + nx * railHalf, pboY + ny * railHalf, pboX - nx * railHalf, pboY - ny * railHalf, 'GATES');
}

// ── Cantilever gate plan footprint — beam + roller carriages + catcher + endstop + leaf ──
function eCantileverGate(o, hA, hB, dx, dy, len, nx, ny, postMap, eLine, FOOTPLATE) {
  const sdx = dx / len, sdy = dy / len;
  const kp         = o.kindProps ?? {};
  const retractEnd = kp.retractEnd ?? 'A';
  const tSide      = kp.trackSide === 'right' ? -1 : 1;
  const tnx = nx * tSide, tny = ny * tSide;
  const railHalf = PANEL_FRAME_SHS.w / 2;

  const rollerSpc  = Math.max(100, kp.rollerSpacingMm ?? 500);
  const tailOver   = Math.max(0, kp.tailOverhangMm ?? 150);
  const catcherOff = kp.catcherOffsetMm ?? 0;
  const carHalf    = 70;

  let hHome, hClose, dirX, dirY;
  if (retractEnd === 'A') { hHome = hA; hClose = hB; dirX = -sdx; dirY = -sdy; }
  else                    { hHome = hB; hClose = hA; dirX =  sdx; dirY =  sdy; }

  const homePost = postMap[retractEnd === 'A' ? o.postA : o.postB];
  const material = homePost?.material ?? 'aluminium';
  const hw = postProfile(material).w / 2;
  const fp = FOOTPLATE[homePost?.footplate] ?? { w: 180, h: 180 };
  const fpHalf = Math.max(fp.w, fp.h) / 2;
  const pc = { x: homePost?.x ?? hHome.x, y: homePost?.y ?? hHome.y };

  const closePost = postMap[retractEnd === 'A' ? o.postB : o.postA];
  const hwC  = postProfile(closePost?.material ?? 'aluminium').w / 2;
  const cCen = closePost ? { x: closePost.x, y: closePost.y } : hClose;
  const noseEnd = { x: cCen.x - dirX * hwC, y: cCen.y - dirY * hwC };

  const frontOff = Math.max(0, kp.frontWheelOffsetMm ?? (fpHalf + 50 + carHalf));
  const w1s      = frontOff;
  const w2s      = w1s + rollerSpc;
  const tailS    = w2s + tailOver;
  const endstopS = tailS + len;

  const beamGap = 10, beamDepth = 50;
  const beamNear = hw + beamGap, beamFar = beamNear + beamDepth;
  const beamCen  = (beamNear + beamFar) / 2;
  const ox = (p, perp) => p.x + tnx * perp;
  const oy = (p, perp) => p.y + tny * perp;
  const along = (s) => ({ x: pc.x + dirX * s, y: pc.y + dirY * s });
  const tail = along(tailS), endstop = along(endstopS);

  eLine(ox(noseEnd, beamNear), oy(noseEnd, beamNear), ox(tail, beamNear), oy(tail, beamNear), 'GATES');
  eLine(ox(noseEnd, beamFar),  oy(noseEnd, beamFar),  ox(tail, beamFar),  oy(tail, beamFar),  'GATES');
  eLine(ox(noseEnd, beamNear), oy(noseEnd, beamNear), ox(noseEnd, beamFar), oy(noseEnd, beamFar), 'GATES');
  eLine(ox(tail, beamNear),   oy(tail, beamNear),   ox(tail, beamFar),   oy(tail, beamFar),   'GATES');

  const nO = beamNear - 20, fO = beamFar + 20;
  for (const s of [w1s, w2s]) {
    const c  = along(s);
    const p1 = { x: c.x + dirX * carHalf, y: c.y + dirY * carHalf };
    const p2 = { x: c.x - dirX * carHalf, y: c.y - dirY * carHalf };
    eLine(ox(p1, nO), oy(p1, nO), ox(p2, nO), oy(p2, nO), 'GATES');
    eLine(ox(p2, nO), oy(p2, nO), ox(p2, fO), oy(p2, fO), 'GATES');
    eLine(ox(p2, fO), oy(p2, fO), ox(p1, fO), oy(p1, fO), 'GATES');
    eLine(ox(p1, fO), oy(p1, fO), ox(p1, nO), oy(p1, nO), 'GATES');
  }

  {
    const epx = endstop.x + tnx * beamCen, epy = endstop.y + tny * beamCen;
    const rr = (cx, cy, ha, hp, layer) => {
      eLine(cx + dirX * ha + nx * hp, cy + dirY * ha + ny * hp, cx - dirX * ha + nx * hp, cy - dirY * ha + ny * hp, layer);
      eLine(cx - dirX * ha + nx * hp, cy - dirY * ha + ny * hp, cx - dirX * ha - nx * hp, cy - dirY * ha - ny * hp, layer);
      eLine(cx - dirX * ha - nx * hp, cy - dirY * ha - ny * hp, cx + dirX * ha - nx * hp, cy + dirY * ha - ny * hp, layer);
      eLine(cx + dirX * ha - nx * hp, cy + dirY * ha - ny * hp, cx + dirX * ha + nx * hp, cy + dirY * ha + ny * hp, layer);
    };
    rr(epx, epy, 90, 90, 'POSTS');
    rr(epx, epy, 37.5, 37.5, 'POSTS');
  }

  {
    const armLen = 55;
    const cpt = (a, perp) => ({
      x: noseEnd.x + dirX * (catcherOff + a) + tnx * perp,
      y: noseEnd.y + dirY * (catcherOff + a) + tny * perp,
    });
    const S1 = cpt(0, beamNear - 6), S2 = cpt(0, beamFar + 6);
    const A1 = cpt(armLen, beamNear - 6), A2 = cpt(armLen, beamFar + 6);
    eLine(A1.x, A1.y, S1.x, S1.y, 'GATES');
    eLine(S1.x, S1.y, S2.x, S2.y, 'GATES');
    eLine(S2.x, S2.y, A2.x, A2.y, 'GATES');
  }

  eLine(ox(noseEnd, beamCen - railHalf), oy(noseEnd, beamCen - railHalf), ox(tail, beamCen - railHalf), oy(tail, beamCen - railHalf), 'GATES');
  eLine(ox(noseEnd, beamCen + railHalf), oy(noseEnd, beamCen + railHalf), ox(tail, beamCen + railHalf), oy(tail, beamCen + railHalf), 'GATES');
}

// Footplate bolt-hole positions (local, mirrors render.js footplateHoles)
function footplateHoles(kind, fp) {
  const ox = fp.offsetX ?? 0, oy = fp.offsetY ?? 0;
  const hw = fp.w / 2, hh = fp.h / 2, i = HOLE_INSET;
  const nx = ox - hw + i, px = ox + hw - i, ny = oy - hh + i, py = oy + hh - i;
  if (kind === 'FPM4' || kind === 'FPZ') return [[nx, ny], [px, ny], [nx, py], [px, py]];
  if (kind === 'FPC')  return [[px, ny], [nx, ny], [px, py]];
  if (kind === 'FPO')  return [[nx, ny], [px, ny], [nx, py], [px, py]];
  if (kind === 'FPM2') return [[ox, ny], [ox, py]];
  return [];
}
