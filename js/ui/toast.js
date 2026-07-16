// Transient on-screen messages (constraint errors, blocked actions, etc.)

let container = null;

/**
 * Show a brief message. type: 'error' | 'info' | 'success'.
 * Identical consecutive messages are de-duped so a multi-post action doesn't spam.
 */
export function showToast(message, type = 'info', ms = 3000) {
  if (!message) return;
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  // De-dupe: if the last toast says the same thing, just refresh it.
  const last = container.lastElementChild;
  if (last && last.dataset.msg === message) return;

  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.textContent = message;
  t.dataset.msg = message;
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--show'));
  setTimeout(() => {
    t.classList.remove('toast--show');
    setTimeout(() => t.remove(), 250);
  }, ms);
}
