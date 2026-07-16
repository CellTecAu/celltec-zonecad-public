// ZoneCAD rendering pipeline — single canvas, immediate-mode

import { layoutMm, postProfile, FOOTPLATE, HOLE_INSET, HOLE_DIA, PANEL_FRAME_SHS, BRACKET_CLEARANCE, modelToCanvas, fmtLen, dimLineOffset, angleLabelAnchor, buildPostMap, normDeg, tieEdgePoint, isBollard, BOLLARD } from './model.js';
import { rotHandlePos } from './hit.js';
import { spanHinges, postPivotPoints, doorHingePositions, ghostPostCenters, dimensionSegments, autoFaceKey, panelConfig, slidingLeafLine, SLIDING_DIM_OFFSET } from './spans.js';
import { getActiveTool } from './interaction.js';
import { constraintBroken, panelDimHinges } from './constraints.js';

const THEME_DARK = {
  background:    '#141414',
  layoutFill:    '#0a0a0a',
  layoutBorder:  '#cc3333',
  gridMajor:     'rgba(255,255,255,0.09)',
  gridMinor:     'rgba(255,255,255,0.04)',
  postAlu:       '#ffc000',
  postSteel:     '#7db86a',
  postOutline:   '#ffc000',
  footplate:     '#ffc000',
  footplateHole: '#ffc000',
  spanPanel:     '#d8d8d8',
  spanGap:       '#555',
  meshTick:      '#b0b0b0',
  selection:     '#f0a500',
  handle:        '#f0a500',
  handleFill:    '#141414',
  pivot:         '#6080b0',
  pivotSnap:     '#f0a500',
  marquee:       'rgba(240,165,0,0.12)',
  marqueeBorder: 'rgba(240,165,0,0.7)',
  pb:            '#666',
  pbPin:         '#444',
  zoneFill:      'rgba(74,144,217,0.12)',
  zoneBorder:    '#4a90d9',
  zoneDragFill:  'rgba(74,144,217,0.06)',
};

const THEME_LIGHT = {
  background:    '#e9e8e4',
  layoutFill:    '#f7f6f2',
  layoutBorder:  '#cc3333',
  gridMajor:     'rgba(0,0,0,0.12)',
  gridMinor:     'rgba(0,0,0,0.05)',
  postAlu:       '#d4900a',
  postSteel:     '#5a8a40',
  postOutline:   '#1a1a1a',
  footplate:     '#c07800',
  footplateHole: '#c07800',
  spanPanel:     '#444',
  spanGap:       '#aaa',
  meshTick:      '#333',
  selection:     '#f0a500',
  handle:        '#f0a500',
  handleFill:    '#fff',
  pivot:         '#5070a0',
  pivotSnap:     '#f0a500',
  marquee:       'rgba(240,165,0,0.15)',
  marqueeBorder: 'rgba(240,165,0,0.8)',
  pb:            '#909090',
  pbPin:         '#b0b0b0',
  zoneFill:      'rgba(74,144,217,0.10)',
  zoneBorder:    '#4a90d9',
  zoneDragFill:  'rgba(74,144,217,0.06)',
};

let COLORS = THEME_DARK;

export function setTheme(darkMode) {
  COLORS = darkMode !== false ? THEME_DARK : THEME_LIGHT;
}

// ─── Constraint badge hit areas (updated each render, read by main.js) ───────

let _badgeHits = []; // { constraintId, postId, constraint, sx, sy, sr } — all in CSS px
let _showMesh  = true; // per-render mesh-layer flag (set from settings.layers.mesh)

export function getConstraintBadgeHits() { return _badgeHits; }

// ─── Dimension label hit areas (updated each render, read by interaction.js) ──
// Humans aim at the value text, not the thin dim line — every label pill drawn
// by cLabel with an owner registers its screen rect as a grab/edit target.

let _labelHits = []; // { kind:'dimc'|'refdim'|'dim'|'anglec'|'tiec', id, sx, sy, w, h } — CSS px, centre + size
export function getDimLabelHits() { return _labelHits; }

// Coarse pointers get larger label pills: easier to read AND a bigger hit target.
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// ─── Background image cache ───────────────────────────────────────────────────

const _bgCache = new Map(); // dataUrl → HTMLImageElement
let   _bgDirtyCallback = null;

export function setBgDirtyCallback(fn) { _bgDirtyCallback = fn; }

function drawBgImage(ctx, bg) {
  if (!bg?.dataUrl) return;
  let img = _bgCache.get(bg.dataUrl);
  if (!img) {
    img = new Image();
    _bgCache.set(bg.dataUrl, img); // register before loaded to prevent double-load
    img.onload = () => _bgDirtyCallback?.();
    img.src = bg.dataUrl;
    return; // will re-render on load
  }
  if (!img.complete || !img.naturalWidth) return;
  ctx.save();
  // bg.y = top edge in Y-up model space; translate there then flip Y so image is right-side-up
  ctx.translate(bg.x, bg.y);
  ctx.scale(bg.widthMm / img.naturalWidth, -bg.heightMm / img.naturalHeight);
  ctx.globalAlpha = bg.opacity ?? 0.45;
  ctx.drawImage(img, 0, 0);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─── View transform helpers ───────────────────────────────────────────────────

function applyViewTransform(ctx, view, layoutH, dpr) {
  const s = view.scale * dpr;
  ctx.setTransform(s, 0, 0, -s, view.panX * dpr, (view.panY + layoutH * view.scale) * dpr);
}

// ─── Main render entry ────────────────────────────────────────────────────────

/**
 * @param {object|null} marquee  {x0,y0,x1,y1} in model coords, or null
 * @param {object|null} overlay  drag-state overlay: { type:'endpoint', spanId, endpoint, postId, snapFaceKey }
 */
export function render(canvas, ctx, doc, dpr = 1, selection = new Set(), marquee = null, overlay = null, hoveredZoneId = null, hoveredPostId = null, hoveredConstraintId = null, constraintRefPostId = null, measureOverlay = null, snapIndicator = null) {
  const { view, layout, settings, objects } = doc;
  setTheme(settings.darkMode !== false);
  const { w: layoutW, h: layoutH } = layoutMm(layout);
  const W = canvas.width;
  const H = canvas.height;

  _badgeHits = []; // reset before each render
  _labelHits = [];

  // 1. Background
  ctx.resetTransform();
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, W, H);

  // 2. Apply Y-up model transform
  applyViewTransform(ctx, view, layoutH, dpr);

  // 3. Layout fill
  ctx.fillStyle = COLORS.layoutFill;
  ctx.fillRect(0, 0, layoutW, layoutH);

  // 3.5. Background image (below grid, above layout fill)
  const layers = settings.layers ?? {};
  _showMesh = layers.mesh !== false;
  if (doc.background && layers.background !== false) drawBgImage(ctx, doc.background);

  // 4. Grid — viewport-based (infinite)
  drawGrid(ctx, layoutW, layoutH, settings, view, W, H, dpr);

  // 5. Layout border — red
  ctx.strokeStyle = COLORS.layoutBorder;
  ctx.lineWidth = 2.5 / view.scale;
  ctx.strokeRect(0, 0, layoutW, layoutH);

  // 6a. Zones (below everything)
  if (layers.zones !== false) {
    for (const obj of objects) {
      if (obj.type === 'zone') drawZone(ctx, obj, view.scale, selection.has(obj.id), dpr, settings.displayUnit, obj.id === hoveredZoneId);
    }
  }

  // 6. Build post map and pivot-posts map
  const posts = buildPostMap(objects);
  const cfg   = panelConfig(settings); // panel-splitting config for ghost posts / breakdowns

  // Posts that should show their 4 pivot circles:
  //   - directly selected posts
  //   - posts connected to a selected span
  //   - the endpoint-drag target post (from overlay)
  // Value = snapFaceKey to highlight (or null = no highlight)
  const pivotPosts = new Map();
  for (const id of selection) {
    const obj = objects.find(o => o.id === id);
    if (!obj) continue;
    if (obj.type === 'post' && !isBollard(obj) && !pivotPosts.has(obj.id)) pivotPosts.set(obj.id, null);
    if (obj.type === 'span') {
      const isHinge = obj.spanKind === 'hingedDoor' || obj.spanKind === 'swingGate';
      if (!isHinge) {
        if (!pivotPosts.has(obj.postA)) pivotPosts.set(obj.postA, null);
        if (!pivotPosts.has(obj.postB)) pivotPosts.set(obj.postB, null);
      }
    }
  }
  if (overlay?.type === 'endpoint') {
    pivotPosts.set(overlay.postId, overlay.snapFaceKey ?? null);
  }

  // 7. Spans (under posts) — rails + SHS bars
  for (const obj of objects) {
    if (obj.type === 'span') drawSpan(ctx, obj, posts, view.scale, selection.has(obj.id), cfg);
  }

  // 8. Posts (constraint-ref post gets a red glow drawn before it)
  for (const obj of objects) {
    if (obj.type === 'post') {
      if (obj.id === constraintRefPostId) drawConstraintRefGlow(ctx, obj, view.scale);
      drawPost(ctx, obj, view.scale, selection.has(obj.id));
    }
  }

  // 8.1. Post labels (optional — matches DXF label output)
  if (settings.showPostLabels) {
    for (const obj of objects) {
      if (obj.type === 'post') drawPostLabel(ctx, obj, view.scale);
    }
  }

  // 8.3. Alignment guides + live dimensions while dragging (model space)
  if (overlay?.type === 'guides') drawAlignGuides(ctx, overlay, view.scale, settings.displayUnit);

  // 8.5. Panel brackets at span-post connections (aluminium posts only)
  for (const obj of objects) {
    if (obj.type !== 'span') continue;
    if (obj.spanKind === 'hingedDoor' || obj.spanKind === 'swingGate' || obj.spanKind === 'slidingDoor' || obj.spanKind === 'cantileverGate') continue;
    const pA = posts[obj.postA], pB = posts[obj.postB];
    if (pA) drawPanelBracket(ctx, pA, obj.faceA ?? autoFaceKey(pA, pB ?? pA), 1 / view.scale);
    if (pB) drawPanelBracket(ctx, pB, obj.faceB ?? autoFaceKey(pB, pA ?? pB), 1 / view.scale);
  }

  // 8.6. Hinge brackets at door/gate span-post connections (aluminium posts only)
  for (const obj of objects) {
    if (obj.type !== 'span') continue;
    if (obj.spanKind !== 'hingedDoor' && obj.spanKind !== 'swingGate') continue;
    const pA = posts[obj.postA], pB = posts[obj.postB];
    const kp = obj.kindProps ?? {};
    const hp = kp.hingePos ?? ((kp.hingeEnd ?? 'A') + ((kp.swingSide ?? 'left') === 'left' ? 'l' : 'r'));
    if (pA) drawHingeBracket(ctx, pA, obj.faceA ?? autoFaceKey(pA, pB ?? pA), 1 / view.scale, hp, 'A');
    if (pB) drawHingeBracket(ctx, pB, obj.faceB ?? autoFaceKey(pB, pA ?? pB), 1 / view.scale, hp, 'B');
  }

  // The 'move' tool hides all edit sub-handles so the canvas is clean for repositioning.
  const moveMode = getActiveTool() === 'move';

  // 9. Pivot circles (on top of posts)
  if (!moveMode) for (const [postId, snapFaceKey] of pivotPosts) {
    const post = posts[postId];
    if (post) drawPostPivots(ctx, post, view.scale, snapFaceKey);
  }

  // 9.5. Door hinge position markers for selected hinged-door spans
  if (!moveMode) for (const id of selection) {
    const obj = objects.find(o => o.id === id);
    if (obj && (obj.spanKind === 'hingedDoor' || obj.spanKind === 'swingGate')) {
      drawDoorHingeMarkers(ctx, obj, posts, view.scale);
    }
  }

  // 10. Span endpoint handles — only when selected or actively dragging (hidden in move mode)
  if (!moveMode) for (const obj of objects) {
    if (obj.type === 'span') {
      const isHinge = obj.spanKind === 'hingedDoor' || obj.spanKind === 'swingGate';
      if (isHinge) continue;
      const dragSide = (overlay?.type === 'endpoint' && overlay.spanId === obj.id)
        ? overlay.endpoint : null;
      if (!selection.has(obj.id) && dragSide === null) continue;
      drawSpanEndpointHandles(ctx, obj, posts, view.scale, selection.has(obj.id), dragSide);
    }
  }

  // 11. Accessories
  for (const obj of objects) {
    if (obj.type === 'accessory') drawAccessory(ctx, obj, posts, view.scale, selection.has(obj.id));
  }

  // 11.5. Labels (free-floating text annotations)
  for (const obj of objects) {
    if (obj.type === 'label') drawLabel(ctx, obj, view.scale, selection.has(obj.id));
  }

  // 11.6. Dimension annotations (persistent measured lines)
  for (const obj of objects) {
    if (obj.type === 'dim') drawDimAnnotation(ctx, obj, view.scale, dpr, settings.displayUnit, selection.has(obj.id));
  }

  // 11.7. Reference (driven) dimensions between posts — live value, dark red
  if (layers.constraints !== false) for (const obj of objects) {
    if (obj.type === 'refdim') drawRefDimension(ctx, obj, posts, view.scale, dpr, settings.displayUnit, selection.has(obj.id));
  }

  // 11.8. Panel dimensions (Settings → "Dimension all panels") — one per PHYSICAL panel
  // (ghost sub-panels included) and per hinged-door/swing-gate opening. Derived
  // annotations: not selectable/editable (owner = null).
  if (settings.dimensionPanels) {
    // Every physical panel gets its violet dim. Sole exception: a SINGLE-bay span whose pair
    // carries a panel-width constraint — that constraint renders as the same violet panel dim
    // (with an editable border), so the auto pill would be an exact duplicate.
    const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const panelDimPairs = new Set();
    for (const c of (doc.constraints ?? []))
      if (c.kind === 'panelDim') panelDimPairs.add(pairKey(c.parent, c.child));

    for (const obj of objects) {
      if (obj.type !== 'span') continue;
      const segs = dimensionSegments(obj, posts, cfg);
      if (segs.length === 1 && panelDimPairs.has(pairKey(obj.postA, obj.postB))) continue;
      // Flip the panel dimensions to whichever side of the run is clearer — away from any
      // constraint (dimension / panelDim) or reference dimension on the same posts.
      const side = panelDimSide(obj, posts, doc, view.scale);
      for (const seg of segs) {
        drawDimBetween(ctx, seg.ax, seg.ay, seg.bx, seg.by, side * seg.offset,
          fmtLen(seg.runMm, settings.displayUnit), C_PANELDIM, view.scale, dpr, null, null, C_PANELDIM_BG);
      }
    }
  }

  // 12. Selection handles (rotation handle on single selected post; hidden in move mode)
  if (!moveMode && selection.size === 1) {
    const selId  = [...selection][0];
    const selObj = objects.find(o => o.id === selId);
    if (selObj?.type === 'post' && !isBollard(selObj)) drawRotationHandle(ctx, selObj, view.scale);
  }

  // 13. Constraint overlays (model space, before reset)
  if (doc.constraints?.length && layers.constraints !== false) drawConstraints(ctx, doc, dpr);

  // 13.5. Hinge drag overlay (model space)
  if (overlay?.type === 'hinge') drawHingeDragOverlay(ctx, overlay, view.scale);

  // 13.7. Measure overlay (model space — drawn before reset so it scales with view)
  if (measureOverlay) drawMeasureOverlay(ctx, measureOverlay, view.scale, dpr, settings.displayUnit);

  // 13.9. Object snap indicator (model space — yellow geometry marker)
  if (snapIndicator) drawSnapIndicator(ctx, snapIndicator, view.scale);

  // 13.95. Trace tool ghost (model space — scales with view)
  if (overlay?.type === 'trace') drawTraceGhost(ctx, overlay, view.scale);

  // 14. Reset and draw screen-space overlays
  ctx.resetTransform();

  // 14.5. Constraint badge ring (screen-space fixed-px ring — no zoom collision)
  if (layers.constraints !== false) drawConstraintRing(ctx, doc, selection, hoveredPostId, hoveredConstraintId, dpr);

  // 15. Marquee rectangle (screen-space)
  if (marquee) drawMarquee(ctx, marquee, view, layoutH, dpr);

  // 16. Zone drag ghost (screen-space)
  if (overlay?.type === 'zone')        drawZoneDragGhost(ctx, overlay, view, layoutH, dpr);
  if (overlay?.type === 'zone-circle') drawCircleZoneDragGhost(ctx, overlay, view, layoutH, dpr);
}

// ─── Trace tool ghost preview ──────────────────────────────────────────────────

function drawTraceGhost(ctx, overlay, scale) {
  const px = 1 / scale;
  const { committed = [], liveRaw = null, livePreview = null } = overlay;

  // Faint raw freehand of the stroke being drawn
  if (liveRaw && liveRaw.length > 1) {
    ctx.strokeStyle = 'rgba(244,161,0,0.35)';
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.moveTo(liveRaw[0].x, liveRaw[0].y);
    for (let i = 1; i < liveRaw.length; i++) ctx.lineTo(liveRaw[i].x, liveRaw[i].y);
    ctx.stroke();
  }

  // Straightened preview of committed strokes + the live one
  const chains = committed.concat(livePreview ? [livePreview] : []);
  const half = 43; // 86 mm post footprint
  for (const chain of chains) {
    const V = chain.vertices;
    if (!V || V.length < 2) continue;
    ctx.strokeStyle = 'rgba(255,192,0,0.9)';
    ctx.lineWidth = 1.6 * px;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(V[0].x, V[0].y);
    for (let i = 1; i < V.length; i++) ctx.lineTo(V[i].x, V[i].y);
    if (chain.closed) ctx.closePath();
    ctx.stroke();
    // Ghost post squares at each corner
    ctx.strokeStyle = 'rgba(255,192,0,0.95)';
    ctx.fillStyle   = 'rgba(255,192,0,0.16)';
    ctx.lineWidth   = 1.2 * px;
    for (const v of V) {
      ctx.beginPath();
      ctx.rect(v.x - half, v.y - half, half * 2, half * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

// ─── Grid ─────────────────────────────────────────────────────────────────────

function drawGrid(ctx, layoutW, layoutH, settings, view, canvasW, canvasH, dpr) {
  const scale = view.scale;
  const px    = 1 / scale;
  const major = 1000;

  // Compute model-space bounds of the current viewport (inverted view transform)
  const cssW = canvasW / dpr, cssH = canvasH / dpr;
  const minMx = -view.panX / scale;
  const maxMx = (cssW - view.panX) / scale;
  const minMy = (view.panY + layoutH * scale - cssH) / scale;
  const maxMy = view.panY / scale + layoutH;

  // Snap to grid multiples, add one step of margin so lines don't pop in at edge
  const x0 = Math.floor(minMx / major) * major - major;
  const x1 = Math.ceil (maxMx / major) * major + major;
  const y0 = Math.floor(minMy / major) * major - major;
  const y1 = Math.ceil (maxMy / major) * major + major;

  // Major grid — spans the full visible viewport
  ctx.strokeStyle = COLORS.gridMajor;
  ctx.lineWidth = px;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += major) {
    ctx.moveTo(x, y0); ctx.lineTo(x, y1);
  }
  for (let y = y0; y <= y1; y += major) {
    ctx.moveTo(x0, y); ctx.lineTo(x1, y);
  }
  ctx.stroke();

  // Minor grid — layout bounds only (dense lines don't need to extend)
  if (settings.snapEnabled && settings.snapMm > 0 && settings.snapMm < major) {
    ctx.strokeStyle = COLORS.gridMinor;
    ctx.lineWidth = px;
    ctx.beginPath();
    for (let x = settings.snapMm; x < layoutW; x += settings.snapMm) {
      if (x % major === 0) continue;
      ctx.moveTo(x, 0); ctx.lineTo(x, layoutH);
    }
    for (let y = settings.snapMm; y < layoutH; y += settings.snapMm) {
      if (y % major === 0) continue;
      ctx.moveTo(0, y); ctx.lineTo(layoutW, y);
    }
    ctx.stroke();
  }
}

// ─── Post ─────────────────────────────────────────────────────────────────────

// Draw the 86×86 aluminium SHS extrusion cross-section at the post origin.
// Geometry derived from samples.dxf ALUMINIUM_POST layer (PSTM4 block).
// Called with ctx already translated to post centre and rotated.
function drawAluminiumSHS(ctx, px) {
  // Key dimensions (mm, from post.dxf ALUMINIUM_POST layer)
  const F   = 43;    // outer half-width (86×86)
  const CR  = 2;     // outer corner radius
  const SO  = 29;    // T-slot face opening half-width
  const SB  = 29.5;  // T-slot neck back wall x
  const SN  = 17;    // T-slot neck half-width
  const LE  = 38.5;  // shoulder outer edge x
  const LS  = 33.5;  // shoulder inner edge x
  const LI  = 32.5;  // ledge inner wall x
  const LY  = 30;    // shoulder y (slightly wider than face opening)
  const LW  = 18;    // ledge to lip transition y
  const LX  = 30;    // lip x
  const LIP = 17.5;  // lip y
  const EI  = 41;    // entrance inner x (r=2 fillet terminus, from ARC centre=(41,29))
  const EY  = 27;    // entrance inner y (from LINE (39.5,27)→(41,27))
  const LP  = 39;    // face lip outer wall x (from LINE (39,27.5)→(39,29.5))
  const LPY = 29.5;  // face lip outer wall y (top of entrance step)
  const HW  = 28;    // hollow half-width (inner tube wall, from DXF x=±28 lines)
  const HN  = 24.4;  // hollow octagon corner chamfer vertex (from DXF x=28,y=±24.4)
  const MH  = 36;    // M8 hole pitch (±36, ±36 from post centre)
  const MR  = 3.4;   // M8 hole radius (Ø6.8mm tapping size)

  // Pre-fill outer square with layout colour so voids show the background
  ctx.fillStyle = COLORS.layoutFill;
  ctx.beginPath();
  ctx.roundRect(-F, -F, F * 2, F * 2, CR);
  ctx.fill();

  // Aluminium solid — evenodd: outer square minus 4 T-slot channels minus central hollow
  ctx.fillStyle = COLORS.postAlu;
  ctx.beginPath();
  ctx.roundRect(-F, -F, F * 2, F * 2, CR);

  // 4 T-slot channel voids — one per face, rotated 90° each
  for (let q = 0; q < 4; q++) {
    const a = q * Math.PI / 2;
    const c = Math.cos(a), s = Math.sin(a);
    const r = (x, y) => [x * c - y * s, x * s + y * c];
    ctx.moveTo(...r(F,   -SO));
    ctx.lineTo(...r(F,    SO));
    // entrance lip — top half: r=2 fillet then step notch then shoulder
    ctx.lineTo(...r(EI,   EY));   // inner entrance corner (r=2 fillet approx)
    ctx.lineTo(...r(LP,   EY));   // lip step bottom edge
    ctx.lineTo(...r(LP,  LPY));   // lip outer wall (step going outward)
    ctx.lineTo(...r(LE,   LY));   // shoulder outer edge
    ctx.lineTo(...r(LS,   LY));
    ctx.lineTo(...r(LI,   SO));
    ctx.lineTo(...r(LI,   LW));
    ctx.lineTo(...r(LX,  LIP));
    ctx.lineTo(...r(SB,   SN));
    ctx.lineTo(...r(SB,  -SN));
    ctx.lineTo(...r(LX, -LIP));
    ctx.lineTo(...r(LI,  -LW));
    ctx.lineTo(...r(LI,  -SO));
    ctx.lineTo(...r(LS,  -LY));
    ctx.lineTo(...r(LE,  -LY));
    // entrance lip — bottom half (mirror)
    ctx.lineTo(...r(LP, -LPY));
    ctx.lineTo(...r(LP,  -EY));
    ctx.lineTo(...r(EI,  -EY));
    ctx.closePath();
  }

  // Central hollow bore — octagon derived from DXF inner wall lines (x=±28, y=±28)
  // with chamfered corners at (±24.4, ±28) and (±28, ±24.4).
  ctx.moveTo( HW, -HN);
  ctx.lineTo( HW,  HN);
  ctx.lineTo( HN,  HW);
  ctx.lineTo(-HN,  HW);
  ctx.lineTo(-HW,  HN);
  ctx.lineTo(-HW, -HN);
  ctx.lineTo(-HN, -HW);
  ctx.lineTo( HN, -HW);
  ctx.closePath();

  ctx.fill('evenodd');

  // 4× Ø6.8mm M8 tapping holes at (±36, ±36) — footplate locating bolt holes
  ctx.fillStyle = COLORS.layoutFill;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(MH * sx, MH * sy, MR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawConstraintRefGlow(ctx, post, scale) {
  const px   = 1 / scale;
  const prof = postProfile(post.material);
  const fp   = FOOTPLATE[post.footplate] ?? { w: prof.w, h: prof.h };
  const ox   = fp.offsetX ?? 0, oy = fp.offsetY ?? 0;
  const hw   = prof.w / 2, hh = prof.h / 2;
  const pad  = 12 * px;
  const minX = Math.min(-hw, ox - fp.w / 2) - pad;
  const maxX = Math.max(+hw, ox + fp.w / 2) + pad;
  const minY = Math.min(-hh, oy - fp.h / 2) - pad;
  const maxY = Math.max(+hh, oy + fp.h / 2) + pad;
  ctx.save();
  ctx.translate(post.x, post.y);
  ctx.rotate(-post.footplateRotationDeg * Math.PI / 180);
  ctx.fillStyle   = 'rgba(220,60,60,0.30)';
  ctx.strokeStyle = 'rgba(220,60,60,0.85)';
  ctx.lineWidth   = 2 * px;
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  ctx.restore();
}

// Upright post id label, placed just above the post (screen-constant size).
function drawPostLabel(ctx, post, scale) {
  const px    = 1 / scale;
  const prof  = postProfile(post.material);
  const above = prof.h / 2 + 70; // mm above the post centre
  const label = post.id;
  ctx.save();
  ctx.translate(post.x, post.y + above);
  ctx.scale(1, -1); // cancel the model Y-flip so text reads upright
  ctx.font         = `600 ${12 * px}px Inter, system-ui, sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(18,24,42,0.78)';
  ctx.fillRect(-tw / 2 - 4 * px, -8 * px, tw + 8 * px, 16 * px);
  ctx.fillStyle = '#c8d0e0';
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

export function drawPost(ctx, post, scale, selected = false, tint = null) {
  if (isBollard(post)) { drawBollard(ctx, post, scale, selected); return; }
  const px   = 1 / scale;
  const prof = postProfile(post.material);
  const hw   = prof.w / 2;
  const hh   = prof.h / 2;
  // tint overrides every post colour (used for auto-generated "ghost" posts)
  const outline = tint ?? (selected ? COLORS.selection : COLORS.postOutline);

  ctx.save();
  ctx.translate(post.x, post.y);
  ctx.rotate(-post.footplateRotationDeg * Math.PI / 180);

  drawFootplate(ctx, post, px, tint);

  // Selection glow / halo
  if (selected) {
    ctx.fillStyle = 'rgba(240,165,0,0.18)';
    const fp  = FOOTPLATE[post.footplate] ?? { w: prof.w, h: prof.h };
    const ox  = fp.offsetX ?? 0, oy = fp.offsetY ?? 0;
    const pad = 10 * px;
    const minX = Math.min(-hw, ox - fp.w / 2) - pad;
    const maxX = Math.max(+hw, ox + fp.w / 2) + pad;
    const minY = Math.min(-hh, oy - fp.h / 2) - pad;
    const maxY = Math.max(+hh, oy + fp.h / 2) + pad;
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
  }

  // Post body
  if (post.material === 'aluminium') {
    ctx.strokeStyle = outline;
    ctx.lineWidth   = selected ? 2 * px : px;
    drawAluminiumSHS(ctx, px);
  } else {
    ctx.fillStyle   = tint ?? COLORS.postSteel;
    ctx.strokeStyle = outline;
    ctx.lineWidth   = selected ? 2 * px : px;
    ctx.fillRect(-hw, -hh, prof.w, prof.h);
    ctx.strokeRect(-hw, -hh, prof.w, prof.h);
  }

  // Centre datum cross
  const cs = 6 * px;
  ctx.strokeStyle = outline;
  ctx.lineWidth   = px;
  ctx.beginPath();
  ctx.moveTo(-cs, 0); ctx.lineTo(cs, 0);
  ctx.moveTo(0, -cs); ctx.lineTo(0, cs);
  ctx.stroke();

  ctx.restore();
}

/** Bollard: circular plate with bolt holes on the BOLLARD-spec PCD, 165×3.2 CHS post, welded cap. */
function drawBollard(ctx, post, scale, selected) {
  const px = 1 / scale;
  const plateR = BOLLARD.plateOd / 2;
  const postR  = BOLLARD.od / 2;
  const wallR  = postR - BOLLARD.wall;

  ctx.save();
  ctx.translate(post.x, post.y);
  ctx.rotate(-post.footplateRotationDeg * Math.PI / 180); // rotates the hole pattern

  // Selection glow
  if (selected) {
    ctx.fillStyle = 'rgba(240,165,0,0.18)';
    ctx.beginPath(); ctx.arc(0, 0, plateR + 10 * px, 0, Math.PI * 2); ctx.fill();
  }

  // Baseplate + bolt holes (holes at 45° offsets so the pattern reads like FPM4 corners)
  ctx.strokeStyle = selected ? COLORS.selection : COLORS.postOutline;
  ctx.lineWidth   = px;
  ctx.beginPath(); ctx.arc(0, 0, plateR, 0, Math.PI * 2); ctx.stroke();
  const holeR = BOLLARD.holeDia / 2, pcdR = BOLLARD.pcd / 2;
  for (let k = 0; k < BOLLARD.holes; k++) {
    const a = (Math.PI / 4) + k * (Math.PI / 2);
    ctx.beginPath(); ctx.arc(Math.cos(a) * pcdR, Math.sin(a) * pcdR, holeR, 0, Math.PI * 2); ctx.stroke();
  }

  // CHS post: filled outer circle + inner wall circle; light cap cross for the welded cap
  ctx.fillStyle   = COLORS.postSteel;
  ctx.strokeStyle = selected ? COLORS.selection : COLORS.postOutline;
  ctx.lineWidth   = selected ? 2 * px : px;
  ctx.beginPath(); ctx.arc(0, 0, postR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.lineWidth = px;
  ctx.beginPath(); ctx.arc(0, 0, wallR, 0, Math.PI * 2); ctx.stroke();
  const cx = wallR * Math.SQRT1_2;
  ctx.beginPath();
  ctx.moveTo(-cx, -cx); ctx.lineTo(cx, cx);
  ctx.moveTo(-cx, cx);  ctx.lineTo(cx, -cx);
  ctx.stroke();

  // Centre datum cross
  const cs = 6 * px;
  ctx.strokeStyle = COLORS.postOutline;
  ctx.beginPath();
  ctx.moveTo(-cs, 0); ctx.lineTo(cs, 0);
  ctx.moveTo(0, -cs); ctx.lineTo(0, cs);
  ctx.stroke();

  ctx.restore();
}

// PB geometry constants (normalised to face=0, outward=+x)
const PB_BW   = 23.5;  // body half-width at face
const PB_D    = 36;    // total depth from post face
const PB_CR   = 3;     // back corner radius
const PB_BW2  = 20.5;  // back half-width (before corner arc)
const PB_PX   = 19.5;  // pin centre depth (= BRACKET_CLEARANCE.aluminium)
const PB_PR   = 10.75; // pin collar outer radius
const PB_PR2  = 8.05;  // pin bore radius
const PB_FX1  = 7;     // inner frame start depth
const PB_FX2  = 32;    // inner frame end depth
const PB_FH   = 12.5;  // inner frame half-height

const PB_FACE_ROT = { px: 0, nx: Math.PI, py: Math.PI / 2, ny: -Math.PI / 2 };

function drawPanelBracket(ctx, post, faceKey, px) {
  if (post.material !== 'aluminium') return;
  const prof = postProfile(post.material);
  const hw = prof.w / 2, hh = prof.h / 2;
  const rad = post.footplateRotationDeg * Math.PI / 180;
  const [ftx, fty] = { px:[hw,0], nx:[-hw,0], py:[0,hh], ny:[0,-hh] }[faceKey] ?? [hw, 0];

  ctx.save();
  ctx.translate(post.x, post.y);
  ctx.rotate(-rad);
  ctx.translate(ftx, fty);
  ctx.rotate(PB_FACE_ROT[faceKey] ?? 0);

  // Body
  ctx.fillStyle = COLORS.pb;
  ctx.beginPath();
  ctx.moveTo(0, -PB_BW);
  ctx.lineTo(PB_D - PB_CR, -PB_BW);
  ctx.arc(PB_D - PB_CR, -PB_BW2, PB_CR, -Math.PI / 2, 0);
  ctx.lineTo(PB_D, PB_BW2);
  ctx.arc(PB_D - PB_CR, PB_BW2, PB_CR, 0, Math.PI / 2);
  ctx.lineTo(0, PB_BW);
  ctx.closePath();
  ctx.fill();

  // Inner frame cutout
  ctx.fillStyle = COLORS.layoutFill;
  ctx.beginPath();
  ctx.rect(PB_FX1, -PB_FH, PB_FX2 - PB_FX1, PB_FH * 2);
  ctx.fill();

  // Pin collar + bore
  ctx.fillStyle = COLORS.pbPin;
  ctx.beginPath();
  ctx.arc(PB_PX, 0, PB_PR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.layoutFill;
  ctx.beginPath();
  ctx.arc(PB_PX, 0, PB_PR2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// HB geometry constants (same face origin as PB — T-slot neck, outward=+x)
const HB_FW  = 29.5;  // face half-width (= post face span for 86mm SHS)
const HB_D   = 36;    // depth from post face (identical to PB)
const HB_CR  = 3;     // back corner radius
const HB_BW  = 42;    // flange outer half-width
const HB_BWC = 39;    // back half-width at corner arc start (= HB_BW - HB_CR)
const HB_SHW = 12.5;  // spine (central web) half-height
const HB_FLW = 17;    // flange inner half-height (gap edge from spine to flange)
const HB_FX  = 7;     // depth at which body widens from face-width to flange-width
const HB_PX  = 22;    // pin slot centre depth (midpoint of 19.5–24.5 from DXF)
const HB_PSL = 2.5;   // pin slot half-length (5mm elongated slot ÷ 2)
const HB_PR  = 7;     // pin slot end-cap radius (r=7 from DXF arc data)
const HB_POF = 29.5;  // outer pin position Y offset from bracket centreline

function drawHingeBracket(ctx, post, faceKey, px, hingePos, postChar) {
  if (post.material !== 'aluminium') return;
  const prof = postProfile(post.material);
  const hw = prof.w / 2, hh = prof.h / 2;
  const rad = post.footplateRotationDeg * Math.PI / 180;
  const [ftx, fty] = { px:[hw,0], nx:[-hw,0], py:[0,hh], ny:[0,-hh] }[faceKey] ?? [hw, 0];

  ctx.save();
  ctx.translate(post.x, post.y);
  ctx.rotate(-rad);
  ctx.translate(ftx, fty);
  ctx.rotate(PB_FACE_ROT[faceKey] ?? 0);

  // Outer body: face tabs → flange widening → back wall with r=3 corners
  ctx.fillStyle = COLORS.pb;
  ctx.beginPath();
  ctx.moveTo(0, -HB_FW);                                    // lower face edge
  ctx.lineTo(HB_FX, -HB_FW);                                // step to flange start
  ctx.lineTo(HB_FX, -HB_BW);                                // lower flange outer edge
  ctx.lineTo(HB_D - HB_CR, -HB_BW);                         // lower flange back
  ctx.arc(HB_D - HB_CR, -HB_BWC, HB_CR, -Math.PI / 2, 0);  // lower-back corner
  ctx.lineTo(HB_D, HB_BWC);                                  // back wall
  ctx.arc(HB_D - HB_CR, HB_BWC, HB_CR, 0, Math.PI / 2);    // upper-back corner
  ctx.lineTo(HB_FX, HB_BW);                                  // upper flange back
  ctx.lineTo(HB_FX, HB_FW);                                  // step to face width
  ctx.lineTo(0, HB_FW);                                      // upper face edge
  ctx.closePath();
  ctx.fill();

  // Open gaps between central spine and each flange (4.5mm clear area each side)
  ctx.fillStyle = COLORS.layoutFill;
  ctx.beginPath();
  ctx.rect(HB_FX, HB_SHW, HB_D - HB_FX, HB_FLW - HB_SHW);  // upper gap
  ctx.fill();
  ctx.beginPath();
  ctx.rect(HB_FX, -HB_FLW, HB_D - HB_FX, HB_FLW - HB_SHW); // lower gap
  ctx.fill();

  // 3 pin slots: lower outer (−29.5), centre (0, visual-only), upper outer (+29.5)
  // nx/ny faces rotate the local y-axis relative to the span perpendicular, so flip slot sign
  const flipSlot = faceKey === 'nx' || faceKey === 'ny';
  const activePinY = (hingePos && hingePos[0] === postChar)
    ? (hingePos[1] === 'l' ? HB_POF : -HB_POF) * (flipSlot ? -1 : 1)
    : null;

  for (const pyOff of [-HB_POF, 0, HB_POF]) {
    const isActive = pyOff !== 0 && pyOff === activePinY;
    ctx.fillStyle = isActive ? COLORS.pivotSnap : COLORS.pbPin;
    ctx.beginPath();
    ctx.roundRect(HB_PX - HB_PSL - HB_PR, pyOff - HB_PR, (HB_PSL + HB_PR) * 2, HB_PR * 2, HB_PR);
    ctx.fill();
    ctx.fillStyle = COLORS.layoutFill;
    ctx.beginPath();
    ctx.arc(HB_PX, pyOff, HB_PR - 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawFootplate(ctx, post, px, tint = null) {
  const fp = FOOTPLATE[post.footplate];
  if (!fp) return;
  const ox = fp.offsetX ?? 0, oy = fp.offsetY ?? 0;
  const stroke = tint ?? COLORS.footplate;

  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth   = px;
  ctx.beginPath();
  ctx.roundRect(-fp.w / 2 + ox, -fp.h / 2 + oy, fp.w, fp.h, 10);
  ctx.stroke();

  // Bolt holes
  ctx.fillStyle   = COLORS.layoutFill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth   = px;
  for (const [hx, hy] of footplateHoles(post.footplate, fp)) {
    ctx.beginPath();
    ctx.arc(hx, hy, (fp.holeDia ?? HOLE_DIA) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function footplateHoles(kind, fp) {
  const ox = fp.offsetX ?? 0, oy = fp.offsetY ?? 0;
  const hw = fp.w / 2, hh = fp.h / 2, i = HOLE_INSET;
  const nx = ox - hw + i, px = ox + hw - i; // left / right column x
  const ny = oy - hh + i, py = oy + hh - i; // bottom / top row y
  if (kind === 'FPM4' || kind === 'FPZ') return [[nx,ny],[px,ny],[nx,py],[px,py]]; // 4 corners
  if (kind === 'FPC')  return [[px,ny],[nx,ny],[px,py]]; // skip (nx,py) — nearest corner to post
  if (kind === 'FPO')  return [[nx,ny],[px,ny],[nx,py],[px,py]];
  if (kind === 'FPM2') return [[ox, oy - hh + i], [ox, oy + hh - i]]; // centreline of long edges
  return [];
}

// ─── Rotation handle (model-space, on selected post) ─────────────────────────

function drawRotationHandle(ctx, post, scale) {
  const px  = 1 / scale;
  const rh  = rotHandlePos(post);

  // Stem line: post centre → handle
  ctx.strokeStyle = COLORS.handle;
  ctx.lineWidth   = px;
  ctx.setLineDash([3 * px, 2 * px]);
  ctx.beginPath();
  ctx.moveTo(post.x, post.y);
  ctx.lineTo(rh.x, rh.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Handle dot — bigger on touch devices so the affordance matches the finger
  const r = (COARSE ? 10 : 6) * px;
  ctx.fillStyle   = COLORS.handleFill;
  ctx.strokeStyle = COLORS.handle;
  ctx.lineWidth   = 1.5 * px;
  ctx.beginPath();
  ctx.arc(rh.x, rh.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

// ─── Span ─────────────────────────────────────────────────────────────────────

export function drawSpan(ctx, span, posts, scale, selected = false, cfg = undefined) {
  const hinges = spanHinges(span, posts);
  if (!hinges) return;

  const { hA, hB } = hinges;
  const px    = 1 / scale;
  const isGap = span.spanKind === 'gap';
  const col   = selected ? COLORS.selection : COLORS.spanPanel;

  if (isGap) {
    ctx.strokeStyle = col;
    ctx.lineWidth   = 2 * px;
    ctx.setLineDash([8 * px, 5 * px]);
    ctx.beginPath();
    ctx.moveTo(hA.x, hA.y);
    ctx.lineTo(hB.x, hB.y);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  // ── Panel / door / gate — draw as double-line frame ──────────────────────
  const dx  = hB.x - hA.x, dy = hB.y - hA.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const nx = -dy / len, ny = dx / len; // normal, left of A→B (= mesh side A direction)
  const sdx = dx / len, sdy = dy / len; // unit span direction

  const isDoor = span.spanKind === 'hingedDoor' || span.spanKind === 'swingGate';

  if (isDoor) {
    drawDoorLeaf(ctx, span, posts, hA, hB, scale, col, selected);
    return;
  }

  if (span.spanKind === 'slidingDoor') {
    drawSlidingDoor(ctx, span, posts, hA, hB, scale, col, selected);
    return;
  }

  if (span.spanKind === 'cantileverGate') {
    drawCantileverGate(ctx, span, posts, hA, hB, scale, col, selected);
    return;
  }

  // Panel is 25 mm wide: rails sit at ±12.5 mm from centreline.
  // Minimum 1.5 screen pixels so it stays visible at small scales.
  const railHalf = Math.max(PANEL_FRAME_SHS.w / 2, 1.5 / scale); // 12.5 mm
  const offX = nx * railHalf, offY = ny * railHalf;
  const shsH = railHalf; // SHS is square (25×25); half-depth along span = 12.5 mm

  // Rails extend 12.5 mm past each pin (to the outer face of the SHS end-bar).
  // 900 mm post spacing → 775 mm pin-to-pin → 800 mm panel overall.
  const aoX = hA.x - sdx * shsH, aoY = hA.y - sdy * shsH; // outer face at A
  const boX = hB.x + sdx * shsH, boY = hB.y + sdy * shsH; // outer face at B

  // Selection fill — amber band behind the panel so it reads clearly when zoomed out
  if (selected) {
    ctx.fillStyle = 'rgba(240,165,0,0.28)';
    ctx.beginPath();
    ctx.moveTo(aoX + offX, aoY + offY);
    ctx.lineTo(boX + offX, boY + offY);
    ctx.lineTo(boX - offX, boY - offY);
    ctx.lineTo(aoX - offX, aoY - offY);
    ctx.closePath();
    ctx.fill();
  }

  ctx.strokeStyle = col;
  ctx.lineWidth   = selected ? 2 * px : px;
  ctx.beginPath();
  // Rails run full panel width (outer SHS face to outer SHS face)
  ctx.moveTo(aoX + offX, aoY + offY); ctx.lineTo(boX + offX, boY + offY);
  ctx.moveTo(aoX - offX, aoY - offY); ctx.lineTo(boX - offX, boY - offY);
  // End caps at outer SHS faces
  ctx.moveTo(aoX + offX, aoY + offY); ctx.lineTo(aoX - offX, aoY - offY);
  ctx.moveTo(boX + offX, boY + offY); ctx.lineTo(boX - offX, boY - offY);
  ctx.stroke();

  // SHS end-bar fill — 25×25 mm square centred on pin
  ctx.fillStyle = selected ? 'rgba(240,165,0,0.18)' : 'rgba(80,80,80,0.30)';
  function drawSHSBar(hx, hy) {
    ctx.beginPath();
    ctx.moveTo(hx + offX + sdx * shsH, hy + offY + sdy * shsH);
    ctx.lineTo(hx - offX + sdx * shsH, hy - offY + sdy * shsH);
    ctx.lineTo(hx - offX - sdx * shsH, hy - offY - sdy * shsH);
    ctx.lineTo(hx + offX - sdx * shsH, hy + offY - sdy * shsH);
    ctx.closePath();
    ctx.fill();
  }
  drawSHSBar(hA.x, hA.y);
  drawSHSBar(hB.x, hB.y);

  // Mesh-side tick marks (between pin centres)
  drawMeshTicks(ctx, span, hA.x, hA.y, hB.x, hB.y, len, nx, ny, px, railHalf);

  // Mid-post ghost(s) — sit ON the pin line, each perpendicular to the run (rotDeg),
  // so panels connect bracket-to-bracket. Mesh ticks are NOT segmented — the whole
  // span is treated as one panel for mesh direction.
  const ghostCenters = ghostPostCenters(span, posts, cfg);
  if (ghostCenters.length) {
    // SHS end-bars at each ghost post connection point (teal to match ghost posts)
    ctx.fillStyle = selected ? 'rgba(240,165,0,0.18)' : 'rgba(31,208,200,0.30)';
    for (const g of ghostCenters) drawSHSBar(g.x, g.y);

    // Ghost posts — full post design in distinct teal (GHOST_TINT) so auto-inserted
    // mid-run posts read as "suggested", never confused with amber real posts. Each is
    // perpendicular to the run (g.rotDeg); its px/nx faces carry the two adjacent panels.
    const refPost = posts[span.postA] ?? posts[span.postB];
    for (const g of ghostCenters) {
      const ghost = {
        x: g.x, y: g.y,
        material:             refPost?.material  ?? 'aluminium',
        footplate:            refPost?.footplate ?? 'FPM4',
        footplateRotationDeg: g.rotDeg ?? 0,
      };
      ctx.save();
      ctx.globalAlpha = 0.85;
      // Full panel-bracket glyph on each run-facing face (as-built joint detail).
      drawPanelBracket(ctx, ghost, 'px', px);
      drawPanelBracket(ctx, ghost, 'nx', px);
      drawPost(ctx, ghost, scale, false, GHOST_TINT);
      ctx.restore();
    }
  }
}

function drawMeshTicks(ctx, span, ax, ay, bx, by, len, nx, ny, px, railMm) {
  if (!_showMesh) return;
  const side = span.meshSide === 'A' ? 1 : -1;
  // Tick starts at the mesh-side rail and protrudes a small fixed amount beyond it.
  // Math.min(8, 4*px): never more than 8mm and never more than 4 screen pixels.
  const protrusion = Math.min(8, 4 * px);
  const tSpc = Math.max(200, len / 8); // ≤8 ticks on any span
  const cnt  = Math.max(1, Math.floor(len / tSpc));

  ctx.strokeStyle = COLORS.meshTick;
  ctx.lineWidth   = px;
  ctx.beginPath();
  for (let i = 1; i <= cnt; i++) {
    const t  = i / (cnt + 1);
    const mx = ax + (bx - ax) * t, my = ay + (by - ay) * t;
    // Start at the outer rail, extend protrusion beyond it
    const ox = nx * railMm * side, oy = ny * railMm * side;
    ctx.moveTo(mx + ox, my + oy);
    ctx.lineTo(mx + ox + nx * protrusion * side, my + oy + ny * protrusion * side);
  }
  ctx.stroke();
}

function drawDoorLeaf(ctx, span, posts, hA, hB, scale, col, selected) {
  const px  = 1 / scale;
  const kp  = span.kindProps ?? {};
  const dx  = hB.x - hA.x, dy = hB.y - hA.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  // Reference span line (gap-style dashed) — shows closed position between bracket pins
  ctx.strokeStyle = selected ? 'rgba(240,165,0,0.30)' : 'rgba(150,150,150,0.40)';
  ctx.lineWidth   = 1.5 * px;
  ctx.setLineDash([8 * px, 5 * px]);
  ctx.beginPath();
  ctx.moveTo(hA.x, hA.y);
  ctx.lineTo(hB.x, hB.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Decode hingePos ('Al'|'Ar'|'Bl'|'Br'). Falls back to legacy fields.
  const hp       = kp.hingePos ?? ((kp.hingeEnd ?? 'A') + ((kp.swingSide ?? 'left') === 'left' ? 'l' : 'r'));
  const postChar = hp[0];                             // 'A' | 'B'
  const sideSign = hp[1] === 'l' ? 1 : -1;           // +1 = left of A→B, -1 = right
  const postSign = postChar === 'A' ? 1 : -1;
  const swingSign = postSign * sideSign;              // rotation direction from closed
  const openDeg  = kp.openAngleDeg ?? 45;

  // Hinge pivot: exact hinge square position (±20mm perpendicular offset from bracket pin)
  const allHingePos = doorHingePositions(span, posts);
  const hingeSquare = allHingePos.find(p => p.pos === hp);
  const hinge = hingeSquare ? { x: hingeSquare.x, y: hingeSquare.y } : (postChar === 'A' ? hA : hB);
  const free  = postChar === 'A' ? hB : hA;

  // Closed direction: from hinge square toward free bracket pin
  const dv    = { x: free.x - hinge.x, y: free.y - hinge.y };
  const dlen  = Math.hypot(dv.x, dv.y);
  const cdx   = dv.x / dlen;
  const cdy   = dv.y / dlen;

  const rad  = swingSign * openDeg * Math.PI / 180;
  const odx  = cdx * Math.cos(rad) - cdy * Math.sin(rad);
  const ody  = cdx * Math.sin(rad) + cdy * Math.cos(rad);
  const openTip = { x: hinge.x + odx * dlen, y: hinge.y + ody * dlen };

  const lnx = -ody, lny = odx;
  const railHalf = Math.max(PANEL_FRAME_SHS.w / 2, 1.5 / scale);
  const offX = lnx * railHalf, offY = lny * railHalf;
  const shsH = railHalf;

  const aoX = hinge.x   - odx * shsH, aoY = hinge.y   - ody * shsH;
  const boX = openTip.x + odx * shsH, boY = openTip.y + ody * shsH;

  ctx.strokeStyle = col;
  ctx.lineWidth   = px;
  ctx.beginPath();
  ctx.moveTo(aoX + offX, aoY + offY); ctx.lineTo(boX + offX, boY + offY);
  ctx.moveTo(aoX - offX, aoY - offY); ctx.lineTo(boX - offX, boY - offY);
  ctx.moveTo(aoX + offX, aoY + offY); ctx.lineTo(aoX - offX, aoY - offY);
  ctx.moveTo(boX + offX, boY + offY); ctx.lineTo(boX - offX, boY - offY);
  ctx.stroke();

  ctx.fillStyle = selected ? 'rgba(240,165,0,0.18)' : 'rgba(80,80,80,0.30)';
  const drawSHSBar = (hx, hy) => {
    ctx.beginPath();
    ctx.moveTo(hx + offX + odx * shsH, hy + offY + ody * shsH);
    ctx.lineTo(hx - offX + odx * shsH, hy - offY + ody * shsH);
    ctx.lineTo(hx - offX - odx * shsH, hy - offY - ody * shsH);
    ctx.lineTo(hx + offX - odx * shsH, hy + offY - ody * shsH);
    ctx.closePath();
    ctx.fill();
  };
  drawSHSBar(hinge.x, hinge.y);
  drawSHSBar(openTip.x, openTip.y);

  drawMeshTicks(ctx, span, hinge.x, hinge.y, openTip.x, openTip.y, dlen, lnx, lny, px, railHalf);

  const arcR = Math.min(dlen * 0.18, 100);
  ctx.strokeStyle = '#555';
  ctx.lineWidth   = px;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.arc(hinge.x, hinge.y, arcR,
          Math.atan2(cdy, cdx), Math.atan2(ody, odx),
          swingSign < 0);
  ctx.stroke();

  const handleR = Math.max(5 / scale, 12);
  ctx.fillStyle  = '#333';
  ctx.beginPath();
  ctx.arc(openTip.x, openTip.y, handleR, 0, 2 * Math.PI);
  ctx.fill();

  ctx.lineCap = 'butt';
}

function drawDoorHingeMarkers(ctx, span, posts, scale) {
  const positions = doorHingePositions(span, posts);
  if (!positions.length) return;
  const kp = span.kindProps ?? {};
  const activePos = kp.hingePos ??
    ((kp.hingeEnd ?? 'A') + ((kp.swingSide ?? 'left') === 'left' ? 'l' : 'r'));
  const r = 5.5 / scale;
  ctx.lineWidth = 1 / scale;
  for (const { pos, x, y } of positions) {
    ctx.fillStyle   = pos === activePos ? COLORS.pivotSnap : COLORS.pivot;
    ctx.strokeStyle = COLORS.background;
    ctx.beginPath();
    ctx.rect(x - r, y - r, r * 2, r * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawSlidingDoor(ctx, span, posts, hA, hB, scale, col, selected) {
  const px  = 1 / scale;
  const dx  = hB.x - hA.x, dy = hB.y - hA.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const nx  = -dy / len, ny  = dx / len;   // left-of-A→B normal
  const sdx =  dx / len, sdy = dy / len;   // A→B unit direction

  const kp        = span.kindProps ?? {};
  const slideEnd  = kp.slideEnd  ?? 'B';
  const tSide     = kp.trackSide === 'right' ? -1 : 1; // +1 = left/+N, -1 = right/-N
  const tnx = nx * tSide, tny = ny * tSide;             // signed track-side normal

  const railHalf = Math.max(PANEL_FRAME_SHS.w / 2, 1.5 / scale);
  const shsH     = railHalf;

  // ── Home post geometry (for reaching the post face + clearance) ──────────
  const homePost = posts[slideEnd === 'A' ? span.postA : span.postB];
  const prof     = postProfile(homePost?.material ?? 'aluminium');
  const hw       = prof.w / 2;                                   // post half-width (perp & along)
  const brC      = BRACKET_CLEARANCE[homePost?.material] ?? BRACKET_CLEARANCE.aluminium;
  const postReach = 2 * hw + brC;  // hinge sits (hw+brC) inside the near face → outer face is this far back

  // ── Slide direction (home post → far end) ────────────────────────────────
  let thX, thY, dirX, dirY;
  if (slideEnd === 'A') {
    thX = hA.x; thY = hA.y; dirX =  sdx; dirY =  sdy;
  } else {
    thX = hB.x; thY = hB.y; dirX = -sdx; dirY = -sdy;
  }
  // Optional extensions: extra track length, and a leaf wider than the opening.
  const trackExtend = Math.max(0, kp.trackExtendMm ?? 0);
  const gateExtend  = Math.max(0, kp.gateExtendMm  ?? 0);
  const trackLen = 2 * len + 200 + trackExtend;
  // Leaf outer width: at minimum the POST CENTRES (c-c) of the span it covers, so the
  // closed door always overlaps both posts — never just the pin-to-pin opening.
  const pA = posts[span.postA], pB = posts[span.postB];
  const c2c   = (pA && pB) ? Math.hypot(pB.x - pA.x, pB.y - pA.y) : len;
  const doorW = c2c + gateExtend;
  // Home end reaches the outer face of the home post; length runs from there.
  const tsX = thX - dirX * postReach, tsY = thY - dirY * postReach;
  const tfX = tsX + dirX * trackLen,  tfY = tsY + dirY * trackLen;

  // ── Opening indicator (thin dashed — door is open/parked at far end) ─────
  ctx.strokeStyle = col;
  ctx.lineWidth   = px;
  ctx.setLineDash([4 * px, 4 * px]);
  ctx.beginPath();
  ctx.moveTo(hA.x, hA.y);
  ctx.lineTo(hB.x, hB.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Track rectangle (plan view of 40 mm wide extrusion) ──────────────────
  // Near track face clears the post face by 10 mm (measured from the actual post, not the rail).
  const trackDepth = 40;
  const trackGap   = 10;                          // mm clearance from post face to near track face
  const tNear = hw + trackGap;                    // dist from fence CL to near track face
  const tFar  = tNear + trackDepth;               // dist from fence CL to far track face
  const tNX   = tnx * tNear, tNY = tny * tNear;
  const tFX   = tnx * tFar,  tFY = tny * tFar;

  ctx.strokeStyle = col;
  ctx.lineWidth   = px;
  ctx.setLineDash([6 * px, 3 * px]);
  ctx.beginPath();
  ctx.moveTo(tsX + tNX, tsY + tNY); ctx.lineTo(tfX + tNX, tfY + tNY); // near edge
  ctx.moveTo(tsX + tFX, tsY + tFY); ctx.lineTo(tfX + tFX, tfY + tFY); // far edge
  ctx.moveTo(tsX + tNX, tsY + tNY); ctx.lineTo(tsX + tFX, tsY + tFY); // home end cap
  ctx.moveTo(tfX + tNX, tfY + tNY); ctx.lineTo(tfX + tFX, tfY + tFY); // far end cap
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Door panel in open / parked position (far end of track) ──────────────
  // Door outer width = opening width + gate extension, far outer face flush with the track far end.
  const tCenX = tnx * (tNear + trackDepth / 2);
  const tCenY = tny * (tNear + trackDepth / 2);

  // Hinges sit shsH inside each outer face; far outer face at trackLen, near outer face doorW back.
  const pBX = tsX + tCenX + dirX * (trackLen - shsH);
  const pBY = tsY + tCenY + dirY * (trackLen - shsH);
  const pAX = tsX + tCenX + dirX * (trackLen - doorW + shsH);
  const pAY = tsY + tCenY + dirY * (trackLen - doorW + shsH);

  // Rails extend shsH (12.5 mm) past each hinge (same as regular panel)
  const paoX = pAX - dirX * shsH, paoY = pAY - dirY * shsH;
  const pboX = pBX + dirX * shsH, pboY = pBY + dirY * shsH;

  ctx.strokeStyle = col;
  ctx.lineWidth   = px;
  ctx.beginPath();
  ctx.moveTo(paoX + nx * railHalf, paoY + ny * railHalf);
  ctx.lineTo(pboX + nx * railHalf, pboY + ny * railHalf);
  ctx.moveTo(paoX - nx * railHalf, paoY - ny * railHalf);
  ctx.lineTo(pboX - nx * railHalf, pboY - ny * railHalf);
  ctx.moveTo(paoX + nx * railHalf, paoY + ny * railHalf);
  ctx.lineTo(paoX - nx * railHalf, paoY - ny * railHalf);
  ctx.moveTo(pboX + nx * railHalf, pboY + ny * railHalf);
  ctx.lineTo(pboX - nx * railHalf, pboY - ny * railHalf);
  ctx.stroke();

  ctx.fillStyle = selected ? 'rgba(240,165,0,0.18)' : 'rgba(80,80,80,0.30)';
  function drawDoorBar(hx, hy) {
    ctx.beginPath();
    ctx.moveTo(hx + nx * railHalf + dirX * shsH, hy + ny * railHalf + dirY * shsH);
    ctx.lineTo(hx - nx * railHalf + dirX * shsH, hy - ny * railHalf + dirY * shsH);
    ctx.lineTo(hx - nx * railHalf - dirX * shsH, hy - ny * railHalf - dirY * shsH);
    ctx.lineTo(hx + nx * railHalf - dirX * shsH, hy + ny * railHalf - dirY * shsH);
    ctx.closePath();
    ctx.fill();
  }
  drawDoorBar(pAX, pAY);
  drawDoorBar(pBX, pBY);

  drawMeshTicks(ctx, span, pAX, pAY, pBX, pBY, doorW - 2 * shsH, nx, ny, px, railHalf);
}

// ─── Cantilever gate (counterbalanced sliding gate — no ground track) ─────────

function drawCantileverGate(ctx, span, posts, hA, hB, scale, col, selected) {
  const px  = 1 / scale;
  const dx  = hB.x - hA.x, dy = hB.y - hA.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const nx  = -dy / len, ny  = dx / len;   // left-of-A→B normal
  const sdx =  dx / len, sdy = dy / len;   // A→B unit direction

  const kp         = span.kindProps ?? {};
  const retractEnd = kp.retractEnd ?? 'A';                    // post the gate retracts past
  const tSide      = kp.trackSide === 'right' ? -1 : 1;
  const tnx = nx * tSide, tny = ny * tSide;                   // signed track-side normal

  const railHalf = Math.max(PANEL_FRAME_SHS.w / 2, 1.5 / scale);
  const shsH     = railHalf;

  // Addable dimensions (selectable offsets)
  const rollerSpc  = Math.max(100, kp.rollerSpacingMm ?? 500);   // WHEEL1 → WHEEL2
  const tailOver   = Math.max(0, kp.tailOverhangMm ?? 150);      // tail past the rear wheel
  const catcherOff = kp.catcherOffsetMm ?? 0;                    // nudge the catcher along the track
  const carHalf    = 70;                                         // wheel-carriage half-length

  // Home (retract) vs closing post; dir points AWAY from the opening (retract direction).
  let hHome, hClose, dirX, dirY;
  if (retractEnd === 'A') { hHome = hA; hClose = hB; dirX = -sdx; dirY = -sdy; }
  else                    { hHome = hB; hClose = hA; dirX =  sdx; dirY =  sdy; }

  const homePost = posts[retractEnd === 'A' ? span.postA : span.postB];
  const prof = postProfile(homePost?.material ?? 'aluminium');
  const hw   = prof.w / 2;
  const fp   = FOOTPLATE[homePost?.footplate] ?? { w: 180, h: 180 };
  const fpHalf = Math.max(fp.w, fp.h) / 2;
  const pc   = { x: homePost?.x ?? hHome.x, y: homePost?.y ?? hHome.y }; // rear opening post centre

  // Closing post outer end (away from the opening) — the gate nose and catcher align here.
  const closePost = posts[retractEnd === 'A' ? span.postB : span.postA];
  const hwC   = postProfile(closePost?.material ?? 'aluminium').w / 2;
  const cCen  = closePost ? { x: closePost.x, y: closePost.y } : hClose;
  const noseEnd = { x: cCen.x - dirX * hwC, y: cCen.y - dirY * hwC };

  // Default front offset leaves a 50 mm gap between the footplate and WHEEL1.
  const frontOff = Math.max(0, kp.frontWheelOffsetMm ?? (fpHalf + 50 + carHalf));

  // Distances along the retract dir from the rear opening post centre.
  const w1s      = frontOff;                 // WHEEL1 (front)
  const w2s      = w1s + rollerSpc;          // WHEEL2 (rear)
  const tailS    = w2s + tailOver;           // gate tail (closed) — just past the rear wheel
  const endstopS = tailS + len;              // capture: tail reaches endstop after sliding by opening width

  // Perpendicular offsets: beam beside the posts on the track side.
  const beamGap = 10, beamDepth = 50;
  const beamNear = hw + beamGap;
  const beamFar  = beamNear + beamDepth;
  const beamCen  = (beamNear + beamFar) / 2;
  const off   = (p, perp) => ({ x: p.x + tnx * perp, y: p.y + tny * perp });
  const along = (s) => ({ x: pc.x + dirX * s, y: pc.y + dirY * s });
  const tailPt = along(tailS), endstopPt = along(endstopS);

  // ── Opening indicator (dashed centreline over the opening) ──────────────
  ctx.strokeStyle = col; ctx.lineWidth = px;
  ctx.setLineDash([4 * px, 4 * px]);
  ctx.beginPath(); ctx.moveTo(hA.x, hA.y); ctx.lineTo(hB.x, hB.y); ctx.stroke();
  ctx.setLineDash([]);

  // ── Gate beam/outline: closing post outer end (nose) → tail just past the rear wheel (dashed) ──
  const bn1 = off(noseEnd, beamNear), bf1 = off(noseEnd, beamFar);
  const bn2 = off(tailPt, beamNear), bf2 = off(tailPt, beamFar);
  ctx.strokeStyle = col; ctx.lineWidth = px;
  ctx.setLineDash([6 * px, 3 * px]);
  ctx.beginPath();
  ctx.moveTo(bn1.x, bn1.y); ctx.lineTo(bn2.x, bn2.y);
  ctx.moveTo(bf1.x, bf1.y); ctx.lineTo(bf2.x, bf2.y);
  ctx.moveTo(bn1.x, bn1.y); ctx.lineTo(bf1.x, bf1.y);
  ctx.moveTo(bn2.x, bn2.y); ctx.lineTo(bf2.x, bf2.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Two wheel carriages, dimensioned off the rear opening post ──────────
  const wheelR = 14, carPerp = 20;
  for (const s of [w1s, w2s]) {
    const c  = along(s);
    const nO = beamNear - carPerp, fO = beamFar + carPerp;
    const c1 = { x: c.x + dirX * carHalf + tnx * nO, y: c.y + dirY * carHalf + tny * nO };
    const c2 = { x: c.x - dirX * carHalf + tnx * nO, y: c.y - dirY * carHalf + tny * nO };
    const c3 = { x: c.x - dirX * carHalf + tnx * fO, y: c.y - dirY * carHalf + tny * fO };
    const c4 = { x: c.x + dirX * carHalf + tnx * fO, y: c.y + dirY * carHalf + tny * fO };
    ctx.fillStyle   = selected ? 'rgba(240,165,0,0.20)' : 'rgba(110,110,110,0.30)';
    ctx.strokeStyle = col; ctx.lineWidth = px;
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y); ctx.lineTo(c4.x, c4.y);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    for (const wd of [-30, 30]) {                        // two wheels on the beam centreline
      const wx = c.x + dirX * wd + tnx * beamCen, wy = c.y + dirY * wd + tny * beamCen;
      ctx.beginPath(); ctx.arc(wx, wy, wheelR, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // ── Endstop post (steel post + footplate), centred on the gate track, set back one opening width ──
  {
    const ep = off(endstopPt, beamCen);                  // post centre sits on the track centreline
    const rr = (cx, cy, ha, hp) => {
      ctx.beginPath();
      ctx.moveTo(cx + dirX * ha + nx * hp, cy + dirY * ha + ny * hp);
      ctx.lineTo(cx - dirX * ha + nx * hp, cy - dirY * ha + ny * hp);
      ctx.lineTo(cx - dirX * ha - nx * hp, cy - dirY * ha - ny * hp);
      ctx.lineTo(cx + dirX * ha - nx * hp, cy + dirY * ha - ny * hp);
      ctx.closePath();
    };
    // Faint dashed travel guide from the closed tail to the endstop (open-position tail).
    ctx.strokeStyle = col; ctx.lineWidth = px;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([3 * px, 5 * px]);
    ctx.beginPath();
    ctx.moveTo(off(tailPt, beamCen).x, off(tailPt, beamCen).y);
    ctx.lineTo(ep.x, ep.y);
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    ctx.lineWidth = px;
    ctx.fillStyle   = selected ? 'rgba(240,165,0,0.12)' : 'rgba(125,184,106,0.14)';
    ctx.strokeStyle = col; rr(ep.x, ep.y, 90, 90);   ctx.fill(); ctx.stroke();  // footplate 180
    ctx.fillStyle   = selected ? 'rgba(240,165,0,0.30)' : 'rgba(125,184,106,0.45)';
    rr(ep.x, ep.y, 37.5, 37.5); ctx.fill(); ctx.stroke();                        // steel post 75
  }

  // ── End catcher: channel on the closing post, spine at the post's outer end, mouth toward the opening ──
  {
    const armLen = 55;                                   // arm length toward the opening
    const cpt = (a, perp) => ({                          // a≥0 = toward opening; catcherOff nudges it
      x: noseEnd.x + dirX * (catcherOff + a) + tnx * perp,
      y: noseEnd.y + dirY * (catcherOff + a) + tny * perp,
    });
    const S1 = cpt(0, beamNear - 6);                     // spine end, near side (at the post end)
    const S2 = cpt(0, beamFar + 6);                      // spine end, far side
    const A1 = cpt(armLen, beamNear - 6);                // arm end, near side (toward opening)
    const A2 = cpt(armLen, beamFar + 6);                 // arm end, far side
    ctx.strokeStyle = col; ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.moveTo(A1.x, A1.y); ctx.lineTo(S1.x, S1.y);      // near arm (opening → spine)
    ctx.lineTo(S2.x, S2.y);                              // spine (perpendicular) at the post end
    ctx.lineTo(A2.x, A2.y);                              // far arm — mouth opens toward the opening
    ctx.stroke();
  }

  // ── Gate frame: nose (closing post outer end) → tail (past rear wheel); mesh over the opening ──
  const lNose = off(noseEnd, beamCen), lTail = off(tailPt, beamCen), lPost = off(hHome, beamCen);
  ctx.strokeStyle = col; ctx.lineWidth = px;
  ctx.beginPath();
  ctx.moveTo(lNose.x + tnx * railHalf, lNose.y + tny * railHalf); ctx.lineTo(lTail.x + tnx * railHalf, lTail.y + tny * railHalf);
  ctx.moveTo(lNose.x - tnx * railHalf, lNose.y - tny * railHalf); ctx.lineTo(lTail.x - tnx * railHalf, lTail.y - tny * railHalf);
  ctx.stroke();

  ctx.fillStyle = selected ? 'rgba(240,165,0,0.18)' : 'rgba(80,80,80,0.30)';
  for (const p of [lNose, lTail]) {                      // SHS end bars at nose and tail
    ctx.beginPath();
    ctx.moveTo(p.x + tnx * railHalf - dirX * shsH, p.y + tny * railHalf - dirY * shsH);
    ctx.lineTo(p.x - tnx * railHalf - dirX * shsH, p.y - tny * railHalf - dirY * shsH);
    ctx.lineTo(p.x - tnx * railHalf + dirX * shsH, p.y - tny * railHalf + dirY * shsH);
    ctx.lineTo(p.x + tnx * railHalf + dirX * shsH, p.y + tny * railHalf + dirY * shsH);
    ctx.closePath(); ctx.fill();
  }
  drawMeshTicks(ctx, span, lNose.x, lNose.y, lPost.x, lPost.y, len, tnx, tny, px, railHalf);
}

// ─── Label (free-floating text annotation) ────────────────────────────────────

function drawLabel(ctx, label, scale, selected) {
  const px = 1 / scale;
  ctx.save();
  ctx.translate(label.x, label.y);
  ctx.scale(1, -1); // cancel the model Y-flip so text reads upright
  ctx.font = `500 ${13 * px}px Inter, system-ui, sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label.text || '').width;
  const padX = 6 * px, boxH = 20 * px;
  ctx.fillStyle   = selected ? 'rgba(240,165,0,0.90)' : 'rgba(20,26,40,0.85)';
  ctx.strokeStyle = selected ? COLORS.selection : 'rgba(120,130,150,0.55)';
  ctx.lineWidth   = px;
  ctx.beginPath();
  ctx.rect(-tw / 2 - padX, -boxH / 2, tw + padX * 2, boxH);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = selected ? '#1a1c22' : '#dfe6f0';
  ctx.fillText(label.text || '', 0, 0);
  ctx.restore();
}

// ─── Dimension annotation (persistent measured line) ──────────────────────────

function drawDimAnnotation(ctx, d, scale, dpr, unit, selected) {
  const px  = 1 / scale;
  const dx  = d.x1 - d.x0, dy = d.y1 - d.y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const tick = 10 * px, arr = Math.min(18, Math.max(5, 7 / scale));
  ctx.strokeStyle = selected ? COLORS.selection : C_DIM;
  ctx.fillStyle   = ctx.strokeStyle;
  ctx.lineWidth   = (selected ? 1.5 : 1) * px;
  ctx.beginPath(); ctx.moveTo(d.x0, d.y0); ctx.lineTo(d.x1, d.y1); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(d.x0 + nx * tick, d.y0 + ny * tick); ctx.lineTo(d.x0 - nx * tick, d.y0 - ny * tick);
  ctx.moveTo(d.x1 + nx * tick, d.y1 + ny * tick); ctx.lineTo(d.x1 - nx * tick, d.y1 - ny * tick);
  ctx.stroke();
  cArrow(ctx, d.x0, d.y0,  ux,  uy, arr);
  cArrow(ctx, d.x1, d.y1, -ux, -uy, arr);
  cLabel(ctx, (d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, fmtLen(len, unit), scale, dpr, undefined, { kind: 'dim', id: d.id });
}

// ─── Alignment guides + live dimensions (drag-time) ───────────────────────────

function drawAlignGuides(ctx, overlay, scale, unit) {
  const px = 1 / scale;
  ctx.strokeStyle = '#f0a000';
  ctx.lineWidth   = px;
  const fmt = mm => fmtLen(mm, unit);

  for (const g of overlay.guides) {
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.beginPath();
    let mx, my, dist;
    if (g.kind === 'alignV') {         // shared X → vertical guide, gap along Y
      ctx.moveTo(g.x, g.ya); ctx.lineTo(g.x, g.yb);
      mx = g.x; my = (g.ya + g.yb) / 2; dist = Math.abs(g.yb - g.ya);
    } else {                           // alignH: shared Y → horizontal guide, gap along X
      ctx.moveTo(g.xa, g.y); ctx.lineTo(g.xb, g.y);
      mx = (g.xa + g.xb) / 2; my = g.y; dist = Math.abs(g.xb - g.xa);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Live gap dimension label
    ctx.save();
    ctx.translate(mx, my);
    ctx.scale(1, -1);
    ctx.font         = `600 ${11 * px}px Inter, system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const label = fmt(dist);
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(18,24,42,0.82)';
    ctx.fillRect(-tw / 2 - 4 * px, -8 * px, tw + 8 * px, 16 * px);
    // Green when the 100 mm spacing magnet has the gap on-grid (panel lands on a round size).
    ctx.fillStyle = g.onGrid ? '#7fe08a' : '#f0c060';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
}

// ─── Hinge drag overlay ───────────────────────────────────────────────────────

function drawHingeDragOverlay(ctx, overlay, scale) {
}

// ─── Span endpoint handles (pin-centre drag targets) ─────────────────────────

function drawSpanEndpointHandles(ctx, span, posts, scale, selected, dragSide) {
  const h = spanHinges(span, posts);
  if (!h) return;
  const r = (COARSE ? 9 : 5) / scale;
  ctx.lineWidth = 1.5 / scale;
  for (const [pt, side] of [[h.hA, 'A'], [h.hB, 'B']]) {
    const active = dragSide === side;
    ctx.fillStyle   = (selected || active) ? COLORS.selection : COLORS.pivot;
    ctx.strokeStyle = COLORS.background;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r * (active ? 1.6 : 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// ─── Constraint badge ring (screen-space, fixed px — no zoom collision) ──────

const BADGE_LETTERS = { tieEdge: 'T', alignH: 'H', alignV: 'V', dimension: 'D', panelDim: '▭', angle: '∠', lock: 'L', collinear: 'C' };
const RING_R_CSS  = 36; // ring radius in CSS px
const BADGE_R_CSS = 10; // badge circle radius in CSS px
// Start angle: lower-right (π/4 from right = away from rotation handle at top)
const RING_START  = Math.PI / 4;

function drawConstraintRing(ctx, doc, selection, hoveredPostId, hoveredConstraintId, dpr) {
  const { view, layout, objects, constraints } = doc;
  if (!constraints?.length) return;
  const { h: layoutH } = layoutMm(layout);

  // Show ring for all selected posts + hovered post
  const postsToShow = new Set();
  for (const id of selection) {
    const obj = objects.find(o => o.id === id);
    if (obj?.type === 'post') postsToShow.add(id);
  }
  if (hoveredPostId) postsToShow.add(hoveredPostId);
  if (!postsToShow.size) return;

  const ringR  = RING_R_CSS  * dpr;
  const badgeR = BADGE_R_CSS * dpr;

  for (const postId of postsToShow) {
    const post   = objects.find(o => o.id === postId);
    if (!post) continue;
    const constrs = constraints.filter(c => c.child === postId);
    if (!constrs.length) continue;

    const sc  = modelToCanvas(post.x, post.y, view, layoutH);
    const pcx = sc.x * dpr; // physical canvas px
    const pcy = sc.y * dpr;
    const n   = constrs.length;

    for (let i = 0; i < n; i++) {
      const c      = constrs[i];
      const angle  = RING_START + (i * 2 * Math.PI / n);
      const bx     = pcx + Math.cos(angle) * ringR;
      const by     = pcy + Math.sin(angle) * ringR;
      const active = c.id === hoveredConstraintId;

      // Dashed stem from post centre toward badge
      ctx.strokeStyle = active ? COLORS.selection : C_DIM;
      ctx.lineWidth   = dpr;
      ctx.setLineDash([3 * dpr, 2 * dpr]);
      ctx.beginPath();
      ctx.moveTo(pcx, pcy);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);

      // Badge circle
      ctx.fillStyle   = active ? COLORS.selection : C_DIM;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth   = dpr;
      ctx.beginPath();
      ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Letter label
      const letter = BADGE_LETTERS[c.kind] ?? '?';
      ctx.font         = `bold ${Math.round(10 * dpr)}px system-ui, sans-serif`;
      ctx.fillStyle    = active ? '#1a1c22' : '#fff';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, bx, by);

      // Record CSS-px hit area (main.js reads this for hover + click)
      _badgeHits.push({
        constraintId: c.id,
        postId,
        constraint: c,
        sx: sc.x + Math.cos(angle) * RING_R_CSS,
        sy: sc.y + Math.sin(angle) * RING_R_CSS,
        sr: BADGE_R_CSS + 6,
      });
    }
  }
}

// ─── Post pivot circles ───────────────────────────────────────────────────────

function drawPostPivots(ctx, post, scale, snapFaceKey) {
  const r = 4.5 / scale;
  ctx.lineWidth = 1 / scale;
  for (const { key, x, y } of postPivotPoints(post)) {
    const isSnap = key === snapFaceKey;
    ctx.fillStyle   = isSnap ? COLORS.pivotSnap : COLORS.pivot;
    ctx.strokeStyle = COLORS.background;
    ctx.beginPath();
    ctx.arc(x, y, r * (isSnap ? 1.5 : 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// ─── Accessory ────────────────────────────────────────────────────────────────

export function drawAccessory(ctx, acc, posts, scale, selected = false) {
  const px = 1 / scale;
  if (acc.accKind === 'bollard') {
    const x = acc.x ?? posts[acc.host]?.x ?? 0;
    const y = acc.y ?? posts[acc.host]?.y ?? 0;
    ctx.strokeStyle = selected ? COLORS.selection : COLORS.postOutline;
    ctx.lineWidth   = 4.5 * px;
    ctx.fillStyle   = 'rgba(180,180,180,0.3)';
    ctx.beginPath();
    ctx.arc(x, y, 82, 0, Math.PI * 2); // 164 OD / 2
    ctx.fill();
    ctx.stroke();
  }
}

// ─── Constraint overlays (model-space) ───────────────────────────────────────

const C_DIM    = '#5b9bd5'; // blue  — driving dimension (satisfied)
const C_REF    = '#5b9bd5'; // reference (driven, read-only) dimension — same blue as driving, the (brackets) + no border differentiate it; violet is reserved for panel widths
const C_BROKEN = '#e5484d'; // red   — a driving dimension the solver couldn't satisfy
const C_PANELDIM    = '#b9a3e0';            // soft violet — derived panel-width dimension line (read-only; distinct from constraint dims)
const C_PANELDIM_BG = 'rgba(52,34,78,0.9)'; // deep purple pill behind panel-dim labels, matching the violet line
const GHOST_TINT = '#1fd0c8'; // teal — auto-inserted mid-run "ghost" posts (unused hue)

// Post Map for constraint drawing, cached on the objects array reference — drags/pans keep
// the same array (values are live references), so this rebuilds only on structural changes.
let _cMapCache = { ref: null, map: null };

function drawConstraints(ctx, doc, dpr) {
  const { constraints, objects, layout, view, settings } = doc;
  const lh     = layout.heightM * 1000;
  const lw     = layout.widthM  * 1000;
  const scale  = view.scale;
  const px     = 1 / scale;
  const unit   = settings.displayUnit;
  if (objects !== _cMapCache.ref)
    _cMapCache = { ref: objects, map: new Map(objects.filter(o => o.type === 'post').map(o => [o.id, o])) };
  const objMap  = _cMapCache.map;

  for (const c of constraints) {
    const child = objMap.get(c.child);
    if (!child) continue;
    switch (c.kind) {
      case 'tieEdge':
        cDrawTieEdge(ctx, c, child, lw, lh, scale, dpr, unit);
        break;
      case 'alignH': {
        const p = objMap.get(c.parent);
        if (p) cDrawAlignH(ctx, child, p, scale, dpr);
        break;
      }
      case 'alignV': {
        const p = objMap.get(c.parent);
        if (p) cDrawAlignV(ctx, child, p, scale, dpr);
        break;
      }
      case 'dimension': {
        const p = objMap.get(c.parent);
        if (p) cDrawDimension(ctx, c, child, p, scale, dpr, unit, constraintBroken(c, objMap, lw, lh));
        break;
      }
      case 'panelDim': {
        const broken = constraintBroken(c, objMap, lw, lh, objects, settings);
        // Sliding door: the constraint is on the LEAF — draw the ▭ dim on the parked leaf itself.
        const span = objects.find(o => o.type === 'span' &&
          ((o.postA === c.parent && o.postB === c.child) || (o.postA === c.child && o.postB === c.parent)));
        if (span?.spanKind === 'slidingDoor') {
          const L = slidingLeafLine(span, buildPostMap(objects));
          if (L) {
            const off = (typeof c.offsetMm === 'number') ? c.offsetMm : SLIDING_DIM_OFFSET;
            const col = broken ? C_BROKEN : C_PANELDIM;
            drawDimBetween(ctx, L.ax, L.ay, L.bx, L.by, off, `▭ ${fmtLen(c.valueMm, unit)}`,
              col, scale, dpr, { kind: 'dimc', id: c.id }, null, C_PANELDIM_BG, col);
          }
          break;
        }
        const h = panelDimHinges(c, objMap, objects);
        if (h) cDrawPanelDim(ctx, c, h, scale, dpr, unit, broken);
        break;
      }
      case 'angle': {
        const p = objMap.get(c.parent);
        if (p) cDrawAngle(ctx, c, child, p, scale, dpr, constraintBroken(c, objMap, lw, lh));
        break;
      }
      case 'collinear': {
        const a = objMap.get(c.parent), b = objMap.get(c.parent2);
        if (a && b) cDrawCollinear(ctx, child, a, b, scale);
        break;
      }
      case 'lock':
        cDrawLock(ctx, child, scale);
        break;
    }
  }
}

function cDrawLock(ctx, child, scale) {
  const px = 1 / scale, s = 9 * px;
  ctx.save();
  ctx.strokeStyle = C_DIM; ctx.lineWidth = 1.4 * px;
  // small padlock glyph offset above-left of the post
  const cx = child.x - 0, cy = child.y;
  ctx.strokeRect(cx - s, cy - s * 0.6, s * 2, s * 1.2);      // body
  ctx.beginPath();                                           // shackle
  ctx.arc(cx, cy + s * 0.6, s * 0.7, Math.PI, 0);
  ctx.stroke();
  ctx.restore();
}

function cDrawAngle(ctx, c, child, parent, scale, dpr, broken = false) {
  const px = 1 / scale;
  const col = broken ? C_BROKEN : C_DIM;
  ctx.strokeStyle = col; ctx.lineWidth = px;
  ctx.setLineDash([6 * px, 3 * px]);
  ctx.beginPath(); ctx.moveTo(parent.x, parent.y); ctx.lineTo(child.x, child.y); ctx.stroke();
  ctx.setLineDash([]);
  // small arc + label at the parent — anchor shared with hit.js so the label stays clickable
  const la = angleLabelAnchor(parent, scale);
  ctx.beginPath(); ctx.arc(parent.x, parent.y, la.r, 0, (c.valueDeg ?? 0) * Math.PI / 180); ctx.stroke();
  const actual = Math.atan2(child.y - parent.y, child.x - parent.x) * 180 / Math.PI;
  const label  = broken ? `${Math.round(c.valueDeg ?? 0)}° → ${Math.round(normDeg(actual))}°` : `${Math.round(c.valueDeg ?? 0)}°`;
  cLabel(ctx, la.x, la.y, label, scale, dpr, col, { kind: 'anglec', id: c.id });
}

function cDrawCollinear(ctx, child, a, b, scale) {
  const px = 1 / scale;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const ext = 60 * px;
  ctx.strokeStyle = C_DIM; ctx.lineWidth = px;
  ctx.setLineDash([8 * px, 4 * px]);
  ctx.beginPath();
  ctx.moveTo(a.x - ux * ext, a.y - uy * ext);
  ctx.lineTo(b.x + ux * ext, b.y + uy * ext);
  ctx.stroke();
  ctx.setLineDash([]);
  // tick at the constrained child
  ctx.beginPath(); ctx.arc(child.x, child.y, 5 * px, 0, Math.PI * 2); ctx.stroke();
}

function cDrawTieEdge(ctx, c, child, lw, lh, scale, dpr, unit) {
  const px = 1 / scale;
  const ep = tieEdgePoint(c, child, lw, lh); // shared with hit.js so the line stays clickable
  if (!ep) return;
  const ex = ep.x, ey = ep.y;
  const label = fmtLen(c.valueMm, unit);

  ctx.strokeStyle = C_DIM;
  ctx.lineWidth   = px;
  ctx.setLineDash([5 * px, 3 * px]);
  ctx.beginPath();
  ctx.moveTo(child.x, child.y);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.setLineDash([]);
  // Edge anchor dot
  ctx.fillStyle = C_DIM;
  ctx.beginPath();
  ctx.arc(ex, ey, 3 * px, 0, Math.PI * 2);
  ctx.fill();
  cLabel(ctx, (child.x + ex) / 2, (child.y + ey) / 2, label, scale, dpr, undefined, { kind: 'tiec', id: c.id });
}

function cDrawAlignH(ctx, child, parent, scale, dpr) {
  const px   = 1 / scale;
  const xMin = Math.min(child.x, parent.x) - 50 * px;
  const xMax = Math.max(child.x, parent.x) + 50 * px;
  ctx.strokeStyle = C_DIM;
  ctx.lineWidth   = px;
  ctx.setLineDash([6 * px, 3 * px]);
  ctx.beginPath();
  ctx.moveTo(xMin, child.y);
  ctx.lineTo(xMax, child.y);
  ctx.stroke();
  ctx.setLineDash([]);
  // Tick at each post
  ctx.beginPath();
  ctx.moveTo(child.x,  child.y  - 10 * px); ctx.lineTo(child.x,  child.y  + 10 * px);
  ctx.moveTo(parent.x, parent.y - 10 * px); ctx.lineTo(parent.x, parent.y + 10 * px);
  ctx.stroke();
}

function cDrawAlignV(ctx, child, parent, scale, dpr) {
  const px   = 1 / scale;
  const yMin = Math.min(child.y, parent.y) - 50 * px;
  const yMax = Math.max(child.y, parent.y) + 50 * px;
  ctx.strokeStyle = C_DIM;
  ctx.lineWidth   = px;
  ctx.setLineDash([6 * px, 3 * px]);
  ctx.beginPath();
  ctx.moveTo(child.x, yMin);
  ctx.lineTo(child.x, yMax);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(child.x  - 10 * px, child.y);  ctx.lineTo(child.x  + 10 * px, child.y);
  ctx.moveTo(parent.x - 10 * px, parent.y); ctx.lineTo(parent.x + 10 * px, parent.y);
  ctx.stroke();
}

/**
 * Draw a dimension between (ax,ay) and (bx,by): witness lines + dim line offset
 * perpendicular by offsetMm (signed) + arrows + label. Shared by driving and reference dims.
 */
function drawDimBetween(ctx, ax, ay, bx, by, offsetMm, label, color, scale, dpr, owner = null, subLines = null, bg = undefined, border = null) {
  const px  = 1 / scale;
  const dx  = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const off = offsetMm;
  const ext = 15 * px * (off >= 0 ? 1 : -1);
  const arr = Math.min(20, Math.max(8, 10 / scale));
  const pa = { x: ax + nx * off, y: ay + ny * off };
  const pb = { x: bx + nx * off, y: by + ny * off };

  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = px;

  // Witness lines from the posts out to (just past) the dim line
  ctx.setLineDash([3 * px, 2 * px]);
  ctx.beginPath();
  ctx.moveTo(ax, ay); ctx.lineTo(pa.x + nx * ext, pa.y + ny * ext);
  ctx.moveTo(bx, by); ctx.lineTo(pb.x + nx * ext, pb.y + ny * ext);
  ctx.stroke();
  ctx.setLineDash([]);

  // Dimension line + inward arrowheads
  ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  cArrow(ctx, pa.x, pa.y,  ux,  uy, arr);
  cArrow(ctx, pb.x, pb.y, -ux, -uy, arr);

  cLabel(ctx, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, label, scale, dpr, undefined, owner, subLines, bg, border);
}

function cDrawDimension(ctx, c, child, parent, scale, dpr, unit, broken = false) {
  const actual = Math.hypot(child.x - parent.x, child.y - parent.y);
  // "Broken" (from constraintBroken): the solver couldn't meet the target distance.
  const label  = broken ? `${fmtLen(c.valueMm, unit)} → ${fmtLen(actual, unit)}` : fmtLen(c.valueMm, unit);
  const col    = broken ? C_BROKEN : C_DIM;
  // Outlined pill (lighter blue) = editable, matching the panel-width dims' violet border;
  // reference dims stay borderless with (brackets).
  drawDimBetween(ctx, parent.x, parent.y, child.x, child.y, dimLineOffset(c, scale), label, col, scale, dpr, { kind: 'dimc', id: c.id }, null, undefined, broken ? C_BROKEN : '#8fc4ee');
}

/**
 * Which side of a span's run the auto panel dimensions should sit (+1 = default left of A→B,
 * −1 = right). Votes by any constraint/reference dimension on the SAME post pair: each sits on
 * one side (its offset projected onto the span normal); the panel dims take the emptier side.
 */
function panelDimSide(span, posts, doc, scale) {
  const A = posts[span.postA], B = posts[span.postB];
  if (!A || !B) return 1;
  const sdx = B.x - A.x, sdy = B.y - A.y, sl = Math.hypot(sdx, sdy) || 1;
  const snx = -sdy / sl, sny = sdx / sl;             // span normal (left of A→B)
  let vote = 0;
  const consider = (p, q, off) => {
    if (!p || !q) return;
    const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
    const onx = -dy / l, ony = dx / l;               // other dim's normal
    vote += Math.sign((onx * off) * snx + (ony * off) * sny); // which side of the run it lands
  };
  const pair = (a, b) => (a === span.postA && b === span.postB) || (a === span.postB && b === span.postA);
  for (const c of (doc.constraints ?? [])) {
    if ((c.kind === 'dimension' || c.kind === 'panelDim') && pair(c.parent, c.child))
      consider(posts[c.parent], posts[c.child], dimLineOffset(c, scale));
  }
  for (const o of doc.objects) {
    if (o.type === 'refdim' && pair(o.postA, o.postB))
      consider(posts[o.postA], posts[o.postB], dimLineOffset(o, scale));
  }
  return vote > 0 ? -1 : 1;                           // sit opposite the crowd; default left
}

/**
 * Panel-width constraint: rendered as the SAME violet panel dimension the auto per-panel dims
 * use — it IS the panel's dimension — but with an outlined pill + ▭ marker so it reads as the
 * editable one (drag to move lanes, double-click to change the width). Drawn along the actual
 * panel (hinge pin → hinge pin), not the post centres, since that's what the value refers to.
 */
function cDrawPanelDim(ctx, c, h, scale, dpr, unit, broken = false) {
  const label = `▭ ${fmtLen(c.valueMm, unit)}`;
  const col   = broken ? C_BROKEN : C_PANELDIM;
  drawDimBetween(ctx, h.hParent.x, h.hParent.y, h.hChild.x, h.hChild.y, dimLineOffset(c, scale),
    label, col, scale, dpr, { kind: 'dimc', id: c.id }, null, C_PANELDIM_BG, col);
}

/** Reference (driven) dimension between two posts — live value, violet, read-only. */
function drawRefDimension(ctx, rd, posts, scale, dpr, unit, selected) {
  const a = posts[rd.postA], b = posts[rd.postB];
  if (!a || !b) return;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const label = `(${fmtLen(len, unit)})`;
  drawDimBetween(ctx, a.x, a.y, b.x, b.y, dimLineOffset(rd, scale), label, selected ? COLORS.selection : C_REF, scale, dpr, { kind: 'refdim', id: rd.id });
}

function cArrow(ctx, tipX, tipY, ux, uy, size) {
  const nx = -uy, ny = ux;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * size + nx * size * 0.35, tipY - uy * size + ny * size * 0.35);
  ctx.lineTo(tipX - ux * size - nx * size * 0.35, tipY - uy * size - ny * size * 0.35);
  ctx.closePath();
  ctx.fill();
}

function cLabel(ctx, mx, my, text, scale, dpr, color = C_DIM, owner = null, subLines = null, bg = 'rgba(18,24,42,0.9)', border = null) {
  ctx.save();
  ctx.translate(mx, my);
  // Undo scale*dpr and Y-flip so we're in 1:1 canvas-pixel space, upright
  ctx.scale(1 / (scale * dpr), -1 / (scale * dpr));
  const fsz = (COARSE ? 13 : 10) * dpr;
  const pad = (COARSE ? 8 : 4) * dpr;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  if (!subLines || !subLines.length) {
    // Single-line pill (unchanged).
    ctx.font = `${fsz}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    const th = fsz * 1.5;
    ctx.fillStyle = bg;
    ctx.fillRect(-tw / 2 - pad, -th / 2 - 1, tw + pad * 2, th + 2);
    if (border) { // outlined pill — marks an EDITABLE dimension (panel-width constraint)
      ctx.strokeStyle = border;
      ctx.lineWidth   = dpr;
      ctx.strokeRect(-tw / 2 - pad, -th / 2 - 1, tw + pad * 2, th + 2);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    if (owner) {
      const m = ctx.getTransform();
      _labelHits.push({ kind: owner.kind, id: owner.id, sx: m.e / dpr, sy: m.f / dpr,
                        w: (tw + pad * 2) / dpr, h: (th + 2) / dpr });
    }
    ctx.restore();
    return;
  }

  // Multi-line pill: headline + smaller sub-lines stacked below (screen-down = local −y).
  const subFsz = fsz * 0.82;
  const lines  = [{ text, fsz, color }, ...subLines.map(t => ({ text: t, fsz: subFsz, color }))];
  const font   = f => `${f}px system-ui, sans-serif`;
  let maxW = 0;
  for (const ln of lines) { ctx.font = font(ln.fsz); maxW = Math.max(maxW, ctx.measureText(ln.text).width); }
  const lineH  = ln => ln.fsz * 1.35;
  const totalH = lines.reduce((s, ln) => s + lineH(ln), 0);
  const pillW  = maxW + pad * 2;

  ctx.fillStyle = bg;
  ctx.fillRect(-pillW / 2, -totalH / 2 - pad, pillW, totalH + pad * 2);

  let y = totalH / 2;                       // top of the stack in local space
  for (const ln of lines) {
    const lh = lineH(ln);
    ctx.font = font(ln.fsz);
    ctx.fillStyle = ln.color;
    ctx.fillText(ln.text, 0, y - lh / 2);
    y -= lh;
  }
  if (owner) {
    const m = ctx.getTransform();
    _labelHits.push({ kind: owner.kind, id: owner.id, sx: m.e / dpr, sy: m.f / dpr,
                      w: pillW / dpr, h: (totalH + pad * 2) / dpr });
  }
  ctx.restore();
}

// ─── Marquee (screen-space) ───────────────────────────────────────────────────

function drawMarquee(ctx, marquee, view, layoutH, dpr) {
  // Convert model corners to screen coords
  const c0 = modelToCanvas(marquee.x0, marquee.y0, view, layoutH);
  const c1 = modelToCanvas(marquee.x1, marquee.y1, view, layoutH);
  const sx  = Math.min(c0.x, c1.x) * dpr;
  const sy  = Math.min(c0.y, c1.y) * dpr;
  const sw  = Math.abs(c1.x - c0.x) * dpr;
  const sh  = Math.abs(c1.y - c0.y) * dpr;

  ctx.fillStyle   = COLORS.marquee;
  ctx.strokeStyle = COLORS.marqueeBorder;
  ctx.lineWidth   = 1 * dpr;
  ctx.fillRect(sx, sy, sw, sh);
  ctx.strokeRect(sx, sy, sw, sh);
}

// ─── Zone (model-space) ───────────────────────────────────────────────────────

function drawZone(ctx, zone, scale, selected, dpr = 1, unit = 'mm', hovered = false) {
  if (zone.shape === 'circle') { drawCircleZone(ctx, zone, scale, selected, dpr, unit, hovered); return; }
  const px = 1 / scale;
  const col = zone.color ?? COLORS.zoneBorder;
  const x = zone.x - zone.widthMm / 2;
  const y = zone.y - zone.heightMm / 2;
  const w = zone.widthMm, h = zone.heightMm;

  ctx.save();
  ctx.setLineDash([8 * px, 4 * px]);
  ctx.strokeStyle = col;
  ctx.lineWidth   = (selected ? 2 : 1) * px;
  ctx.fillStyle   = col + '1a';
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  if (selected) {
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth   = 1.5 * px;
    ctx.setLineDash([6 * px, 3 * px]);
    ctx.strokeRect(x - 3 * px, y - 3 * px, w + 6 * px, h + 6 * px);
    ctx.setLineDash([]);
  }

  // Dimension lines — only shown on hover
  if (hovered) drawZoneDimensions(ctx, zone, scale, dpr, unit);

  // Name label — constant 13px screen size; ctx.scale(1,-1) cancels the Y-flip from the view transform
  if (zone.name) {
    ctx.save();
    ctx.translate(zone.x, zone.y);
    ctx.scale(1, -1);
    ctx.font         = `500 ${13 * px}px Inter, system-ui, sans-serif`;
    ctx.fillStyle    = col;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(zone.name, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function drawZoneDimensions(ctx, zone, scale, dpr, unit) {
  const px    = 1 / scale;
  const halfW = zone.widthMm  / 2;
  const halfH = zone.heightMm / 2;
  const arr  = Math.min(20, Math.max(6, 8 / scale));
  const tick = 8 * px;

  const wLabel = fmtLen(zone.widthMm, unit);
  const hLabel = fmtLen(zone.heightMm, unit);

  ctx.strokeStyle = C_DIM;
  ctx.fillStyle   = C_DIM;
  ctx.lineWidth   = px;

  // Width dimension — on the bottom edge of the zone
  {
    const dimY = zone.y - halfH; // sits on the bottom boundary
    const x0   = zone.x - halfW;
    const x1   = zone.x + halfW;
    ctx.beginPath();
    ctx.moveTo(x0, dimY);        ctx.lineTo(x1, dimY);        // dim line along bottom edge
    ctx.moveTo(x0, dimY);        ctx.lineTo(x0, dimY + tick); // left tick (up into zone)
    ctx.moveTo(x1, dimY);        ctx.lineTo(x1, dimY + tick); // right tick (up into zone)
    ctx.stroke();
    cArrow(ctx, x0, dimY,  1, 0, arr);
    cArrow(ctx, x1, dimY, -1, 0, arr);
    cLabel(ctx, zone.x, dimY, wLabel, scale, dpr);
  }

  // Height dimension — on the right edge of the zone
  {
    const dimX = zone.x + halfW; // sits on the right boundary
    const y0   = zone.y - halfH;
    const y1   = zone.y + halfH;
    ctx.beginPath();
    ctx.moveTo(dimX, y0);        ctx.lineTo(dimX, y1);        // dim line along right edge
    ctx.moveTo(dimX, y0);        ctx.lineTo(dimX - tick, y0); // bottom tick (left into zone)
    ctx.moveTo(dimX, y1);        ctx.lineTo(dimX - tick, y1); // top tick (left into zone)
    ctx.stroke();
    cArrow(ctx, dimX, y0, 0,  1, arr);
    cArrow(ctx, dimX, y1, 0, -1, arr);
    cLabel(ctx, dimX, zone.y, hLabel, scale, dpr);
  }

  // Area readout at the centre
  const areaM2 = (zone.widthMm / 1000) * (zone.heightMm / 1000);
  cLabel(ctx, zone.x, zone.y - 22 * px, `${areaM2.toFixed(2)} m²`, scale, dpr);
}

// ─── Circular zone (model-space) ─────────────────────────────────────────────

function drawCircleZone(ctx, zone, scale, selected, dpr, unit, hovered) {
  const px  = 1 / scale;
  const col = zone.color ?? COLORS.zoneBorder;
  const r   = zone.radiusMm ?? zone.widthMm / 2;

  ctx.save();
  ctx.setLineDash([8 * px, 4 * px]);
  ctx.strokeStyle = col;
  ctx.lineWidth   = (selected ? 2 : 1) * px;
  ctx.fillStyle   = col + '1a';
  ctx.beginPath(); ctx.arc(zone.x, zone.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.setLineDash([]);

  if (selected) {
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth   = 1.5 * px;
    ctx.setLineDash([6 * px, 3 * px]);
    ctx.beginPath(); ctx.arc(zone.x, zone.y, r + 3 * px, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  if (hovered) {
    const label = `r = ${fmtLen(r, unit)}`;
    ctx.strokeStyle = C_DIM; ctx.fillStyle = C_DIM; ctx.lineWidth = px;
    ctx.beginPath(); ctx.moveTo(zone.x, zone.y); ctx.lineTo(zone.x + r, zone.y); ctx.stroke();
    cLabel(ctx, zone.x + r / 2, zone.y + 10 * px, label, scale, dpr);
    const areaM2 = Math.PI * (r / 1000) * (r / 1000);
    cLabel(ctx, zone.x, zone.y - 16 * px, `${areaM2.toFixed(2)} m²`, scale, dpr);
  }

  if (zone.name) {
    ctx.save();
    ctx.translate(zone.x, zone.y); ctx.scale(1, -1);
    ctx.font = `500 ${13 * px}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(zone.name, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

// ─── Circle zone drag ghost (screen-space) ────────────────────────────────────

function drawCircleZoneDragGhost(ctx, overlay, view, layoutH, dpr) {
  const cc = modelToCanvas(overlay.cx, overlay.cy, view, layoutH);
  const cp = modelToCanvas(overlay.toX, overlay.toY, view, layoutH);
  const r  = Math.hypot(cp.x - cc.x, cp.y - cc.y) * dpr;
  if (r < 1) return;
  const cx = cc.x * dpr, cy = cc.y * dpr;

  ctx.fillStyle   = COLORS.zoneDragFill;
  ctx.strokeStyle = COLORS.zoneBorder;
  ctx.lineWidth   = 1.5 * dpr;
  ctx.setLineDash([6 * dpr, 3 * dpr]);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.setLineDash([]);
  // Radius guide line
  ctx.strokeStyle = COLORS.zoneBorder + 'aa';
  ctx.lineWidth   = dpr;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cp.x * dpr, cp.y * dpr); ctx.stroke();
  // Radius text
  const rMm   = Math.round(Math.hypot(overlay.toX - overlay.cx, overlay.toY - overlay.cy));
  const mid   = { x: (cx + cp.x * dpr) / 2, y: (cy + cp.y * dpr) / 2 };
  const fsz   = 11 * dpr;
  ctx.font          = `${fsz}px system-ui, sans-serif`;
  ctx.textAlign     = 'center';
  ctx.textBaseline  = 'middle';
  ctx.fillStyle     = 'rgba(18,24,42,0.85)';
  const tw = ctx.measureText(`r = ${rMm} mm`).width;
  ctx.fillRect(mid.x - tw / 2 - 4, mid.y - fsz * 0.75, tw + 8, fsz * 1.5);
  ctx.fillStyle = COLORS.zoneBorder;
  ctx.fillText(`r = ${rMm} mm`, mid.x, mid.y);
}

// ─── Measure overlay (model-space) ───────────────────────────────────────────

const M_COL = '#e03838'; // measure red

function drawSnapIndicator(ctx, si, scale) {
  const px = 1 / scale;
  const sz = 8 * px;
  ctx.save();
  ctx.translate(si.x, si.y);
  ctx.strokeStyle = '#f0e800';
  ctx.lineWidth   = 1.5 * px;
  if (si.type === 'midpoint') {
    // Triangle pointing up
    ctx.beginPath();
    ctx.moveTo(0,  sz);
    ctx.lineTo(-sz * 0.866, -sz * 0.5);
    ctx.lineTo( sz * 0.866, -sz * 0.5);
    ctx.closePath();
    ctx.stroke();
  } else if (si.type === 'center') {
    // Diamond
    ctx.beginPath();
    ctx.moveTo(-sz, 0); ctx.lineTo(0, sz); ctx.lineTo(sz, 0); ctx.lineTo(0, -sz);
    ctx.closePath();
    ctx.stroke();
  } else {
    // Square (endpoint)
    ctx.strokeRect(-sz, -sz, sz * 2, sz * 2);
  }
  ctx.restore();
}

function drawMeasureOverlay(ctx, mo, scale, dpr, unit) {
  const px  = 1 / scale;
  const arr = Math.min(18, Math.max(5, 7 / scale));

  // Calibration points (background-scale tool — two orange dots + connecting dash)
  if (mo.calibration) {
    const { pt1, pt2 } = mo.calibration;
    const dot = 5 * px;
    ctx.fillStyle   = '#e09020';
    ctx.strokeStyle = '#e09020';
    ctx.lineWidth   = 1.5 * px;
    if (pt1) {
      ctx.beginPath(); ctx.arc(pt1.x, pt1.y, dot, 0, Math.PI * 2); ctx.fill();
    }
    if (pt1 && pt2) {
      ctx.beginPath(); ctx.arc(pt2.x, pt2.y, dot, 0, Math.PI * 2); ctx.fill();
      ctx.setLineDash([5 * px, 3 * px]);
      ctx.beginPath(); ctx.moveTo(pt1.x, pt1.y); ctx.lineTo(pt2.x, pt2.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Snap highlight circle (always shown when there's a snap point)
  if (mo.cursor?.snapped) {
    const r = 5 * px;
    ctx.strokeStyle = M_COL;
    ctx.lineWidth   = 1.5 * px;
    ctx.beginPath(); ctx.arc(mo.cursor.x, mo.cursor.y, r, 0, Math.PI * 2); ctx.stroke();
  }

  // From-point dot (first anchor set)
  if (mo.from) {
    ctx.fillStyle = M_COL;
    ctx.beginPath(); ctx.arc(mo.from.x, mo.from.y, 4 * px, 0, Math.PI * 2); ctx.fill();
    // Live dashed line from → cursor
    if (mo.cursor) {
      ctx.strokeStyle = M_COL;
      ctx.lineWidth   = 1.5 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.beginPath(); ctx.moveTo(mo.from.x, mo.from.y); ctx.lineTo(mo.cursor.x, mo.cursor.y); ctx.stroke();
      ctx.setLineDash([]);
      drawMeasureLine(ctx, mo.from.x, mo.from.y, mo.cursor.x, mo.cursor.y, null, scale, dpr, unit, true);
    }
  }

  // Completed measurement — solid line with full annotation
  if (mo.result) {
    drawMeasureLine(ctx, mo.result.x0, mo.result.y0, mo.result.x1, mo.result.y1, mo.result.label, scale, dpr, unit, false);
  }
}

function drawMeasureLine(ctx, x0, y0, x1, y1, label, scale, dpr, unit, live) {
  const px  = 1 / scale;
  const dx  = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const tick = 10 * px;
  const arr  = Math.min(18, Math.max(5, 7 / scale));

  ctx.fillStyle   = M_COL;
  ctx.strokeStyle = M_COL;
  ctx.lineWidth   = (live ? 1 : 1.5) * px;

  if (!live) {
    // Solid line
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    // End ticks
    ctx.beginPath();
    ctx.moveTo(x0 + nx * tick, y0 + ny * tick); ctx.lineTo(x0 - nx * tick, y0 - ny * tick);
    ctx.moveTo(x1 + nx * tick, y1 + ny * tick); ctx.lineTo(x1 - nx * tick, y1 - ny * tick);
    ctx.stroke();
    // Arrows
    cArrow(ctx, x0, y0,  ux,  uy, arr);
    cArrow(ctx, x1, y1, -ux, -uy, arr);
  }

  // Distance label
  const text = label ?? fmtLen(len, unit);
  const offset = live ? 12 * px : 0;
  cLabel(ctx, (x0 + x1) / 2 + nx * offset, (y0 + y1) / 2 + ny * offset, text, scale, dpr);
}

// ─── Zone drag ghost (screen-space) ──────────────────────────────────────────

function drawZoneDragGhost(ctx, overlay, view, layoutH, dpr) {
  const c0 = modelToCanvas(overlay.x0, overlay.y0, view, layoutH);
  const c1 = modelToCanvas(overlay.x1, overlay.y1, view, layoutH);
  const sx  = Math.min(c0.x, c1.x) * dpr;
  const sy  = Math.min(c0.y, c1.y) * dpr;
  const sw  = Math.abs(c1.x - c0.x) * dpr;
  const sh  = Math.abs(c1.y - c0.y) * dpr;

  ctx.fillStyle   = COLORS.zoneDragFill;
  ctx.strokeStyle = COLORS.zoneBorder;
  ctx.lineWidth   = 1.5 * dpr;
  ctx.setLineDash([6 * dpr, 3 * dpr]);
  ctx.fillRect(sx, sy, sw, sh);
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.setLineDash([]);
}
