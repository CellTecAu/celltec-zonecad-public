// ZoneCAD — entry point

import * as store       from './store.js';
import { render, getConstraintBadgeHits, setBgDirtyCallback } from './render.js';
import { setupInput }   from './input.js';
import { setupInteraction, setActiveTool, getActiveTool, beginGrab } from './interaction.js';
import { setupGestures, runToolTap, isGestureActive } from './gestures.js';
import { canvasToModel, modelToCanvas, snapPoint, createPost, createSpan, createLabel, createRefDimension, uid, buildPostMap, postProfile, fmtLen, normDeg, BOLLARD } from './model.js';
import { pickObject }   from './hit.js';
import { constraintLabel, lockedAxes, countBrokenConstraints, rotationBlockReason } from './constraints.js';
import { setupSettings }    from './ui/settings.js';
import { setupToolbar, warnDocProblems } from './ui/toolbar.js';
import { setupContextMenu } from './ui/contextmenu.js';
import { setupProperties }  from './ui/properties.js';
import { setupBom }         from './ui/bom.js';
import { setupAddConstraint, openAddConstraint, applyAlignToSelection, applyDimension, applyPanelDim, applyAngle, applyLock, orientDimension, setDimensionValue, setPanelDimValue, setAngleValue, setTieEdgeValue, convertRefToDimension } from './ui/add-constraint.js';
import { showInlineInput, evalExpr } from './ui/inline-input.js';
import { showToast } from './ui/toast.js';
import { setupToolbox, setToolboxActive } from './ui/toolbox.js';
import { addPanelNearest, spanHinges, autoLink, ghostPostCenters, ghostPanelSections, spanRunLength, panelConfig, slidingLeafLine } from './spans.js';
import { findObjectSnap } from './snaps.js';
import { exportDxf }      from './dxf.js';

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
let   dpr    = devicePixelRatio;

// ─── Selection state (UI state, not document state) ───────────────────────────

let selection           = new Set();
let marquee             = null; // {x0,y0,x1,y1} in model coords during box-select drag
let dragOverlay         = null; // endpoint drag state passed to render
let hoveredZoneId         = null; // zone under cursor (for dimension display)
let hoveredPostId         = null; // post under cursor (for constraint badges)
let hoveredConstraintId   = null; // constraint badge under cursor (for highlight + tooltip)
let constraintRefPostId   = null; // parent post of hovered constraint (red glow)

// ── Measure tool state ────────────────────────────────────────────────────────
let measureFrom   = null; // { x, y } — first anchor point
let measureCursor = null; // { x, y, snapped } — live cursor model position
let measureResult = null; // { x0, y0, x1, y1, label } — completed measurement

// ── Background calibration state ──────────────────────────────────────────────
let bgCalibPt1 = null; // first clicked point in model coords
let bgCalibPt2 = null; // second clicked point in model coords

// ── Dimension tool state ──────────────────────────────────────────────────────
let dimFrom = null; // id of the first-clicked post

// ── Object snap ───────────────────────────────────────────────────────────────
let objectSnap = null; // { x, y, type } | null

let syncToolbox = null; // set once setupToolbox() runs; re-syncs action buttons on selection change

function setSelection(newSel) {
  selection = newSel;
  scheduleRender();
  updateSelectionUI();
}

function getSelection() { return selection; }

function updateSelectionUI() {
  const lbl = document.getElementById('status-selection');
  if (lbl) {
    const n = selection.size;
    lbl.textContent = n === 0 ? '' : n === 1 ? '1 object selected' : `${n} objects selected`;
  }
  // Toolbox action buttons depend on selection, which lives outside the store.
  if (syncToolbox) syncToolbox();
}

// ─── Clipboard / duplicate / nudge / select-all ───────────────────────────────

let clipboard = []; // deep-cloned objects from the last copy

function snapshotSelection() {
  const doc = store.getDoc();
  return JSON.parse(JSON.stringify(doc.objects.filter(o => selection.has(o.id))));
}

function copySelection() {
  if (selection.size) clipboard = snapshotSelection();
}

/**
 * Clone `source` objects into `doc` with new ids, offset by (ox, oy). Shared by
 * paste/duplicate and array so the rules can't drift. Two passes: independent objects
 * first, then dependents (spans, accessories, reference dims) — a dependent is cloned
 * only when everything it references was also copied, with its refs remapped.
 * Returns the Set of new ids.
 */
function cloneObjectsInto(doc, source, ox, oy) {
  const newIds = new Set();
  const idMap  = new Map(); // old id → new id
  for (const o of source) {
    if (o.type === 'span' || o.type === 'accessory' || o.type === 'refdim') continue;
    const clone  = JSON.parse(JSON.stringify(o));
    const prefix = o.type === 'post' ? 'p' : o.type === 'zone' ? 'z' : o.type === 'label' ? 'l' : o.type === 'dim' ? 'd' : 'o';
    clone.id = uid(prefix);
    idMap.set(o.id, clone.id);
    translateObj(clone, ox, oy);
    doc.objects.push(clone);
    newIds.add(clone.id);
  }
  for (const o of source) {
    if (o.type === 'span' || o.type === 'refdim') {
      const a = idMap.get(o.postA), b = idMap.get(o.postB);
      if (!a || !b) continue;
      const clone = JSON.parse(JSON.stringify(o));
      clone.id = uid(o.type === 'span' ? 's' : 'r');
      clone.postA = a; clone.postB = b;
      doc.objects.push(clone);
      newIds.add(clone.id);
    } else if (o.type === 'accessory') {
      const host = idMap.get(o.host);
      if (!host) continue;
      const clone = JSON.parse(JSON.stringify(o));
      clone.id = uid('a'); clone.host = host;
      if (typeof clone.x === 'number') clone.x += ox;
      if (typeof clone.y === 'number') clone.y += oy;
      doc.objects.push(clone);
      newIds.add(clone.id);
    }
  }
  return newIds;
}

/** Paste a set of cloned objects with new ids, offset, then select them. */
function pasteObjects(source, offsetMm = 200) {
  if (!source || !source.length) return;
  let newIds = new Set();
  store.mutate(doc => { newIds = cloneObjectsInto(doc, source, offsetMm, offsetMm); });
  if (newIds.size) setSelection(newIds);
}

function duplicateSelection() { pasteObjects(snapshotSelection()); }
function pasteClipboard()     { pasteObjects(clipboard); }

/** Repeat the current selection `count` times, each copy offset by i·(dx,dy). */
function arraySelection(count, dx, dy) {
  const source = snapshotSelection();
  if (!source.length || !(count >= 1)) return;
  const allNew = new Set();
  store.mutate(doc => {
    for (let i = 1; i <= count; i++) {
      for (const id of cloneObjectsInto(doc, source, dx * i, dy * i)) allNew.add(id);
    }
  });
  if (allNew.size) setSelection(allNew);
}

/** Inline "count, dx, dy" typer to array the selection. */
function openArray() {
  if (!selection.size) return;
  const doc  = store.getDoc();
  const pts  = doc.objects.filter(o => selection.has(o.id)).map(objAnchor).filter(Boolean);
  if (!pts.length) return;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const lh = doc.layout.heightM * 1000;
  const r  = canvas.getBoundingClientRect();
  const sc = modelToCanvas(cx, cy, doc.view, lh);
  showInlineInput({
    x: r.left + sc.x, y: r.top + sc.y, placeholder: 'count, dx, dy', math: false,
    onCommit: (_v, raw) => {
      const parts = String(raw).split(',');
      if (parts.length !== 3) return 'Enter: count, dx, dy';
      const n  = Math.round(evalExpr(parts[0]));
      const dx = evalExpr(parts[1]), dy = evalExpr(parts[2]);
      if (!(n >= 1) || isNaN(dx) || isNaN(dy)) return 'Invalid count / dx / dy';
      arraySelection(n, dx, dy);
      return null;
    },
  });
}

function selectAll() {
  const doc = store.getDoc();
  setSelection(new Set(doc.objects.map(o => o.id)));
}

/** Anchor point of a movable object (dim uses its midpoint), or null. */
function objAnchor(o) {
  if (o.type === 'dim') return { x: (o.x0 + o.x1) / 2, y: (o.y0 + o.y1) / 2 };
  return typeof o.x === 'number' ? { x: o.x, y: o.y } : null;
}

/** Translate an object by (dx,dy) in place — handles {x,y} and dim {x0,y0,x1,y1}. */
function translateObj(o, dx, dy) {
  if (o.type === 'dim') { o.x0 += dx; o.y0 += dy; o.x1 += dx; o.y1 += dy; return; }
  if (typeof o.x === 'number') o.x += dx;
  if (typeof o.y === 'number') o.y += dy;
}

/** Move all selected posts/zones/labels/dims by an exact (dx,dy) mm, respecting locked axes. */
function moveSelectionBy(dx, dy) {
  if (!selection.size) return;
  store.mutate(d => {
    for (const o of d.objects) {
      if (!selection.has(o.id) || o.type === 'span') continue;
      if (o.type === 'dim') { translateObj(o, dx, dy); continue; }
      const lock = o.type === 'post' ? lockedAxes(o.id, d.constraints, selection) : { xLocked: false, yLocked: false };
      if (typeof o.x === 'number' && !lock.xLocked) o.x += dx;
      if (typeof o.y === 'number' && !lock.yLocked) o.y += dy;
    }
  });
}

/** Inline "dx, dy" typer to move the selection by an exact offset (each field math-aware). */
function openTypedMove() {
  if (!selection.size) return;
  const doc  = store.getDoc();
  const pts  = doc.objects.filter(o => selection.has(o.id)).map(objAnchor).filter(Boolean);
  if (!pts.length) return;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const lh = doc.layout.heightM * 1000;
  const r  = canvas.getBoundingClientRect();
  const sc = modelToCanvas(cx, cy, doc.view, lh);
  showInlineInput({
    x: r.left + sc.x, y: r.top + sc.y, placeholder: 'dx, dy (mm)', math: false,
    onCommit: (_v, raw) => {
      const parts = String(raw).split(',');
      if (parts.length !== 2) return 'Enter dx, dy';
      const dx = evalExpr(parts[0]), dy = evalExpr(parts[1]);
      if (isNaN(dx) || isNaN(dy)) return 'Invalid dx / dy';
      moveSelectionBy(dx, dy);
      return null;
    },
  });
}

/** Move selected posts/zones by (dx,dy) steps; step = snap spacing (or 10mm), 1mm when fine. */
function nudgeSelection(dx, dy, fine) {
  if (!selection.size) return;
  const doc  = store.getDoc();
  const step = fine ? 1 : (doc.settings.snapEnabled ? doc.settings.snapMm : 10);
  store.mutate(d => {
    for (const o of d.objects) {
      if (!selection.has(o.id) || o.type === 'span') continue; // spans derive from posts
      const lock = o.type === 'post' ? lockedAxes(o.id, d.constraints, selection) : { xLocked: false, yLocked: false };
      if (typeof o.x === 'number' && !lock.xLocked) o.x += dx * step;
      if (typeof o.y === 'number' && !lock.yLocked) o.y += dy * step;
    }
  });
}

/**
 * Rotate the selection rigidly by deltaDeg (CCW positive, model space) about the
 * centroid of the selected objects' anchors. Constraints that encode an absolute
 * direction or anchor a selected post to the world (or to an unselected parent)
 * can't survive a rigid rotation — those refuse up front with a toast instead of
 * letting the re-solve snap posts back. Rotation-safe constraints are carried
 * along: angle values get the delta added, and on odd quarter-turns alignH/alignV
 * swap kinds.
 */
function rotateSelectionBy(deltaDeg) {
  if (!selection.size) return;
  const norm = v => ((v % 360) + 360) % 360;
  const delta = norm(deltaDeg);
  if (!delta) return;
  const quarterTurn = delta % 90 === 0;
  const oddQuarter  = quarterTurn && delta % 180 !== 0;

  const doc = store.getDoc();
  const why = rotationBlockReason(selection, doc.constraints, quarterTurn);
  if (why) { showToast(`Rotation blocked — ${why}. Remove the constraint or change the selection.`, 'info'); return; }

  const pts = doc.objects.filter(o => selection.has(o.id)).map(objAnchor).filter(Boolean);
  if (!pts.length) return;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

  const rad = delta * Math.PI / 180;
  // Exact quarter-turns snap cos/sin to 0/±1 so grid coordinates stay exact.
  const cos = quarterTurn ? Math.round(Math.cos(rad)) : Math.cos(rad);
  const sin = quarterTurn ? Math.round(Math.sin(rad)) : Math.sin(rad);
  const rot = (x, y) => ({ x: cx + (x - cx) * cos - (y - cy) * sin,
                           y: cy + (x - cx) * sin + (y - cy) * cos });

  store.mutate(d => {
    for (const c of d.constraints) {
      if (!selection.has(c.child)) continue;
      if (c.kind === 'angle') c.valueDeg = norm((c.valueDeg ?? 0) + delta);
      if (oddQuarter && c.kind === 'alignH') c.kind = 'alignV';
      else if (oddQuarter && c.kind === 'alignV') c.kind = 'alignH';
    }
    for (const o of d.objects) {
      if (!selection.has(o.id) || o.type === 'span' || o.type === 'refdim') continue; // derived from posts
      if (o.type === 'dim') {
        const a = rot(o.x0, o.y0), b = rot(o.x1, o.y1);
        o.x0 = a.x; o.y0 = a.y; o.x1 = b.x; o.y1 = b.y;
        continue;
      }
      if (typeof o.x === 'number') { const p = rot(o.x, o.y); o.x = p.x; o.y = p.y; }
      if (o.type === 'post') o.footplateRotationDeg = norm((o.footplateRotationDeg ?? 0) + delta);
      // Rect zones have no rotation of their own: odd quarter-turns swap the sides;
      // other angles just carry the centre (the rect stays axis-aligned).
      if (o.type === 'zone' && o.shape !== 'circle' && oddQuarter) {
        const w = o.widthMm; o.widthMm = o.heightMm; o.heightMm = w;
      }
    }
  });
}

/** Inline angle typer to rotate the selection (positive = CCW). */
function openTypedRotate() {
  if (!selection.size) return;
  const doc  = store.getDoc();
  const pts  = doc.objects.filter(o => selection.has(o.id)).map(objAnchor).filter(Boolean);
  if (!pts.length) return;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const lh = doc.layout.heightM * 1000;
  const r  = canvas.getBoundingClientRect();
  const sc = modelToCanvas(cx, cy, doc.view, lh);
  showInlineInput({
    x: r.left + sc.x, y: r.top + sc.y, placeholder: 'angle° (CCW+)', math: false,
    onCommit: (_v, raw) => {
      const deg = evalExpr(raw);
      if (isNaN(deg)) return 'Invalid angle';
      rotateSelectionBy(deg);
      return null;
    },
  });
}

document.addEventListener('zc:rotate',     e => rotateSelectionBy(e.detail?.deltaDeg ?? 0));
document.addEventListener('zc:rotatefree', () => openTypedRotate());

// ─── Render loop ──────────────────────────────────────────────────────────────

let rafId = null;

function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(frame);
}

// ── Contextual status hint — tells you what the active tool wants next ─────────
// Updated from the render loop (every state change schedules a render), with a
// change guard so the DOM write only happens when the text actually changes.
const statusHintEl = document.getElementById('status-hint');
const TOOL_HINTS = {
  select:        'Right-click to add post · Middle-drag / Space-drag to pan · V=Select G=Move Q=Rotate R=Measure · F=Fit',
  move:          'Move: drag posts freely — object snapping off, align guides + 100 mm spacing snap on',
  rotate:        'Rotate: with a selection, drag anywhere — spins about the selection centre in 5° steps, hold Shift for free angle',
  split:         'Split: click a panel to insert a post — stays active for successive splits',
  measure:       'Measure: click the first point',
  dimension:     'Dimension: click the first post',
  panelDim:      'Panel width: click a panel to set its width (up to the max panel run)',
  'add-post':    'Click to place a post · press-and-hold to place then drag it',
  'add-bollard': 'Click to place a bollard · press-and-hold to place then drag it',
  'add-label':   'Click to place a text note',
  zone:          'Drag to draw a rectangular zone',
  'zone-circle': 'Drag from the centre to draw a circular zone',
  trace:         'Trace: sketch walls freehand — gaps become doorways · Enter or ✓ to commit',
  'bg-calibrate': 'Calibrate: click the first of two points a known distance apart',
};
let lastHint = null;
function updateStatusHint() {
  if (!statusHintEl) return;
  const t  = getActiveTool();
  let text = TOOL_HINTS[t] ?? TOOL_HINTS.select;
  if (t === 'dimension'    && dimFrom)     text = 'Dimension: click the second post';
  if (t === 'measure'      && measureFrom) text = 'Measure: click the second point';
  if (t === 'bg-calibrate' && bgCalibPt1)  text = 'Calibrate: click the second point';
  if (text !== lastHint) { lastHint = text; statusHintEl.textContent = text; }
}

function frame() {
  rafId = null;
  updateStatusHint(); // cheap (guarded) — keeps the hint in step with tool + click state
  dpr   = devicePixelRatio;
  const pxW = Math.round(canvas.clientWidth  * dpr);
  const pxH = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width  = pxW;
    canvas.height = pxH;
  }
  const isMeasure = getActiveTool() === 'measure';
  const isCalib   = getActiveTool() === 'bg-calibrate';
  const mo = (isMeasure || measureResult || isCalib)
    ? {
        from:        isMeasure ? measureFrom   : null,
        cursor:      isMeasure ? measureCursor : null,
        result:      isMeasure ? measureResult : null,
        calibration: isCalib   ? { pt1: bgCalibPt1, pt2: bgCalibPt2 } : null,
      }
    : null;
  render(canvas, ctx, store.getDoc(), dpr, selection, marquee, dragOverlay, hoveredZoneId, hoveredPostId, hoveredConstraintId, constraintRefPostId, mo, objectSnap);
}

store.subscribe(scheduleRender);
window.addEventListener('resize', scheduleRender);

// Rotate/resize: Chromium keeps the absolutely-positioned toolbox's stale
// shrink-to-fit width when its wrapped columns re-flow — force a fresh layout.
window.addEventListener('resize', () => {
  const tbx = document.getElementById('toolbox');
  if (!tbx) return;
  tbx.style.display = 'none';
  void tbx.offsetWidth;   // flush layout
  tbx.style.display = ''; // restore stylesheet value
});

// Hover tracking — zone dimensions, post constraint badges
const tooltip        = document.getElementById('constraint-tooltip');
const measureTooltip = document.getElementById('measure-tooltip');

canvas.addEventListener('pointermove', e => {
  if (!e.isPrimary || isGestureActive()) return; // second finger of a pinch is not a hover
  const r   = canvas.getBoundingClientRect();
  const sx  = e.clientX - r.left;
  const sy  = e.clientY - r.top;
  const doc = store.getDoc();
  const mp  = canvasToModel(sx, sy, doc.view, doc.layout.heightM * 1000);
  let needRender = false;

  // Zone hover (handles both rect and circle zones)
  const zoneHit = doc.objects.find(o => {
    if (o.type !== 'zone') return false;
    if (o.shape === 'circle') {
      const r = o.radiusMm ?? o.widthMm / 2;
      return Math.hypot(mp.x - o.x, mp.y - o.y) <= r;
    }
    return mp.x >= o.x - o.widthMm / 2 && mp.x <= o.x + o.widthMm / 2 &&
           mp.y >= o.y - o.heightMm / 2 && mp.y <= o.y + o.heightMm / 2;
  });
  const zid = zoneHit?.id ?? null;
  if (zid !== hoveredZoneId) { hoveredZoneId = zid; needRender = true; }

  // Post hover
  const postHit = pickObject(sx, sy, doc.objects, doc.view, doc.layout.heightM * 1000);
  const pid = (postHit?.type === 'post') ? postHit.id : null;
  if (pid !== hoveredPostId) { hoveredPostId = pid; needRender = true; }

  // Constraint badge hover (uses positions from last render)
  const badge = getConstraintBadgeHits().find(b => Math.hypot(sx - b.sx, sy - b.sy) <= b.sr);
  const cid   = badge?.constraintId ?? null;
  if (cid !== hoveredConstraintId) { hoveredConstraintId = cid; needRender = true; }
  // Highlight the parent post that the hovered constraint references
  const refId = badge?.constraint?.parent ?? null;
  const resolvedRefId = refId && doc.objects.find(o => o.id === refId) ? refId : null;
  if (resolvedRefId !== constraintRefPostId) { constraintRefPostId = resolvedRefId; needRender = true; }

  // Constraint badge tooltip
  if (badge && tooltip) {
    tooltip.textContent = constraintLabel(badge.constraint, doc.objects);
    tooltip.style.display = 'block';
    tooltip.style.left    = (e.clientX + 14) + 'px';
    tooltip.style.top     = (e.clientY - 32) + 'px';
  } else if (tooltip) {
    tooltip.style.display = 'none';
  }

  // Object snap indicator — only for tools that place something on click; in plain
  // select/move hover it's dead weight (drags do their own snap in interaction.js).
  const snapTools = getActiveTool() === 'add-post' || getActiveTool() === 'add-bollard' ||
                    getActiveTool() === 'add-label';
  const oSnap = snapTools ? findObjectSnap(mp.x, mp.y, doc, doc.view.scale) : null;
  if (oSnap?.x !== objectSnap?.x || oSnap?.y !== objectSnap?.y || oSnap?.type !== objectSnap?.type) {
    objectSnap = oSnap;
    needRender = true;
  }

  // Measure cursor tracking
  if (getActiveTool() === 'measure') {
    const snap = measureSnapPoint(sx, sy, doc);
    measureCursor = snap;
    needRender = true;
    if (measureTooltip) {
      const info = measureHoverInfo(mp, doc);
      if (info) {
        measureTooltip.textContent = info;
        measureTooltip.style.display = 'block';
        measureTooltip.style.left    = (e.clientX + 14) + 'px';
        measureTooltip.style.top     = (e.clientY - 36) + 'px';
      } else {
        measureTooltip.style.display = 'none';
      }
    }
  } else if (measureCursor !== null) {
    measureCursor = null; needRender = true;
    if (measureTooltip) measureTooltip.style.display = 'none';
  }

  if (needRender) scheduleRender();
});

canvas.addEventListener('pointerleave', () => {
  let needRender = false;
  if (hoveredZoneId       !== null) { hoveredZoneId       = null; needRender = true; }
  if (hoveredPostId       !== null) { hoveredPostId       = null; needRender = true; }
  if (hoveredConstraintId !== null) { hoveredConstraintId = null; needRender = true; }
  if (constraintRefPostId !== null) { constraintRefPostId = null; needRender = true; }
  if (measureCursor       !== null) { measureCursor       = null; needRender = true; }
  if (objectSnap          !== null) { objectSnap          = null; needRender = true; }
  if (tooltip)        tooltip.style.display        = 'none';
  if (measureTooltip) measureTooltip.style.display = 'none';
  if (needRender) scheduleRender();
});

// Badge click — select post + open properties (capture phase so it fires before interaction.js)
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary) return;
  const r     = canvas.getBoundingClientRect();
  const badge = getConstraintBadgeHits().find(b =>
    Math.hypot(e.clientX - r.left - b.sx, e.clientY - r.top - b.sy) <= b.sr
  );
  if (badge) {
    e.stopImmediatePropagation();
    runToolTap(e, () => {
      setSelection(new Set([badge.postId]));
      updateSelectionUI();
      scheduleRender();
      canvas.dispatchEvent(new CustomEvent('zc:openprops', { bubbles: true }));
    });
  }
}, true); // capture phase


// ── Measure tool — click-click interaction ────────────────────────────────────

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary || getActiveTool() !== 'measure') return;
  e.stopImmediatePropagation();
  runToolTap(e, () => {
    const r    = canvas.getBoundingClientRect();
    const doc  = store.getDoc();
    const snap = measureSnapPoint(e.clientX - r.left, e.clientY - r.top, doc);

    if (!measureFrom) {
      measureFrom   = snap;
      measureResult = null;
    } else {
      const dx   = snap.x - measureFrom.x, dy = snap.y - measureFrom.y;
      const dist = Math.hypot(dx, dy);
      const unit = doc.settings.displayUnit;
      const label = fmtLen(dist, unit);
      measureResult = { x0: measureFrom.x, y0: measureFrom.y, x1: snap.x, y1: snap.y, label };
      measureFrom   = null;
    }
    scheduleRender();
  });
}, true);

// ── Split tool — click a panel to insert a post, dividing it in two ───────────

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary || getActiveTool() !== 'split') return;
  e.stopImmediatePropagation();
  runToolTap(e, () => {
    const r    = canvas.getBoundingClientRect();
    const doc  = store.getDoc();
    const lhMm = doc.layout.heightM * 1000;
    const obj  = pickObject(e.clientX - r.left, e.clientY - r.top, doc.objects, doc.view, lhMm);
    if (!obj || obj.type !== 'span') { showToast('Click a panel to split it.', 'info'); return; }
    if (obj.spanKind !== 'panel')    { showToast('Only panels can be split — doors and gates are single leaves.', 'info'); return; }
    const err = splitSpanAt(obj.id, canvasToModel(e.clientX - r.left, e.clientY - r.top, doc.view, lhMm));
    if (err) showToast(err, 'info');
    // Tool stays active — keep clicking for successive splits.
  });
}, true);

/** Insert a post on `spanId` at the point of `mp` projected onto the span, replacing it with two panels. */
function splitSpanAt(spanId, mp) {
  let newPostId = null;
  const result = store.mutate(d => {
    const span = d.objects.find(o => o.id === spanId);
    if (!span) return false;
    const postMap = buildPostMap(d.objects);
    const pA = postMap[span.postA], pB = postMap[span.postB];
    if (!pA || !pB) return false;
    const dx = pB.x - pA.x, dy = pB.y - pA.y, len = Math.hypot(dx, dy);
    if (len < 600) return false; // too short to yield two buildable panels
    // Project the click onto the post-centre line, kept ≥300mm from either post.
    const margin = Math.min(0.45, 300 / len);
    const t = Math.max(margin, Math.min(1 - margin, ((mp.x - pA.x) * dx + (mp.y - pA.y) * dy) / (len * len)));
    const np = createPost(pA.x + t * dx, pA.y + t * dy, {
      material: pA.material, heightMm: pA.heightMm,
      footplate: pA.footplate, footplateRotationDeg: pA.footplateRotationDeg,
    });
    newPostId = np.id;
    // Two panels inheriting the original's settings; faces at the new post auto-detect.
    const half = (aId, bId, faceA, faceB) => {
      const s = createSpan(aId, bId, {
        spanKind: span.spanKind, faceA, faceB,
        floorClearanceMm: span.floorClearanceMm, meshSide: span.meshSide,
        kindProps: JSON.parse(JSON.stringify(span.kindProps ?? {})),
      });
      s.heightMm = span.heightMm;
      return s;
    };
    d.objects.push(np, half(span.postA, np.id, span.faceA, null), half(np.id, span.postB, null, span.faceB));
    d.objects = d.objects.filter(o => o.id !== spanId);
  });
  if (result === false) return 'That panel is too short to split (needs ≥ 600 mm between posts).';
  if (newPostId) { setSelection(new Set([newPostId])); updateSelectionUI(); }
  return null;
}

// ── Dimension tool — click two posts to open Set Dimension ────────────────────

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary || getActiveTool() !== 'dimension') return;
  e.stopImmediatePropagation();
  e.preventDefault(); // keep focus on the inline input we're about to create
  runToolTap(e, () => {
    const r   = canvas.getBoundingClientRect();
    const doc = store.getDoc();
    const lh  = doc.layout.heightM * 1000;
    const obj = pickObject(e.clientX - r.left, e.clientY - r.top, doc.objects, doc.view, lh);

    if (!obj || obj.type !== 'post') {   // click on empty space → cancel the pending pick
      dimFrom = null;
      setSelection(new Set());
      return;
    }
    // A pending first pick may have been deleted since it was clicked — restart from this post.
    if (dimFrom && !doc.objects.some(o => o.id === dimFrom && o.type === 'post')) dimFrom = null;
    if (!dimFrom) {                       // first post
      dimFrom = obj.id;
      setSelection(new Set([obj.id]));
    } else if (obj.id !== dimFrom) {      // second post
      const first  = dimFrom;
      const second = obj.id;
      dimFrom = null;
      setSelection(new Set([first, second]));

      const oriented = orientDimension(first, second); // { child, parent } or null → reference
      if (oriented) {
        // Driving dimension — inline typer; the freer post moves to the set distance.
        const pA = doc.objects.find(o => o.id === first);
        const pB = doc.objects.find(o => o.id === second);
        const curDist = Math.round(Math.hypot(pA.x - pB.x, pA.y - pB.y));
        const mid = modelToCanvas((pA.x + pB.x) / 2, (pA.y + pB.y) / 2, doc.view, lh);
        showInlineInput({
          x: r.left + mid.x, y: r.top + mid.y,
          initial: String(curDist), suffix: 'mm',
          onCommit: (val) => applyDimension(oriented.child, oriented.parent, val),
        });
      } else {
        // Would over-constrain → drop a reference (driven) dimension showing the live length.
        const id = store.mutate(d => {
          const rd = createRefDimension(first, second);
          d.objects.push(rd);
          return rd.id;
        });
        setSelection(new Set([id]));
        showToast('Reference dimension added (read-only — both posts are already positioned).', 'info');
      }
    }
  });
}, true);

// ── Panel-width tool — click a panel to constrain its width ───────────────────
// Unlike the dimension tool (two posts, centre-to-centre), this takes ONE click on a
// span and opens the inline typer to set its physical panel width (a panelDim constraint;
// the freer post then pivots about the anchor's pin to hold it — see zc:setpaneldim).
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary || getActiveTool() !== 'panelDim') return;
  e.stopImmediatePropagation();
  e.preventDefault(); // keep focus for the inline input
  runToolTap(e, () => {
    const r   = canvas.getBoundingClientRect();
    const doc = store.getDoc();
    const lh  = doc.layout.heightM * 1000;
    const obj = pickObject(e.clientX - r.left, e.clientY - r.top, doc.objects, doc.view, lh);
    if (!obj || obj.type !== 'span') { setSelection(new Set()); return; }
    setSelection(new Set([obj.id]));
    document.dispatchEvent(new CustomEvent('zc:setpaneldim', { detail: { spanId: obj.id } }));
  });
}, true);

// ── Add-post tool — click to place a post ─────────────────────────────────────

// Add-post / add-bollard placement + hold-to-move. Placement is DEFERRED so one press
// can't place twice: a quick tap places on release; pressing and holding ~600 ms without
// moving places the post and hands it to interaction.js for a live move-drag (align
// guides + object snap) so you can nudge it onto a neighbour. Either way the add tool
// stays active for the next placement.
const HOLD_TO_MOVE_MS = 600;
let holdTimer = null, hold = null; // hold = { ptr, e, bollard, x, y, done }

function placePost(e, bollard) {
  const r   = canvas.getBoundingClientRect();
  const doc = store.getDoc();
  const lh  = doc.layout.heightM * 1000;
  const raw = canvasToModel(e.clientX - r.left, e.clientY - r.top, doc.view, lh);
  // Object snap wins over grid snap when a snap point is under the cursor.
  const os  = findObjectSnap(raw.x, raw.y, doc, doc.view.scale);
  const mp  = os ? { x: os.x, y: os.y } : snapPoint(raw.x, raw.y, doc.settings);
  const id  = store.mutate(d => {
    const p = bollard
      ? createPost(Math.round(mp.x), Math.round(mp.y), { kind: 'bollard', material: 'steel' })
      : createPost(Math.round(mp.x), Math.round(mp.y));
    d.objects.push(p);
    if (!bollard) autoLink(d); // bollards never span
    return p.id;
  });
  setSelection(new Set([id]));
  return id;
}

function clearHold() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  hold = null;
}

function armAddTool(e, bollard) {
  e.stopImmediatePropagation();
  hold = { ptr: e.pointerId, e, bollard, x: e.clientX, y: e.clientY, done: false };
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (!hold || hold.done || isGestureActive()) return; // pinch took over → abort
    hold.done = true;
    beginGrab(placePost(hold.e, bollard), hold.e); // place now + live move-drag
  }, HOLD_TO_MOVE_MS);
}

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary || getActiveTool() !== 'add-post') return;
  armAddTool(e, false);
}, true);

// ── Add-bollard tool — click to place a bollard (no auto-linking; bollards never span) ──

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary || getActiveTool() !== 'add-bollard') return;
  armAddTool(e, true);
}, true);

// While an add tool is active, a press means place / hold-to-move — never a menu. Kill
// the context menu at the source (both the browser's native touch long-press menu AND
// input.js's zc:contextmenu). Registered before setupInput() so it wins on the canvas
// target (same-element listeners fire in registration order); capture + preventDefault +
// stopImmediatePropagation blocks the native menu and input.js's handler alike.
canvas.addEventListener('contextmenu', e => {
  const t = getActiveTool();
  if (t === 'add-post' || t === 'add-bollard') {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

// Movement past a small slop cancels the hold-to-move (stays a plain placement on release).
window.addEventListener('pointermove', e => {
  if (hold && !hold.done && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) {
    clearTimeout(holdTimer); holdTimer = null;
  }
});
// Release before the hold fired → plain placement at the release point (deferred, single).
window.addEventListener('pointerup', e => {
  if (hold && !hold.done && e.pointerId === hold.ptr) {
    hold.done = true;
    if (!isGestureActive()) placePost(e, hold.bollard);
  }
  clearHold();
});
window.addEventListener('pointercancel', clearHold);

// ── Add-label tool — click to place, then type the text inline ────────────────

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary || getActiveTool() !== 'add-label') return;
  e.stopImmediatePropagation();
  e.preventDefault(); // keep focus on the inline input
  runToolTap(e, () => {
    const r   = canvas.getBoundingClientRect();
    const doc = store.getDoc();
    const lh  = doc.layout.heightM * 1000;
    const mp  = canvasToModel(e.clientX - r.left, e.clientY - r.top, doc.view, lh);
    showInlineInput({
      x: e.clientX, y: e.clientY, placeholder: 'Label text…', math: false,
      onCommit: (_v, raw) => {
        const text = (raw ?? '').trim();
        if (!text) return null;                      // empty → don't create
        const id = store.mutate(d => {
          const l = createLabel(mp.x, mp.y, { text });
          d.objects.push(l);
          return l.id;
        });
        setSelection(new Set([id]));
        return null;
      },
    });
  });
}, true);

// Array (from context menu) → inline "count, dx, dy" typer
document.addEventListener('zc:array', () => openArray());

// Set Angle (from context menu) → inline typer at the child post
document.addEventListener('zc:setangle', e => {
  const { childId, parentId } = e.detail ?? {};
  const doc   = store.getDoc();
  const child = doc.objects.find(o => o.id === childId);
  const par   = doc.objects.find(o => o.id === parentId);
  if (!child || !par) return;
  const r  = canvas.getBoundingClientRect();
  const lh = doc.layout.heightM * 1000;
  const sc = modelToCanvas(child.x, child.y, doc.view, lh);
  const curDeg = Math.round(normDeg(Math.atan2(child.y - par.y, child.x - par.x) * 180 / Math.PI));
  showInlineInput({
    x: r.left + sc.x, y: r.top + sc.y, initial: String(curDeg), suffix: '°',
    onCommit: (val) => applyAngle(childId, parentId, val),
  });
});

// Set Panel Width (from context menu on a span) → inline typer at the span midpoint.
// Creates a panelDim constraint holding the physical panel width; the freer post pivots.
document.addEventListener('zc:setpaneldim', e => {
  const { spanId } = e.detail ?? {};
  const doc  = store.getDoc();
  const span = doc.objects.find(o => o.id === spanId && o.type === 'span');
  if (!span) return;
  const a = doc.objects.find(o => o.id === span.postA);
  const b = doc.objects.find(o => o.id === span.postB);
  if (!a || !b) return;
  const r   = canvas.getBoundingClientRect();
  const lh  = doc.layout.heightM * 1000;
  const mid = modelToCanvas((a.x + b.x) / 2, (a.y + b.y) / 2, doc.view, lh);
  // Prefill with the current physical panel width; a multi-bay run prefills its largest bay
  // (committing will pull the posts to a single panel of the typed width — capped at max run).
  // Sliding door: the "panel" is the LEAF (post c-c + gate extension).
  const postMap = buildPostMap(doc.objects);
  const maxRun  = doc.settings.maxPanelRunMm ?? 2400;
  const leaf    = span.spanKind === 'slidingDoor' ? slidingLeafLine(span, postMap) : null;
  const secs    = leaf ? [] : ghostPanelSections(span, postMap, panelConfig(doc.settings));
  const cur     = Math.round(leaf ? leaf.widthMm
                : secs.length === 1 ? secs[0].runMm
                : secs.length ? Math.max(...secs.map(s => s.runMm))
                : Math.min(maxRun, spanRunLength(span, postMap)));
  showInlineInput({
    x: r.left + mid.x, y: r.top + mid.y, initial: String(cur), suffix: 'mm',
    onCommit: (val) => applyPanelDim(span.postA, span.postB, val),
  });
});

// Double-click a dimension → edit its value inline
canvas.addEventListener('zc:editdim', e => {
  const { kind, id, sx, sy } = e.detail ?? {};
  const doc = store.getDoc();
  const postById = pid => doc.objects.find(o => o.id === pid);

  // Driving-constraint kinds share one edit path; only the field/unit/setter differ.
  const constraintEditors = {
    // 'dimc' covers both post-to-post dimensions and panel-width constraints — route the
    // commit by the constraint's actual kind so panel widths get the max-panel cap.
    dimc:   { value: c => c.valueMm,       suffix: 'mm',
              commit: (id, val) => {
                const k = store.getDoc().constraints.find(x => x.id === id)?.kind;
                return (k === 'panelDim' ? setPanelDimValue : setDimensionValue)(id, val);
              } },
    anglec: { value: c => c.valueDeg ?? 0, suffix: '°',  commit: setAngleValue },
    tiec:   { value: c => c.valueMm,       suffix: 'mm', commit: setTieEdgeValue },
  };
  const editor = constraintEditors[kind];
  if (editor) {
    const c = doc.constraints.find(k => k.id === id);
    if (!c) return;
    showInlineInput({
      x: sx, y: sy, initial: String(Math.round(editor.value(c))), suffix: editor.suffix,
      onCommit: (val) => editor.commit(id, val),
    });
  } else if (kind === 'refdim') {
    const rd = doc.objects.find(o => o.id === id && o.type === 'refdim');
    if (!rd) return;
    const a = postById(rd.postA), b = postById(rd.postB);
    if (!a || !b) return;
    if (!orientDimension(rd.postA, rd.postB)) {
      showToast('Reference dimension is read-only — both posts are already positioned.', 'info');
      return;
    }
    const cur = Math.round(Math.hypot(a.x - b.x, a.y - b.y));
    showInlineInput({
      x: sx, y: sy, initial: String(cur), suffix: 'mm',
      onCommit: (val) => convertRefToDimension(id, rd.postA, rd.postB, val),
    });
  }
});

// Double-click a label → edit its text inline
canvas.addEventListener('zc:editlabel', e => {
  const doc   = store.getDoc();
  const label = doc.objects.find(o => o.id === e.detail?.id && o.type === 'label');
  if (!label) return;
  const r  = canvas.getBoundingClientRect();
  const lh = doc.layout.heightM * 1000;
  const sc = modelToCanvas(label.x, label.y, doc.view, lh);
  showInlineInput({
    x: r.left + sc.x, y: r.top + sc.y, initial: label.text, math: false,
    onCommit: (_v, raw) => {
      const text = (raw ?? '').trim();
      store.mutate(d => { const l = d.objects.find(o => o.id === label.id); if (l && text) l.text = text; });
      return null;
    },
  });
});

// ── Background calibration — two-click to set real-world scale ────────────────

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary || getActiveTool() !== 'bg-calibrate') return;
  e.stopImmediatePropagation();
  runToolTap(e, () => {
    const r   = canvas.getBoundingClientRect();
    const doc = store.getDoc();
    const mp  = canvasToModel(e.clientX - r.left, e.clientY - r.top, doc.view, doc.layout.heightM * 1000);

    if (!bgCalibPt1) {
      bgCalibPt1 = { x: mp.x, y: mp.y };
      scheduleRender();
    } else {
      bgCalibPt2 = { x: mp.x, y: mp.y };
      scheduleRender();
      document.getElementById('modal-bg-calibrate')?.showModal();
      const distInput = document.getElementById('bg-cal-dist');
      if (distInput) { distInput.value = ''; distInput.focus(); }
    }
  });
}, true);

/** Snap the cursor to a nearby post center or span bracket pin; otherwise free cursor. */
function measureSnapPoint(sx, sy, doc) {
  const SNAP_PX = 16;
  const mp      = canvasToModel(sx, sy, doc.view, doc.layout.heightM * 1000);
  const snapR   = SNAP_PX / doc.view.scale;
  const postMap = buildPostMap(doc.objects);
  const cfg     = panelConfig(doc.settings);

  for (const o of doc.objects) {
    if (o.type !== 'post') continue;
    if (Math.hypot(mp.x - o.x, mp.y - o.y) <= snapR) return { x: o.x, y: o.y, snapped: true };
  }
  // Ghost post centres (intermediate posts on long panel runs)
  for (const o of doc.objects) {
    if (o.type !== 'span') continue;
    for (const g of ghostPostCenters(o, postMap, cfg)) {
      if (Math.hypot(mp.x - g.x, mp.y - g.y) <= snapR) return { x: g.x, y: g.y, snapped: true };
    }
  }
  for (const o of doc.objects) {
    if (o.type !== 'span') continue;
    const h = spanHinges(o, postMap);
    if (!h) continue;
    if (Math.hypot(mp.x - h.hA.x, mp.y - h.hA.y) <= snapR) return { x: h.hA.x, y: h.hA.y, snapped: true };
    if (Math.hypot(mp.x - h.hB.x, mp.y - h.hB.y) <= snapR) return { x: h.hB.x, y: h.hB.y, snapped: true };
  }
  return { x: mp.x, y: mp.y, snapped: false };
}

/** Returns a short info string when cursor is over an object in measure mode. */
function measureHoverInfo(mp, doc) {
  const postMap = buildPostMap(doc.objects);
  for (const o of doc.objects) {
    if (o.type === 'post') {
      if (o.kind === 'bollard') {
        if (Math.hypot(mp.x - o.x, mp.y - o.y) <= BOLLARD.plateOd / 2 + 12)
          return `Bollard · ${BOLLARD.od}×${BOLLARD.wall} CHS · h = ${o.heightMm} mm`;
        continue;
      }
      const prof = postProfile(o.material);
      const hw = prof.w / 2 + 12;
      if (Math.abs(mp.x - o.x) <= hw && Math.abs(mp.y - o.y) <= hw)
        return `Post · ${o.material} ${prof.w}×${prof.h} · h = ${o.heightMm} mm`;
    }
    if (o.type === 'span') {
      const h = spanHinges(o, postMap);
      if (!h) continue;
      const run = Math.round(Math.hypot(h.hB.x - h.hA.x, h.hB.y - h.hA.y));
      return `${o.spanKind} · run ${run} mm`;
    }
  }
  return null;
}

// ─── Initial view centering ───────────────────────────────────────────────────

function centerView() {
  const doc     = store.getDoc();
  const layoutW = doc.layout.widthM  * 1000;
  const layoutH = doc.layout.heightM * 1000;
  const cssW    = canvas.clientWidth  || window.innerWidth;
  const cssH    = canvas.clientHeight || window.innerHeight;
  const scale   = Math.min((cssW * 0.82) / layoutW, (cssH * 0.82) / layoutH);
  store.updateView({
    scale,
    panX: (cssW - layoutW * scale) / 2,
    panY: (cssH - layoutH * scale) / 2,
  });
}

/** Model-space bounds of the given objects (Set of ids, or null = all). */
function objectBounds(ids) {
  const doc  = store.getDoc();
  const objs = doc.objects.filter(o => !ids || ids.has(o.id));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const o of objs) {
    if (o.type === 'post') {
      const half = postProfile(o.material).w / 2;
      add(o.x - half, o.y - half); add(o.x + half, o.y + half);
    } else if (o.type === 'zone') {
      add(o.x - o.widthMm / 2, o.y - o.heightMm / 2);
      add(o.x + o.widthMm / 2, o.y + o.heightMm / 2);
    } else if (o.type === 'span') {
      const pa = doc.objects.find(p => p.id === o.postA);
      const pb = doc.objects.find(p => p.id === o.postB);
      if (pa) add(pa.x, pa.y);
      if (pb) add(pb.x, pb.y);
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** Frame the given bounds in the viewport (with padding). */
function zoomToBounds(b) {
  if (!b) return;
  const doc     = store.getDoc();
  const layoutH = doc.layout.heightM * 1000;
  const cssW    = canvas.clientWidth  || window.innerWidth;
  const cssH    = canvas.clientHeight || window.innerHeight;
  const w = Math.max(b.maxX - b.minX, 500);
  const h = Math.max(b.maxY - b.minY, 500);
  const scale = Math.max(0.005, Math.min(20, Math.min((cssW * 0.82) / w, (cssH * 0.82) / h)));
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  store.updateView({
    scale,
    panX: cssW / 2 - cx * scale,
    panY: cssH / 2 - (layoutH - cy) * scale,
  });
}

/** F key — frame the selection, or the whole layout when nothing is selected. */
function zoomToFit() {
  const b = selection.size ? objectBounds(selection) : objectBounds(null);
  if (b) zoomToBounds(b);
  else centerView();
}

// ─── Wire subsystems ──────────────────────────────────────────────────────────

const props = setupProperties(store, getSelection);

setupInput(canvas, store);
setupGestures(canvas, store);

setupInteraction(canvas, store, getSelection, setSelection, m => {
  marquee = m;
  scheduleRender();
}, overlay => {
  dragOverlay = overlay;
  scheduleRender();
});

setupSettings(store);
setupToolbar(store);
setupBom(store);

setupAddConstraint(store);
setupContextMenu(store, getSelection, setSelection, () => props.open(), duplicateSelection);

// ── Unified tool switching ─────────────────────────────────────────────────────

function switchTool(tool) {
  const wasMeasure = getActiveTool() === 'measure';
  const wasCalib   = getActiveTool() === 'bg-calibrate';
  const wasTrace   = getActiveTool() === 'trace';
  setActiveTool(tool);
  setToolboxActive(tool);
  const crosshairTools = ['zone', 'zone-circle', 'measure', 'bg-calibrate', 'dimension', 'panelDim', 'add-post', 'add-bollard', 'add-label', 'split', 'trace'];
  canvas.style.cursor = tool === 'move' ? 'move' : tool === 'rotate' ? 'grab' : (crosshairTools.includes(tool) ? 'crosshair' : '');
  if (wasMeasure && tool !== 'measure') {
    measureFrom = null; measureCursor = null; measureResult = null;
  }
  if (wasCalib && tool !== 'bg-calibrate') {
    bgCalibPt1 = null; bgCalibPt2 = null;
  }
  if (wasTrace && tool !== 'trace') document.dispatchEvent(new CustomEvent('zc:trace-clear'));
  if (tool !== 'dimension') dimFrom = null;    // clear a pending first-post pick
  scheduleRender();
}

// ── Trace tool ✓/✕ bar ──────────────────────────────────────────────────────────
{
  const bar = document.getElementById('trace-bar');
  document.addEventListener('zc:trace-changed', e => {
    if (bar) bar.style.display = (getActiveTool() === 'trace' && (e.detail?.count ?? 0) > 0) ? 'flex' : 'none';
  });
  document.getElementById('trace-done')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent('zc:trace-commit')));
  document.getElementById('trace-clear')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent('zc:trace-clear')));
  // After a commit, frame the new layout.
  document.addEventListener('zc:trace-committed', () => { if (bar) bar.style.display = 'none'; updateSelectionUI(); requestAnimationFrame(zoomToFit); });
}

// ── Toolbox ────────────────────────────────────────────────────────────────────

syncToolbox = setupToolbox(store, getSelection, switchTool);

// ── Help / shortcuts dialog ─────────────────────────────────────────────────────

const helpModal = document.getElementById('modal-help');
function openHelp()  { if (helpModal && !helpModal.open) helpModal.showModal(); }
document.getElementById('btn-help')?.addEventListener('click', openHelp);
document.getElementById('help-close')?.addEventListener('click', () => helpModal?.close());
helpModal?.addEventListener('click', e => { if (e.target === helpModal) helpModal.close(); });

// ── Status-bar metrics + broken-constraint indicator ────────────────────────────
// Both scan every object/constraint, and the store notifies on every pan/zoom and drag
// frame — so coalesce to one rAF-scheduled update per frame instead of one per notify.
const metricsEl = document.getElementById('status-metrics');
const brokenEl  = document.getElementById('status-broken');
function updateStatusBar() {
  const doc = store.getDoc();
  if (metricsEl) {
    const posts   = doc.objects.filter(o => o.type === 'post');
    const spans   = doc.objects.filter(o => o.type === 'span' && o.spanKind !== 'gap');
    const postMap = buildPostMap(doc.objects);
    const totalMm = spans.reduce((s, sp) => s + spanRunLength(sp, postMap), 0);
    metricsEl.textContent = posts.length ? `${posts.length} posts · ${fmtLen(totalMm, doc.settings.displayUnit)} run` : '';
  }
  if (brokenEl) {
    const n = countBrokenConstraints(doc);
    brokenEl.textContent = n ? `⚠ ${n} constraint${n === 1 ? '' : 's'} unsatisfied` : '';
    brokenEl.classList.toggle('has-broken', n > 0);
  }
}
let statusScheduled = false;
store.subscribe(() => {
  if (statusScheduled) return;
  statusScheduled = true;
  requestAnimationFrame(() => { statusScheduled = false; updateStatusBar(); });
});
updateStatusBar();

const featModal = document.getElementById('modal-features');
document.getElementById('btn-features')?.addEventListener('click', () => { if (featModal && !featModal.open) featModal.showModal(); });
document.getElementById('features-close')?.addEventListener('click', () => featModal?.close());
featModal?.addEventListener('click', e => { if (e.target === featModal) featModal.close(); });

// ── Menu collapse toggle (phone-only via CSS) — frees space for tools + canvas ─

{
  const menuToggle = document.getElementById('menu-toggle');
  if (menuToggle) {
    const KEY    = 'zonecad:menuOpen';
    const stored = localStorage.getItem(KEY);
    // First visit on a small screen (narrow portrait OR short landscape) starts
    // collapsed — must match the CSS media query that shows the toggle.
    const small = matchMedia('(max-width: 760px), (max-height: 500px)').matches;
    let open = stored !== null ? stored === '1' : !small;
    const apply = () => {
      document.body.classList.toggle('menu-collapsed', !open);
      menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      window.dispatchEvent(new Event('resize')); // canvas re-measures via the existing listener
    };
    menuToggle.addEventListener('click', () => {
      open = !open;
      try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* private mode */ }
      apply();
    });
    apply();
  }
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  const k = e.key;
  if (k === 'Escape') {
    switchTool('select');
    measureFrom = null; measureResult = null;
    bgCalibPt1  = null; bgCalibPt2   = null;
    scheduleRender();
  }
  // Enter commits an in-progress trace (same as the ✓ button).
  if (k === 'Enter' && getActiveTool() === 'trace') { document.dispatchEvent(new CustomEvent('zc:trace-commit')); return; }
  if (k === '?') { openHelp(); return; }
  // Clipboard / selection shortcuts (Ctrl+Z/Y/S and Delete are handled in input.js).
  if (e.ctrlKey || e.metaKey) {
    const kl = k.toLowerCase();
    if (kl === 'c') { copySelection();      e.preventDefault(); return; }
    if (kl === 'v') { pasteClipboard();      e.preventDefault(); return; }
    if (kl === 'd') { duplicateSelection();  e.preventDefault(); return; }
    if (kl === 'a') { selectAll();           e.preventDefault(); return; }
    return; // leave undo/redo/save to input.js
  }

  // Arrow-key nudge (Shift = 1 mm fine step).
  if (k === 'ArrowUp')    { nudgeSelection(0,  1, e.shiftKey); if (selection.size) e.preventDefault(); return; }
  if (k === 'ArrowDown')  { nudgeSelection(0, -1, e.shiftKey); if (selection.size) e.preventDefault(); return; }
  if (k === 'ArrowLeft')  { nudgeSelection(-1, 0, e.shiftKey); if (selection.size) e.preventDefault(); return; }
  if (k === 'ArrowRight') { nudgeSelection( 1, 0, e.shiftKey); if (selection.size) e.preventDefault(); return; }

  {
    // Post ids in click order (selection Set preserves insertion order).
    const doc      = store.getDoc();
    const postIds  = [...selection].filter(id => doc.objects.some(o => o.id === id && o.type === 'post'));
    const selPost  = postIds[0];
    // 2+ posts → align directly to the first; single post → dialog to pick a reference.
    const align = kind => {
      if (postIds.length >= 2)      applyAlignToSelection(kind, postIds);
      else if (postIds.length === 1) openAddConstraint(kind, selPost);
    };
    // Aligns fire only with 2+ posts selected — with a single post selected V must still
    // return to the Select tool (the most-used key), not open the align dialog.
    if (k === 'h' || k === 'H') { if (postIds.length >= 2) { align('alignH'); return; } }
    if (k === 'e' || k === 'E') { if (selPost) { openAddConstraint('tieEdge', selPost); return; } }
    if (k === 'v' || k === 'V') {
      if (postIds.length >= 2) { align('alignV'); return; }
      switchTool('select');
      return;
    }
    if (k === 'k' || k === 'K') { if (postIds.length) { for (const id of postIds) applyLock(id); return; } }
    if (k === 'p' || k === 'P') {
      if (postIds.length < 2) { showToast('Select two or more posts to add a panel.', 'info'); return; }
      const ok = store.mutate(d => addPanelNearest(d, selection));
      if (!ok) showToast('No panel added — those posts are already fully linked.', 'info');
      return;
    }
    if (k === 'd' || k === 'D') { switchTool('dimension'); return; }
    if (k === 'w' || k === 'W') { switchTool('panelDim'); return; }
    if (k === 'n' || k === 'N') { switchTool('add-label'); return; }
    if (k === 'a' || k === 'A') { switchTool('add-post'); return; }
    if (k === 'b' || k === 'B') { switchTool('add-bollard'); return; }
    if (k === 'g' || k === 'G') { switchTool('move'); return; }
    if (k === 'm' || k === 'M') { if (selection.size) { openTypedMove(); return; } }
    if (k === 'q' || k === 'Q') { if (selection.size) { rotateSelectionBy(e.shiftKey ? 90 : -90); return; } }
    if (k === 'o' || k === 'O') { switchTool('rotate'); return; }
    if (k === 's' || k === 'S') { switchTool('split'); return; }
    if (k === 'r' || k === 'R') switchTool('measure');
    if (k === 'z' || k === 'Z') switchTool('zone');
    if (k === 'c' || k === 'C') switchTool('zone-circle');
    if (k === 't' || k === 'T') switchTool('trace');
    if (k === 'f' || k === 'F') { zoomToFit(); return; }
  }
});

// ── Background image ──────────────────────────────────────────────────────────

setBgDirtyCallback(scheduleRender);

function updateBgButtons() {
  // A restored autosave keeps background geometry but drops the image data URL — treat that as "no image".
  const hasBg = !!store.getDoc().background?.dataUrl;
  const calBtn = document.getElementById('btn-bg-calibrate');
  const remBtn = document.getElementById('btn-bg-remove');
  const opRow  = document.getElementById('bg-opacity-row');
  if (calBtn) calBtn.disabled = !hasBg;
  if (remBtn) remBtn.disabled = !hasBg;
  if (opRow)  opRow.style.display = hasBg ? 'flex' : 'none';
}

function importBackground() {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const probe = new Image();
      probe.onload = () => {
        const doc     = store.getDoc();
        const layoutH = doc.layout.heightM * 1000;
        const layoutW = doc.layout.widthM  * 1000;
        const imgAspect = probe.naturalWidth / probe.naturalHeight;
        const layAspect = layoutW / layoutH;
        const bgW = imgAspect > layAspect ? layoutW : layoutH * imgAspect;
        const bgH = imgAspect > layAspect ? layoutW / imgAspect : layoutH;
        store.mutate(d => {
          d.background = { dataUrl, x: 0, y: layoutH, widthMm: bgW, heightMm: bgH, opacity: 0.45 };
        });
        const opInput = document.getElementById('bg-opacity');
        if (opInput) opInput.value = '0.45';
        updateBgButtons();
      };
      probe.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function removeBackground() {
  store.mutate(d => { d.background = null; });
  updateBgButtons();
}

document.getElementById('btn-bg-import')?.addEventListener('click', importBackground);

document.getElementById('btn-bg-calibrate')?.addEventListener('click', () => {
  if (!store.getDoc().background) return;
  bgCalibPt1 = null; bgCalibPt2 = null;
  switchTool('bg-calibrate');
});

document.getElementById('btn-bg-remove')?.addEventListener('click', removeBackground);

document.getElementById('bg-opacity')?.addEventListener('input', e => {
  const val = parseFloat(e.target.value);
  store.mutate(d => { if (d.background) d.background.opacity = val; }, { pushHistory: false });
});

// Calibration dialog
const modalBgCal = document.getElementById('modal-bg-calibrate');
const formBgCal  = document.getElementById('form-bg-calibrate');

document.getElementById('btn-bg-cal-cancel')?.addEventListener('click', () => {
  bgCalibPt1 = null; bgCalibPt2 = null;
  modalBgCal?.close();
  switchTool('select');
});

formBgCal?.addEventListener('submit', e => {
  e.preventDefault();
  const distMm = parseFloat(document.getElementById('bg-cal-dist')?.value);
  if (!distMm || distMm <= 0 || !bgCalibPt1 || !bgCalibPt2) { modalBgCal?.close(); return; }
  const currentDist = Math.hypot(bgCalibPt2.x - bgCalibPt1.x, bgCalibPt2.y - bgCalibPt1.y);
  if (currentDist < 1) { modalBgCal?.close(); return; }
  const ratio = distMm / currentDist;
  store.mutate(d => {
    if (!d.background) return;
    // Keep top-left corner (bg.x, bg.y) fixed, scale width and height
    d.background.widthMm  *= ratio;
    d.background.heightMm *= ratio;
  });
  bgCalibPt1 = null; bgCalibPt2 = null;
  modalBgCal?.close();
  switchTool('select');
});

// ── Export ────────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name.replace(/[/\\:*?"<>|]/g, '-');
}

function exportPng() {
  const doc     = store.getDoc();
  const layoutW = doc.layout.widthM  * 1000;
  const layoutH = doc.layout.heightM * 1000;
  const MAX_DIM = 3000;
  const aspect  = layoutW / layoutH;
  const exportW = aspect >= 1 ? MAX_DIM : Math.round(MAX_DIM * aspect);
  const exportH = aspect >= 1 ? Math.round(MAX_DIM / aspect) : MAX_DIM;
  const margin  = 80;
  const scale   = Math.min((exportW - margin * 2) / layoutW, (exportH - margin * 2) / layoutH);
  const panX    = (exportW - layoutW * scale) / 2;
  const panY    = (exportH - layoutH * scale) / 2;

  // Text, dimensions and line weights are drawn at fixed *screen* px (12px etc.),
  // which is unreadably small relative to a MAX_DIM-wide image of a large layout.
  // The canvas transform is view.scale·dpr but screen-fixed glyph sizes derive from
  // view.scale alone — so dividing view.scale/pan by TEXT_SCALE and rendering with
  // dpr = TEXT_SCALE keeps the geometry pixel-identical while text and line weights
  // come out TEXT_SCALE× larger.
  const TEXT_SCALE = 3;

  const off = document.createElement('canvas');
  off.width  = exportW;
  off.height = exportH;
  render(off, off.getContext('2d'),
         { ...doc, view: { scale: scale / TEXT_SCALE, panX: panX / TEXT_SCALE, panY: panY / TEXT_SCALE } },
         TEXT_SCALE, new Set());

  const url = off.toDataURL('image/png');
  const a   = Object.assign(document.createElement('a'), { href: url, download: sanitizeFilename(doc.layout.title || 'layout') + '.png' });
  a.click();
}

function exportDxfFile() {
  const doc  = store.getDoc();
  const blob = new Blob([exportDxf(doc)], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: sanitizeFilename(doc.layout.title || 'layout') + '.dxf' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('btn-export-png')?.addEventListener('click', exportPng);
document.getElementById('btn-export-dxf')?.addEventListener('click', exportDxfFile);

store.subscribe(updateBgButtons);

// ── Delete handler ─────────────────────────────────────────────────────────────

document.addEventListener('zc:delete', () => {
  if (selection.size === 0) return;
  if (dimFrom && selection.has(dimFrom)) dimFrom = null; // deleted the pending dimension pick
  store.mutate(doc => {
    const sel = selection;
    doc.objects     = doc.objects.filter(o => !sel.has(o.id));
    doc.constraints = doc.constraints.filter(c => !sel.has(c.child) && !sel.has(c.parent) && !sel.has(c.parent2));
    doc.objects     = doc.objects.filter(o => o.type !== 'span' || (!sel.has(o.postA) && !sel.has(o.postB)));
    // Drop reference dimensions whose posts were removed
    doc.objects     = doc.objects.filter(o => o.type !== 'refdim' || (!sel.has(o.postA) && !sel.has(o.postB)));
  });
  setSelection(new Set());
});

// Re-center on New Doc (view is reset to default 0,0,0.1)
store.subscribe(() => {
  const { view } = store.getDoc();
  if (view.panX === 0 && view.panY === 0 && view.scale === 0.1) {
    requestAnimationFrame(centerView);
  }
});

// ── Layout title (inline edit) ─────────────────────────────────────────────────

const titleEl = document.getElementById('layout-title');
if (titleEl) {
  store.subscribe(() => {
    const doc = store.getDoc();
    if (document.activeElement !== titleEl) titleEl.textContent = doc.layout?.title ?? 'Untitled layout';
  });

  titleEl.addEventListener('click', () => {
    const currentTitle = store.getDoc().layout?.title ?? 'Untitled layout';
    const input = document.createElement('input');
    input.className = 'layout-title-input';
    input.value = currentTitle;
    titleEl.replaceWith(input);
    input.focus(); input.select();
    const commit = () => {
      const val = input.value.trim() || 'Untitled layout';
      store.mutate(d => { d.layout.title = val; }, { pushHistory: false });
      titleEl.textContent = val;
      input.replaceWith(titleEl);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
    });
  });
}

// ── Welcome dialog (on load, unless dismissed with "don't show again") ────────

{
  const welcomeModal = document.getElementById('modal-welcome');
  const WELCOME_KEY  = 'zonecad:hideWelcome';
  let hideWelcome = false;
  try { hideWelcome = localStorage.getItem(WELCOME_KEY) === '1'; } catch { /* private mode */ }
  if (welcomeModal && !hideWelcome) welcomeModal.showModal();
  document.getElementById('welcome-close')?.addEventListener('click', () => {
    try {
      if (document.getElementById('welcome-skip')?.checked) localStorage.setItem(WELCOME_KEY, '1');
    } catch { /* ignore */ }
    welcomeModal?.close();
  });
  welcomeModal?.addEventListener('click', e => { if (e.target === welcomeModal) welcomeModal.close(); });
  // Reopen the welcome / what's-new message on demand from the ? menu.
  document.getElementById('btn-welcome')?.addEventListener('click', () => {
    if (welcomeModal && !welcomeModal.open) welcomeModal.showModal();
  });
}

// ── PWA: service worker + install affordance ──────────────────────────────────
// Installed (standalone) ZoneCAD runs full-screen with no URL bar — the whole
// point on phones/tablets. The SW is network-first (see sw.js): it never serves
// stale files while online, it only enables install + offline fallback.

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/celltec-zonecad-public/sw.js').catch(() => { /* e.g. file:// or unsupported */ });
}

{
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const installBtn  = document.getElementById('btn-install');
  const welcomeAndr = document.getElementById('welcome-install-android');
  const welcomeIos  = document.getElementById('welcome-install-ios');
  let deferredPrompt = null;

  if (!standalone) {
    // Android/Chrome: the browser fires this when the app qualifies for install.
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault(); // suppress the mini-infobar; we show our own buttons
      deferredPrompt = e;
      if (installBtn)  installBtn.hidden  = false;
      if (welcomeAndr) welcomeAndr.hidden = false;
    });

    const doInstall = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredPrompt = null;
        if (installBtn)  installBtn.hidden  = true;
        if (welcomeAndr) welcomeAndr.hidden = true;
      }
    };
    installBtn?.addEventListener('click', doInstall);
    document.getElementById('welcome-install-btn')?.addEventListener('click', doInstall);

    // iOS Safari has no install prompt API — show the Add to Home Screen hint.
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS masquerades as Mac
    if (isIos && welcomeIos) welcomeIos.hidden = false;
  }

  window.addEventListener('appinstalled', () => {
    if (installBtn)  installBtn.hidden  = true;
    if (welcomeAndr) welcomeAndr.hidden = true;
  });
}

// ── Restore autosaved work from a previous session ─────────────────────────────

const restored = store.loadAutosave();
if (restored) {
  // pushHistory:false — otherwise Ctrl+Z right after reload would "undo" the restore,
  // replacing the user's layout with a blank default document.
  store.setDoc(restored, { pushHistory: false });
  warnDocProblems(store.getDoc());
}

// Warn before leaving with unsaved (non-manually-saved) changes.
window.addEventListener('beforeunload', e => {
  if (store.isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

// Initial render — keep the restored view; only auto-frame a fresh document.
requestAnimationFrame(() => {
  if (!restored) centerView();
  scheduleRender();
});
