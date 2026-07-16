// Touch gestures: two-finger pinch-zoom / pan, long-press context menu,
// double-tap, and tap-deferred tool actions. Mouse and pen input pass through
// untouched — this layer only changes behaviour for pointerType 'touch'.
//
// Ordering: listeners here are registered on `document` in the CAPTURE phase,
// so they run before every canvas listener and can swallow the second finger
// of a pinch before any tool handler sees it.

import { cancelInteraction, getActiveTool } from './interaction.js';
import { setPickBoost } from './hit.js';

/** Tools whose press-and-hold means "grab and move", not "open context menu". */
const HOLD_TOOLS = new Set(['add-post', 'add-bollard']);

const LONG_PRESS_MS    = 550;
const TAP_SLOP_PX      = 12;  // movement allowed before a tap/long-press is abandoned
const TAP_MAX_MS       = 400; // press longer than this is not a tap
const DBL_TAP_MS       = 350; // max gap between two taps
const DBL_TAP_DIST_PX  = 40;
const TOUCH_PICK_BOOST = 2.5; // finger pick-tolerance multiplier (see hit.js)

let _gestureActive = false;
/** True while a multi-finger gesture (pinch/pan) owns the canvas. */
export function isGestureActive() { return _gestureActive; }

let _pendingTap = null; // { id, act }

/**
 * Tool handlers call this instead of acting directly. Mouse/pen acts
 * immediately (unchanged desktop behaviour); touch defers the action to the
 * finger lifting cleanly, so a pinch or drag never fires a placement tool.
 */
export function runToolTap(e, act) {
  if (e.pointerType !== 'touch') { act(); return; }
  _pendingTap = { id: e.pointerId, act };
}

/** Drop the deferred touch tap (add-tool hold-to-move places the post itself). */
export function cancelPendingTap() { _pendingTap = null; }

export function setupGestures(canvas, store) {
  const touches = new Map(); // pointerId → { x, y } — touches that began on the canvas
  let pinch    = null;       // { d0, mid0, scale0, panX0, panY0 }
  let tapStart = null;       // { id, x, y, t } — first-finger press, for tap/long-press tests
  let lpTimer  = null;
  let lpFired  = false;
  let lastTap  = null;       // { x, y, t } — previous completed tap, for double-tap

  function clearLongPress() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }

  /** (Re-)anchor the pinch on the two oldest touches. */
  function startPinch() {
    const [a, b] = [...touches.values()];
    const r = canvas.getBoundingClientRect();
    const v = store.getDoc().view;
    pinch = {
      d0:     Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      mid0:   { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
      scale0: v.scale, panX0: v.panX, panY0: v.panY,
    };
  }

  // Pick tolerance follows the pointer type of whatever is happening now.
  document.addEventListener('pointerdown', e => setPickBoost(e.pointerType === 'touch' ? TOUCH_PICK_BOOST : 1), true);
  document.addEventListener('pointermove', e => setPickBoost(e.pointerType === 'touch' ? TOUCH_PICK_BOOST : 1), true);

  document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || e.target !== canvas) return;
    // Suppress compatibility mouse events (mousedown/click/dblclick) for canvas
    // touches — the pointer handlers are the single source of truth, and the
    // double-tap synthesiser below must not race a native dblclick.
    e.preventDefault();
    // preventDefault also blocks the focus shift that would blur an open inline
    // editor (which is how tap-outside-dismisses works with a mouse) — do it
    // explicitly so a canvas tap cancels the editor like a click does.
    document.querySelector('#inline-input-wrap input')?.blur();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touches.size === 1) {
      lpFired  = false;
      tapStart = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
      const { clientX, clientY } = e;
      // On add-post/add-bollard, a held press means "grab and move the placed post"
      // (handled in main.js) — don't also open the context menu.
      if (!HOLD_TOOLS.has(getActiveTool())) {
        lpTimer = setTimeout(() => {
          lpTimer = null;
          lpFired = true;
          _pendingTap = null;
          lastTap     = null;
          cancelInteraction(); // press already armed a select/drag — discard it
          canvas.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX, clientY,
          }));
        }, LONG_PRESS_MS);
      }
    } else {
      // Second (or later) finger: this is a pinch, never a tool action.
      e.stopPropagation(); // no canvas handler may see it
      clearLongPress();
      _pendingTap = null;
      lastTap     = null;
      tapStart    = null;
      if (touches.size === 2) {
        cancelInteraction(); // abort the first finger's in-progress press/drag
        _gestureActive = true;
        startPinch();
      }
    }
  }, true);

  window.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Real movement abandons tap and long-press intents.
    if (tapStart && e.pointerId === tapStart.id &&
        Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > TAP_SLOP_PX) {
      clearLongPress();
      if (_pendingTap?.id === e.pointerId) _pendingTap = null;
      tapStart = null;
    }

    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const r    = canvas.getBoundingClientRect();
      const d1   = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const mid1 = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      // Zoom about the finger midpoint: keep the model point that was under
      // mid0 under mid1 (same anchor math as the wheel zoom in input.js).
      const newScale = Math.max(0.005, Math.min(20, pinch.scale0 * d1 / pinch.d0));
      store.updateView({
        scale: newScale,
        panX:  mid1.x - (pinch.mid0.x - pinch.panX0) / pinch.scale0 * newScale,
        panY:  mid1.y - (pinch.mid0.y - pinch.panY0) / pinch.scale0 * newScale,
      });
    }
  }, true);

  function liftPointer(e, cancelled) {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    clearLongPress();

    if (pinch) {
      if (touches.size >= 2) startPinch(); // a third finger lifted — re-anchor
      else pinch = null;
    }
    // The gesture keeps "owning" the canvas until every finger lifts, so the
    // survivor of a pinch can't drift the selection or hover state.
    if (touches.size === 0) _gestureActive = false;

    if (cancelled) { _pendingTap = null; lastTap = null; tapStart = null; return; }

    // Deferred tool action fires on a clean tap release.
    if (_pendingTap && e.pointerId === _pendingTap.id) {
      const t = _pendingTap;
      _pendingTap = null;
      if (!lpFired && !_gestureActive) t.act();
    }

    // Tap bookkeeping → double-tap synthesises dblclick (compat mouse events
    // were suppressed on pointerdown, so the browser won't produce one).
    const isTap = tapStart && e.pointerId === tapStart.id &&
                  performance.now() - tapStart.t < TAP_MAX_MS &&
                  !lpFired && !_gestureActive;
    tapStart = null;
    if (isTap) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < DBL_TAP_MS &&
          Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DBL_TAP_DIST_PX) {
        lastTap = null;
        canvas.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
        }));
      } else {
        lastTap = { x: e.clientX, y: e.clientY, t: now };
      }
    }
  }

  window.addEventListener('pointerup',     e => liftPointer(e, false), true);
  window.addEventListener('pointercancel', e => liftPointer(e, true),  true);
}
