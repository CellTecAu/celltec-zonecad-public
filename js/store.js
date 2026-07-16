// Central document store with history

import { createDocument, syncUidFromDoc, migrateSettings } from './model.js';
import { History } from './history.js';
import { evaluateConstraints } from './constraints.js';

const history  = new History(30); // snapshots are bg-stripped JSON strings — 30 deep is cheap
const listeners = new Set();

let doc = createDocument();

// ─── Autosave + unsaved-changes tracking ──────────────────────────────────────

const AUTOSAVE_KEY = 'zonecad:autosave';
let autosaveTimer  = null;
let dirty          = false; // structural changes since the last manual save

/**
 * Serialize a doc to { json, bg }: the JSON string EXCLUDES the background image data URL,
 * which rides alongside as a plain string reference (immutable, so no copy cost). This keeps
 * every snapshot/clone/autosave path from serializing a multi-MB base64 image per mutation.
 */
function toSnap(d) {
  const bg = d.background?.dataUrl ?? null;
  if (bg) d.background.dataUrl = null;
  const json = JSON.stringify(d);
  if (bg) d.background.dataUrl = bg;
  return { json, bg };
}

/** Reconstruct a doc from a toSnap() snapshot, re-attaching the background image reference. */
function fromSnap(s) {
  const d = JSON.parse(s.json);
  if (s.bg && d.background) d.background.dataUrl = s.bg;
  return d;
}

/**
 * Doc clone with the background image data URL dropped — base64 images are large
 * and would blow the ~5 MB localStorage budget (autosave + recent share it).
 * The background geometry/opacity is kept so the placeholder survives a reload.
 */
export function docWithoutBgImage(d) {
  return JSON.parse(toSnap(d).json);
}

function scheduleAutosave() {
  if (autosaveTimer) return;
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    try { localStorage.setItem(AUTOSAVE_KEY, toSnap(doc).json); } // single stringify, no image
    catch { /* quota / private mode */ }
  }, 500);
}

/** Latest autosaved document, or null if none / unreadable. */
export function loadAutosave() {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    const d = s ? JSON.parse(s) : null;
    return d && d.schema === 'zonecad/1' ? d : null;
  } catch { return null; }
}

export function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
}

/** True when there are structural changes since the last manual save. */
export function isDirty() { return dirty; }

/** Call after a successful manual Save so the unsaved-changes warning clears. */
export function markSaved() { dirty = false; }

function notify() {
  for (const fn of listeners) fn(doc);
  scheduleAutosave();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDoc() { return doc; }

/**
 * Structural mutation (objects, constraints, settings).
 * Deep-clones the doc, calls fn(clone), then replaces doc and notifies.
 * Pushed to undo history unless opts.pushHistory === false.
 */
/**
 * Returns whatever fn() returns, so callers can capture newly-created IDs.
 * A mutator that returns exactly `false` signals "nothing changed" — the mutation is
 * discarded: no history entry, no redo wipe, no dirty flag (e.g. Add Panel on fully-linked posts).
 */
export function mutate(fn, opts = {}) {
  const snap  = toSnap(doc);          // one serialize: both the deep clone and the undo entry
  const clone = fromSnap(snap);
  const result = fn(clone);
  if (result === false) return false;
  if (opts.pushHistory !== false) history.save(snap);
  evaluateConstraints(clone);
  doc = clone;
  dirty = true;
  notify();
  return result;
}

/** Save the current state to history without changing anything (call before a drag). */
export function saveSnapshot() {
  history.save(toSnap(doc));
}

/**
 * Direct in-place patch for live-dragging — no clone, no history entry.
 * patches: Map<id, {x?, y?, rotationDeg?, ...}>
 */
export function patchObjects(patches) {
  for (const obj of doc.objects) {
    if (patches.has(obj.id)) Object.assign(obj, patches.get(obj.id));
  }
  evaluateConstraints(doc); // constrained children follow their free parents during drag
  dirty = true;
  notify();
}

/** In-place patch of a single constraint (e.g. a dimension's render offset) — no history, no re-solve needed for cosmetic fields. */
export function patchConstraint(id, patch) {
  const c = doc.constraints.find(k => k.id === id);
  if (c) { Object.assign(c, patch); dirty = true; notify(); }
}

/**
 * Replace entire document (e.g. load from file or new document).
 * Pushes the outgoing doc to history unless opts.pushHistory === false — pass false for
 * the startup autosave restore, so Ctrl+Z can't "undo" the restore into a blank document.
 */
export function setDoc(newDoc, opts = {}) {
  if (opts.pushHistory !== false) history.save(toSnap(doc));
  doc = newDoc;
  migrateSettings(doc);     // normalise settings + one-time resets (e.g. snap off) for older docs
  syncUidFromDoc(doc);
  evaluateConstraints(doc); // re-solve on load so stale/violated saved geometry self-corrects
  dirty = false; // freshly loaded/restored content matches its source
  notify();
}

export function newDoc(widthM = 12, heightM = 8) {
  history.save(toSnap(doc));
  doc = createDocument(widthM, heightM);
  dirty = true;
  notify();
}

/**
 * View-only mutation (pan, zoom). No history, no clone — just patch and notify.
 */
export function updateView(patch) {
  Object.assign(doc.view, patch);
  notify();
}

export function undo() {
  const prev = history.undo(toSnap(doc));
  if (prev) {
    // Preserve current view state across undo
    const view = { ...doc.view };
    doc = fromSnap(prev);
    doc.view = view;
    dirty = true;
    notify();
  }
}

export function redo() {
  const next = history.redo(toSnap(doc));
  if (next) {
    const view = { ...doc.view };
    doc = fromSnap(next);
    doc.view = view;
    dirty = true;
    notify();
  }
}

export function canUndo() { return history.canUndo(); }
export function canRedo() { return history.canRedo(); }
