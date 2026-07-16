// Object snap finder — returns nearest snap point within screen-pixel radius
import { spanHinges } from './spans.js';
import { buildPostMap } from './model.js';

const SNAP_PX = 20; // screen-pixel radius

/**
 * Nearest snap point to (mx,my) within a screen-pixel radius.
 * Priority: post/hinge/corner endpoints → midpoints/centres → nearest-on-span line.
 * @param {Set<string>} [exclude] object ids to ignore (e.g. the objects being dragged)
 * @returns {{x,y,type:'endpoint'|'midpoint'|'center'|'nearest'}|null}
 */
export function findObjectSnap(mx, my, doc, scale, exclude = null) {
  const radMm   = SNAP_PX / scale;
  const skip    = id => exclude && exclude.has(id);
  const postMap = buildPostMap(doc.objects);

  // Post centers (highest priority)
  for (const o of doc.objects) {
    if (o.type !== 'post' || skip(o.id)) continue;
    if (Math.hypot(mx - o.x, my - o.y) <= radMm) return { x: o.x, y: o.y, type: 'endpoint' };
  }

  // Span hinge pins and midpoints
  for (const o of doc.objects) {
    if (o.type !== 'span' || skip(o.id)) continue;
    const h = spanHinges(o, postMap);
    if (!h) continue;
    if (Math.hypot(mx - h.hA.x, my - h.hA.y) <= radMm) return { x: h.hA.x, y: h.hA.y, type: 'endpoint' };
    if (Math.hypot(mx - h.hB.x, my - h.hB.y) <= radMm) return { x: h.hB.x, y: h.hB.y, type: 'endpoint' };
    const mx2 = (h.hA.x + h.hB.x) / 2, my2 = (h.hA.y + h.hB.y) / 2;
    if (Math.hypot(mx - mx2, my - my2) <= radMm) return { x: mx2, y: my2, type: 'midpoint' };
  }

  // Zone corners and centers
  for (const o of doc.objects) {
    if (o.type !== 'zone' || skip(o.id)) continue;
    if (o.shape === 'circle') {
      if (Math.hypot(mx - o.x, my - o.y) <= radMm) return { x: o.x, y: o.y, type: 'center' };
    } else {
      const hw = o.widthMm / 2, hh = o.heightMm / 2;
      for (const [cx, cy] of [
        [o.x - hw, o.y - hh], [o.x + hw, o.y - hh],
        [o.x - hw, o.y + hh], [o.x + hw, o.y + hh],
      ]) {
        if (Math.hypot(mx - cx, my - cy) <= radMm) return { x: cx, y: cy, type: 'endpoint' };
      }
      if (Math.hypot(mx - o.x, my - o.y) <= radMm) return { x: o.x, y: o.y, type: 'center' };
    }
  }

  // Nearest point on a span line (lowest priority)
  let best = null, bestD = radMm;
  for (const o of doc.objects) {
    if (o.type !== 'span' || skip(o.id)) continue;
    const h = spanHinges(o, postMap);
    if (!h) continue;
    const p = projectOnSeg(mx, my, h.hA.x, h.hA.y, h.hB.x, h.hB.y);
    const d = Math.hypot(mx - p.x, my - p.y);
    if (d <= bestD) { bestD = d; best = { x: p.x, y: p.y, type: 'nearest' }; }
  }
  return best;
}

function projectOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return { x: ax, y: ay };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { x: ax + t * dx, y: ay + t * dy };
}
