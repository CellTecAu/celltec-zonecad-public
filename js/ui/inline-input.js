// Floating inline text entry with live math-expression evaluation.
// Lets the user type a value (e.g. "500*2" or "500.0*2") directly on the canvas
// instead of opening a modal, keeping the drawing visible.

/**
 * Evaluate a basic arithmetic expression. Only digits, whitespace and + - * / ( ) .
 * are permitted (whitelist), so this can't run arbitrary code. Returns a finite
 * number, or NaN if the input is empty / invalid.
 */
export function evalExpr(str) {
  const s = String(str).trim();
  if (!s) return NaN;
  if (!/^[0-9+\-*/().\s]+$/.test(s)) return NaN;
  try {
    const v = Function(`"use strict"; return (${s});`)();
    return (typeof v === 'number' && isFinite(v)) ? v : NaN;
  } catch {
    return NaN;
  }
}

/**
 * Show a floating input at page coords (x, y).
 * @param {object} opts
 *   x, y         page-space position (px)
 *   initial      initial text (selected on focus)
 *   placeholder  placeholder text
 *   suffix       unit label shown after the live value (e.g. "mm")
 *   onCommit(value, rawText) → string|null   return an error string to keep the
 *                                            input open, or null/undefined to close.
 *   onCancel()   called on Escape / blur without commit.
 */
export function showInlineInput({ x, y, initial = '', placeholder = '', suffix = '', math = true, onCommit, onCancel }) {
  // Close any previous editor via blur (runs its cancel handler) before removal.
  // Removing a still-focused input directly races Chrome's blur-during-remove
  // and throws NotFoundError — hit on touch, where pointerdown is preventDefault'd
  // and never blurs the old editor the way a native mousedown does.
  const prev = document.getElementById('inline-input-wrap');
  if (prev) {
    prev.querySelector('input')?.blur();
    prev.remove(); // no-op if the blur handler already removed it
  }

  const coarse = matchMedia('(pointer: coarse)').matches;

  const wrap = document.createElement('div');
  wrap.id = 'inline-input-wrap';
  wrap.className = 'inline-input-wrap';
  wrap.style.left = `${x}px`;
  // Touch: sit above the tap point so neither the finger nor the on-screen
  // keyboard (which claims the bottom half) covers what's being typed.
  wrap.style.top  = `${coarse ? Math.max(60, y - 56) : y}px`;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-input';
  input.value = initial;
  input.placeholder = placeholder;
  // Numeric fields get the numeric on-screen keyboard. inputmode only affects
  // virtual keyboards, so desktop typing (incl. math like "500*2") is unchanged;
  // Enter still commits on hardware and Android keyboards.
  if (math) input.inputMode = 'decimal';

  const hint = document.createElement('span');
  hint.className = 'inline-input-hint';

  wrap.append(input, hint);

  let done = false;
  const cleanup = () => { if (!done) { done = true; wrap.remove(); } };

  const commit = () => {
    const val = evalExpr(input.value);
    const err = onCommit ? onCommit(val, input.value) : null;
    if (err) { showErr(err); return; }
    cleanup();
  };

  // Touch keyboards can lack Enter/Escape (iOS decimal pad has neither), so
  // coarse pointers get explicit ✓ / ✕ buttons. pointerdown (not click): it must
  // run before the input's blur-to-cancel fires.
  if (coarse) {
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'inline-input-btn inline-input-btn--ok';
    ok.textContent = '✓';
    ok.addEventListener('pointerdown', e => { e.preventDefault(); commit(); });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'inline-input-btn';
    no.textContent = '✕';
    no.addEventListener('pointerdown', e => { e.preventDefault(); cleanup(); onCancel?.(); });
    wrap.append(ok, no);
  }

  document.body.appendChild(wrap);
  input.focus();
  input.select();

  const updateHint = () => {
    if (!math) { hint.textContent = ''; return; }
    const v = evalExpr(input.value);
    if (isNaN(v)) { hint.textContent = ''; return; }
    // Only show the "= value" hint when the text isn't already just that number.
    hint.textContent = `= ${Number.isInteger(v) ? v : v.toFixed(2)}${suffix ? ' ' + suffix : ''}`;
  };
  updateHint();

  const showErr = msg => {
    wrap.classList.add('inline-input--error');
    hint.textContent = msg;
    setTimeout(() => wrap.classList.remove('inline-input--error'), 600);
  };

  input.addEventListener('input', () => { wrap.classList.remove('inline-input--error'); updateHint(); });

  input.addEventListener('keydown', e => {
    e.stopPropagation(); // don't trigger global canvas shortcuts while typing
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
      onCancel?.();
    }
  });

  // Attach blur-to-cancel only after focus has settled, so the mousedown that
  // created this input doesn't immediately blur and remove it.
  setTimeout(() => {
    if (done) return;
    input.addEventListener('blur', () => { cleanup(); onCancel?.(); });
  }, 0);

  return input;
}
