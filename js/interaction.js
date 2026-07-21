// Pointer interaction state machine: selection, move, rotate, marquee, endpoint drag, zone drag.
// Uses Pointer Events so mouse, touch, and pen all drive the same states; only
// the primary pointer participates (multi-finger gestures live in gestures.js).

import { pickObject, pickHandle, rotHandlePos, objectsInMarquee, pickSpanEndpoint, pickDoorHinge, pickDimensionLine, setPickBoost, getPickBoost } from './hit.js';
import { getDimLabelHits } from './render.js';
import { canvasToModel, snapPoint, createZone, createPost, createSpan, createConstraint, buildPostMap, PANEL_FRAME_SHS } from './model.js';
import { isDragBlocked, lockedAxes, validateConstraint, wouldCycle, rotationBlockReason } from './constraints.js';
import { showToast } from './ui/toast.js';
import { postPivotPoints, doorHingePositions, autoFaceKey, spanHinges, PANEL_DIM_OFFSET, pinOffset, slidingLeafLine } from './spans.js';
import { findObjectSnap } from './snaps.js';
import { vectorizeStroke, assembleTrace } from './trace.js';
import { setPendingTraceScale } from './ui/add-constraint.js';

const DRAG_THRESHOLD       = 4;  // screen pixels before a click becomes a drag
const TOUCH_DRAG_THRESHOLD = 10; // fingers wobble more than mice
const EP_SNAP_PX           = 40; // screen pixels snap radius for endpoint drag

let _activeTool = 'select';
export function setActiveTool(tool) { _activeTool = tool; }
export function getActiveTool()     { return _activeTool; }

let _beginGrab = () => {};
/** Start a live move-drag of an object bound to a pointer (add-tool hold-to-move). */
export function beginGrab(objId, e) { _beginGrab(objId, e); }

let _cancelCurrent = () => {};
/** Abort any in-progress press/drag without committing (a touch gesture took over). */
export function cancelInteraction() { _cancelCurrent(); }

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} store
 * @param {() => Set<string>} getSelection
 * @param {(Set<string>) => void} setSelection
 * @param {(marquee: object|null) => void} onMarquee  called whenever marquee rect changes
 * @param {(overlay: object|null) => void} onDragState  called during endpoint drags
 */
export function setupInteraction(canvas, store, getSelection, setSelection, onMarquee, onDragState = null) {
  let state   = 'IDLE'; // IDLE | DOWN | MOVE_OBJ | MARQUEE | ROTATE | DRAG_ENDPOINT | DRAG_ZONE | DRAG_CIRCLE_ZONE | DRAG_HINGE
  let downEvt = null;
  let downObj = null;

  // Active-pointer bookkeeping — one pointer drives the state machine at a time.
  let activePtr  = null;           // pointerId of the press that owns the current state
  let dragThresh = DRAG_THRESHOLD; // per-press: wider for touch
  let downSel    = null;           // selection at press time, restored if a gesture cancels

  // Move drag bookkeeping
  let dragStartModel     = { x: 0, y: 0 };
  let dragStartPositions = new Map(); // id → {x, y}

  // Rotate drag bookkeeping
  let rotTargetId   = null;
  let rotSnapped    = false; // history snapshot taken for the current rotate drag
  let rotStartAngle = 0;  // angle (deg) from post centre to cursor at drag start
  let rotStartDeg   = 0;  // post's footplateRotationDeg at drag start

  // Group-rotate drag (rotate tool) — rotate the whole selection about its centroid
  let grpPivot      = { x: 0, y: 0 };
  let grpStartAngle = 0;         // deg, pivot → cursor at drag start
  let grpStart      = new Map(); // id → original geometry at drag start
  let grpAngleC     = new Map(); // angle-constraint id → original valueDeg
  let grpSnapped    = false;     // history snapshot taken
  let grpLastDelta  = 0;         // last applied delta (deg, 0..360)

  // Endpoint drag bookkeeping
  let dragEndpoint = null; // { span, endpoint: 'A'|'B' }

  // Hinge drag bookkeeping
  let dragHinge = null; // { span, startPos, fromX, fromY }

  // Dimension offset drag ({ kind, id, aPt, bPt })
  let dragDim = null;

  // Zone drag
  let zoneDragStart  = { x: 0, y: 0 };
  let circleZoneCenter = { x: 0, y: 0 };

  // Marquee
  let marqueeStart = { x: 0, y: 0 };

  // Trace tool — multi-stroke session. traceStrokes accumulates committed strokes
  // (kept across pointerups until ✓/✕); traceRaw is the in-flight stroke's raw pts.
  let traceStrokes = []; // [{ vertices, closed }]
  let traceRaw     = null; // [{x,y}] model space, or null when not drawing

  function lh() { return store.getDoc().layout.heightM * 1000; }
  function lw() { return store.getDoc().layout.widthM  * 1000; }

  /**
   * Find the nearest STATIONARY post sharing the dragged post's X and/or Y within `tol`.
   * `movingIds` excludes every post travelling with the drag — a co-moving post must never
   * count as a match, or a rigid multi-select drag (e.g. two H-constrained posts sharing an X)
   * reads as a "corner" and wrongly disables the 100 mm spacing magnet below.
   * Returns snap coordinates (or null) plus guide segments for rendering.
   */
  function findAlignGuides(cur, movingIds, objects, tol, dragPost = null) {
    let snapX = null, snapY = null, bestXD = tol, bestYD = tol, mX = null, mY = null;
    for (const o of objects) {
      if (o.type !== 'post' || movingIds.has(o.id)) continue;
      const adx = Math.abs(o.x - cur.x);
      if (adx < bestXD) { bestXD = adx; snapX = o.x; mX = o; }
      const ady = Math.abs(o.y - cur.y);
      if (ady < bestYD) { bestYD = ady; snapY = o.y; mY = o; }
    }
    // 100 mm PANEL helper: while aligned on exactly ONE axis (a straight H/V run, posts
    // facing each other), magnet the FREE axis so the PHYSICAL PANEL between the posts
    // lands on the panel-divisor grid. Spacing = panel + (pinOffset(ref) + pinOffset(dragged)
    // − frame) — that correction is 100 for alu–alu but 99 steel–steel and 80 z65–z65 (and
    // mixed pairs in between), so snap the panel and derive the spacing from the real pin
    // offsets, never the centres. Skipped at a corner (both axes aligned). Soft magnet
    // (free band between increments); finer as you zoom in.
    const div    = Math.max(1, store.getDoc().settings.panelDivisorMm || 100);
    const magnet = Math.min(tol, div * 0.45);
    const panelInc = (coord, refPost, refCoord) => {
      const off    = pinOffset(refPost) + pinOffset(dragPost ?? refPost) - PANEL_FRAME_SHS.w;
      const gap    = Math.abs(coord - refCoord);
      const panel  = Math.max(div, Math.round((gap - off) / div) * div); // ≥ one increment
      const target = refCoord + Math.sign(coord - refCoord || 1) * (panel + off);
      return Math.abs(target - coord) <= magnet ? target : null;
    };
    let onGridY = false, onGridX = false; // did the magnet land the panel on-grid?
    if (mX && !mY) { const s = panelInc(cur.y, mX, mX.y); if (s !== null) { snapY = s; onGridY = true; } }
    else if (mY && !mX) { const s = panelInc(cur.x, mY, mY.x); if (s !== null) { snapX = s; onGridX = true; } }

    const gx = snapX ?? cur.x, gy = snapY ?? cur.y; // guide endpoints at the snapped position
    const guides = [];
    if (mX) guides.push({ kind: 'alignV', x: mX.x, ya: mX.y, yb: gy, onGrid: onGridY });
    if (mY) guides.push({ kind: 'alignH', y: mY.y, xa: mY.x, xb: gx, onGrid: onGridX });
    return { snapX, snapY, guides };
  }

  function modelPt(e) {
    const r = canvas.getBoundingClientRect();
    return canvasToModel(e.clientX - r.left, e.clientY - r.top, store.getDoc().view, lh());
  }

  function moved(e) {
    return downEvt && (
      Math.abs(e.clientX - downEvt.clientX) > dragThresh ||
      Math.abs(e.clientY - downEvt.clientY) > dragThresh
    );
  }

  /** Top-most dimension value label whose pill rect (padded) contains (sx, sy). */
  function pickDimLabel(sx, sy, pad) {
    const hits = getDimLabelHits();
    for (let i = hits.length - 1; i >= 0; i--) {
      const l = hits[i];
      if (Math.abs(sx - l.sx) <= l.w / 2 + pad && Math.abs(sy - l.sy) <= l.h / 2 + pad) return l;
    }
    return null;
  }

  /** Build the dragDim shape ({kind, id, aPt, bPt}) for a dimc/refdim label hit. */
  function dragDimFromLabel(lbl, doc) {
    const postMap = buildPostMap(doc.objects);
    if (lbl.kind === 'dimc') {
      const c = doc.constraints.find(k => k.id === lbl.id);
      const parent = c && postMap[c.parent], child = c && postMap[c.child];
      if (!parent || !child) return null;
      let aPt = { x: parent.x, y: parent.y }, bPt = { x: child.x, y: child.y };
      if (c.kind === 'panelDim') {
        // panelDim draws along the panel (pin-to-pin) — or the parked LEAF for a sliding
        // door — so offset-drag off that line, not the post centres. Order parent → child
        // to match render's normal (so the offset sign agrees).
        const span = doc.objects.find(o => o.type === 'span' &&
          ((o.postA === c.parent && o.postB === c.child) || (o.postA === c.child && o.postB === c.parent)));
        if (span?.spanKind === 'slidingDoor') {
          const L = slidingLeafLine(span, postMap);
          if (L) { aPt = { x: L.ax, y: L.ay }; bPt = { x: L.bx, y: L.by }; }
        } else {
          const h = span ? spanHinges(span, postMap) : null;
          if (h) {
            const hp = span.postA === c.parent ? h.hA : h.hB;
            const hc = span.postA === c.parent ? h.hB : h.hA;
            aPt = { x: hp.x, y: hp.y }; bPt = { x: hc.x, y: hc.y };
          }
        }
      }
      return { kind: 'dimc', id: c.id, aPt, bPt };
    }
    const rd = doc.objects.find(o => o.id === lbl.id && o.type === 'refdim');
    const a = rd && postMap[rd.postA], b = rd && postMap[rd.postB];
    if (!a || !b) return null;
    return { kind: 'refdim', id: rd.id, aPt: { x: a.x, y: a.y }, bPt: { x: b.x, y: b.y } };
  }

  /** Abort the current press/drag without committing anything. */
  function cancelCurrent() {
    if (state === 'IDLE') { downEvt = null; activePtr = null; return; }
    // Drags that mutate the doc live saved a history snapshot at drag start —
    // undo restores it exactly. (The aborted fragment lands on the redo stack; harmless.)
    if (state === 'MOVE_OBJ' || state === 'DRAG_DIM' || (state === 'ROTATE' && rotSnapped)
        || (state === 'ROTATE_GROUP' && grpSnapped)) store.undo();
    if (downSel) setSelection(downSel); // undo any press-time selection change
    if (state === 'MARQUEE') onMarquee(null);
    // Trace: discard only the in-flight stroke; keep already-drawn session strokes.
    if (state === 'DRAG_TRACE') { traceRaw = null; emitTraceOverlay(); }
    else if (onDragState) onDragState(null);
    canvas.style.cursor = '';
    state = 'IDLE'; downEvt = null; downObj = null; activePtr = null;
    dragEndpoint = null; dragHinge = null; dragDim = null; downSel = null;
    grpStart = new Map(); grpAngleC = new Map();
  }
  _cancelCurrent = cancelCurrent;

  // Hold-to-move: the add-post/bollard tools place a post then hand it here to be
  // dragged (with align guides + object snap) on the same held pointer. Seeds a
  // MOVE_OBJ exactly like a grabbed selection; pointermove/up finish it normally.
  _beginGrab = (objId, e) => {
    const doc = store.getDoc();
    const obj = doc.objects.find(o => o.id === objId);
    if (!obj) return;
    activePtr  = e.pointerId;
    downEvt    = e;
    dragThresh = 0; // already committed to moving
    downObj    = obj;
    downSel    = new Set([objId]);
    setSelection(new Set([objId]));
    store.saveSnapshot();
    dragStartModel     = modelPt(e);
    dragStartPositions = new Map([[objId, { x: obj.x, y: obj.y }]]);
    state = 'MOVE_OBJ';
  };

  // ── Trace tool session ─────────────────────────────────────────────────────

  function traceStep() { return store.getDoc().settings.traceSnapDeg ?? 45; }

  function emitTraceOverlay() {
    if (!onDragState) return;
    const scale = store.getDoc().view.scale;
    const live  = traceRaw && traceRaw.length > 1 ? vectorizeStroke(traceRaw, scale, traceStep()) : null;
    if (!traceStrokes.length && !traceRaw) { onDragState(null); return; }
    onDragState({ type: 'trace', committed: traceStrokes, liveRaw: traceRaw, livePreview: live });
  }

  function notifyTraceChanged() {
    document.dispatchEvent(new CustomEvent('zc:trace-changed', { detail: { count: traceStrokes.length } }));
  }

  function clearTrace() {
    traceStrokes = []; traceRaw = null;
    if (onDragState) onDragState(null);
    notifyTraceChanged();
  }

  /** Vectorized session strokes → posts, panels, constraints, layout resize. */
  function commitTrace() {
    const scale = store.getDoc().view.scale;
    if (!traceStrokes.length) { clearTrace(); return; }
    // Land traced posts on the panel-divisor grid (default 100 mm) so wall dimensions —
    // and hence panel widths (panel = post spacing − 100) — come out on round increments,
    // independent of the (now off-by-default) grid snap. See zonecad-spec §4.2.
    const st   = store.getDoc().settings;
    const snap = Math.max(1, st.panelDivisorMm || 100);
    const plan = assembleTrace(traceStrokes.map(s => ({ vertices: s.vertices.map(v => ({ ...v })), closed: s.closed })), scale, snap);
    if (plan.posts.length < 2) { clearTrace(); return; }

    // A background image counts as content: if you traced over one, keep the trace where
    // you drew it (grow the layout only) so it stays aligned to the image — don't recentre.
    const prevHadContent = !!store.getDoc().background ||
      store.getDoc().objects.some(o => o.type === 'post' || o.type === 'span' || o.type === 'zone');

    const newIds = store.mutate(d => {
      // 1. Posts
      const postObjs = plan.posts.map(p => createPost(p.x, p.y));
      for (const p of postObjs) d.objects.push(p);

      // 2. Spans (panels) between the plan's post pairs, faces auto-detected
      for (const [a, b] of plan.spans) {
        const A = postObjs[a], B = postObjs[b];
        d.objects.push(createSpan(A.id, B.id, { faceA: autoFaceKey(A, B), faceB: autoFaceKey(B, A) }));
      }

      // 3. Constraints hold the shape true. Each span's child post is constrained
      //    to its neighbour: axis-aligned → alignH/alignV, diagonal → angle bearing.
      //    Guard every one against over-constraint / cycles and skip if unsafe, so
      //    the graph stays an acyclic DAG (see zonecad-spec §6).
      const tryAdd = (c) => {
        if (wouldCycle(c.parent, c.child, d.constraints)) return false;
        if (validateConstraint(c, d.constraints, d.objects)) return false;
        d.constraints.push(c); return true;
      };
      const edgeConstraint = (ai, bi) => {
        const A = postObjs[ai], B = postObjs[bi];
        const dx = B.x - A.x, dy = B.y - A.y;
        // Decide from the edge's quantized bearing (edges are already 22.5°-snapped),
        // not raw coords: mm-rounding can leave a 1–2 mm mismatch on a "horizontal"
        // wall. alignH/alignV then also self-corrects that tiny gap on evaluation.
        const q = (Math.round(Math.atan2(dy, dx) / (Math.PI / 8)) * 22.5 % 360 + 360) % 360;
        if (q === 0 || q === 180) return createConstraint('alignH', B.id, A.id, 0);   // horizontal
        if (q === 90 || q === 270) return createConstraint('alignV', B.id, A.id, 0);  // vertical
        return createConstraint('angle', B.id, A.id, 0, Math.atan2(dy, dx) * 180 / Math.PI);
      };
      for (const [a, b] of plan.spans) { const c = edgeConstraint(a, b); if (c) tryAdd(c); }
      // Door-gap posts stay in line across the opening — same bearing→constraint mapping
      // as a panel edge (alignH/alignV for H/V doorways, angle for diagonal ones), but
      // no span bridges the gap.
      for (const g of plan.gaps) { const c = edgeConstraint(g.a, g.b); if (c) tryAdd(c); }

      // 4. Layout resize (empty doc → fit + centre; else grow only). Mutates layout
      //    and translates posts as needed. Returns the new post ids for selection.
      resizeLayoutForTrace(d, postObjs, prevHadContent);
      return postObjs.map(p => p.id);
    });

    // Arm "first dimension scales the whole trace"
    setPendingTraceScale(new Set(newIds));

    traceStrokes = [];
    setSelection(new Set(newIds));
    if (onDragState) onDragState(null);
    notifyTraceChanged();
    document.dispatchEvent(new CustomEvent('zc:trace-committed'));
    canvas.dispatchEvent(new CustomEvent('zc:tooldone', { bubbles: true }));
  }

  /** Empty doc: layout = trace bbox rounded up to whole m + 2 m margins, trace
   *  centred. Otherwise: grow layout to include the trace, move nothing. */
  function resizeLayoutForTrace(d, postObjs, hadContent) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of postObjs) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const wMm = maxX - minX, hMm = maxY - minY;
    if (!hadContent) {
      const layW = Math.ceil(wMm / 1000) + 4; // +2 m each side
      const layH = Math.ceil(hMm / 1000) + 4;
      d.layout.widthM  = layW;
      d.layout.heightM = layH;
      // Centre the trace in the new layout
      const offX = (layW * 1000 - wMm) / 2 - minX;
      const offY = (layH * 1000 - hMm) / 2 - minY;
      for (const p of postObjs) { p.x = Math.round(p.x + offX); p.y = Math.round(p.y + offY); }
    } else {
      // Grow to fit with a 2 m margin, keeping origin at 0,0 (never shrink/move).
      d.layout.widthM  = Math.max(d.layout.widthM,  Math.ceil((maxX + 2000) / 1000));
      d.layout.heightM = Math.max(d.layout.heightM, Math.ceil((maxY + 2000) / 1000));
    }
  }

  document.addEventListener('zc:trace-commit', commitTrace);
  document.addEventListener('zc:trace-clear', clearTrace);

  // ── pointerdown ────────────────────────────────────────────────────────────

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    downEvt    = e;
    activePtr  = e.pointerId;
    dragThresh = e.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD;

    const doc  = store.getDoc();
    const r    = canvas.getBoundingClientRect();
    const sx   = e.clientX - r.left;
    const sy   = e.clientY - r.top;
    const sel  = getSelection();
    downSel    = new Set(sel);

    // 0. Zone/circle-zone drag tools — bypass all normal picking
    if (_activeTool === 'zone') {
      const mp = modelPt(e);
      zoneDragStart = { x: mp.x, y: mp.y };
      state = 'DRAG_ZONE';
      if (onDragState) onDragState({ type: 'zone', x0: mp.x, y0: mp.y, x1: mp.x, y1: mp.y });
      return;
    }
    if (_activeTool === 'zone-circle') {
      const mp = modelPt(e);
      circleZoneCenter = { x: mp.x, y: mp.y };
      state = 'DRAG_CIRCLE_ZONE';
      if (onDragState) onDragState({ type: 'zone-circle', cx: mp.x, cy: mp.y, toX: mp.x, toY: mp.y });
      return;
    }
    if (_activeTool === 'trace') {
      const mp = modelPt(e);
      traceRaw = [{ x: mp.x, y: mp.y }];
      state = 'DRAG_TRACE';
      emitTraceOverlay();
      return;
    }

    // Rotate tool: with a selection, a press ANYWHERE starts a group rotation about the
    // selection centroid — the press point only seeds the reference ray, so you can grab
    // a comfortable lever arm. Shift-press falls through so selection edits still work;
    // an empty selection falls through to normal click-select/marquee.
    if (_activeTool === 'rotate' && sel.size > 0 && !e.shiftKey) {
      const why = rotationBlockReason(sel, doc.constraints, false);
      if (why) {
        showToast(`Rotation blocked — ${why}. Remove the constraint or change the selection.`, 'info');
        state = 'IDLE'; downEvt = null; activePtr = null; downSel = null;
        return;
      }
      grpStart = new Map();
      let cx = 0, cy = 0, n = 0;
      for (const o of doc.objects) {
        if (!sel.has(o.id)) continue;
        if (o.type === 'dim') {
          grpStart.set(o.id, { isDim: true, x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1 });
          cx += (o.x0 + o.x1) / 2; cy += (o.y0 + o.y1) / 2; n++;
        } else if (o.type === 'post') {
          grpStart.set(o.id, { isPost: true, x: o.x, y: o.y, rot: o.footplateRotationDeg ?? 0 });
          cx += o.x; cy += o.y; n++;
        } else if (o.type === 'zone' || o.type === 'label') {
          grpStart.set(o.id, { isRectZone: o.type === 'zone' && o.shape !== 'circle',
                               x: o.x, y: o.y, w: o.widthMm, h: o.heightMm });
          cx += o.x; cy += o.y; n++;
        }
      }
      if (n > 0) {
        grpPivot  = { x: cx / n, y: cy / n };
        grpAngleC = new Map();
        for (const c of doc.constraints) {
          if (c.kind === 'angle' && sel.has(c.child)) grpAngleC.set(c.id, c.valueDeg ?? 0);
        }
        const mp = modelPt(e);
        grpStartAngle = Math.atan2(mp.y - grpPivot.y, mp.x - grpPivot.x) * 180 / Math.PI;
        grpSnapped = false; grpLastDelta = 0;
        state = 'ROTATE_GROUP';
        return;
      }
      // nothing rotatable in the selection (e.g. spans only) — fall through to select
    }
    // The 'move' tool skips all sub-handles (hinge markers, endpoint re-face, rotation) —
    // clicks fall straight through to selecting/moving the object.
    const handlesActive = _activeTool !== 'move';

    // 1. Door hinge-position marker (drag from one square to another to set hingePos)
    const hingeHit = handlesActive ? pickDoorHinge(sx, sy, doc.objects, doc.view, lh(), getSelection()) : null;
    if (hingeHit) {
      const postMap = buildPostMap(doc.objects);
      const grabbed = doorHingePositions(hingeHit.span, postMap).find(p => p.pos === hingeHit.pos);
      dragHinge = { span: hingeHit.span, startPos: hingeHit.pos, fromX: grabbed?.x ?? sx, fromY: grabbed?.y ?? sy };
      state = 'DRAG_HINGE';
      downEvt = null;
      return;
    }

    // 2. Span endpoint handle takes priority
    const epHit = handlesActive ? pickSpanEndpoint(sx, sy, doc.objects, doc.view, lh()) : null;
    if (epHit) {
      state        = 'DRAG_ENDPOINT';
      dragEndpoint = epHit;
      const targetPostId = epHit.endpoint === 'A' ? epHit.span.postA : epHit.span.postB;
      if (onDragState) onDragState({ type: 'endpoint', spanId: epHit.span.id, endpoint: epHit.endpoint, postId: targetPostId, snapFaceKey: null });
      return;
    }

    // 2. Check rotation handle on the single selected post
    if (handlesActive && sel.size === 1) {
      const selObj = doc.objects.find(o => o.id === [...sel][0]);
      if (selObj && pickHandle(sx, sy, selObj, doc.view, lh()) === 'rotate') {
        state        = 'ROTATE';
        rotTargetId  = selObj.id;
        rotStartDeg  = selObj.footplateRotationDeg;
        rotSnapped   = false; // snapshot deferred to the first actual rotation, like MOVE_OBJ
        const mp     = modelPt(e);
        rotStartAngle = Math.atan2(mp.y - selObj.y, mp.x - selObj.x) * 180 / Math.PI;
        return;
      }
    }

    // 2.4. Dimension value label — the target humans actually aim at. The pill
    // rect comes from the last render (getDimLabelHits), padded for fingers.
    let labelObj = null;
    const lblHit = pickDimLabel(sx, sy, e.pointerType === 'touch' ? 14 : 4);
    if (lblHit) {
      if (lblHit.kind === 'dimc' || lblHit.kind === 'refdim') {
        const dd = dragDimFromLabel(lblHit, doc);
        if (dd) {
          dragDim = dd;
          setSelection(dd.kind === 'refdim' ? new Set([dd.id]) : new Set());
          state = 'DOWN_DIM';
          return;
        }
      } else if (lblHit.kind === 'dim') {
        labelObj = doc.objects.find(o => o.id === lblHit.id) ?? null; // annotation → normal select/move
      } else {
        // anglec / tiec labels are edit targets (double-click / double-tap), not
        // selections — consume the press so it can't select the span behind them.
        state = 'IDLE'; downEvt = null; activePtr = null; downSel = null;
        return;
      }
    }

    // 2.5. Dimension line drag-to-offset (driving constraints + reference dims; angle/tie have no offset)
    const dimHit = pickDimensionLine(sx, sy, doc.objects, doc.constraints, doc.view, lh(), lw());
    if (dimHit && (dimHit.kind === 'dimc' || dimHit.kind === 'refdim')) {
      dragDim = dimHit;
      setSelection(dimHit.kind === 'refdim' ? new Set([dimHit.id]) : new Set());
      state = 'DOWN_DIM';
      return;
    }

    // 3. Pick object
    downObj = labelObj ?? pickObject(sx, sy, doc.objects, doc.view, lh());

    // 3.5. Touch second chance — rescue near-misses that would otherwise land on
    // nothing (deselect or start a marquee). Never steals a direct hit.
    if (!downObj && e.pointerType === 'touch') {
      const dh2 = pickDimensionLine(sx, sy, doc.objects, doc.constraints, doc.view, lh(), lw(), 18);
      if (dh2 && (dh2.kind === 'dimc' || dh2.kind === 'refdim')) {
        dragDim = dh2;
        setSelection(dh2.kind === 'refdim' ? new Set([dh2.id]) : new Set());
        state = 'DOWN_DIM';
        return;
      }
      if (sel.size > 0) {
        // Sloppy re-grab: something is selected and the finger came down near it.
        const g = getPickBoost();
        setPickBoost(g * 2);
        const o2 = pickObject(sx, sy, doc.objects, doc.view, lh());
        setPickBoost(g);
        if (o2 && sel.has(o2.id)) downObj = o2;
      }
    }

    state   = 'DOWN';
    marqueeStart = modelPt(e);

    // Move tool: with a selection, a press anywhere arms a move of the whole selection.
    // Selection changes are deferred to mouseup, so a plain click still selects/deselects.
    if (_activeTool === 'move' && sel.size > 0 && !e.shiftKey) return;

    if (downObj) {
      if (e.shiftKey) {
        const newSel = new Set(sel);
        if (newSel.has(downObj.id)) newSel.delete(downObj.id);
        else newSel.add(downObj.id);
        setSelection(newSel);
      } else if (!sel.has(downObj.id)) {
        setSelection(new Set([downObj.id]));
      }
    }
  });

  // ── pointermove ───────────────────────────────────────────────────────────

  window.addEventListener('pointermove', e => {
    if (state === 'IDLE' || e.pointerId !== activePtr) return;

    if (state === 'DRAG_ZONE') {
      const mp = modelPt(e);
      if (onDragState) onDragState({ type: 'zone', x0: zoneDragStart.x, y0: zoneDragStart.y, x1: mp.x, y1: mp.y });
    }

    if (state === 'DRAG_CIRCLE_ZONE') {
      const mp = modelPt(e);
      if (onDragState) onDragState({ type: 'zone-circle', cx: circleZoneCenter.x, cy: circleZoneCenter.y, toX: mp.x, toY: mp.y });
    }

    if (state === 'DRAG_TRACE' && traceRaw) {
      const mp  = modelPt(e);
      const dec = 3 / store.getDoc().view.scale; // decimate: min 3px screen spacing
      const last = traceRaw[traceRaw.length - 1];
      if (Math.hypot(mp.x - last.x, mp.y - last.y) >= dec) traceRaw.push({ x: mp.x, y: mp.y });
      emitTraceOverlay();
    }

    if (state === 'DRAG_HINGE') {
      const mp  = modelPt(e);
      const doc = store.getDoc();
      const postMap = buildPostMap(doc.objects);
      const positions = doorHingePositions(dragHinge.span, postMap);
      const snapTol = 30 / doc.view.scale;
      let snap = null, snapD = snapTol;
      for (const p of positions) {
        if (p.pos === dragHinge.startPos) continue;
        const d = Math.hypot(mp.x - p.x, mp.y - p.y);
        if (d < snapD) { snapD = d; snap = p; }
      }
      if (onDragState) onDragState({ type: 'hinge', fromX: dragHinge.fromX, fromY: dragHinge.fromY, toX: mp.x, toY: mp.y, snap });
    }

    if (state === 'DOWN_DIM' && moved(e)) {
      state = 'DRAG_DIM';
      store.saveSnapshot();
    }

    if (state === 'DRAG_DIM' && dragDim) {
      const mp = modelPt(e);
      const { aPt, bPt } = dragDim;
      const dx = bPt.x - aPt.x, dy = bPt.y - aPt.y, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      let offsetMm = Math.round((mp.x - aPt.x) * nx + (mp.y - aPt.y) * ny); // perpendicular projection
      // Lane snapping: the dim "pops" between tidy rows — multiples of the auto panel-dim
      // offset — so stacked dimensions reorder cleanly past each other (never lane 0, which
      // would sit on the posts). Hold Shift to place freely.
      if (!e.shiftKey) {
        const lane = Math.round(offsetMm / PANEL_DIM_OFFSET) * PANEL_DIM_OFFSET;
        offsetMm = lane === 0 ? (offsetMm >= 0 ? PANEL_DIM_OFFSET : -PANEL_DIM_OFFSET) : lane;
      }
      if (dragDim.kind === 'refdim') store.patchObjects(new Map([[dragDim.id, { offsetMm }]]));
      else store.patchConstraint(dragDim.id, { offsetMm });
    }

    if (state === 'DOWN' && moved(e)) {
      const sel = getSelection();
      const doc = store.getDoc();
      // Move tool: a drag anywhere moves the whole selection. Otherwise you must grab a selected object.
      const moveSel = _activeTool === 'move' && sel.size > 0;
      const grabObj = downObj && sel.has(downObj.id) &&
        (downObj.type === 'post' || downObj.type === 'zone' || downObj.type === 'label' || downObj.type === 'dim') &&
        !isDragBlocked(downObj.id, doc.constraints, sel, doc.objects);
      if (moveSel || grabObj) {
        state = 'MOVE_OBJ';
        store.saveSnapshot();
        dragStartModel = modelPt(downEvt);
        dragStartPositions = new Map();
        for (const obj of doc.objects) {
          if (!sel.has(obj.id)) continue;
          if (obj.type === 'dim') dragStartPositions.set(obj.id, { isDim: true, x0: obj.x0, y0: obj.y0, x1: obj.x1, y1: obj.y1 });
          else if (obj.type === 'post' || obj.type === 'zone' || obj.type === 'label') dragStartPositions.set(obj.id, { x: obj.x, y: obj.y });
        }
      } else if (!downObj) {
        state = 'MARQUEE';
      }
    }

    if (state === 'MOVE_OBJ') {
      const mp  = modelPt(e);
      let dx  = mp.x - dragStartModel.x;
      let dy  = mp.y - dragStartModel.y;
      // Ortho lock: hold Shift to constrain the move to the dominant axis.
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      const doc = store.getDoc();
      const { settings, constraints, objects } = doc;
      // Polar snapping: snap the move-vector angle to a fixed increment (when not ortho-locked).
      if (!e.shiftKey && settings.polarSnapDeg > 0) {
        const mag = Math.hypot(dx, dy);
        if (mag > 1) {
          const inc = settings.polarSnapDeg * Math.PI / 180;
          const a   = Math.round(Math.atan2(dy, dx) / inc) * inc;
          dx = Math.cos(a) * mag; dy = Math.sin(a) * mag;
        }
      }

      // The 'move' tool skips object snapping (hinge pins / span lines) but KEEPS the
      // post-to-post alignment guides, so posts still line up cleanly.
      const freeMove = _activeTool === 'move';

      // The post that drives snapping/guides: the grabbed post, or the sole selected post
      // (so a drag started off-object in move mode still guides).
      let primaryPost = (downObj?.type === 'post' && dragStartPositions.has(downObj.id)) ? downObj : null;
      if (!primaryPost && dragStartPositions.size === 1) {
        const only = objects.find(o => o.id === [...dragStartPositions.keys()][0]);
        if (only?.type === 'post') primaryPost = only;
      }

      // Alignment FIRST (from the raw cursor) so it keeps working for ANY run length — even long
      // runs where the object snap below would otherwise grab a ghost pin / midpoint and suppress
      // it. When the dragged post lines up with a neighbour (typically the other end of its span),
      // its spacing snaps to the 100 mm panel grid; object snap is then skipped for this drag.
      let guides = null, aligned = false;
      if (!settings.snapEnabled && !e.shiftKey && primaryPost) {
        const start = dragStartPositions.get(primaryPost.id);
        if (start) {
          // Measure from where the post will actually BE, not the raw cursor: a constraint-
          // locked axis (e.g. alignH holding Y) doesn't follow the cursor, and vertical hand
          // drift while sliding along the row would silently push `cur` off the row match and
          // disengage the 100 mm spacing magnet. Clamp locked axes first — an H/V-constrained
          // post then ALWAYS registers its row/column, so the magnet stays live for the whole slide.
          const movingIds = new Set(dragStartPositions.keys());
          const axes0     = lockedAxes(primaryPost.id, constraints, movingIds);
          const cur = { x: axes0.xLocked ? start.x : start.x + dx,
                        y: axes0.yLocked ? start.y : start.y + dy };
          const tol = 8 / doc.view.scale; // ~8 screen px in model units
          const g   = findAlignGuides(cur, movingIds, objects, tol, primaryPost);
          if (g.snapX !== null && !axes0.xLocked) { dx += g.snapX - cur.x; aligned = true; }
          if (g.snapY !== null && !axes0.yLocked) { dy += g.snapY - cur.y; aligned = true; }
          // A locked-axis row/column match still counts as aligned (object-snap must not hijack).
          if ((axes0.xLocked || axes0.yLocked) && (g.snapX !== null || g.snapY !== null)) aligned = true;
          if (g.guides.length) guides = g.guides;
        }
      }

      // Object snap: a single-post drag snaps onto nearby geometry (endpoints/midpoints/nearest),
      // unless it's already aligned to a neighbour (alignment + 100 mm spacing takes precedence).
      if (!aligned && !freeMove && !e.shiftKey && dragStartPositions.size === 1 && primaryPost) {
        // Exclude the dragged post AND any span touching it (their hinges/midpoints move with the cursor).
        const exclude = new Set(getSelection());
        for (const o of objects) {
          if (o.type === 'span' && (o.postA === primaryPost.id || o.postB === primaryPost.id)) exclude.add(o.id);
        }
        const os = findObjectSnap(mp.x, mp.y, doc, doc.view.scale, exclude);
        if (os) {
          const start = dragStartPositions.get(primaryPost.id);
          dx = os.x - start.x; dy = os.y - start.y;
        }
      }

      const movingSet = new Set(dragStartPositions.keys());
      const patches = new Map();
      for (const [id, start] of dragStartPositions) {
        if (start.isDim) { // dimension note — translate both endpoints
          patches.set(id, { x0: start.x0 + dx, y0: start.y0 + dy, x1: start.x1 + dx, y1: start.y1 + dy });
          continue;
        }
        let nx = start.x + dx, ny = start.y + dy;
        if (settings.snapEnabled) ({ x: nx, y: ny } = snapPoint(nx, ny, settings));
        // Pre-clamp locked axes so evaluation never has to snap them back (no jitter).
        // Constraints whose reference is also moving are ignored — the group translates rigidly.
        const axes = lockedAxes(id, constraints, movingSet);
        if (axes.xLocked) nx = start.x;
        if (axes.yLocked) ny = start.y;
        patches.set(id, { x: nx, y: ny });
      }
      store.patchObjects(patches);
      if (onDragState) onDragState(guides ? { type: 'guides', guides } : null);
    }

    if (state === 'MARQUEE') {
      const mp = modelPt(e);
      onMarquee({ x0: marqueeStart.x, y0: marqueeStart.y, x1: mp.x, y1: mp.y });
    }

    if (state === 'ROTATE_GROUP') {
      const mp  = modelPt(e);
      const doc = store.getDoc();
      const cur = Math.atan2(mp.y - grpPivot.y, mp.x - grpPivot.x) * 180 / Math.PI;
      let delta = cur - grpStartAngle;
      const snap = e.shiftKey ? 0 : (doc.settings.rotSnapDeg ?? 5);
      if (snap > 0) delta = Math.round(delta / snap) * snap;
      delta = ((delta % 360) + 360) % 360;
      if (delta !== grpLastDelta) {
        grpLastDelta = delta;
        if (!grpSnapped && delta !== 0) { store.saveSnapshot(); grpSnapped = true; }
        const quarter = delta % 90 === 0;
        const oddQ    = quarter && delta % 180 !== 0;
        const rad = delta * Math.PI / 180;
        // Exact quarter-turns snap cos/sin to 0/±1 so grid coordinates stay exact.
        const cos = quarter ? Math.round(Math.cos(rad)) : Math.cos(rad);
        const sin = quarter ? Math.round(Math.sin(rad)) : Math.sin(rad);
        const rot = (x, y) => ({ x: grpPivot.x + (x - grpPivot.x) * cos - (y - grpPivot.y) * sin,
                                 y: grpPivot.y + (x - grpPivot.x) * sin + (y - grpPivot.y) * cos });
        // Angle-constraint bearings first, so the re-solve in patchObjects uses them.
        for (const [cid, v0] of grpAngleC) {
          store.patchConstraint(cid, { valueDeg: ((v0 + delta) % 360 + 360) % 360 });
        }
        const patches = new Map();
        for (const [id, s] of grpStart) {
          if (s.isDim) {
            const a = rot(s.x0, s.y0), b = rot(s.x1, s.y1);
            patches.set(id, { x0: a.x, y0: a.y, x1: b.x, y1: b.y });
            continue;
          }
          const p = rot(s.x, s.y);
          const patch = { x: p.x, y: p.y };
          if (s.isPost) patch.footplateRotationDeg = ((s.rot + delta) % 360 + 360) % 360;
          // Rect zones stay axis-aligned: odd quarter-turns swap the sides, other angles
          // just carry the centre.
          if (s.isRectZone) { patch.widthMm = oddQ ? s.h : s.w; patch.heightMm = oddQ ? s.w : s.h; }
          patches.set(id, patch);
        }
        store.patchObjects(patches);
      }
      if (onDragState) onDragState({ type: 'rotate', cx: grpPivot.x, cy: grpPivot.y,
        startDeg: grpStartAngle, deltaDeg: grpLastDelta, toX: mp.x, toY: mp.y });
    }

    if (state === 'ROTATE') {
      const mp  = modelPt(e);
      const doc = store.getDoc();
      const obj = doc.objects.find(o => o.id === rotTargetId);
      if (!obj) return;
      const curAngle = Math.atan2(mp.y - obj.y, mp.x - obj.x) * 180 / Math.PI;
      let newRot = ((rotStartDeg - (curAngle - rotStartAngle)) % 360 + 360) % 360;
      const snap = doc.settings.rotSnapDeg ?? 5;
      if (snap > 0) newRot = (Math.round(newRot / snap) * snap % 360 + 360) % 360;
      if (newRot === obj.footplateRotationDeg) return; // no change → don't touch history
      if (!rotSnapped) { store.saveSnapshot(); rotSnapped = true; }
      store.patchObjects(new Map([[rotTargetId, { footplateRotationDeg: newRot }]]));
    }

    if (state === 'DRAG_ENDPOINT') {
      const mp  = modelPt(e);
      const doc = store.getDoc();
      const targetPostId = dragEndpoint.endpoint === 'A' ? dragEndpoint.span.postA : dragEndpoint.span.postB;
      const targetPost   = doc.objects.find(o => o.id === targetPostId);
      let snapFaceKey = null;
      if (targetPost) {
        const snapR = EP_SNAP_PX / doc.view.scale;
        let bestD = snapR;
        for (const { key, x, y } of postPivotPoints(targetPost)) {
          const d = Math.hypot(mp.x - x, mp.y - y);
          if (d < bestD) { bestD = d; snapFaceKey = key; }
        }
      }
      if (onDragState) onDragState({ type: 'endpoint', spanId: dragEndpoint.span.id, endpoint: dragEndpoint.endpoint, postId: targetPostId, snapFaceKey });
    }
  });

  // ── pointerup ─────────────────────────────────────────────────────────────

  window.addEventListener('pointercancel', cancelCurrent);

  window.addEventListener('pointerup', e => {
    if (e.button !== 0 || (activePtr !== null && e.pointerId !== activePtr)) return;
    activePtr = null;

    if (state === 'DRAG_ZONE') {
      const mp = modelPt(e);
      const x0 = Math.min(zoneDragStart.x, mp.x);
      const x1 = Math.max(zoneDragStart.x, mp.x);
      const y0 = Math.min(zoneDragStart.y, mp.y);
      const y1 = Math.max(zoneDragStart.y, mp.y);
      const wMm = x1 - x0, hMm = y1 - y0;
      if (wMm > 10 && hMm > 10) {
        const doc = store.getDoc();
        const zoneCount = doc.objects.filter(o => o.type === 'zone').length;
        const newZone = createZone((x0 + x1) / 2, (y0 + y1) / 2, {
          widthMm: wMm, heightMm: hMm,
          name: `Zone ${zoneCount + 1}`,
        });
        store.mutate(d => { d.objects.push(newZone); });
        setSelection(new Set([newZone.id]));
      }
      if (onDragState) onDragState(null);
      setActiveTool('select');
      canvas.style.cursor = '';
      state = 'IDLE'; downEvt = null;
      return;
    }

    if (state === 'DRAG_CIRCLE_ZONE') {
      const mp = modelPt(e);
      const r  = Math.round(Math.hypot(mp.x - circleZoneCenter.x, mp.y - circleZoneCenter.y));
      if (r > 50) {
        const doc       = store.getDoc();
        const zoneCount = doc.objects.filter(o => o.type === 'zone').length;
        const newZone   = createZone(circleZoneCenter.x, circleZoneCenter.y, {
          shape: 'circle', radiusMm: r,
          name: `Zone ${zoneCount + 1}`,
        });
        store.mutate(d => { d.objects.push(newZone); });
        setSelection(new Set([newZone.id]));
      }
      if (onDragState) onDragState(null);
      setActiveTool('select');
      canvas.style.cursor = '';
      state = 'IDLE'; downEvt = null;
      return;
    }

    if (state === 'DRAG_TRACE') {
      // Finish this stroke: vectorize and add to the session (do NOT commit — the
      // ✓ bar commits all strokes). Stay in the tool for the next stroke.
      const scale = store.getDoc().view.scale;
      const v = traceRaw ? vectorizeStroke(traceRaw, scale, traceStep()) : null;
      if (v) traceStrokes.push(v);
      traceRaw = null;
      emitTraceOverlay();
      notifyTraceChanged();
      state = 'IDLE'; downEvt = null;
      return;
    }

    if (state === 'DRAG_HINGE') {
      const mp  = modelPt(e);
      const doc = store.getDoc();
      const postMap = buildPostMap(doc.objects);
      const positions = doorHingePositions(dragHinge.span, postMap);
      const snapTol = 30 / doc.view.scale;
      let best = null, bestD = snapTol;
      for (const p of positions) {
        if (p.pos === dragHinge.startPos) continue;
        const d = Math.hypot(mp.x - p.x, mp.y - p.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best) {
        store.mutate(d => {
          const s = d.objects.find(o => o.id === dragHinge.span.id);
          if (s) { if (!s.kindProps) s.kindProps = {}; s.kindProps.hingePos = best.pos; }
        });
      }
      if (onDragState) onDragState(null);
      dragHinge = null;
      state = 'IDLE'; downEvt = null;
      return;
    }

    if (state === 'DRAG_ENDPOINT') {
      const mp  = modelPt(e);
      const doc = store.getDoc();
      const ep  = dragEndpoint.endpoint;
      const targetPostId = ep === 'A' ? dragEndpoint.span.postA : dragEndpoint.span.postB;
      const targetPost   = doc.objects.find(o => o.id === targetPostId);
      let snapFaceKey = null;
      if (targetPost) {
        const snapR = EP_SNAP_PX / doc.view.scale;
        let bestD = snapR;
        for (const { key, x, y } of postPivotPoints(targetPost)) {
          const d = Math.hypot(mp.x - x, mp.y - y);
          if (d < bestD) { bestD = d; snapFaceKey = key; }
        }
      }
      if (snapFaceKey) {
        const spanId = dragEndpoint.span.id;
        store.mutate(doc => {
          const s = doc.objects.find(o => o.id === spanId);
          if (s) { if (ep === 'A') s.faceA = snapFaceKey; else s.faceB = snapFaceKey; }
        });
      }
      if (onDragState) onDragState(null);
      dragEndpoint = null;
      state   = 'IDLE';
      downEvt = null;
      return;
    }

    if (state === 'DOWN') {
      if (_activeTool === 'move' && getSelection().size > 0 && !e.shiftKey) {
        // Move-mode click (no drag): apply the deferred selection change.
        if (downObj) { if (!getSelection().has(downObj.id)) setSelection(new Set([downObj.id])); }
        else setSelection(new Set());
      } else if (!downObj) {
        setSelection(new Set()); // bare click on empty → deselect
      }
    }
    if (state === 'MARQUEE') {
      const mp = modelPt(e);
      const rect = { x0: marqueeStart.x, y0: marqueeStart.y, x1: mp.x, y1: mp.y };
      const hit  = objectsInMarquee(store.getDoc().objects, rect.x0, rect.y0, rect.x1, rect.y1);
      setSelection(new Set(hit.map(o => o.id)));
      onMarquee(null);
    }
    if (state === 'ROTATE_GROUP') {
      if (onDragState) onDragState(null); // clear the radial guide
      grpStart = new Map(); grpAngleC = new Map();
    }
    if (state === 'MOVE_OBJ' && onDragState) onDragState(null); // clear alignment guides
    // MOVE_OBJ / ROTATE / ROTATE_GROUP / DRAG_DIM: snapshot saved at drag start; patches are live
    dragDim = null;
    state   = 'IDLE';
    downEvt = null;
    downObj = null;
    downSel = null;
  });

  // ── double-click → open properties ────────────────────────────────────────

  canvas.addEventListener('dblclick', e => {
    const r   = canvas.getBoundingClientRect();
    const doc = store.getDoc();
    // The value label is the biggest, most obvious target — double-click/tap it
    // to edit even when the thin dim line itself is missed.
    const lbl = pickDimLabel(e.clientX - r.left, e.clientY - r.top, 10);
    if (lbl) {
      if (lbl.kind === 'dim') {
        const obj = doc.objects.find(o => o.id === lbl.id);
        if (obj) {
          setSelection(new Set([obj.id]));
          canvas.dispatchEvent(new CustomEvent('zc:openprops', { bubbles: true }));
        }
      } else {
        canvas.dispatchEvent(new CustomEvent('zc:editdim', { bubbles: true, detail: { kind: lbl.kind, id: lbl.id, sx: e.clientX, sy: e.clientY } }));
      }
      return;
    }
    // A dimension line (driving constraint, reference dim, angle or tie) → edit its value inline.
    const dimHit = pickDimensionLine(e.clientX - r.left, e.clientY - r.top, doc.objects, doc.constraints, doc.view, lh(), lw());
    if (dimHit) {
      canvas.dispatchEvent(new CustomEvent('zc:editdim', { bubbles: true, detail: { kind: dimHit.kind, id: dimHit.id, sx: e.clientX, sy: e.clientY } }));
      return;
    }
    const obj = pickObject(e.clientX - r.left, e.clientY - r.top, doc.objects, doc.view, lh());
    if (obj) {
      if (!getSelection().has(obj.id)) setSelection(new Set([obj.id]));
      if (obj.type === 'label') {
        canvas.dispatchEvent(new CustomEvent('zc:editlabel', { bubbles: true, detail: { id: obj.id } }));
      } else {
        canvas.dispatchEvent(new CustomEvent('zc:openprops', { bubbles: true }));
      }
    }
  });
}
