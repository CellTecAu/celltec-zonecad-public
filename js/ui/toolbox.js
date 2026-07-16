// Fixed canvas toolbox — tool selection and quick-action buttons

import { addPanelNearest } from '../spans.js';
import { openAddConstraint, applyAlignToSelection, applyLock, applyCollinear } from './add-constraint.js';
import { showToast } from './toast.js';

export function setupToolbox(store, getSelection, onToolChange) {
  const toolbox = document.getElementById('toolbox');
  if (!toolbox) return;

  // ── Tool mode buttons ─────────────────────────────────────────────────────

  toolbox.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      onToolChange(btn.dataset.tool);
    });
  });

  // ── Action buttons (one-shot, not mode tools) ─────────────────────────────

  const addPanelBtn = document.getElementById('tb-add-panel');
  if (addPanelBtn) {
    addPanelBtn.addEventListener('click', () => {
      const sel = getSelection();
      if (sel.size < 2) return;
      const ok = store.mutate(doc => addPanelNearest(doc, sel));
      if (!ok) showToast('No panel added — those posts are already fully linked.', 'info');
    });
  }

  const flipMeshBtn = document.getElementById('tb-flip-mesh');
  if (flipMeshBtn) {
    flipMeshBtn.addEventListener('click', () => {
      const sel = getSelection();
      store.mutate(doc => {
        for (const o of doc.objects) {
          if (o.type === 'span' && sel.has(o.id)) {
            o.meshSide = o.meshSide === 'A' ? 'B' : 'A';
          }
        }
      });
      // Brief flash to confirm action
      flipMeshBtn.classList.add('tool-flash');
      setTimeout(() => flipMeshBtn.classList.remove('tool-flash'), 300);
    });
  }

  // ── Constraint buttons (single post selected) ─────────────────────────────

  const alignHBtn    = document.getElementById('tb-align-h');
  const alignVBtn    = document.getElementById('tb-align-v');
  const tieEdgeBtn   = document.getElementById('tb-tie-edge');
  const lockBtn      = document.getElementById('tb-lock');
  const collinearBtn = document.getElementById('tb-collinear');
  const angleBtn     = document.getElementById('tb-angle');

  function selectedPost() {
    const sel   = getSelection();
    const posts = store.getDoc().objects.filter(o => o.type === 'post' && sel.has(o.id));
    return posts.length === 1 ? posts[0] : null;
  }

  // Selected post ids in click order (Set preserves insertion order).
  function selectedPostIds() {
    const sel = getSelection();
    const doc = store.getDoc();
    return [...sel].filter(id => doc.objects.some(o => o.id === id && o.type === 'post'));
  }

  // 2+ posts → align them directly to the first; single post → dialog to pick a reference.
  function doAlign(kind) {
    const ids = selectedPostIds();
    if (ids.length >= 2)      applyAlignToSelection(kind, ids);
    else if (ids.length === 1) openAddConstraint(kind, ids[0]);
  }

  if (alignHBtn)  alignHBtn.addEventListener('click',  () => doAlign('alignH'));
  if (alignVBtn)  alignVBtn.addEventListener('click',  () => doAlign('alignV'));
  if (tieEdgeBtn) tieEdgeBtn.addEventListener('click', () => { const p = selectedPost(); if (p) openAddConstraint('tieEdge', p.id); });
  if (lockBtn)    lockBtn.addEventListener('click',    () => { for (const id of selectedPostIds()) applyLock(id); });
  if (collinearBtn) collinearBtn.addEventListener('click', () => {
    const ids = selectedPostIds();
    if (ids.length === 3) applyCollinear(ids[0], ids[1], ids[2]);
  });
  if (angleBtn) angleBtn.addEventListener('click', () => {
    const ids = selectedPostIds();
    if (ids.length === 2) document.dispatchEvent(new CustomEvent('zc:setangle', { detail: { childId: ids[0], parentId: ids[1] } }));
  });

  // ── Keep action button enabled/disabled in sync with selection ────────────

  function syncActions() {
    const doc      = store.getDoc();
    const sel      = getSelection();
    const selPosts = doc.objects.filter(o => o.type === 'post' && sel.has(o.id));
    const selSpans = doc.objects.filter(o => o.type === 'span' && sel.has(o.id));
    const onePost  = selPosts.length === 1;
    const alignOk  = selPosts.length >= 1; // 1 → dialog, 2 → pair, 3+ → multi-align to anchor
    if (addPanelBtn)  addPanelBtn.disabled  = selPosts.length < 2;
    if (flipMeshBtn)  flipMeshBtn.disabled  = selSpans.length === 0;
    if (alignHBtn)    alignHBtn.disabled    = !alignOk;
    if (alignVBtn)    alignVBtn.disabled    = !alignOk;
    if (tieEdgeBtn)   tieEdgeBtn.disabled   = !onePost;
    if (lockBtn)      lockBtn.disabled      = selPosts.length < 1;
    if (collinearBtn) collinearBtn.disabled = selPosts.length !== 3;
    if (angleBtn)     angleBtn.disabled     = selPosts.length !== 2;
  }

  store.subscribe(syncActions);
  syncActions();

  // Selection lives outside the store, so callers must invoke this on select change.
  return syncActions;
}

/** Highlight the active tool button in the toolbox. */
export function setToolboxActive(toolName) {
  document.querySelectorAll('#toolbox .tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === toolName);
  });
}
