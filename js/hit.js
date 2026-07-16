// Hit-testing and handle picking — all in model space

import { postProfile, FOOTPLATE, canvasToModel, PANEL_FRAME_SHS, buildPostMap, dimLineOffset, angleLabelAnchor, tieEdgePoint, isBollard, BOLLARD } from './model.js';
import { spanHinges, doorHingePositions, spanHitShapes, slidingLeafLine, SLIDING_DIM_OFFSET } from './spans.js';

const PICK_PX      = 8;  // screen pixels pick tolerance (posts)
const SPAN_PICK_PX = 4;  // screen pixels for span perp hit — stays tight at any zoom

// Coarse-pointer boost: a fingertip needs bigger targets than a mouse cursor.
// The gesture layer sets this per pointer event (1 = mouse/pen, ~2.5 = touch).
let _pickBoost = 1;
export function setPickBoost(b) { _pickBoost = b; }
export function getPickBoost()  { return _pickBoost; }

// ─── Object picking ───────────────────────────────────────────────────────────

export function pickObject(screenX, screenY, objects, view, layoutH) {
  const tol     = PICK_PX      * _pickBoost / view.scale;
  const spanTol = SPAN_PICK_PX * _pickBoost / view.scale; // tighter perp tolerance for spans
  const mp      = canvasToModel(screenX, screenY, view, layoutH);

  // Posts are tested first — they always win over spans at any zoom level.
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.type === 'post' && hitPost(mp.x, mp.y, obj, tol)) return obj;
  }
  // Labels (small floating text — easy to grab, tested before spans/zones)
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.type === 'label' && hitLabel(mp.x, mp.y, obj, view.scale)) return obj;
  }
  // Dimension annotations (near their line)
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.type === 'dim' && ptSegDist(mp.x, mp.y, obj.x0, obj.y0, obj.x1, obj.y1) <= spanTol) return obj;
  }
  // Then spans (using smaller perp tolerance so spans don't overwhelm posts when zoomed out)
  const postMap = buildPostMap(objects);
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.type === 'span' && hitSpan(mp.x, mp.y, obj, postMap, spanTol)) return obj;
  }
  // Then zones (below everything visually)
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.type === 'zone' && hitZone(mp.x, mp.y, obj)) return obj;
  }
  return null;
}

export function pickHandle(screenX, screenY, obj, view, layoutH) {
  if (obj.type !== 'post') return null;
  if (isBollard(obj)) return null; // circular + symmetric hole pattern — rotation is meaningless
  const tol = 10 * _pickBoost / view.scale;
  const mp  = canvasToModel(screenX, screenY, view, layoutH);
  const rh  = rotHandlePos(obj);
  return Math.hypot(mp.x - rh.x, mp.y - rh.y) <= tol ? 'rotate' : null;
}

/** Model-space position of the rotation handle for a post. */
export function rotHandlePos(post) {
  const prof = postProfile(post.material);
  const fp   = FOOTPLATE[post.footplate] ?? { w: prof.w, h: prof.h, offsetY: 0 };
  const oy   = fp.offsetY ?? 0;
  const top  = Math.max(prof.h / 2, oy + fp.h / 2); // highest local-Y extent of footplate
  const rad  = post.footplateRotationDeg * Math.PI / 180;
  // Handle is at local +Y rotated CW by θ: [0,1] CW θ → [sin(θ), cos(θ)]
  return {
    x: post.x + Math.sin(rad) * (top + 60),
    y: post.y + Math.cos(rad) * (top + 60),
  };
}

/** Hit-test span endpoint handles (the pin-center circles). Returns { span, endpoint: 'A'|'B' } or null. */
export function pickSpanEndpoint(screenX, screenY, objects, view, layoutH) {
  const tol = 10 * _pickBoost / view.scale;
  const mp  = canvasToModel(screenX, screenY, view, layoutH);
  const postMap = buildPostMap(objects);
  const spans = objects.filter(o => o.type === 'span');
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    const h = spanHinges(span, postMap);
    if (!h) continue;
    if (Math.hypot(mp.x - h.hA.x, mp.y - h.hA.y) <= tol) return { span, endpoint: 'A' };
    if (Math.hypot(mp.x - h.hB.x, mp.y - h.hB.y) <= tol) return { span, endpoint: 'B' };
  }
  return null;
}

/** When a single hinged-door span is selected, picks a click on one of its 4 hinge-mount markers. */
export function pickDoorHinge(screenX, screenY, objects, view, layoutH, selection) {
  if (selection.size !== 1) return null;
  const span = objects.find(o => o.id === [...selection][0]);
  if (!span || (span.spanKind !== 'hingedDoor' && span.spanKind !== 'swingGate')) return null;
  const tol    = 10 * _pickBoost / view.scale;
  const mp     = canvasToModel(screenX, screenY, view, layoutH);
  const postMap = buildPostMap(objects);
  for (const { pos, x, y } of doorHingePositions(span, postMap)) {
    if (Math.hypot(mp.x - x, mp.y - y) <= tol) return { span, pos };
  }
  return null;
}

/**
 * Pick a dimension-ish annotation line near the cursor (drag-to-offset / dblclick-to-edit).
 * Returns { kind:'refdim'|'dimc'|'anglec'|'tiec', id, aPt, bPt } or null.
 * layoutW is needed to resolve tieEdge lines anchored to the right edge.
 */
export function pickDimensionLine(sx, sy, objects, constraints, view, layoutH, layoutW = 0, tolPx = 8) {
  const tol = tolPx * _pickBoost / view.scale;
  const mp  = canvasToModel(sx, sy, view, layoutH);
  const postMap = buildPostMap(objects);
  const lineHit = (a, b, o, off = null) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1) return false;
    const nx = -dy / len, ny = dx / len, k = off ?? dimLineOffset(o, view.scale);
    return ptSegDist(mp.x, mp.y, a.x + nx * k, a.y + ny * k, b.x + nx * k, b.y + ny * k) <= tol;
  };
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type !== 'refdim') continue;
    const a = postMap[o.postA], b = postMap[o.postB];
    if (a && b && lineHit(a, b, o)) return { kind: 'refdim', id: o.id, aPt: { x: a.x, y: a.y }, bPt: { x: b.x, y: b.y } };
  }
  for (const c of (constraints ?? [])) {
    // panelDim renders and edits like a dimension (shares the 'dimc' label plumbing), but its
    // line runs pin-to-pin along the panel — hit-test that line, not the post centres.
    if (c.kind !== 'dimension' && c.kind !== 'panelDim') continue;
    const child = postMap[c.child], parent = postMap[c.parent];
    if (!child || !parent) continue;
    let a = { x: parent.x, y: parent.y }, b = { x: child.x, y: child.y }, off = null;
    if (c.kind === 'panelDim') {
      const span = objects.find(o => o.type === 'span' &&
        ((o.postA === c.parent && o.postB === c.child) || (o.postA === c.child && o.postB === c.parent)));
      if (span?.spanKind === 'slidingDoor') {
        // Drawn on the parked LEAF (small fixed default offset) — hit-test the same line.
        const L = slidingLeafLine(span, postMap);
        if (L) { a = { x: L.ax, y: L.ay }; b = { x: L.bx, y: L.by }; }
        if (typeof c.offsetMm !== 'number') off = SLIDING_DIM_OFFSET;
      } else {
        const h = span ? spanHinges(span, postMap) : null;
        if (h) {                                   // parent-hinge → child-hinge (matches render normal)
          a = span.postA === c.parent ? h.hA : h.hB;
          b = span.postA === c.parent ? h.hB : h.hA;
        }
      }
    }
    if (lineHit(a, b, c, off)) return { kind: 'dimc', id: c.id, aPt: { x: a.x, y: a.y }, bPt: { x: b.x, y: b.y } };
  }
  // Angle constraints render as a dashed line from parent to child, plus an arc
  // and a degree label near the parent. Accept a hit on the line OR on that
  // label/arc region — the label is the obvious thing to double-click.
  for (const c of (constraints ?? [])) {
    if (c.kind !== 'angle') continue;
    const child = postMap[c.child], parent = postMap[c.parent];
    if (!child || !parent) continue;
    const onLine = ptSegDist(mp.x, mp.y, parent.x, parent.y, child.x, child.y) <= tol;
    const la = angleLabelAnchor(parent, view.scale); // same anchor render.js draws the label at
    const onLabel = Math.hypot(mp.x - la.x, mp.y - la.y) <= 18 / view.scale;
    if (onLine || onLabel)
      return { kind: 'anglec', id: c.id, aPt: { x: parent.x, y: parent.y }, bPt: { x: child.x, y: child.y } };
  }
  // Tie-to-edge: dashed line from the child post to the layout edge, label at its midpoint.
  for (const c of (constraints ?? [])) {
    if (c.kind !== 'tieEdge') continue;
    const child = postMap[c.child];
    if (!child) continue;
    const ep = tieEdgePoint(c, child, layoutW, layoutH); // same geometry render.js draws
    if (ep && ptSegDist(mp.x, mp.y, child.x, child.y, ep.x, ep.y) <= tol)
      return { kind: 'tiec', id: c.id, aPt: { x: child.x, y: child.y }, bPt: ep };
  }
  return null;
}

// ─── Marquee selection ────────────────────────────────────────────────────────

export function objectsInMarquee(objects, x0, y0, x1, y1) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const inBox = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  const postMap = buildPostMap(objects);
  return objects.filter(obj => {
    if (obj.type === 'post' || obj.type === 'zone' || obj.type === 'label') {
      return inBox(obj.x, obj.y);
    }
    if (obj.type === 'span') {
      // A span is captured when both of its posts fall inside the box.
      const pA = postMap[obj.postA], pB = postMap[obj.postB];
      return pA && pB && inBox(pA.x, pA.y) && inBox(pB.x, pB.y);
    }
    return false;
  });
}

// ─── Internals ────────────────────────────────────────────────────────────────

function hitPost(mx, my, post, tol) {
  if (isBollard(post)) return Math.hypot(mx - post.x, my - post.y) <= BOLLARD.plateOd / 2 + tol;
  const prof = postProfile(post.material);
  const fp   = FOOTPLATE[post.footplate] ?? { w: prof.w, h: prof.h, offsetX: 0, offsetY: 0 };
  const ox = fp.offsetX ?? 0, oy = fp.offsetY ?? 0;
  const dx = mx - post.x, dy = my - post.y;
  // Inverse of the render transform (render draws local geometry via ctx.rotate(-rad)):
  // world = R(-rad)·local, so local = R(+rad)·(world - post).
  const rad = post.footplateRotationDeg * Math.PI / 180;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  // Asymmetric bounds: union of post SHS and offset footplate extents
  const minX = Math.min(-prof.w / 2, ox - fp.w / 2) - tol;
  const maxX = Math.max(+prof.w / 2, ox + fp.w / 2) + tol;
  const minY = Math.min(-prof.h / 2, oy - fp.h / 2) - tol;
  const maxY = Math.max(+prof.h / 2, oy + fp.h / 2) + tol;
  return lx >= minX && lx <= maxX && ly >= minY && ly <= maxY;
}

function hitSpan(mx, my, span, postMap, tol) {
  const pA = postMap[span.postA], pB = postMap[span.postB];
  if (!pA || !pB) return false;

  const h = spanHinges(span, postMap);
  const ax = h ? h.hA.x : pA.x, ay = h ? h.hA.y : pA.y;
  const bx = h ? h.hB.x : pB.x, by = h ? h.hB.y : pB.y;

  if (span.spanKind === 'gap') return ptSegDist(mx, my, ax, ay, bx, by) <= tol;

  // The opening centreline (the dotted line between pins) is always clickable.
  if (segStripHit(mx, my, ax, ay, bx, by, PANEL_FRAME_SHS.w / 2, tol)) return true;

  // Also hit the rendered geometry (angled leaf, sliding track, cantilever beam).
  for (const s of spanHitShapes(span, postMap)) {
    if (segStripHit(mx, my, s.ax, s.ay, s.bx, s.by, s.halfW, tol)) return true;
  }
  return false;
}

/** True if (mx,my) is within halfW+tol of the a→b segment strip. */
function segStripHit(mx, my, ax, ay, bx, by, halfW, tol) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return false;
  const sdx = dx / len, sdy = dy / len;
  const lnx = -sdy, lny = sdx;
  const relX = mx - ax, relY = my - ay;
  const along = relX * sdx + relY * sdy;
  const perp  = relX * lnx + relY * lny;
  return along >= -tol && along <= len + tol && Math.abs(perp) <= halfW + tol;
}

function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitLabel(mx, my, label, scale) {
  // Screen-constant box roughly matching the rendered pill (≈13px text + padding).
  const fontPx = 13;
  const halfW  = ((label.text || '').length * fontPx * 0.55 / 2 + 6) / scale;
  const halfH  = 11 / scale;
  return Math.abs(mx - label.x) <= halfW && Math.abs(my - label.y) <= halfH;
}

function hitZone(mx, my, zone) {
  if (zone.shape === 'circle') {
    const r = zone.radiusMm ?? zone.widthMm / 2;
    return Math.hypot(mx - zone.x, my - zone.y) <= r;
  }
  return mx >= zone.x - zone.widthMm  / 2 &&
         mx <= zone.x + zone.widthMm  / 2 &&
         my >= zone.y - zone.heightMm / 2 &&
         my <= zone.y + zone.heightMm / 2;
}

