// Trace tool geometry — freehand strokes → clean 22.5°-snapped polylines.
//
// Pure functions, no DOM/store. All points are MODEL space (mm). `scale` is the
// view scale (px per mm) so screen-pixel tolerances translate to mm: pxTol/scale.
//
// Pipeline per stroke: decimate → detect closure → RDP simplify → quantize each
// segment's bearing to the nearest 22.5° → merge equal-direction runs → refit
// each run as an infinite line (fixed direction, through its points' centroid)
// → corners = consecutive line intersections. assembleTrace() then stitches
// multiple strokes: near endpoints merge to one post, and axis-aligned facing
// gaps become doorways (aligned, no span).

// ─── vector helpers ────────────────────────────────────────────────────────────
const sub   = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dist  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a, b) => a.x * b.y - a.y * b.x;

/** Perpendicular distance from p to the infinite line a→b (a,b distinct). */
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return dist(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Ramer–Douglas–Peucker on an open polyline. Returns kept points (with ends). */
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left  = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/** RDP for a closed ring: split at the two farthest-apart points so the stroke's
 *  arbitrary start/end seam isn't forced to be a corner. Returns ring vertices. */
function rdpClosed(pts, eps) {
  if (pts.length < 4) return pts.slice();
  // Farthest point from pts[0], then farthest from that — the ring "diameter".
  let i1 = 0, best = -1;
  for (let i = 1; i < pts.length; i++) { const d = dist(pts[i], pts[0]); if (d > best) { best = d; i1 = i; } }
  let i2 = 0; best = -1;
  for (let i = 0; i < pts.length; i++) { const d = dist(pts[i], pts[i1]); if (d > best) { best = d; i2 = i; } }
  const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
  const arcA = pts.slice(lo, hi + 1);
  const arcB = pts.slice(hi).concat(pts.slice(0, lo + 1));
  const ra = rdp(arcA, eps);
  const rb = rdp(arcB, eps);
  // Concatenate, dropping the shared endpoints (lo and hi appear in both arcs).
  return ra.slice(0, -1).concat(rb.slice(0, -1));
}

/** Nearest quantized unit direction to the vector a→b (stepRad = angle quantum). */
function quantDir(a, b, stepRad) {
  const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / stepRad) * stepRad;
  return { x: Math.cos(ang), y: Math.sin(ang), ang };
}

/** Intersection of lines (P along u) and (Q along v); null if near-parallel. */
function lineIntersect(P, u, Q, v) {
  const denom = cross(u, v);
  if (Math.abs(denom) < 1e-6) return null;
  const t = cross(sub(Q, P), v) / denom;
  return { x: P.x + u.x * t, y: P.y + u.y * t };
}

const centroid = pts => {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
};

/**
 * Straighten one raw stroke into corner vertices.
 * @returns {{vertices:{x,y}[], closed:boolean} | null}  null = too small / degenerate
 */
export function vectorizeStroke(rawPts, scale, stepDeg = 45) {
  const decMm   = 3  / scale;   // min spacing between kept raw points
  const rdpMm   = 12 / scale;   // corner detection tolerance
  const minLen  = 50 / scale;   // ignore accidental taps / tiny squiggles
  const closeMm = 40 / scale;   // endpoint-to-start closure radius (also % of bbox below)
  const stepRad = (stepDeg > 0 ? stepDeg : 45) * Math.PI / 180; // edge bearing quantum

  // 1. Decimate
  const dec = [];
  for (const p of rawPts) {
    if (!dec.length || dist(dec[dec.length - 1], p) >= decMm) dec.push({ x: p.x, y: p.y });
  }
  if (dec.length < 2) return null;

  // 1b. Light 3-point smoothing (endpoints fixed) — removes hand-jitter and the
  // acceleration "hooks" at a stroke's start/end that would otherwise spawn a
  // spurious short segment at a slightly different quantized angle. Real corners
  // survive a single averaging pass.
  const pts = dec.map((p, i) => {
    if (i === 0 || i === dec.length - 1) return p;
    return { x: (dec[i - 1].x + p.x + dec[i + 1].x) / 3, y: (dec[i - 1].y + p.y + dec[i + 1].y) / 3 };
  });

  // Path length + bbox
  let pathLen = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i) pathLen += dist(pts[i - 1], pts[i]);
    minX = Math.min(minX, pts[i].x); maxX = Math.max(maxX, pts[i].x);
    minY = Math.min(minY, pts[i].y); maxY = Math.max(maxY, pts[i].y);
  }
  if (pathLen < minLen) return null;

  // 2. Closure
  const diag     = Math.hypot(maxX - minX, maxY - minY);
  const closeTol = Math.max(closeMm, diag * 0.06);
  const closed   = pts.length >= 4 && dist(pts[0], pts[pts.length - 1]) <= closeTol;

  // 3. RDP → coarse corners, plus the index in `pts` each corner maps to
  const ring = closed ? pts.slice(0, -1) : pts; // drop the near-duplicate closing point
  const simplified = closed ? rdpClosed(ring, rdpMm) : rdp(ring, rdpMm);
  if (simplified.length < 2) return null;

  // 4. Build direction-quantized segments over the ORIGINAL ring, so each segment
  //    carries the raw points that fall along it (for the least-squares refit).
  //    Map each simplified vertex back to its index in `ring`.
  const idxOf = v => ring.indexOf(v);
  const cornerIdx = simplified.map(idxOf).filter(i => i >= 0);
  // Guarantee monotonic, unique, wrapping indices
  const n = ring.length;
  const segCount = closed ? cornerIdx.length : cornerIdx.length - 1;
  let segments = [];
  for (let s = 0; s < segCount; s++) {
    const i0 = cornerIdx[s];
    const i1 = cornerIdx[(s + 1) % cornerIdx.length];
    // Collect ring points from i0..i1 (wrapping for closed)
    const seg = [];
    let i = i0;
    while (true) {
      seg.push(ring[i]);
      if (i === i1) break;
      i = (i + 1) % n;
      if (seg.length > n) break; // safety
    }
    if (seg.length < 2) continue;
    const dir = quantDir(seg[0], seg[seg.length - 1], stepRad);
    segments.push({ pts: seg, dir, ang: dir.ang });
  }
  if (!segments.length) return null;

  // 4b. Merge consecutive segments with the same quantized bearing
  segments = mergeSameDir(segments, closed);
  // 4c. Drop tiny segments (merge their points into the longer neighbour), repeat
  segments = dropMicroSegments(segments, closed, 18 / scale);
  segments = mergeSameDir(segments, closed);

  if (closed && segments.length < 3) return null;
  if (!closed && segments.length < 1) return null;

  // 5. Refit: each segment → line (fixed quantized direction, through its centroid)
  let lines = segments.map(seg => ({ P: centroid(seg.pts), u: { x: seg.dir.x, y: seg.dir.y } }));
  const rawStart = ring[cornerIdx[0]] ?? ring[0];
  const rawEnd   = ring[cornerIdx[cornerIdx.length - 1]] ?? ring[n - 1];

  // 5b. Remove spurious "chamfer" lines: a noisy 90° corner often yields a tiny
  // extra segment whose edge is a few cm long. Drop the line with the shortest
  // resulting edge while that edge is below minEdge, then re-intersect the real
  // walls into a sharp corner. Never drop below a valid polygon.
  const minEdge = 22 / scale;
  const floor   = closed ? 3 : 1;
  while (lines.length > floor) {
    const corners = cornersFromLines(lines, closed, rawStart, rawEnd);
    // Edge i runs along line i, from corners[i] to corners[i+1] (open) / cyclic (closed)
    let shortest = Infinity, shortI = -1;
    const eCount = closed ? lines.length : lines.length; // one edge per line
    for (let i = 0; i < eCount; i++) {
      const c0 = corners[i];
      const c1 = corners[closed ? (i + 1) % corners.length : i + 1];
      if (!c0 || !c1) continue;
      const d = dist(c0, c1);
      if (d < shortest) { shortest = d; shortI = i; }
    }
    if (shortI < 0 || shortest >= minEdge) break;
    lines.splice(shortI, 1);
  }

  const vertices = cornersFromLines(lines, closed, rawStart, rawEnd).filter(Boolean);

  // Round to whole mm and drop consecutive duplicates
  const out = [];
  for (const v of vertices) {
    const r = { x: Math.round(v.x), y: Math.round(v.y) };
    if (!out.length || dist(out[out.length - 1], r) > 1) out.push(r);
  }
  if (closed && out.length >= 2 && dist(out[0], out[out.length - 1]) <= 1) out.pop();

  if (closed && out.length < 3) return null;
  if (!closed && out.length < 2) return null;
  return { vertices: out, closed };
}

function projectOnto(q, line) {
  const w = sub(q, line.P);
  const t = w.x * line.u.x + w.y * line.u.y;
  return { x: line.P.x + line.u.x * t, y: line.P.y + line.u.y * t };
}

/** Corner vertices from a list of refit lines. Closed: cyclic intersections
 *  (n lines → n corners). Open: raw start/end projected onto the end lines,
 *  interior corners = consecutive intersections (n lines → n+1 corners). */
function cornersFromLines(lines, closed, rawStart, rawEnd) {
  const out = [];
  if (closed) {
    for (let s = 0; s < lines.length; s++) {
      const a = lines[(s - 1 + lines.length) % lines.length], b = lines[s];
      out.push(lineIntersect(a.P, a.u, b.P, b.u));
    }
  } else {
    out.push(projectOnto(rawStart, lines[0]));
    for (let s = 1; s < lines.length; s++) {
      out.push(lineIntersect(lines[s - 1].P, lines[s - 1].u, lines[s].P, lines[s].u) ?? lines[s].P);
    }
    out.push(projectOnto(rawEnd, lines[lines.length - 1]));
  }
  return out;
}

/** Merge neighbouring segments that share a quantized bearing (cyclic if closed). */
function mergeSameDir(segments, closed) {
  if (segments.length < 2) return segments;
  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.ang === seg.ang) {
      prev.pts = prev.pts.concat(seg.pts.slice(1));
    } else {
      merged.push({ pts: seg.pts.slice(), dir: seg.dir, ang: seg.ang });
    }
  }
  // Closed: first and last may now share a bearing across the seam
  if (closed && merged.length > 1 && merged[0].ang === merged[merged.length - 1].ang) {
    const last = merged.pop();
    merged[0].pts = last.pts.concat(merged[0].pts.slice(1));
  }
  return merged;
}

/** Remove segments shorter than minLen by folding their points into a neighbour. */
function dropMicroSegments(segments, closed, minLen) {
  if (segments.length <= (closed ? 3 : 1)) return segments;
  const len = seg => dist(seg.pts[0], seg.pts[seg.pts.length - 1]);
  let changed = true;
  while (changed && segments.length > (closed ? 3 : 1)) {
    changed = false;
    for (let i = 0; i < segments.length; i++) {
      if (len(segments[i]) >= minLen) continue;
      // Fold into the longer adjacent segment
      const prevI = (i - 1 + segments.length) % segments.length;
      const nextI = (i + 1) % segments.length;
      const intoPrev = len(segments[prevI]) >= len(segments[nextI]);
      const host = segments[intoPrev ? prevI : nextI];
      host.pts = intoPrev ? host.pts.concat(segments[i].pts.slice(1))
                          : segments[i].pts.concat(host.pts.slice(1));
      segments.splice(i, 1);
      changed = true;
      break;
    }
  }
  return segments;
}

// ─── Cross-stroke assembly ─────────────────────────────────────────────────────

/**
 * Stitch several straightened strokes into a post/span/gap plan.
 * @param {{vertices,closed}[]} chains  from vectorizeStroke
 * @param {number} scale
 * @returns {{posts:{x,y}[], spans:[number,number][], gaps:{a:number,b:number}[]}}
 *   posts: unique corner positions; spans/gaps index into posts. A gap is a doorway —
 *   two open wall-ends that continue in a straight line across an opening (any 22.5°
 *   bearing); its constraint is derived from the snapped post coords at commit.
 */
export function assembleTrace(chains, scale, snap = 1) {
  const joinMm = 25 / scale;   // endpoints this close collapse to one post
  const gapMax = 2500;          // max doorway width (mm)
  const offMm  = 18 / scale;    // axis-alignment tolerance for a doorway
  const grid   = Math.max(1, snap); // final post positions round to this grid (grid-snap increment)

  const posts = [];
  /** find-or-create a merged post index for point p */
  const idFor = p => {
    for (let i = 0; i < posts.length; i++) {
      if (dist(posts[i], p) <= joinMm) return i;
    }
    posts.push({ x: p.x, y: p.y });
    return posts.length - 1;
  };

  const spans = [];
  const spanKey = new Set();
  const addSpan = (a, b) => {
    if (a === b) return;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (spanKey.has(k)) return;
    spanKey.add(k);
    spans.push([a, b]);
  };

  // Build posts + spans per chain
  for (const chain of chains) {
    const ids = chain.vertices.map(idFor);
    for (let i = 0; i < ids.length - 1; i++) addSpan(ids[i], ids[i + 1]);
    if (chain.closed && ids.length >= 3) addSpan(ids[ids.length - 1], ids[0]);
  }

  // Door gaps: two open ends (posts touched by < 2 spans) that CONTINUE both walls in a
  // straight line across an opening — any 22.5° bearing, not just horizontal/vertical.
  const degree = new Array(posts.length).fill(0);
  const neighbour = new Array(posts.length).fill(-1); // an end's single wall neighbour
  for (const [a, b] of spans) { degree[a]++; degree[b]++; neighbour[a] = b; neighbour[b] = a; }
  const ends = posts.map((_, i) => i).filter(i => degree[i] < 2);

  const STEP = Math.PI / 8; // 22.5° → 16 steps around the circle
  // Nearest 22.5° step as an INTEGER index 0..15 (exact — avoids float-equality pitfalls).
  const stepIdx = ang => ((Math.round(ang / STEP) % 16) + 16) % 16;
  // Outward wall bearing at an end = from its neighbour toward the end (null if lone post).
  const wallStep = i => {
    const nb = neighbour[i];
    if (nb < 0 || degree[i] < 1) return null;
    return stepIdx(Math.atan2(posts[i].y - posts[nb].y, posts[i].x - posts[nb].x));
  };

  const gaps = [];
  const usedInGap = new Set();
  const candidates = [];
  for (let x = 0; x < ends.length; x++) {
    for (let y = x + 1; y < ends.length; y++) {
      const a = ends[x], b = ends[y];
      const gx = posts[b].x - posts[a].x, gy = posts[b].y - posts[a].y;
      const d  = Math.hypot(gx, gy);
      if (d < joinMm || d > gapMax) continue;
      const ang = Math.atan2(gy, gx);
      const ti  = stepIdx(ang), tq = ti * STEP; // gap bearing (step index + float)
      // Both ends must lie on the θq line (perpendicular error small).
      if (Math.abs(d * Math.sin(ang - tq)) > offMm) continue;
      // Wall-continuation: each present wall must run straight into the gap (a's wall along
      // the gap, b's wall opposite = +8 steps). Compare integer steps, not floats.
      const wa = wallStep(a), wb = wallStep(b);
      if (wa === null && wb === null) continue;
      if (wa !== null && wa !== ti) continue;
      if (wb !== null && wb !== (ti + 8) % 16) continue;
      candidates.push({ a, b, d, tq });
    }
  }
  candidates.sort((p, q) => p.d - q.d);
  for (const c of candidates) {
    if (usedInGap.has(c.a) || usedInGap.has(c.b)) continue;
    usedInGap.add(c.a); usedInGap.add(c.b);
    // Project both ends onto the shared θq line through their midpoint, so the opening
    // is dead straight and the derived align/angle constraint lands satisfied.
    const ux = Math.cos(c.tq), uy = Math.sin(c.tq);
    const mx = (posts[c.a].x + posts[c.b].x) / 2, my = (posts[c.a].y + posts[c.b].y) / 2;
    for (const i of [c.a, c.b]) {
      const t = (posts[i].x - mx) * ux + (posts[i].y - my) * uy;
      posts[i].x = Math.round(mx + ux * t);
      posts[i].y = Math.round(my + uy * t);
    }
    gaps.push({ a: c.a, b: c.b });
  }

  // Round post coords to the grid-snap increment so traced walls land on clean values.
  for (const p of posts) { p.x = Math.round(p.x / grid) * grid; p.y = Math.round(p.y / grid) * grid; }
  return { posts, spans, gaps };
}
