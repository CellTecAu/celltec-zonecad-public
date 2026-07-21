// Constraint subsystem: DOF tracking, cycle detection, DAG evaluation

import { PANEL_FRAME_SHS } from './model.js';
import { autoFaceKey, hingePoint, pinOffset, bayPitch } from './spans.js';

// ─── DOF tracking ─────────────────────────────────────────────────────────────

// 'panelDim' is radial like 'dimension' but its target is the physical PANEL WIDTH
// between two posts (pin-to-pin + frame), not the centre-to-centre distance.
const POSITIONAL = new Set(['tieEdge', 'alignH', 'alignV', 'dimension', 'panelDim', 'angle', 'lock', 'collinear']);

/** DOF a constraint removes from a post: lock fixes both (2); every other positional removes 1. */
function dofRemoved(kind) {
  if (kind === 'lock') return 2;
  return POSITIONAL.has(kind) ? 1 : 0;
}

/**
 * Axis orientation of an axis-aligned line constraint: 'V' (vertical line, fixes X),
 * 'H' (horizontal line, fixes Y), or null for arbitrary-direction lines (collinear/angle)
 * whose parallelism can't be judged without positions.
 */
function axisOrient(c) {
  if (c.kind === 'alignV') return 'V';
  if (c.kind === 'alignH') return 'H';
  if (c.kind === 'tieEdge') {
    const e = c.parent.split(':')[1];
    if (e === 'left' || e === 'right') return 'V';
    if (e === 'top'  || e === 'bottom') return 'H';
  }
  return null;
}

/** True when every non-layout ref of a constraint resolves to an existing object id. */
function refsResolve(c, ids) {
  for (const ref of [c.parent, c.parent2])
    if (ref && !String(ref).startsWith('layout:') && !ids.has(ref)) return false;
  return true;
}

/**
 * Returns an error string if the new constraint would over-constrain, conflict, or cycle, else null.
 * DOF-budget model: each line/circle removes 1 DOF, lock removes 2; a post's budget is 2.
 * `objects` (optional): when given, constraints with dangling refs are geometrically inert and
 * don't count toward the budget, and a new constraint referencing a missing post is rejected.
 */
export function validateConstraint(newC, allConstraints, objects = null) {
  const ids = objects ? new Set(objects.map(o => o.id)) : null;
  if (ids && !refsResolve(newC, ids)) return 'Constraint references a post that no longer exists.';
  const existing = allConstraints.filter(c => c.child === newC.child && (!ids || refsResolve(c, ids)));
  const usedDof  = existing.reduce((n, c) => n + dofRemoved(c.kind), 0);
  const addDof   = dofRemoved(newC.kind);

  if (newC.kind === 'lock' && usedDof >= 1)
    return 'Over-constrained: post already has a positional constraint.';
  if (usedDof + addDof > 2)
    return 'Over-constrained: post already has enough constraints to fix its position.';

  // Structural conflict: two parallel axis-aligned lines (e.g. two Align V, or Align V + tie left/right)
  // can never be satisfied together. Arbitrary-direction lines (collinear/angle) are checked at solve
  // time instead (flagged red if degenerate), since parallelism depends on positions.
  const newOrient = axisOrient(newC);
  if (newOrient && existing.some(c => axisOrient(c) === newOrient))
    return newOrient === 'V'
      ? 'Over-constrained: X position already fixed by a vertical constraint.'
      : 'Over-constrained: Y position already fixed by a horizontal constraint.';

  for (const ref of [newC.parent, newC.parent2]) {
    if (ref && !ref.startsWith('layout:') && wouldCycle(ref, newC.child, allConstraints))
      return 'Constraint would create a dependency cycle.';
  }

  return null;
}

export function wouldCycle(parentId, childId, constraints) {
  // BFS from parentId following its own dependency chain — if we reach childId, it's a cycle.
  const deps = new Map();
  for (const c of constraints) {
    if (!deps.has(c.child)) deps.set(c.child, []);
    for (const ref of [c.parent, c.parent2]) {
      if (ref && !ref.startsWith('layout:')) deps.get(c.child).push(ref);
    }
  }
  const visited = new Set();
  const queue   = [parentId];
  while (queue.length) {
    const node = queue.shift();
    if (node === childId)    return true;
    if (visited.has(node))   continue;
    visited.add(node);
    for (const d of (deps.get(node) ?? [])) queue.push(d);
  }
  return false;
}

// ─── Geometry layer ───────────────────────────────────────────────────────────
// Every positional constraint confines a post to a locus: a LINE (align/tie/collinear/angle)
// or a CIRCLE (dimension). A post with two constraints is solved by intersecting its two loci.

/** Line locus {px,py,dx,dy} (dir is unit) for a line-type constraint, else null. */
function constraintLine(c, objMap, lw, lh) {
  switch (c.kind) {
    case 'alignH': { const p = objMap.get(c.parent); return p ? { px: p.x, py: p.y, dx: 1, dy: 0 } : null; }
    case 'alignV': { const p = objMap.get(c.parent); return p ? { px: p.x, py: p.y, dx: 0, dy: 1 } : null; }
    case 'tieEdge': {
      const edge = c.parent.split(':')[1];
      if (edge === 'left')   return { px: c.valueMm,       py: 0, dx: 0, dy: 1 };
      if (edge === 'right')  return { px: lw - c.valueMm,  py: 0, dx: 0, dy: 1 };
      if (edge === 'bottom') return { px: 0, py: c.valueMm,      dx: 1, dy: 0 };
      if (edge === 'top')    return { px: 0, py: lh - c.valueMm, dx: 1, dy: 0 };
      return null;
    }
    case 'collinear': {
      const a = objMap.get(c.parent), b = objMap.get(c.parent2);
      if (!a || !b) return null;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1) return null;
      return { px: a.x, py: a.y, dx: dx / len, dy: dy / len };
    }
    case 'angle': {
      const p = objMap.get(c.parent);
      if (!p) return null;
      const r = (c.valueDeg ?? 0) * Math.PI / 180;
      // ray:true — an angle is a DIRECTED bearing; the child lives on the half-line
      // from the parent, matching constraintBroken's directed check.
      return { px: p.x, py: p.y, dx: Math.cos(r), dy: Math.sin(r), ray: true };
    }
  }
  return null;
}

/**
 * Circle locus for a panelDim: the physical panel width `c.valueMm` = hinge-to-hinge distance L
 * + frame (PANEL_FRAME_SHS.w), so the child's bracket pin must sit at distance L from the parent's
 * bracket pin. The child CENTRE therefore rides a circle of radius L centred at `hA − vB`, where
 * hA is the parent hinge (world) and vB is the child's hinge offset (rotation-only, position-
 * independent): |cB − (hA − vB)| = L ⟺ |hB − hA| = L. This holds the panel width EXACTLY as the
 * child pivots about the parent's pin, regardless of run direction or post rotation. Faces are
 * auto-detected from current geometry, matching spanHinges.
 */
/** The panel span between two post ids (any kind), else null. */
function spanBetween(objects, a, b) {
  if (!objects) return null;
  for (const o of objects)
    if (o.type === 'span' && ((o.postA === a && o.postB === b) || (o.postA === b && o.postB === a))) return o;
  return null;
}

/**
 * Parent + child bracket-pin (hinge) world positions for a panelDim, using the SAME faces the
 * span (and the on-canvas panel dimension) uses — stored `faceA/faceB` when set, else auto. This
 * keeps the constraint, the drawn dimension and the measured panel width in exact agreement.
 */
export function panelDimHinges(c, objMap, objects) {
  const parent = objMap.get(c.parent), child = objMap.get(c.child);
  if (!parent || !child) return null;
  const span = spanBetween(objects, c.parent, c.child);
  let fParent, fChild;
  if (span) {
    const fA = span.faceA ?? autoFaceKey(objMap.get(span.postA), objMap.get(span.postB));
    const fB = span.faceB ?? autoFaceKey(objMap.get(span.postB), objMap.get(span.postA));
    if (span.postA === c.parent) { fParent = fA; fChild = fB; } else { fParent = fB; fChild = fA; }
  } else {
    fParent = autoFaceKey(parent, child);
    fChild  = autoFaceKey(child, parent);
  }
  return { parent, child, hParent: hingePoint(parent, fParent), hChild: hingePoint(child, fChild) };
}

/**
 * Hinge-to-hinge distance D that makes the TOTAL physical panel width of the run equal T.
 * A panelDim's value is the sum of the physical panels between the posts — the manufacturing
 * number — not the raw run: once the run needs N bays, each ghost post consumes (2p − shs) of
 * run (its two pin offsets minus the frame overlap), so T = D + 2p − N·(2p − shs), mirroring
 * bayLayout's maths exactly (uniform pin offset p from the span's post A, like bayLayout).
 * N itself depends on D, so iterate: f(N) = ceil((D(N)+2p)/pitchMax) grows slower than N
 * (slope (2p−shs)/pitchMax ≪ 1), so the fixed point is unique and found in a few steps.
 * ≤ one max panel (N = 1) reduces to the plain D = T − frame.
 */
function panelDimTargetD(c, objMap, objects, settings) {
  const span = spanBetween(objects, c.parent, c.child);
  const T    = c.valueMm;
  const shs  = PANEL_FRAME_SHS.w;
  // Doors/gates and pair-without-span: single leaf/panel, no ghost splitting.
  if (!span || (span.spanKind ?? 'panel') !== 'panel') return T - shs;
  const refPost  = objMap.get(span.postA);            // bayLayout sizes bays from post A
  const p        = pinOffset(refPost);
  const pitchMax = bayPitch(refPost, settings?.maxPanelRunMm ?? 2400);
  for (let N = 1; N <= 500; N++) {
    const D = T - 2 * p + N * (2 * p - shs);
    if (D < 1) continue;
    if (Math.ceil((D + 2 * p) / pitchMax - 1e-9) === N) return D;
  }
  return Math.max(1, T - shs);                        // degenerate T — behave like one panel
}

/**
 * Circle locus for a panelDim: the child's bracket pin must sit at distance D (from
 * panelDimTargetD) from the parent's pin, so the child CENTRE rides a circle of radius D about
 * `hParent − vChild` (vChild = child pin offset, rotation-only): |cChild − (hParent − vChild)| = D
 * ⟺ |hChild − hParent| = D. Holds the panels' total width exactly as the post pivots about the
 * pin, for any run angle/rotation, including runs that auto-split with ghost posts.
 */
function panelDimCircle(c, objMap, objects, settings) {
  // Sliding door: the "panel" is the LEAF, whose width = post c-c + gateExtend (see
  // slidingLeafLine) — so hold the post CENTRES at (value − gateExtend). Plain centre circle.
  const span = spanBetween(objects, c.parent, c.child);
  if (span?.spanKind === 'slidingDoor') {
    const p = objMap.get(c.parent);
    if (!p) return null;
    const gateExtend = Math.max(0, span.kindProps?.gateExtendMm ?? 0);
    return { cx: p.x, cy: p.y, r: Math.max(1, c.valueMm - gateExtend) };
  }
  const h = panelDimHinges(c, objMap, objects);
  if (!h) return null;
  const vx = h.hChild.x - h.child.x, vy = h.hChild.y - h.child.y;
  const D  = panelDimTargetD(c, objMap, objects, settings);
  return { cx: h.hParent.x - vx, cy: h.hParent.y - vy, r: Math.max(1, D) };
}

/** Circle locus {cx,cy,r} for a dimension or panelDim, else null. */
function constraintCircle(c, objMap, objects, settings) {
  if (c.kind === 'dimension') {
    const p = objMap.get(c.parent);
    return p ? { cx: p.x, cy: p.y, r: c.valueMm } : null;
  }
  if (c.kind === 'panelDim') return panelDimCircle(c, objMap, objects, settings);
  return null;
}

function projectPointLine(x, y, line) {
  let t = (x - line.px) * line.dx + (y - line.py) * line.dy;
  if (line.ray && t < 0) t = 0; // directed locus (angle): clamp to the half-line
  return { x: line.px + t * line.dx, y: line.py + t * line.dy };
}

/** True when (x,y) lies on the line's valid range (always, unless it's a ray behind its origin). */
function onLineRange(line, x, y) {
  return !line.ray || (x - line.px) * line.dx + (y - line.py) * line.dy >= -1e-9;
}

function projectPointCircle(x, y, circ) {
  const dx = x - circ.cx, dy = y - circ.cy, len = Math.hypot(dx, dy) || 1;
  return { x: circ.cx + dx / len * circ.r, y: circ.cy + dy / len * circ.r };
}

/** Intersect two lines → point, or null if parallel / off a ray's valid half. */
function lineLine(l1, l2) {
  const det = l1.dx * (-l2.dy) - (-l2.dx) * l1.dy;
  if (Math.abs(det) < 1e-9) return null; // parallel
  const rx = l2.px - l1.px, ry = l2.py - l1.py;
  const t = (rx * (-l2.dy) - (-l2.dx) * ry) / det;
  const pt = { x: l1.px + t * l1.dx, y: l1.py + t * l1.dy };
  return onLineRange(l1, pt.x, pt.y) && onLineRange(l2, pt.x, pt.y) ? pt : null;
}

/** Intersect a line with a circle → 0, 1 or 2 points (rays keep only their half). */
function lineCircle(line, circ) {
  const wx = line.px - circ.cx, wy = line.py - circ.cy;
  const b  = wx * line.dx + wy * line.dy;
  const cc = wx * wx + wy * wy - circ.r * circ.r;
  const disc = b * b - cc;
  if (disc < -1e-6) return [];
  const s = Math.sqrt(Math.max(0, disc));
  let ts = s < 1e-9 ? [-b] : [-b + s, -b - s];
  if (line.ray) ts = ts.filter(t => t >= -1e-9);
  return ts.map(t => ({ x: line.px + t * line.dx, y: line.py + t * line.dy }));
}

/** Intersect two circles → 0, 1 or 2 points. */
function circleCircle(c1, c2) {
  const dx = c2.cx - c1.cx, dy = c2.cy - c1.cy, d = Math.hypot(dx, dy);
  if (d < 1e-6) return []; // concentric
  if (d > c1.r + c2.r + 1e-6 || d < Math.abs(c1.r - c2.r) - 1e-6) return []; // separate / contained
  const a  = (c1.r * c1.r - c2.r * c2.r + d * d) / (2 * d);
  const h  = Math.sqrt(Math.max(0, c1.r * c1.r - a * a));
  const mx = c1.cx + a * dx / d, my = c1.cy + a * dy / d;
  const ox = -dy / d * h, oy = dx / d * h;
  return [{ x: mx + ox, y: my + oy }, { x: mx - ox, y: my - oy }];
}

/** Of candidate points, the one nearest (x,y) — preserves the branch the user dragged toward. */
function nearest(pts, x, y) {
  let best = null, bd = Infinity;
  for (const p of pts) { const dd = (p.x - x) ** 2 + (p.y - y) ** 2; if (dd < bd) { bd = dd; best = p; } }
  return best;
}

/**
 * Solve a single post's position from its (≤2) constraints by intersecting geometric loci.
 * Order-independent — all constraints considered together.
 */
function solvePost(child, cs, objMap, lw, lh, objects, settings) {
  const lock = cs.find(c => c.kind === 'lock');
  if (lock) {
    if (typeof lock.atX === 'number') child.x = lock.atX;
    if (typeof lock.atY === 'number') child.y = lock.atY;
    return;
  }
  const lines = [], circles = [];
  for (const c of cs) {
    const l = constraintLine(c, objMap, lw, lh);
    if (l) { lines.push(l); continue; }
    const ci = constraintCircle(c, objMap, objects, settings);
    if (ci) circles.push(ci);
  }
  const cx = child.x, cy = child.y;

  let pts = null;                       // candidate intersection points (2-constraint cases)
  let fallbackLine = null, fallbackCircle = null; // 1-DOF locus, or where to rest if no intersection
  if (lines.length >= 2)                      { pts = [lineLine(lines[0], lines[1])].filter(Boolean); fallbackLine = lines[0]; }
  else if (lines.length === 1 && circles.length >= 1) { pts = lineCircle(lines[0], circles[0]);        fallbackLine = lines[0]; }
  else if (circles.length >= 2)               { pts = circleCircle(circles[0], circles[1]);           fallbackCircle = circles[0]; }
  else if (lines.length === 1)                { fallbackLine = lines[0]; }   // 1 DOF → slide on line
  else if (circles.length === 1)              { fallbackCircle = circles[0]; } // 1 DOF → slide on arc

  if (pts && pts.length) { const p = nearest(pts, cx, cy); child.x = p.x; child.y = p.y; return; }
  // No intersection (or single-locus slide) → rest on the fallback locus; constraintBroken flags red.
  if (fallbackLine)   { const p = projectPointLine(cx, cy, fallbackLine);     child.x = p.x; child.y = p.y; return; }
  if (fallbackCircle) { const p = projectPointCircle(cx, cy, fallbackCircle); child.x = p.x; child.y = p.y; return; }
}

// ─── DAG evaluation ───────────────────────────────────────────────────────────

// Memoised evaluation plan, keyed on the constraints ARRAY REFERENCE. The plan only encodes
// topo order + per-child grouping; values (valueMm/valueDeg/atX...) are read live from the
// constraint objects at solve time. Every structural or value change goes through
// store.mutate/setDoc/undo, which all produce fresh arrays — while drags (patchObjects)
// keep the same array, so the O(1) reference check skips the rebuild on every frame.
let _planCache = { ref: null, steps: null };

// Same trick for the id→object map: patchObjects mutates objects in place (array reference
// stable, map values are live references), while structural changes swap the array.
let _objMapCache = { ref: null, map: null };

/** Build the ordered [{ childId, cs }] evaluation plan (parents before children). */
function buildPlan(constraints) {
  const deps = new Map(); // childId → Set<parentId>
  for (const c of constraints) {
    if (!deps.has(c.child)) deps.set(c.child, new Set());
    for (const ref of [c.parent, c.parent2]) {
      if (ref && !ref.startsWith('layout:')) deps.get(c.child).add(ref);
    }
  }
  const steps = [];
  for (const childId of topoSort(deps)) {
    const cs = constraints.filter(c => c.child === childId);
    if (cs.length) steps.push({ childId, cs });
  }
  return steps;
}

/**
 * Evaluate all constraints and update constrained object positions in-place.
 * Topological pass: parents before children. Reuses a cached plan across position-only changes.
 * Each post is solved from all its constraints at once (geometric locus intersection).
 */
export function evaluateConstraints(doc) {
  const { constraints, objects, layout } = doc;
  if (!constraints?.length) return;

  const lw = layout.widthM  * 1000;
  const lh = layout.heightM * 1000;

  if (objects !== _objMapCache.ref)
    _objMapCache = { ref: objects, map: new Map(objects.map(o => [o.id, o])) };
  const objMap = _objMapCache.map;

  if (constraints !== _planCache.ref)
    _planCache = { ref: constraints, steps: buildPlan(constraints) };

  for (const { childId, cs } of _planCache.steps) {
    const child = objMap.get(childId);
    if (child) solvePost(child, cs, objMap, lw, lh, objects, doc.settings);
  }
}

function topoSort(deps) {
  const result   = [];
  const visited  = new Set();
  const visiting = new Set();

  function visit(node) {
    if (visited.has(node) || visiting.has(node)) return;
    visiting.add(node);
    for (const p of (deps.get(node) ?? [])) visit(p);
    visiting.delete(node);
    visited.add(node);
    result.push(node);
  }

  for (const node of deps.keys()) visit(node);
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns which axes are locked for this object by its direct constraints.
 * Used to pre-clamp drag deltas so there is no jitter from snap-back.
 * `movingSet` (optional): ids being dragged together — a constraint whose reference
 * (parent) is also moving is skipped, since a rigid group translation preserves it.
 */
export function lockedAxes(objectId, constraints, movingSet = null) {
  let xLocked = false, yLocked = false;
  const refMoving = ref => !!(movingSet && ref && movingSet.has(ref));
  for (const c of constraints) {
    if (c.child !== objectId) continue;
    switch (c.kind) {
      case 'tieEdge': { // pinned to a layout edge (absolute) — always applies
        const edge = c.parent.split(':')[1];
        if (edge === 'left' || edge === 'right') xLocked = true;
        if (edge === 'top'  || edge === 'bottom') yLocked = true;
        break;
      }
      case 'alignH': if (!refMoving(c.parent)) yLocked = true; break;
      case 'alignV': if (!refMoving(c.parent)) xLocked = true; break;
      case 'lock':   return { xLocked: true, yLocked: true }; // absolute pin
      // dimension / angle are radial — they don't lock an axis. The post can still be dragged
      // around the arc (distance) or along the ray (angle); the evaluator re-projects it.
      // A radial paired with one axis-lock fully positions the post — handled by isDragBlocked.
    }
  }
  return { xLocked, yLocked };
}

/**
 * Why a rigid rotation of the selection can't proceed, or null when it can.
 * Rotation-invariant constraints (dimension/collinear/panelDim between rotating posts)
 * pass; world-anchored ones (lock/tieEdge) and references outside the selection never
 * survive. `alignsOk`: quarter-turn rotations keep alignH/alignV meaningful (the kinds
 * swap on odd quarter-turns), so the 90°-step commands pass true; free rotation false.
 */
export function rotationBlockReason(sel, constraints, alignsOk = false) {
  for (const c of constraints) {
    if (!sel.has(c.child)) continue;
    if (c.kind === 'lock' || c.kind === 'tieEdge')
      return 'a post is locked / tied to a layout edge';
    if (![c.parent, c.parent2].filter(Boolean).every(r => sel.has(r)))
      return 'a constraint references a post outside the selection';
    if ((c.kind === 'alignH' || c.kind === 'alignV') && !alignsOk)
      return 'align constraints only survive 90° steps';
  }
  return null;
}

/**
 * True only when the object is fully defined and can't move in ANY direction (≥2 DOF removed,
 * or a lock). A post with a single constraint (1 DOF) still slides along its locus — the solver
 * re-projects the cursor onto the line/circle. `movingSet`: a constraint whose reference is also
 * being dragged is preserved by rigid translation, so it doesn't count toward blocking.
 */
export function isDragBlocked(objectId, constraints, movingSet = null, objects = null) {
  const ids = objects ? new Set(objects.map(o => o.id)) : null;
  const refMoving = c => !!(movingSet && ((c.parent && movingSet.has(c.parent)) || (c.parent2 && movingSet.has(c.parent2))));
  let dof = 0;
  for (const c of constraints) {
    if (c.child !== objectId) continue;
    if (ids && !refsResolve(c, ids)) continue; // dangling ref → geometrically inert, can't block
    if (c.kind === 'lock') return true;
    if (POSITIONAL.has(c.kind) && !refMoving(c)) dof += dofRemoved(c.kind);
  }
  return dof >= 2;
}

/**
 * True when a constraint's target can't be met by the current geometry (the solver couldn't
 * satisfy it). Used to flag it red and to count problems. objMap: id→post.
 */
export function constraintBroken(c, objMap, lw = 0, lh = 0, objects = null, settings = null) {
  const child = objMap.get(c.child);
  if (!child) return true; // orphaned constraint — child post no longer exists
  for (const ref of [c.parent, c.parent2])
    if (ref && !String(ref).startsWith('layout:') && !objMap.get(ref))
      return true; // dangling ref — the constraint can't be evaluated, surface it
  const p = objMap.get(c.parent);
  switch (c.kind) {
    case 'dimension': {
      if (!p) return false;
      const actual = Math.hypot(child.x - p.x, child.y - p.y);
      return Math.abs(actual - c.valueMm) > Math.max(1, c.valueMm * 0.005);
    }
    case 'panelDim': {
      const circ = panelDimCircle(c, objMap, objects, settings);
      if (!circ) return false;
      const actual = Math.hypot(child.x - circ.cx, child.y - circ.cy);
      return Math.abs(actual - circ.r) > Math.max(1, circ.r * 0.005);
    }
    case 'angle': {
      if (!p) return false;
      const actual = Math.atan2(child.y - p.y, child.x - p.x) * 180 / Math.PI;
      const diff   = Math.abs((((actual - (c.valueDeg ?? 0)) % 360) + 540) % 360 - 180);
      return diff > 0.5;
    }
    case 'alignH': return p ? Math.abs(child.y - p.y) > 1 : false;
    case 'alignV': return p ? Math.abs(child.x - p.x) > 1 : false;
    case 'tieEdge': {
      const edge = c.parent.split(':')[1];
      if (edge === 'left')   return Math.abs(child.x - c.valueMm) > 1;
      if (edge === 'right')  return Math.abs(child.x - (lw - c.valueMm)) > 1;
      if (edge === 'bottom') return Math.abs(child.y - c.valueMm) > 1;
      if (edge === 'top')    return Math.abs(child.y - (lh - c.valueMm)) > 1;
      return false;
    }
    case 'collinear': {
      const a = objMap.get(c.parent), b = objMap.get(c.parent2);
      if (!a || !b) return false;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1) return false;
      return Math.abs((child.x - a.x) * dy - (child.y - a.y) * dx) / len > 1;
    }
    case 'lock':
      return (typeof c.atX === 'number' && Math.abs(child.x - c.atX) > 1) ||
             (typeof c.atY === 'number' && Math.abs(child.y - c.atY) > 1);
  }
  return false;
}

/** Count constraints the solver couldn't satisfy in the current geometry. */
export function countBrokenConstraints(doc) {
  const objMap = new Map(doc.objects.filter(o => o.type === 'post').map(o => [o.id, o]));
  const lw = doc.layout.widthM * 1000, lh = doc.layout.heightM * 1000;
  let n = 0;
  for (const c of (doc.constraints ?? [])) if (constraintBroken(c, objMap, lw, lh, doc.objects, doc.settings)) n++;
  return n;
}

/**
 * Sanity-check a whole document's constraint graph (for load paths, which bypass
 * validateConstraint). Returns user-facing problem strings, empty when healthy.
 */
export function docConstraintProblems(doc) {
  const problems = [];
  const cs  = doc.constraints ?? [];
  if (!cs.length) return problems;
  const ids = new Set(doc.objects.map(o => o.id));

  const dangling = cs.filter(c => !ids.has(c.child) || !refsResolve(c, ids)).length;
  if (dangling) problems.push(`${dangling} constraint${dangling > 1 ? 's' : ''} referencing missing posts`);

  const dofByChild = new Map();
  for (const c of cs) {
    if (!ids.has(c.child) || !refsResolve(c, ids)) continue;
    dofByChild.set(c.child, (dofByChild.get(c.child) ?? 0) + dofRemoved(c.kind));
  }
  const over = [...dofByChild.values()].filter(d => d > 2).length;
  if (over) problems.push(`${over} post${over > 1 ? 's' : ''} over-constrained (more than 2 constraints)`);

  // Cycle check: DFS over the child→parent dependency graph looking for back edges.
  const deps = new Map();
  for (const c of cs) {
    if (!deps.has(c.child)) deps.set(c.child, []);
    for (const ref of [c.parent, c.parent2])
      if (ref && !String(ref).startsWith('layout:')) deps.get(c.child).push(ref);
  }
  const done = new Set(), path = new Set();
  let cycles = false;
  const visit = node => {
    if (done.has(node) || cycles) return;
    if (path.has(node)) { cycles = true; return; }
    path.add(node);
    for (const p of (deps.get(node) ?? [])) visit(p);
    path.delete(node);
    done.add(node);
  };
  for (const node of deps.keys()) visit(node);
  if (cycles) problems.push('a constraint dependency loop (solve order is unpredictable)');

  return problems;
}

/** Human-readable description of a constraint. Unknown/missing posts render as "(missing)". */
export function constraintLabel(c, objects) {
  const ref = id => (objects.some(o => o.id === id) ? id : `${id} (missing)`);
  switch (c.kind) {
    case 'tieEdge':   return `${c.valueMm} mm from ${c.parent.split(':')[1]} edge`;
    case 'alignH':    return `Aligned H with ${ref(c.parent)}`;
    case 'alignV':    return `Aligned V with ${ref(c.parent)}`;
    case 'dimension': return `${c.valueMm} mm from ${ref(c.parent)}`;
    case 'panelDim':  return `${c.valueMm} mm panel to ${ref(c.parent)}`;
    case 'angle':     return `${c.valueDeg}° from ${ref(c.parent)}`;
    case 'lock':      return 'Locked in place';
    case 'collinear': return `Collinear with ${ref(c.parent)} & ${ref(c.parent2)}`;
    default:          return c.kind;
  }
}
