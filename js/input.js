// View-level input: pan, zoom, keyboard, contextmenu event dispatch

import { canvasToModel } from './model.js';
import { pickObject, pickDimensionLine } from './hit.js';
import { getDimLabelHits } from './render.js';
import { pushRecent } from './recent.js';

export function setupInput(canvas, store) {
  let panPtrId     = null; // pointerId of the middle-button pan in progress
  let panOrigin    = { x: 0, y: 0 };
  let panViewStart = { panX: 0, panY: 0 };

  // ── Middle-mouse / Space-drag pan (two-finger pan for touch lives in gestures.js) ──────

  function startPan(e) {
    e.preventDefault();
    panPtrId     = e.pointerId;
    panOrigin    = { x: e.clientX, y: e.clientY };
    const v      = store.getDoc().view;
    panViewStart = { panX: v.panX, panY: v.panY };
    canvas.style.cursor = 'grabbing';
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 1) return;
    startPan(e);
  });

  // Space-hold turns a left-drag into a pan (standard CAD idiom). Capture phase so it
  // pre-empts the interaction state machine's canvas handlers.
  let spaceHeld = false;
  window.addEventListener('keydown', e => {
    if (e.key !== ' ' || e.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    e.preventDefault(); // stop the page scrolling
    spaceHeld = true;
    if (panPtrId === null) canvas.style.cursor = 'grab';
  });
  window.addEventListener('keyup', e => {
    if (e.key !== ' ') return;
    spaceHeld = false;
    if (panPtrId === null) canvas.style.cursor = '';
  });
  canvas.addEventListener('pointerdown', e => {
    if (!spaceHeld || e.button !== 0 || !e.isPrimary) return;
    e.stopImmediatePropagation(); // don't let this press start a select/drag
    startPan(e);
  }, true);

  window.addEventListener('pointermove', e => {
    if (e.pointerId !== panPtrId) return;
    const { settings } = store.getDoc();
    const sens = settings.panSensitivity ?? 1;
    store.updateView({
      panX: panViewStart.panX + (e.clientX - panOrigin.x) * sens,
      panY: panViewStart.panY + (e.clientY - panOrigin.y) * sens,
    });
  });

  const endPan = e => {
    if (e.pointerId === panPtrId) {
      panPtrId = null;
      canvas.style.cursor = spaceHeld ? 'grab' : '';
    }
  };
  window.addEventListener('pointerup', endPan);
  window.addEventListener('pointercancel', endPan);

  // ── Scroll-wheel zoom ─────────────────────────────────────────────────────

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const doc  = store.getDoc();
    const { view, settings } = doc;
    const lh   = doc.layout.heightM * 1000;

    const sens      = settings.zoomSensitivity ?? 1;
    const rawFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const factor    = 1 + (rawFactor - 1) * sens;
    const newScale  = Math.max(0.005, Math.min(20, view.scale * factor));

    if (settings.zoomToCursor) {
      const rect = canvas.getBoundingClientRect();
      const cx   = e.clientX - rect.left;
      const cy   = e.clientY - rect.top;
      const mx   = (cx - view.panX) / view.scale;
      const my   = lh - (cy - view.panY) / view.scale;
      store.updateView({
        scale: newScale,
        panX:  cx - mx * newScale,
        panY:  cy - (lh - my) * newScale,
      });
    } else {
      store.updateView({ scale: newScale });
    }
  }, { passive: false });

  // ── Right-click / long-press — dispatch custom event with model coords + hit object ───

  let lastCtxAt = 0;

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    // The long-press gesture synthesises this event; Android can also fire a
    // native one from the same press — collapse the pair.
    const now = performance.now();
    if (now - lastCtxAt < 250) return;
    lastCtxAt = now;
    const doc  = store.getDoc();
    const lh   = doc.layout.heightM * 1000;
    const lw   = doc.layout.widthM  * 1000;
    const rect = canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    const mp   = canvasToModel(sx, sy, doc.view, lh);
    let   obj  = pickObject(sx, sy, doc.objects, doc.view, lh);

    // Dimensions aren't in pickObject — resolve them here so the context menu
    // (the only touch path to Delete) can target them: value label first (the
    // big target), then anywhere along the dim line. Driving dimension / angle
    // / tie constraints get a synthetic target the menu knows how to delete.
    if (!obj) {
      const lbl = getDimLabelHits().slice().reverse().find(l =>
        Math.abs(sx - l.sx) <= l.w / 2 + 14 && Math.abs(sy - l.sy) <= l.h / 2 + 14);
      let kind = lbl?.kind ?? null, id = lbl?.id ?? null;
      if (!kind) {
        const dh = pickDimensionLine(sx, sy, doc.objects, doc.constraints, doc.view, lh, lw);
        if (dh) { kind = dh.kind; id = dh.id; }
      }
      if (kind === 'refdim' || kind === 'dim') {
        obj = doc.objects.find(o => o.id === id) ?? null;
      } else if (kind === 'dimc' || kind === 'anglec' || kind === 'tiec') {
        obj = { type: 'constraint', ckind: kind, id };
      }
    }

    canvas.dispatchEvent(new CustomEvent('zc:contextmenu', {
      bubbles: true,
      detail: {
        screenX:   e.clientX,
        screenY:   e.clientY,
        modelX:    mp.x,
        modelY:    mp.y,
        targetObj: obj ?? null,
      },
    }));
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  window.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); store.undo(); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); store.redo(); }
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); triggerSave(store); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      canvas.dispatchEvent(new CustomEvent('zc:delete', { bubbles: true }));
    }
  });
}

function triggerSave(store) {
  const doc  = store.getDoc();
  const json = JSON.stringify(doc, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  const title = (doc.layout?.title ?? 'layout').replace(/[/\\:*?"<>|]/g, '_');
  a.download = `${title}.zonecad.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  store.markSaved();
  pushRecent(doc);
}
