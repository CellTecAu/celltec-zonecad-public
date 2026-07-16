// Recent layouts persisted in localStorage (most-recent first, de-duped by title).

import { docWithoutBgImage } from './store.js';

const RECENT_KEY = 'zonecad:recent';
const MAX_RECENT = 8;

export function getRecent() {
  try {
    const s = localStorage.getItem(RECENT_KEY);
    const list = s ? JSON.parse(s) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/**
 * Store a snapshot of `doc` as a recent entry, replacing any earlier one with the same title.
 * The background image data URL is dropped so a handful of entries can't exhaust localStorage
 * (which would silently take autosave down with it).
 */
export function pushRecent(doc) {
  try {
    const entry = {
      name:    doc.layout?.title ?? 'Untitled layout',
      savedAt: Date.now(),
      doc:     docWithoutBgImage(doc),
    };
    let list = getRecent().filter(e => e.name !== entry.name);
    list.unshift(entry);
    list = list.slice(0, MAX_RECENT);
    // Trim oldest entries until it fits, so one big layout can't wedge the whole list.
    while (list.length) {
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); return; }
      catch { list.pop(); }
    }
  } catch { /* private mode / serialisation issue */ }
}
