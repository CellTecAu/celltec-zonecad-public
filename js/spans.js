// Span geometry: hinge points, run length, height, auto-link, cut list

import { postProfile, BRACKET_CLEARANCE, createSpan, FOOTPLATE, PANEL_FRAME_SHS } from './model.js';

export const MAX_PANEL_RUN = 2400; // max PHYSICAL panel width (incl. 25 SHS verticals overhanging the pins)

// Panel-splitting defaults (overridable per-doc via Settings — see panelConfig).
export const PANEL_DEFAULTS = {
  maxPanelRunMm:  MAX_PANEL_RUN, // largest standard panel
  panelDivisorMm: 100,           // bays are split near-equal and rounded to this increment
};

/** Build a panel config from doc.settings, filling any missing value with a default. */
export function panelConfig(settings = {}) {
  return {
    maxPanelRunMm:  settings.maxPanelRunMm  ?? PANEL_DEFAULTS.maxPanelRunMm,
    panelDivisorMm: settings.panelDivisorMm ?? PANEL_DEFAULTS.panelDivisorMm,
  };
}

/** Bracket-pin offset from a post's centre (half post width + bracket clearance). */
export function pinOffset(post) {
  return postProfile(post?.material).w / 2 + (BRACKET_CLEARANCE[post?.material] ?? 19.5);
}

/**
 * Centre-to-centre bay pitch for a max-width panel between posts of this material:
 * a 2400 physical panel = 2375 pin-to-pin (panel overhangs pins by 12.5 each side)
 * plus a pin offset at each end. Aluminium → exactly 2500.
 */
export function bayPitch(post, maxRun = MAX_PANEL_RUN) {
  return maxRun - PANEL_FRAME_SHS.w + 2 * pinOffset(post);
}

// ─── Face keys: 'px'=+X, 'nx'=−X, 'py'=+Y, 'ny'=−Y in post-local space ──────

/** Auto-detect which face key to use for a span from post toward other. */
export function autoFaceKey(post, other) {
  const dx = other.x - post.x, dy = other.y - post.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return 'px';
  const rad = post.footplateRotationDeg * Math.PI / 180;
  const lx  = (dx / len) * Math.cos(rad) - (dy / len) * Math.sin(rad);
  const ly  = (dx / len) * Math.sin(rad) + (dy / len) * Math.cos(rad);
  if (Math.abs(lx) >= Math.abs(ly)) return lx >= 0 ? 'px' : 'nx';
  return ly >= 0 ? 'py' : 'ny';
}

/** World-space position of the bracket pin on `post` for a given face key. */
export function hingePoint(post, faceKey) {
  const prof = postProfile(post.material);
  const hw   = prof.w / 2, hh = prof.h / 2;
  const c    = BRACKET_CLEARANCE[post.material] ?? 19.5;
  const rad  = post.footplateRotationDeg * Math.PI / 180;
  const vmap = { px: [hw + c, 0], nx: [-(hw + c), 0], py: [0, hh + c], ny: [0, -(hh + c)] };
  const [vx, vy] = vmap[faceKey] ?? [hw + c, 0];
  return {
    x: post.x + vx * Math.cos(rad) + vy * Math.sin(rad),
    y: post.y - vx * Math.sin(rad) + vy * Math.cos(rad),
  };
}

/** All 4 world-space pivot points for a post (one per face). */
export function postPivotPoints(post) {
  return ['px', 'nx', 'py', 'ny'].map(key => ({ key, ...hingePoint(post, key) }));
}

/**
 * The 4 selectable hinge-bracket pin positions for a hinged door span.
 * Each bracket has 3 slots (centre + two outer at ±29.5 mm); only the two outer
 * slots are selectable — centre is visual-only on the HB render.
 * Returns [{ pos: 'Al'|'Ar'|'Bl'|'Br', x, y }, ...]
 */
export function doorHingePositions(span, postMap) {
  const h = spanHinges(span, postMap);
  if (!h) return [];
  const { hA, hB } = h;
  const dx = hB.x - hA.x, dy = hB.y - hA.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];
  const nx = -dy / len, ny = dx / len; // left-of-A→B unit normal
  const off = 29.5; // mm — matches outer HB pin slot offset from bracket centreline
  return [
    { pos: 'Al', x: hA.x + nx * off, y: hA.y + ny * off },
    { pos: 'Ar', x: hA.x - nx * off, y: hA.y - ny * off },
    { pos: 'Bl', x: hB.x + nx * off, y: hB.y + ny * off },
    { pos: 'Br', x: hB.x - nx * off, y: hB.y - ny * off },
  ];
}

/**
 * Clickable oriented-strip primitives for a span's *rendered* geometry (the leaf drawn
 * at an angle, the sliding-door track, the cantilever gate beam) — so those can be
 * selected, not just the opening centreline. Each shape is a segment + half-width:
 * { ax, ay, bx, by, halfW }. Mirrors the geometry in render.js. Empty for plain panels/gaps.
 */
export function spanHitShapes(span, postMap) {
  const h = spanHinges(span, postMap);
  if (!h) return [];
  const { hA, hB } = h;
  const dx = hB.x - hA.x, dy = hB.y - hA.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];
  const sdx = dx / len, sdy = dy / len;
  const nx = -sdy, ny = sdx;                    // left of A→B
  const railHalf = PANEL_FRAME_SHS.w / 2;       // 12.5
  const kind = span.spanKind;
  const kp = span.kindProps ?? {};

  if (kind === 'hingedDoor' || kind === 'swingGate') {
    // Leaf from the hinge square to its open tip (mirrors drawDoorLeaf).
    const hp        = kp.hingePos ?? ((kp.hingeEnd ?? 'A') + ((kp.swingSide ?? 'left') === 'left' ? 'l' : 'r'));
    const postChar  = hp[0];
    const sideSign  = hp[1] === 'l' ? 1 : -1;
    const swingSign = (postChar === 'A' ? 1 : -1) * sideSign;
    const openDeg   = kp.openAngleDeg ?? 45;
    const hingeSq   = doorHingePositions(span, postMap).find(p => p.pos === hp);
    const hinge     = hingeSq ? { x: hingeSq.x, y: hingeSq.y } : (postChar === 'A' ? hA : hB);
    const free      = postChar === 'A' ? hB : hA;
    const dv        = { x: free.x - hinge.x, y: free.y - hinge.y };
    const dlen      = Math.hypot(dv.x, dv.y) || 1;
    const cdx = dv.x / dlen, cdy = dv.y / dlen;
    const rad = swingSign * openDeg * Math.PI / 180;
    const odx = cdx * Math.cos(rad) - cdy * Math.sin(rad);
    const ody = cdx * Math.sin(rad) + cdy * Math.cos(rad);
    return [{ ax: hinge.x, ay: hinge.y, bx: hinge.x + odx * dlen, by: hinge.y + ody * dlen, halfW: railHalf }];
  }

  if (kind === 'slidingDoor') {
    const slideEnd = kp.slideEnd ?? 'B';
    const tSide    = kp.trackSide === 'right' ? -1 : 1;
    const tnx = nx * tSide, tny = ny * tSide;
    const homePost = postMap[slideEnd === 'A' ? span.postA : span.postB];
    const hw  = postProfile(homePost?.material ?? 'aluminium').w / 2;
    const brC = BRACKET_CLEARANCE[homePost?.material] ?? BRACKET_CLEARANCE.aluminium;
    const postReach = 2 * hw + brC;
    const trackExtend = Math.max(0, kp.trackExtendMm ?? 0);
    let thX, thY, dirX, dirY;
    if (slideEnd === 'A') { thX = hA.x; thY = hA.y; dirX = sdx;  dirY = sdy;  }
    else                  { thX = hB.x; thY = hB.y; dirX = -sdx; dirY = -sdy; }
    const trackLen = 2 * len + 200 + trackExtend;
    const tsX = thX - dirX * postReach, tsY = thY - dirY * postReach;
    const tfX = tsX + dirX * trackLen,  tfY = tsY + dirY * trackLen;
    const trackDepth = 40, trackGap = 10;
    const tCen = hw + trackGap + trackDepth / 2;
    return [{ ax: tsX + tnx * tCen, ay: tsY + tny * tCen, bx: tfX + tnx * tCen, by: tfY + tny * tCen, halfW: trackDepth / 2 }];
  }

  if (kind === 'cantileverGate') {
    const retractEnd = kp.retractEnd ?? 'A';
    const tSide = kp.trackSide === 'right' ? -1 : 1;
    const tnx = nx * tSide, tny = ny * tSide;
    let hHome, hClose, dirX, dirY;
    if (retractEnd === 'A') { hHome = hA; hClose = hB; dirX = -sdx; dirY = -sdy; }
    else                    { hHome = hB; hClose = hA; dirX = sdx;  dirY = sdy;  }
    const homePost = postMap[retractEnd === 'A' ? span.postA : span.postB];
    const hw = postProfile(homePost?.material ?? 'aluminium').w / 2;
    const fp = FOOTPLATE[homePost?.footplate] ?? { w: 180, h: 180 };
    const fpHalf = Math.max(fp.w, fp.h) / 2;
    const pc = { x: homePost?.x ?? hHome.x, y: homePost?.y ?? hHome.y };
    const carHalf   = 70;
    const rollerSpc = Math.max(100, kp.rollerSpacingMm ?? 500);
    const tailOver  = Math.max(0, kp.tailOverhangMm ?? 150);
    const frontOff  = Math.max(0, kp.frontWheelOffsetMm ?? (fpHalf + 50 + carHalf));
    const tailS = frontOff + rollerSpc + tailOver;
    const closePost = postMap[retractEnd === 'A' ? span.postB : span.postA];
    const hwC = postProfile(closePost?.material ?? 'aluminium').w / 2;
    const cCen = closePost ? { x: closePost.x, y: closePost.y } : hClose;
    const noseEnd = { x: cCen.x - dirX * hwC, y: cCen.y - dirY * hwC };
    const tailPt  = { x: pc.x + dirX * tailS, y: pc.y + dirY * tailS };
    const beamCen = hw + 10 + 25; // beamNear (hw+10) + beamDepth/2 (25)
    return [{ ax: noseEnd.x + tnx * beamCen, ay: noseEnd.y + tny * beamCen,
              bx: tailPt.x + tnx * beamCen,  by: tailPt.y + tny * beamCen, halfW: 25 }];
  }

  return [];
}

/**
 * Perpendicular offset (mm) a sliding-door panel-width dimension defaults to — small, so the
 * ▭ dim sits ON the parked leaf rather than out in a dimension lane. Shared by render + hit +
 * label-drag so they always agree.
 */
export const SLIDING_DIM_OFFSET = 120;

/**
 * World-space centreline of a sliding door's parked LEAF (at the far end of its track, offset
 * to the track side) plus its width. Single source of truth mirrored by drawSlidingDoor
 * (render.js) and eSlidingDoor (dxf.js): leaf width = post c-c + gateExtend; leaf outer face
 * flush with the track far end; centreline at trackGap(10) + trackDepth(40)/2 off the post face.
 * Returns { ax, ay, bx, by, widthMm } or null.
 */
export function slidingLeafLine(span, postMap) {
  if (span.spanKind !== 'slidingDoor') return null;
  const h = spanHinges(span, postMap);
  if (!h) return null;
  const { hA, hB } = h;
  const dx = hB.x - hA.x, dy = hB.y - hA.y, len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const sdx = dx / len, sdy = dy / len;
  const nx = -sdy, ny = sdx;
  const kp       = span.kindProps ?? {};
  const slideEnd = kp.slideEnd ?? 'B';
  const tSide    = kp.trackSide === 'right' ? -1 : 1;
  const tnx = nx * tSide, tny = ny * tSide;
  const homePost  = postMap[slideEnd === 'A' ? span.postA : span.postB];
  const hw        = postProfile(homePost?.material ?? 'aluminium').w / 2;
  const brC       = BRACKET_CLEARANCE[homePost?.material] ?? BRACKET_CLEARANCE.aluminium;
  const postReach = 2 * hw + brC;
  let thX, thY, dirX, dirY;
  if (slideEnd === 'A') { thX = hA.x; thY = hA.y; dirX =  sdx; dirY =  sdy; }
  else                  { thX = hB.x; thY = hB.y; dirX = -sdx; dirY = -sdy; }
  const trackExtend = Math.max(0, kp.trackExtendMm ?? 0);
  const gateExtend  = Math.max(0, kp.gateExtendMm  ?? 0);
  const trackLen = 2 * len + 200 + trackExtend;
  const pA = postMap[span.postA], pB = postMap[span.postB];
  const c2c   = (pA && pB) ? Math.hypot(pB.x - pA.x, pB.y - pA.y) : len;
  const doorW = c2c + gateExtend;
  const tsX  = thX - dirX * postReach, tsY = thY - dirY * postReach;
  const tCen = hw + 10 + 20;                     // trackGap + trackDepth/2 (matches drawSlidingDoor)
  return {
    ax: tsX + dirX * (trackLen - doorW) + tnx * tCen, ay: tsY + dirY * (trackLen - doorW) + tny * tCen,
    bx: tsX + dirX * trackLen           + tnx * tCen, by: tsY + dirY * trackLen           + tny * tCen,
    widthMm: doorW,
  };
}

// ─── Span geometry ────────────────────────────────────────────────────────────

/** Both hinge points for a span; returns null if posts can't be resolved. */
export function spanHinges(span, postMap) {
  const pA = postMap[span.postA], pB = postMap[span.postB];
  if (!pA || !pB) return null;
  const fA = span.faceA ?? autoFaceKey(pA, pB);
  const fB = span.faceB ?? autoFaceKey(pB, pA);
  return { hA: hingePoint(pA, fA), hB: hingePoint(pB, fB), fA, fB };
}

/** Run length (mm) of a span, computed from hinge geometry. */
export function spanRunLength(span, postMap) {
  const h = spanHinges(span, postMap);
  // Panel overall width = pin-to-pin + one SHS bar depth at each end (12.5 mm × 2 = 25 mm).
  // e.g. 900 mm post spacing → 775 mm pin-to-pin → 800 mm panel.
  return h ? Math.round(Math.hypot(h.hB.x - h.hA.x, h.hB.y - h.hA.y)) + PANEL_FRAME_SHS.w : 0;
}

/** Nominal panel height (mm): stored if set, otherwise derived. */
export function spanHeight(span, postMap) {
  const pA = postMap[span.postA], pB = postMap[span.postB];
  if (!pA || !pB) return 0;
  if (span.heightMm !== null) return span.heightMm;
  return Math.min(pA.heightMm, pB.heightMm) - span.floorClearanceMm;
}

/**
 * Panel frame cut list.
 *   Frame: 25×1.6 SHS
 *   2 verticals  @ spanHeight
 *   3 horizontals @ runLength − 50  (runLength minus 2 × 25 mm vertical width)
 */
/**
 * Bay layout for a panel span, in PIN-LINE space (the actual panel run hA→hB, the
 * hinge line — NOT the post-centre line, which can sit off to the side when the end
 * posts' bracket faces aren't perpendicular to the run, e.g. a diagonal Trace run).
 * Ghost posts sit ON this line, perpendicular to the run, so every panel connects
 * bracket-to-bracket.
 *
 * Spacing (configurable, see panelConfig): the run is divided into the minimum number of
 * bays `Nmin` so each panel is ≤ the max run, then split as EVENLY as possible and landed
 * on the panel divisor grid (default 100 mm): the equal width is rounded to the nearest
 * increment for all but one panel, and the final "balance" panel absorbs the remainder so
 * the widths sum exactly to the run. Because the bays stay near-equal, the balance panel is
 * always within ~one increment of the others (never a sliver), so no min-short handling is
 * needed. E.g. a 3000 run → 1500 + 1500; a 3050 run → 1500 + 1550.
 *
 * Returns ghost CENTRE distances `cds` along the pin line from hA — the single source of
 * truth for ghostPostCenters / ghostPanelSections. Physical panel width W for N equal
 * panels relates to pin geometry by pitchW=(D+2p)/N and W=pitchW−2p+PANEL_FRAME_SHS.w.
 */
function bayLayout(span, postMap, cfg = PANEL_DEFAULTS) {
  if ((span.spanKind ?? 'panel') !== 'panel') return null;
  const A = postMap[span.postA];
  const h = spanHinges(span, postMap);
  if (!A || !h) return null;
  const dx = h.hB.x - h.hA.x, dy = h.hB.y - h.hA.y;
  const D  = Math.hypot(dx, dy);            // pin-to-pin run length
  if (D < 1) return null;
  const p        = pinOffset(A);            // ghosts match post A's material (convert-ghost inherits it)
  const shs      = PANEL_FRAME_SHS.w;
  const pitchMax = bayPitch(A, cfg.maxPanelRunMm);

  const Nmin = Math.ceil((D + 2 * p) / pitchMax); // min panels so each ≤ max run
  if (Nmin <= 1) return null;                     // fits one panel → no ghosts

  const ux = dx / D, uy = dy / D;
  // Perpendicular post: a face points ALONG the run so its pin lands on the pin line.
  // hingePoint uses angle −rad for face px, so footplateRotationDeg = −runBearing.
  const rotDeg = -Math.atan2(dy, dx) * 180 / Math.PI;

  // Near-equal split rounded to the divisor. `We` is the equal physical width; the panel
  // widths must sum to `total` (= Nmin·We) to fit the pin geometry. Floor every bay to the
  // grid, then distribute the surplus one increment at a time across bays (so each stays
  // within one increment of equal, never exceeding the max panel), leaving only a sub-grid
  // remainder that lands on a single balance panel. e.g. 3000→[1500,1500], 3050→[1500,1550].
  const div   = Math.max(1, cfg.panelDivisorMm || 1);
  const We    = (D + 2 * p) / Nmin - 2 * p + shs;   // equal physical panel width
  const total = Nmin * We;
  const base  = Math.floor(We / div) * div;          // grid floor shared by every bay
  const rem   = total - base * Nmin;                 // surplus to spread (≥ 0, < Nmin·div)
  const k     = Math.floor((rem + 1e-6) / div);      // this many bays get one extra increment
  const frac  = rem - k * div;                       // sub-grid leftover → one balance panel
  const widths = Array.from({ length: Nmin }, (_, i) => base + (i < k ? div : 0));
  if (frac > 0.5) widths[widths.length - 1] += frac;

  // Arrange symmetrically about the run midpoint (a singular/odd panel sits dead-centre),
  // then convert to ghost-centre distances along the pin line.
  const cds = cdsFromWidths(symmetrize(widths), shs, p);

  return { hA: h.hA, ux, uy, D, pin: p, rotDeg, cds };
}

/** Ghost-centre distances along the pin line from an ordered list of physical panel widths. */
function cdsFromWidths(widths, shs, p) {
  const cds = [];
  let prevFwd = 0;                          // forward pin of the previous post (post-A pin = 0)
  for (let i = 0; i < widths.length - 1; i++) {
    const cd = prevFwd + (widths[i] - shs) + p; // panel i pin-to-pin = width−shs; ghost back pin = cd−p
    cds.push(cd);
    prevFwd = cd + p;
  }
  return cds;                               // last panel is implied by the run remainder
}

/**
 * Reorder panel widths into a symmetric (palindromic) run: equal panels mirror the
 * midpoint and any singular width sits dead-centre (e.g. [2400,1250,1250] → [1250,2400,1250]).
 * Order-agnostic — the grouped breakdown (N@width) is unchanged; only physical placement is.
 */
function symmetrize(widths) {
  const groups = new Map();                 // rounded width → the actual values in that group
  for (const w of widths) {
    const k = Math.round(w);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const left = [], center = [];
  for (const k of [...groups.keys()].sort((a, b) => a - b)) {
    const arr = groups.get(k);
    for (let i = 0; i < Math.floor(arr.length / 2); i++) left.push(arr[i]); // one of each pair
    if (arr.length % 2 === 1) center.push(arr[arr.length - 1]);             // the odd one out
  }
  return [...left, ...center, ...left.slice().reverse()];
}

/**
 * Perpendicular offset (mm, left of A→B) of a panel-width dimension line from the panel it
 * measures. Shared by the canvas (render.js) and the DXF exporter so both agree.
 */
export const PANEL_DIM_OFFSET = 300;

/**
 * World-space extents of each PHYSICAL panel in a span — one entry per sub-panel, so a
 * long run split by ghost posts yields one entry per bay. Panels overhang their bracket
 * pins by PANEL_FRAME_SHS.w/2 at each end, so a panel runs from (pin − 12.5) to
 * (pin + 12.5) along the pin line. Empty for non-panel spans.
 *
 * Single source of truth for panel extents: ghostPanelSections (BOM), the canvas panel
 * dimensions and the DXF DIMENSION entities all derive from this, so they can't disagree.
 *
 * Returns [{ ax, ay, bx, by, runMm }].
 */
export function panelSegments(span, postMap, cfg = PANEL_DEFAULTS) {
  if ((span.spanKind ?? 'panel') !== 'panel') return [];
  const h = spanHinges(span, postMap);
  if (!h) return [];
  const dx = h.hB.x - h.hA.x, dy = h.hB.y - h.hA.y;
  const D  = Math.hypot(dx, dy);
  if (D < 1) return [];
  const ux = dx / D, uy = dy / D;
  const half = PANEL_FRAME_SHS.w / 2;

  // Pin-line spans of each bay, as [start, end] distances from the post-A pin. Post-A pin
  // sits at 0 and post-B at D; each ghost contributes a back pin (cd−p) and forward pin (cd+p).
  const lay   = bayLayout(span, postMap, cfg);
  const bays  = [];
  let prevFwd = 0;
  if (lay) {
    for (const cd of lay.cds) { bays.push([prevFwd, cd - lay.pin]); prevFwd = cd + lay.pin; }
  }
  bays.push([prevFwd, D]);

  return bays.map(([s, e]) => ({
    ax: h.hA.x + ux * (s - half), ay: h.hA.y + uy * (s - half),
    bx: h.hA.x + ux * (e + half), by: h.hA.y + uy * (e + half),
    runMm: Math.round((e - s) + PANEL_FRAME_SHS.w),
  }));
}

/**
 * Width-dimension segments for a span — the single source of truth for the "Dimension all
 * panels" annotations (canvas + DXF). Each entry carries its own perpendicular `offset`
 * (mm, left of A→B) so different span kinds place their dimension line differently:
 *  - panel: one entry per physical sub-panel (ghost splits included); offset PANEL_DIM_OFFSET
 *    so the dimension floats clear of the fence line — see panelSegments.
 *  - hingedDoor / swingGate: one entry ALONG the drawn open leaf (hinge → open tip at the
 *    open angle), offset clear of the leaf like a panel, so the dimension line runs parallel
 *    to the leaf at, e.g., 45° (rather than buried down its centre) and reads the leaf width.
 *  - gap / slidingDoor / cantileverGate: none (a gap has no leaf; sliding/cantilever widths
 *    are itemised in the BOM instead of dimensioned here).
 * Returns [{ ax, ay, bx, by, runMm, offset }].
 */
export function dimensionSegments(span, postMap, cfg = PANEL_DEFAULTS) {
  const kind = span.spanKind ?? 'panel';
  if (kind === 'panel') {
    return panelSegments(span, postMap, cfg).map(s => ({ ...s, offset: PANEL_DIM_OFFSET }));
  }
  if (kind === 'hingedDoor' || kind === 'swingGate') {
    const h = spanHinges(span, postMap);
    if (!h) return [];
    // The VALUE is the leaf panel width (the manufacturing number): hinge bracket slot to
    // the free pin, plus the frame — mirrors drawDoorLeaf / spanHitShapes.
    const kp        = span.kindProps ?? {};
    const hp        = kp.hingePos ?? ((kp.hingeEnd ?? 'A') + ((kp.swingSide ?? 'left') === 'left' ? 'l' : 'r'));
    const postChar  = hp[0];
    const hingeSq   = doorHingePositions(span, postMap).find(p => p.pos === hp);
    const hinge     = hingeSq ? { x: hingeSq.x, y: hingeSq.y } : (postChar === 'A' ? h.hA : h.hB);
    const free      = postChar === 'A' ? h.hB : h.hA;
    const dlen      = Math.hypot(free.x - hinge.x, free.y - hinge.y) || 1;
    // …but the dimension LIES FLAT along the span line (closed position), like a panel dim —
    // drawn along the 45°-open leaf it reads as diagonal geometry floating mid-walkway.
    const sl   = Math.hypot(h.hB.x - h.hA.x, h.hB.y - h.hA.y) || 1;
    const ux   = (h.hB.x - h.hA.x) / sl, uy = (h.hB.y - h.hA.y) / sl;
    const half = PANEL_FRAME_SHS.w / 2;      // leaf overhangs each end by half an SHS, like a panel
    return [{
      ax: h.hA.x - ux * half, ay: h.hA.y - uy * half,
      bx: h.hB.x + ux * half, by: h.hB.y + uy * half,
      runMm: Math.round(dlen + PANEL_FRAME_SHS.w),
      offset: PANEL_DIM_OFFSET,
    }];
  }
  return [];
}

/**
 * Returns one entry per physical sub-panel for a span. Spans within one bay return a
 * single entry; longer spans split per bayLayout (equal panels, or max + short/evened
 * remainder). runMm is the overall physical panel width (pin-to-pin + SHS overhang).
 */
export function ghostPanelSections(span, postMap, cfg = PANEL_DEFAULTS) {
  const segs = panelSegments(span, postMap, cfg);
  if (!segs.length) return [];
  const base = { heightMm: spanHeight(span, postMap), meshSide: span.meshSide };
  return segs.map(seg => ({ ...base, runMm: seg.runMm }));
}

/**
 * World-space centres (+ perpendicular rotation) of the intermediate "ghost" posts for
 * a long panel span — placed on the PIN LINE at the centre distances computed by
 * bayLayout (equal or max+short spacing), so panels connect bracket-to-bracket.
 * Empty for short runs / other kinds. Returns [{ x, y, rotDeg }].
 */
export function ghostPostCenters(span, postMap, cfg = PANEL_DEFAULTS) {
  const lay = bayLayout(span, postMap, cfg);
  if (!lay) return [];
  return lay.cds.map(d => ({ x: lay.hA.x + lay.ux * d, y: lay.hA.y + lay.uy * d, rotDeg: lay.rotDeg }));
}

export function panelCutList(span, postMap) {
  const run    = spanRunLength(span, postMap);
  const height = spanHeight(span, postMap);
  return {
    runMm:    run,
    heightMm: height,
    verticals:   { qty: 2, lengthMm: height,       section: '25×1.6 SHS' },
    horizontals: { qty: 3, lengthMm: run - 50,      section: '25×1.6 SHS' },
    meshArea:    (run * height) / 1e6,              // m²
    meshSide:    span.meshSide,
  };
}

// ─── Auto-link ────────────────────────────────────────────────────────────────

/**
 * Mutates doc in-place: for each post that has no spans yet, creates one span
 * to its nearest neighbour (skipping pairs blocked by an intervening post).
 *
 * Call inside store.mutate() after adding a new post.
 */
export function autoLink(doc) {
  const posts = doc.objects.filter(o => o.type === 'post' && o.kind !== 'bollard'); // bollards never span
  if (posts.length < 2) return;

  const existing   = new Set();
  const hasSpan    = new Set(); // posts that already have ≥1 span
  for (const s of doc.objects) {
    if (s.type !== 'span') continue;
    existing.add(pairKey(s.postA, s.postB));
    hasSpan.add(s.postA);
    hasSpan.add(s.postB);
  }

  for (const A of posts) {
    if (hasSpan.has(A.id)) continue; // already connected

    // Find single nearest unblocked post that isn't already linked to A
    let nearest = null, nearestDist = Infinity;
    for (const B of posts) {
      if (B.id === A.id) continue;
      if (existing.has(pairKey(A.id, B.id))) continue;
      if (posts.some(C => C.id !== A.id && C.id !== B.id && postOnSegment(A, B, C))) continue;
      const d = Math.hypot(B.x - A.x, B.y - A.y);
      if (d < nearestDist) { nearestDist = d; nearest = B; }
    }

    if (nearest) {
      const key = pairKey(A.id, nearest.id);
      doc.objects.push(createSpan(A.id, nearest.id, {
        faceA: autoFaceKey(A, nearest),
        faceB: autoFaceKey(nearest, A),
      }));
      existing.add(key);
      hasSpan.add(A.id);
      hasSpan.add(nearest.id);
    }
  }
}

/**
 * Creates one panel span between the two nearest unlinked posts in the
 * selected set.  Mutates doc in-place; returns true if a span was added.
 */
const MAX_SPANS_PER_PAIR = 3;
const FACE_CYCLE = ['px', 'py', 'nx', 'ny'];

/**
 * Add a panel between the nearest eligible pair of selected posts.
 * Up to MAX_SPANS_PER_PAIR spans are allowed between the same pair — each
 * uses a face rotated 90° from the previous so bracket pins don't overlap.
 */
export function addPanelNearest(doc, selectedIds) {
  const selPosts = doc.objects.filter(o => o.type === 'post' && o.kind !== 'bollard' && selectedIds.has(o.id));
  if (selPosts.length < 2) return false;

  // Build per-pair face-combo usage: pairKey → Set<"fA:fB"> (both normalised to smaller-id first)
  const usedByPair = new Map();
  for (const s of doc.objects.filter(o => o.type === 'span')) {
    const k  = pairKey(s.postA, s.postB);
    const fa = s.postA <= s.postB ? s.faceA : s.faceB;
    const fb = s.postA <= s.postB ? s.faceB : s.faceA;
    if (!usedByPair.has(k)) usedByPair.set(k, new Set());
    usedByPair.get(k).add(`${fa}:${fb}`);
  }

  let bestA = null, bestB = null, bestFaceA = null, bestFaceB = null, bestDist = Infinity;

  for (let i = 0; i < selPosts.length; i++) {
    for (let j = i + 1; j < selPosts.length; j++) {
      const A = selPosts[i], B = selPosts[j];
      const k    = pairKey(A.id, B.id);
      const used = usedByPair.get(k) ?? new Set();
      if (used.size >= MAX_SPANS_PER_PAIR) continue;

      const { fa, fb } = nextFaceCombo(A, B, used);
      if (!fa) continue;

      const d = Math.hypot(B.x - A.x, B.y - A.y);
      if (d < bestDist) { bestDist = d; bestA = A; bestB = B; bestFaceA = fa; bestFaceB = fb; }
    }
  }

  if (bestA && bestB) {
    doc.objects.push(createSpan(bestA.id, bestB.id, { faceA: bestFaceA, faceB: bestFaceB }));
    return true;
  }
  return false;
}

/** Returns the first face-combo (A-face, B-face) not already used for this pair. */
function nextFaceCombo(A, B, usedSet) {
  const primaryFA = autoFaceKey(A, B);
  const primaryFB = autoFaceKey(B, A);
  const startIdx  = FACE_CYCLE.indexOf(primaryFA);

  for (let rot = 0; rot < FACE_CYCLE.length; rot++) {
    const fa = FACE_CYCLE[(startIdx + rot) % FACE_CYCLE.length];
    const fb = rot === 0 ? primaryFB : autoFaceKey(B, A); // keep B's natural face, vary A's
    const normFA = A.id <= B.id ? fa : fb;
    const normFB = A.id <= B.id ? fb : fa;
    if (!usedSet.has(`${normFA}:${normFB}`)) return { fa, fb };
  }
  return { fa: null, fb: null };
}

function pairKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

function postOnSegment(A, B, C) {
  const dx  = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return false;
  const t = ((C.x - A.x) * dx + (C.y - A.y) * dy) / len2;
  if (t < 0.02 || t > 0.98) return false; // beyond endpoints
  const perpX = A.x + t * dx - C.x;
  const perpY = A.y + t * dy - C.y;
  const fp   = FOOTPLATE[C.footplate] ?? { w: 180, h: 180 };
  const thresh = Math.max(fp.w, fp.h) / 2 + 60; // half-footplate + margin
  return perpX * perpX + perpY * perpY <= thresh * thresh;
}
