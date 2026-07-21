// Custom right-click context menu

import { createPost, createSpan, buildPostMap } from '../model.js';
import { autoLink, addPanelNearest, autoFaceKey, ghostPostCenters, panelConfig } from '../spans.js';
import { openAddConstraint, applyAlignToSelection, applyLock, applyAngle, applyCollinear } from './add-constraint.js';
import { showToast } from './toast.js';

let menuEl        = null;
let _store        = null;
let _getSelection = null;
let _setSelection = null;
let _openProps    = null;
let _onDuplicate  = null;
let _pendingPt     = null; // { x, y } in model space
let _pendingScreen = null; // { x, y } in page space (for inline editors)
let _targetObj    = null;
let _ghostHit     = null; // { spanId, x, y } when the right-click is on a ghost post

export function setupContextMenu(store, getSelection, setSelection, openProps, onDuplicate = null) {
  _store        = store;
  _getSelection = getSelection;
  _setSelection = setSelection;
  _openProps    = openProps;
  _onDuplicate  = onDuplicate;

  menuEl = document.getElementById('ctx-menu');

  // pointerdown (not mousedown): canvas touches suppress compatibility mouse
  // events, so a tap on the canvas must still close the menu.
  document.addEventListener('pointerdown', e => {
    if (!menuEl.contains(e.target)) hide();
  });

  menuEl.addEventListener('click', e => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    hide();
    runAction(item.dataset.action);
  });

  document.addEventListener('zc:contextmenu', e => {
    e.stopPropagation();
    const { screenX, screenY, modelX, modelY, targetObj } = e.detail;
    _pendingPt     = { x: modelX, y: modelY };
    _pendingScreen = { x: screenX, y: screenY };
    _targetObj = targetObj;
    _ghostHit  = findGhostAt(modelX, modelY);

    // Constraints are not selectable objects — don't put their id in the selection.
    if (targetObj && targetObj.type !== 'constraint' && !getSelection().has(targetObj.id)) {
      setSelection(new Set([targetObj.id]));
    }

    buildMenu(targetObj);
    show(screenX, screenY);
  });
}

/** Find a ghost post centre near (mx,my); returns { spanId, x, y, rotDeg } or null. */
function findGhostAt(mx, my) {
  const doc = _store.getDoc();
  const postMap = buildPostMap(doc.objects);
  const cfg = panelConfig(doc.settings);
  const tol = 14 / doc.view.scale;
  for (const o of doc.objects) {
    if (o.type !== 'span') continue;
    for (const g of ghostPostCenters(o, postMap, cfg)) {
      if (Math.hypot(mx - g.x, my - g.y) <= tol) return { spanId: o.id, x: g.x, y: g.y, rotDeg: g.rotDeg };
    }
  }
  return null;
}

function buildMenu(obj) {
  menuEl.innerHTML = '';
  const doc      = _store.getDoc();
  const sel      = _getSelection();
  const selPosts = doc.objects.filter(o => o.type === 'post' && sel.has(o.id));

  // Ghost post under the cursor → offer to materialise it (splits the run for a mid-run doorway).
  if (_ghostHit) {
    addItem('convert-ghost', 'Convert to Post');
    addSep();
  }

  if (!obj) {
    addItem('add-post', 'Add Post');
    addItem('add-bollard', 'Add Bollard');
    if (selPosts.length >= 1) {
      addSep();
      addItem('properties', 'Properties…');
      addItem('tie-edge',   'Tie to Edge…');
      if (selPosts.length >= 2) {
        addItem('add-panel', 'Add Panel');
        addItem('align-h',   'Align Horizontal');
        addItem('align-v',   'Align Vertical');
      }
      if (selPosts.length === 2) {
        addItem('dimension', 'Set Dimension…');
        addItem('set-angle', 'Set Angle…');
      }
      if (selPosts.length === 3) {
        addItem('collinear', 'Make Collinear');
      }
      addSep();
      addRotateItems();
      addSep();
      addItem('delete', 'Delete', true);
    }
    return;
  }

  if (obj.type === 'post') {
    addItem('properties', 'Properties…');
    addSep();
    addItem('tie-edge', 'Tie to Edge…');
    addItem('lock',     'Lock in Place');
    if (selPosts.length >= 2) {
      addItem('add-panel', 'Add Panel');
      addItem('align-h',   'Align Horizontal');
      addItem('align-v',   'Align Vertical');
    }
    if (selPosts.length === 2) {
      addItem('dimension', 'Set Dimension…');
      addItem('set-angle', 'Set Angle…');
    }
    if (selPosts.length === 3) {
      addItem('collinear', 'Make Collinear');
    }
    addSep();
    if (_onDuplicate) addItem('duplicate', 'Duplicate');
    addItem('array', 'Array / Repeat…');
    addRotateItems();
    addItem('delete', 'Delete', true);
    return;
  }

  if (obj.type === 'span') {
    addItem('properties', 'Properties…');
    addItem('flip-mesh',  'Flip Mesh Side');
    addItem('panel-dim',  'Set Panel Width…');
    addSep();
    if (_onDuplicate) addItem('duplicate', 'Duplicate');
    addItem('array', 'Array / Repeat…');
    addItem('delete', 'Delete', true);
    return;
  }

  if (obj.type === 'refdim') {
    // Reference dims: edit (converts to a driving dim when possible) + Delete —
    // on touch this menu is the only route to Delete.
    addItem('edit-dim', 'Edit Value…');
    addItem('delete', 'Delete', true);
    return;
  }

  if (obj.type === 'constraint') {
    // Driving dimension / angle / tie-edge hit via its value label or line.
    addItem('edit-dim', 'Edit Value…');
    addItem('delete-constraint', 'Delete', true);
    return;
  }

  if (obj.type === 'zone' || obj.type === 'label' || obj.type === 'dim') {
    if (_onDuplicate) addItem('duplicate', 'Duplicate');
    addItem('array', 'Array / Repeat…');
    addRotateItems();
    addSep();
    addItem('delete', 'Delete', true);
  }
}

/** Rotate entries — act on the whole selection about its centroid (main.js zc:rotate). */
function addRotateItems() {
  addItem('rotate-cw',   'Rotate 90° CW');
  addItem('rotate-ccw',  'Rotate 90° CCW');
  addItem('rotate-free', 'Rotate by Angle…');
}

function addItem(action, label, danger = false) {
  const div = document.createElement('div');
  div.className  = 'ctx-item' + (danger ? ' ctx-danger' : '');
  div.dataset.action = action;
  div.textContent    = label;
  menuEl.appendChild(div);
}

function addSep() {
  const d = document.createElement('div');
  d.className = 'ctx-sep';
  menuEl.appendChild(d);
}

function show(sx, sy) {
  menuEl.removeAttribute('hidden');
  menuEl.style.left = sx + 'px';
  menuEl.style.top  = sy + 'px';
  requestAnimationFrame(() => {
    const r = menuEl.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menuEl.style.left = (sx - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menuEl.style.top  = (sy - r.height) + 'px';
  });
}

function hide() { menuEl.setAttribute('hidden', ''); }

function runAction(action) {
  switch (action) {
    case 'add-post': {
      const { x, y } = _pendingPt ?? { x: 0, y: 0 };
      const id = _store.mutate(doc => {
        const p = createPost(x, y);
        doc.objects.push(p);
        autoLink(doc);
        return p.id;
      });
      _setSelection(new Set([id]));
      break;
    }

    case 'add-bollard': {
      const { x, y } = _pendingPt ?? { x: 0, y: 0 };
      const id = _store.mutate(doc => {
        const p = createPost(x, y, { kind: 'bollard', material: 'steel' });
        doc.objects.push(p);
        return p.id; // bollards never auto-link
      });
      _setSelection(new Set([id]));
      break;
    }

    case 'convert-ghost': {
      if (!_ghostHit) break;
      const { spanId, x, y, rotDeg } = _ghostHit;
      const newId = _store.mutate(doc => {
        const span = doc.objects.find(o => o.id === spanId);
        if (!span) return null;
        const pA = doc.objects.find(o => o.id === span.postA);
        const p  = createPost(Math.round(x), Math.round(y), {
          material:             pA?.material,
          footplate:            pA?.footplate,
          // Ghost sits perpendicular to the run — keep that orientation so its brackets
          // stay aligned; the user can rotate it freely now that it's a real post.
          footplateRotationDeg: rotDeg ?? pA?.footplateRotationDeg,
        });
        doc.objects.push(p);
        // Split the panel run at the new post, preserving panel properties.
        const common = { spanKind: 'panel', meshSide: span.meshSide, floorClearanceMm: span.floorClearanceMm };
        doc.objects.push(createSpan(span.postA, p.id, { ...common, faceA: span.faceA, faceB: null }));
        doc.objects.push(createSpan(p.id, span.postB, { ...common, faceA: null, faceB: span.faceB }));
        doc.objects = doc.objects.filter(o => o.id !== spanId);
        return p.id;
      });
      if (newId) _setSelection(new Set([newId]));
      break;
    }

    case 'properties':
      _openProps();
      break;

    case 'duplicate':
      _onDuplicate?.();
      break;

    case 'array':
      document.dispatchEvent(new CustomEvent('zc:array'));
      break;

    // Model space is Y-up, so CW on screen = negative (CCW-positive) delta.
    case 'rotate-cw':
      document.dispatchEvent(new CustomEvent('zc:rotate', { detail: { deltaDeg: -90 } }));
      break;

    case 'rotate-ccw':
      document.dispatchEvent(new CustomEvent('zc:rotate', { detail: { deltaDeg: 90 } }));
      break;

    case 'rotate-free':
      document.dispatchEvent(new CustomEvent('zc:rotatefree'));
      break;

    case 'panel-dim': {
      const doc  = _store.getDoc();
      const sel  = _getSelection();
      const span = (_targetObj && _targetObj.type === 'span') ? _targetObj
                 : doc.objects.find(o => o.type === 'span' && sel.has(o.id));
      if (span) document.dispatchEvent(new CustomEvent('zc:setpaneldim', { detail: { spanId: span.id } }));
      break;
    }

    case 'flip-mesh': {
      const sel = _getSelection();
      _store.mutate(doc => {
        doc.objects.forEach(o => {
          if (o.type === 'span' && sel.has(o.id)) {
            o.meshSide = o.meshSide === 'A' ? 'B' : 'A';
          }
        });
      });
      break;
    }

    case 'add-panel': {
      const sel = _getSelection();
      const ok = _store.mutate(doc => addPanelNearest(doc, sel));
      if (!ok) showToast('No panel added — those posts are already fully linked.', 'info');
      break;
    }

    case 'tie-edge': {
      const doc    = _store.getDoc();
      const sel    = _getSelection();
      const target = _targetObj ?? doc.objects.find(o => o.type === 'post' && sel.has(o.id));
      if (target) openAddConstraint('tieEdge', target.id);
      break;
    }

    case 'align-h':
    case 'align-v': {
      const doc     = _store.getDoc();
      const sel     = _getSelection();
      const kind    = action === 'align-h' ? 'alignH' : 'alignV';
      const postIds = [...sel].filter(id => doc.objects.some(o => o.type === 'post' && o.id === id));
      if (postIds.length >= 2)      applyAlignToSelection(kind, postIds);
      else if (postIds.length === 1) openAddConstraint(kind, postIds[0]);
      break;
    }

    case 'dimension': {
      const doc      = _store.getDoc();
      const sel      = _getSelection();
      const selPosts = doc.objects.filter(o => o.type === 'post' && sel.has(o.id));
      const target   = _targetObj ?? selPosts[0];
      if (!target) break;
      const other    = selPosts.find(p => p.id !== target.id);
      openAddConstraint('dimension', target.id, other?.id);
      break;
    }

    case 'lock': {
      const doc = _store.getDoc();
      const sel = _getSelection();
      for (const id of sel) {
        if (doc.objects.some(o => o.id === id && o.type === 'post')) applyLock(id);
      }
      break;
    }

    case 'set-angle': {
      const doc      = _store.getDoc();
      const selPosts = [...(_getSelection())].filter(id => doc.objects.some(o => o.type === 'post' && o.id === id));
      if (selPosts.length === 2) {
        // Hand off to main.js for an inline typer at the child post.
        document.dispatchEvent(new CustomEvent('zc:setangle', { detail: { childId: selPosts[0], parentId: selPosts[1] } }));
      }
      break;
    }

    case 'collinear': {
      const doc      = _store.getDoc();
      const selPosts = [...(_getSelection())].filter(id => doc.objects.some(o => o.type === 'post' && o.id === id));
      if (selPosts.length === 3) applyCollinear(selPosts[0], selPosts[1], selPosts[2]);
      break;
    }

    case 'delete':
      // One delete cascade lives in main.js's zc:delete handler — delegate, don't duplicate.
      document.dispatchEvent(new CustomEvent('zc:delete'));
      break;

    case 'delete-constraint': {
      const t = _targetObj;
      if (t?.type === 'constraint') {
        _store.mutate(doc => { doc.constraints = doc.constraints.filter(c => c.id !== t.id); });
      }
      break;
    }

    case 'edit-dim': {
      const t = _targetObj;
      if (!t) break;
      const kind = t.type === 'constraint' ? t.ckind : 'refdim';
      // Same inline-editor route the double-click/double-tap path uses (main.js).
      document.getElementById('canvas')?.dispatchEvent(new CustomEvent('zc:editdim', {
        bubbles: true,
        detail: { kind, id: t.id, sx: _pendingScreen?.x ?? 0, sy: _pendingScreen?.y ?? 0 },
      }));
      break;
    }
  }
}
