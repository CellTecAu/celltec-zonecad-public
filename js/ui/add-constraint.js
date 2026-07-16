// Add-constraint dialog — shared by context menu and properties panel

import { createConstraint, normDeg } from '../model.js';
import { validateConstraint, wouldCycle } from '../constraints.js';
import { showToast } from './toast.js';

let _store    = null;
let _kind     = null;
let _childId  = null;

// Trace tool: after a trace is committed its posts are "pending scale" — the very
// next driving dimension placed between two of them uniformly scales the whole
// trace so the shape keeps its proportions (see applyDimension). Session-only.
let _pendingTraceScale = new Set();
export function setPendingTraceScale(ids) { _pendingTraceScale = ids instanceof Set ? ids : new Set(ids); }
export function clearPendingTraceScale()  { _pendingTraceScale = new Set(); }

export function setupAddConstraint(store) {
  _store = store;

  document.getElementById('ac-cancel').addEventListener('click', closeDialog);
  document.getElementById('ac-ok').addEventListener('click', confirmConstraint);

  document.getElementById('modal-add-constraint').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDialog();
  });
}

/**
 * Directly align a selection of posts without opening the dialog.
 * The first selected post is the anchor; every other selected post is constrained
 * to it. Posts that would be over-constrained (or cycle) are silently skipped.
 * @param {'alignH'|'alignV'} kind
 * @param {string[]} postIds — selected post ids, in selection (click) order
 * @returns {number} how many constraints were applied
 */
export function applyAlignToSelection(kind, postIds) {
  if (!_store) return 0;
  const doc    = _store.getDoc();
  const posts  = postIds
    .map(id => doc.objects.find(o => o.id === id && o.type === 'post'))
    .filter(Boolean);
  if (posts.length < 2) return 0;

  const kindName = kind === 'alignH' ? 'horizontal align' : 'vertical align';

  // For a simple pair, orient so the LESS-constrained post moves (e.g. align a free post
  // to a dimensioned one, rather than fighting the dimension).
  if (posts.length === 2) {
    const cp = orient(kind, posts[0].id, posts[1].id, doc.constraints, doc.objects);
    if (!cp) {
      showToast(alignFailReason(kind, posts[0].id, posts[1].id, doc, kindName), 'error');
      return 0;
    }
    _store.mutate(d => d.constraints.push(createConstraint(kind, cp.child, cp.parent, 0)));
    return 1;
  }

  // 3+ posts: anchor the most-constrained (highest moveCost) post and align the rest to it,
  // so the frame's fixed corner stays put and the free posts move.
  const anchorId = posts
    .map(p => p.id)
    .reduce((best, id) => moveCost(id, doc.constraints) > moveCost(best, doc.constraints) ? id : best);
  let applied = 0, skipped = 0, lastErr = null;
  _store.mutate(d => {
    for (const p of posts) {
      if (p.id === anchorId) continue;
      const c = createConstraint(kind, p.id, anchorId, 0);
      const err = validateConstraint(c, d.constraints, d.objects);
      if (!err) { d.constraints.push(c); applied++; } else { skipped++; lastErr = err; }
    }
  });
  if (applied === 0 && lastErr) showToast(friendly(lastErr, kindName), 'error');
  else if (skipped) showToast(`Aligned ${applied}, skipped ${skipped} (already constrained).`, 'info');
  return applied;
}

/** Best explanation for why an align between two posts couldn't be applied either way. */
function alignFailReason(kind, aId, bId, doc, kindName) {
  const err = validateConstraint(createConstraint(kind, aId, bId, 0), doc.constraints, doc.objects)
           || validateConstraint(createConstraint(kind, bId, aId, 0), doc.constraints, doc.objects)
           || 'Both posts are fully constrained.';
  return friendly(err, kindName);
}

/** Turn a raw validator message into a clearer, action-oriented one. */
function friendly(err, what) {
  if (/cycle/i.test(err)) return `Can't add ${what}: it would create a constraint loop. Anchor one corner so nothing references back to it.`;
  if (/enough constraints/i.test(err)) return `Can't add ${what}: this post is already fully positioned (2 constraints). Remove one first, or add a reference dimension.`;
  if (/over-constrained/i.test(err)) return `Can't add ${what}: ${err.replace(/^Over-constrained:\s*/i, '')}`;
  return err;
}

/**
 * Choose child/parent for a relational constraint so the constrainable (freer) post is the
 * child that moves. Tries the requested direction first, then the swap. Returns null if neither works.
 */
function orient(kind, aId, bId, constraints, objects = null) {
  const ok = (child, parent) => validateConstraint(createConstraint(kind, child, parent, 0), constraints, objects) === null;
  const okA = ok(aId, bId), okB = ok(bId, aId);
  if (okA && okB) {
    // Both directions valid — move the "cheaper" post: prefer the freer one (fewer of its own
    // constraints, so we don't risk breaking an existing dimension), then the more leaf-like one.
    return moveCost(bId, constraints) < moveCost(aId, constraints) ? { child: bId, parent: aId } : { child: aId, parent: bId };
  }
  if (okA) return { child: aId, parent: bId };
  if (okB) return { child: bId, parent: aId };
  return null;
}

/** Lower = safer to move: heavily weight the post's own constraints, then how many depend on it. */
function moveCost(id, constraints) {
  let own = 0, deps = 0;
  for (const c of constraints) {
    if (c.child === id) own++;
    if (c.parent === id || c.parent2 === id) deps++;
  }
  return own * 10 + deps;
}

/**
 * Choose which post a driving dimension should move so it's valid — prefers the requested
 * child, else swaps to the free post. Returns { child, parent } or null (→ use a reference dim).
 */
export function orientDimension(aId, bId) {
  if (!_store) return null;
  const doc = _store.getDoc();
  return orient('dimension', aId, bId, doc.constraints, doc.objects);
}

/**
 * Directly create a dimension constraint between two posts (no dialog).
 * Swaps child/parent if that direction would cycle. Returns an error string
 * (over-constrained / cycle / bad value) or null on success.
 */
export function applyDimension(childId, parentId, valueMm) {
  if (!_store) return 'Not ready.';
  if (!(Number.isFinite(valueMm) && valueMm > 0)) return 'Enter a valid distance (> 0).';
  const doc = _store.getDoc();

  // First dimension after a trace: rescale the whole trace to this measurement so
  // its drawn proportions are preserved, then the dimension lands exactly satisfied.
  const pending = _pendingTraceScale;
  const scaleTrace = pending.size >= 2 && pending.has(childId) && pending.has(parentId)
    && doc.objects.some(o => o.id === childId) && doc.objects.some(o => o.id === parentId);
  if (scaleTrace) {
    const cp = doc.objects.find(o => o.id === childId);
    const pp = doc.objects.find(o => o.id === parentId);
    const cur = Math.hypot(cp.x - pp.x, cp.y - pp.y);
    _pendingTraceScale = new Set(); // one-shot, regardless of outcome below
    if (cur > 1) {
      const f = valueMm / cur;
      _store.mutate(d => {
        // Snap AFTER scaling (the commit-time snap is undone by this rescale) onto the
        // panel-divisor grid (default 100 mm), so the rescaled walls land back on round
        // panel increments — a small size nudge that keeps the rough geometry. The driving
        // dimension created below re-solves its own pair to exactly valueMm on evaluation.
        const gs = d.settings;
        const grid = Math.max(1, gs.panelDivisorMm || 100);
        for (const id of pending) {
          const o = d.objects.find(x => x.id === id && x.type === 'post');
          if (o) {
            o.x = Math.round((pp.x + (o.x - pp.x) * f) / grid) * grid;
            o.y = Math.round((pp.y + (o.y - pp.y) * f) / grid) * grid;
          }
        }
      });
    }
  }

  const doc2 = _store.getDoc();
  let child = childId, parent = parentId;
  if (wouldCycle(parent, child, doc2.constraints)) { const t = child; child = parent; parent = t; }
  const c = createConstraint('dimension', child, parent, valueMm);
  const err = validateConstraint(c, doc2.constraints, doc2.objects);
  if (err) return err;
  _store.mutate(d => d.constraints.push(c));
  return null;
}

/**
 * Constrain the PANEL WIDTH between two posts (pin-to-pin + frame). Like a dimension, the
 * freer post becomes the moving child and pivots on an arc about the anchor to hold the width.
 * Returns an error string (over-constrained / cycle / bad value) or null on success.
 */
export function applyPanelDim(aId, bId, valueMm) {
  if (!_store) return 'Not ready.';
  if (!(Number.isFinite(valueMm) && valueMm > 0)) return 'Enter a valid panel width (> 0).';
  const doc = _store.getDoc();
  const maxRun = doc.settings?.maxPanelRunMm ?? 2400;
  if (valueMm > maxRun) return `Max panel is ${maxRun} mm — a longer run needs multiple panels (dimension post-to-post instead).`;
  const o = orient('panelDim', aId, bId, doc.constraints, doc.objects);
  if (!o) return 'Both posts are already fully positioned — free one to constrain the panel.';
  const c = createConstraint('panelDim', o.child, o.parent, valueMm);
  const err = validateConstraint(c, doc.constraints, doc.objects);
  if (err) return err;
  _store.mutate(d => d.constraints.push(c));
  return null;
}

/** Change an existing panel-width constraint's value (capped at the max panel run). */
export function setPanelDimValue(constraintId, valueMm) {
  if (!_store) return 'Not ready.';
  if (!(Number.isFinite(valueMm) && valueMm > 0)) return 'Enter a valid panel width (> 0).';
  const maxRun = _store.getDoc().settings?.maxPanelRunMm ?? 2400;
  if (valueMm > maxRun) return `Max panel is ${maxRun} mm.`;
  _store.mutate(d => { const c = d.constraints.find(k => k.id === constraintId); if (c) c.valueMm = valueMm; });
  return null;
}

/** Change an existing driving dimension's value. Returns an error string or null. */
export function setDimensionValue(constraintId, valueMm) {
  if (!_store) return 'Not ready.';
  if (!(Number.isFinite(valueMm) && valueMm > 0)) return 'Enter a valid distance (> 0).';
  _store.mutate(d => { const c = d.constraints.find(k => k.id === constraintId); if (c) c.valueMm = valueMm; });
  return null;
}

/** Change an existing tie-to-edge constraint's distance. Returns an error string or null. */
export function setTieEdgeValue(constraintId, valueMm) {
  if (!_store) return 'Not ready.';
  if (!(Number.isFinite(valueMm) && valueMm >= 0)) return 'Enter a valid distance (≥ 0).';
  _store.mutate(d => { const c = d.constraints.find(k => k.id === constraintId); if (c) c.valueMm = valueMm; });
  return null;
}

/** Change an existing angle constraint's bearing. Returns an error string or null. */
export function setAngleValue(constraintId, valueDeg) {
  if (!_store) return 'Not ready.';
  if (!Number.isFinite(valueDeg)) return 'Enter a valid angle.';
  _store.mutate(d => { const c = d.constraints.find(k => k.id === constraintId); if (c) c.valueDeg = normDeg(valueDeg); });
  return null;
}

/** Promote a reference dimension to a driving one (if the posts allow it). Returns error or null. */
export function convertRefToDimension(refdimId, aId, bId, valueMm) {
  if (!_store) return 'Not ready.';
  if (!(Number.isFinite(valueMm) && valueMm > 0)) return 'Enter a valid distance (> 0).';
  const doc = _store.getDoc();
  const o = orient('dimension', aId, bId, doc.constraints, doc.objects);
  if (!o) return 'Both posts are already fully positioned — this dimension can only be reference.';
  const c = createConstraint('dimension', o.child, o.parent, valueMm);
  const err = validateConstraint(c, doc.constraints, doc.objects);
  if (err) { showToast(friendly(err, 'dimension'), 'error'); return err; }
  _store.mutate(d => {
    d.objects = d.objects.filter(x => x.id !== refdimId); // drop the reference dim
    d.constraints.push(c);
  });
  return null;
}

/** Pin a post at its current position. Returns an error string or null. */
export function applyLock(postId) {
  if (!_store) return 'Not ready.';
  const doc  = _store.getDoc();
  const post = doc.objects.find(o => o.id === postId && o.type === 'post');
  if (!post) return 'Select a post first.';
  const c = createConstraint('lock', postId, null, 0);
  c.atX = post.x; c.atY = post.y;
  const err = validateConstraint(c, doc.constraints, doc.objects);
  if (err) { showToast(friendly(err, 'lock'), 'error'); return err; }
  _store.mutate(d => d.constraints.push(c));
  return null;
}

/**
 * Set the bearing (degrees) of childId as seen from parentId. Like the other relational
 * constraints, the freer post becomes the moving child; when the roles are reversed the
 * stored bearing is flipped 180° so the geometry the user asked for is preserved.
 */
export function applyAngle(childId, parentId, valueDeg) {
  if (!_store) return 'Not ready.';
  if (!Number.isFinite(valueDeg)) return 'Enter a valid angle.';
  const doc = _store.getDoc();
  const mk  = (child, parent, deg) => createConstraint('angle', child, parent, 0, normDeg(deg));
  const fwd  = mk(childId, parentId, valueDeg);        // requested: child moves
  const rev  = mk(parentId, childId, valueDeg + 180);  // reversed roles: same geometry
  const okF  = validateConstraint(fwd, doc.constraints, doc.objects) === null;
  const okR  = validateConstraint(rev, doc.constraints, doc.objects) === null;
  let c;
  if (okF && okR) c = moveCost(parentId, doc.constraints) < moveCost(childId, doc.constraints) ? rev : fwd;
  else if (okF)   c = fwd;
  else if (okR)   c = rev;
  else return validateConstraint(fwd, doc.constraints, doc.objects);
  _store.mutate(d => d.constraints.push(c));
  return null;
}

/** Constrain a post onto the line through two reference posts. */
export function applyCollinear(childId, ref1Id, ref2Id) {
  if (!_store) return 'Not ready.';
  const doc = _store.getDoc();
  const c = createConstraint('collinear', childId, ref1Id, 0);
  c.parent2 = ref2Id;
  const err = validateConstraint(c, doc.constraints, doc.objects);
  if (err) { showToast(friendly(err, 'collinear constraint'), 'error'); return err; }
  _store.mutate(d => d.constraints.push(c));
  return null;
}

/**
 * Open the dialog for a specific constraint kind.
 * @param {'tieEdge'|'dimension'|'alignH'|'alignV'} kind
 * @param {string} childId   — the post being constrained
 * @param {string|null} preselectedParent — pre-select this parent in dropdown
 */
export function openAddConstraint(kind, childId, preselectedParent = null) {
  _kind    = kind;
  _childId = childId;

  const dialog  = document.getElementById('modal-add-constraint');
  const errorEl = document.getElementById('ac-error');
  const tieF    = document.getElementById('ac-tie-fields');
  const dimF    = document.getElementById('ac-dim-fields');
  const alignF  = document.getElementById('ac-align-fields');

  // Ensure the dialog is closed before (re)opening — showModal throws if already open
  if (dialog.open) dialog.close();

  tieF.style.display    = 'none';
  dimF.style.display    = 'none';
  alignF.style.display  = 'none';
  errorEl.style.display = 'none';
  errorEl.textContent   = '';

  const titles = {
    tieEdge:   'Tie to Edge',
    dimension:  'Set Dimension',
    alignH:    'Align Horizontal',
    alignV:    'Align Vertical',
  };
  document.getElementById('ac-title').textContent = titles[kind] ?? 'Add Constraint';

  const doc = _store.getDoc();

  // For dimension: if child→parent direction would create a cycle (because parent
  // already depends on child via another constraint), silently swap the two.
  if (kind === 'dimension' && preselectedParent) {
    if (wouldCycle(preselectedParent, _childId, doc.constraints)) {
      const tmp  = _childId;
      _childId   = preselectedParent;
      preselectedParent = tmp;
    }
  }

  const posts = doc.objects.filter(o => o.type === 'post' && o.id !== _childId);
  const child = doc.objects.find(o => o.id === _childId);

  switch (kind) {
    case 'tieEdge':
      tieF.style.display = '';
      break;

    case 'dimension': {
      dimF.style.display = '';
      const parentSel = dimF.querySelector('[name="ac-dim-parent"]');
      parentSel.innerHTML = posts.map(p =>
        `<option value="${p.id}">${p.id} (${Math.round(p.x)}, ${Math.round(p.y)} mm)</option>`
      ).join('');
      if (preselectedParent) parentSel.value = preselectedParent;

      // Pre-fill distance
      const pPost = posts.find(p => p.id === (preselectedParent ?? posts[0]?.id));
      if (pPost && child) {
        const dist = Math.round(Math.hypot(child.x - pPost.x, child.y - pPost.y));
        dimF.querySelector('[name="ac-dim-val"]').value = dist || '';
      }
      break;
    }

    case 'alignH':
    case 'alignV': {
      alignF.style.display = '';
      const parentSel = alignF.querySelector('[name="ac-align-parent"]');
      parentSel.innerHTML = posts.map(p =>
        `<option value="${p.id}">${p.id} (${Math.round(p.x)}, ${Math.round(p.y)} mm)</option>`
      ).join('');
      if (preselectedParent) parentSel.value = preselectedParent;
      break;
    }
  }

  dialog.showModal();
}

function closeDialog() {
  document.getElementById('modal-add-constraint').close();
}

function confirmConstraint() {
  const doc     = _store.getDoc();
  const errorEl = document.getElementById('ac-error');

  let constraint;

  switch (_kind) {
    case 'tieEdge': {
      const edge = document.querySelector('[name="ac-edge"]').value;
      const val  = parseFloat(document.querySelector('[name="ac-tie-val"]').value);
      if (!Number.isFinite(val) || val < 0) { showError('Enter a valid distance (≥ 0).'); return; }
      constraint = createConstraint('tieEdge', _childId, `layout:${edge}`, val);
      break;
    }
    case 'dimension': {
      const parentId = document.querySelector('[name="ac-dim-parent"]').value;
      const val      = parseFloat(document.querySelector('[name="ac-dim-val"]').value);
      if (!parentId) { showError('Select a reference post.'); return; }
      if (!Number.isFinite(val) || val <= 0) { showError('Enter a valid distance (> 0).'); return; }
      constraint = createConstraint('dimension', _childId, parentId, val);
      break;
    }
    case 'alignH':
    case 'alignV': {
      const parentId = document.querySelector('[name="ac-align-parent"]').value;
      if (!parentId) { showError('Select a reference post.'); return; }
      // Orient so the freer post moves (align a free post to a dimensioned one).
      const cp = orient(_kind, _childId, parentId, doc.constraints, doc.objects);
      if (!cp) { showError('Over-constrained: neither post can take this alignment.'); return; }
      constraint = createConstraint(_kind, cp.child, cp.parent, 0);
      break;
    }
    default: return;
  }

  const err = validateConstraint(constraint, doc.constraints, doc.objects);
  if (err) { showError(err); return; }

  _store.mutate(d => d.constraints.push(constraint));
  closeDialog();
}

function showError(msg) {
  const el = document.getElementById('ac-error');
  el.textContent    = msg;
  el.style.display  = '';
}
