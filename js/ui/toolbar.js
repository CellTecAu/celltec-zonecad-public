// Toolbar actions: New, Save, Load, Recent, Undo, Redo

import { getRecent, pushRecent } from '../recent.js';
import { EXAMPLES } from '../examples.js';
import { docConstraintProblems } from '../constraints.js';
import { showToast } from './toast.js';

/**
 * Warn about constraint-graph problems in a doc that arrived from outside the guarded
 * creation paths (file load, Recent, Examples, autosave restore). Nothing is auto-fixed —
 * the affected constraints show red on the canvas; this just says why.
 */
export function warnDocProblems(doc) {
  const problems = docConstraintProblems(doc);
  if (problems.length) showToast(`Loaded with constraint problems: ${problems.join(' · ')}.`, 'error', 7000);
}

/**
 * Toolbar view-toggle buttons (layer visibility + display prefs). These write to
 * doc.settings and rely on the render loop reading darkMode/layers/displayUnit live
 * each frame, so no extra redraw wiring is needed. Toggling a view preference is not a
 * structural edit, so it does NOT push undo history (pushHistory: false).
 */
function setupViewToggles(store) {
  const toggles = [...document.querySelectorAll('.tb-toggle, .tb-vis-item')];
  const darkBtn = document.getElementById('tgl-dark');
  const apply   = mutator => store.mutate(mutator, { pushHistory: false });

  for (const btn of toggles) {
    btn.addEventListener('click', () => {
      const { layer, setting } = btn.dataset;
      if (layer) {
        apply(d => { (d.settings.layers ??= {}); d.settings.layers[layer] = !(d.settings.layers[layer] !== false); });
      } else if (setting) {
        apply(d => { d.settings[setting] = !d.settings[setting]; });
      } else if (btn === darkBtn) {
        apply(d => { d.settings.darkMode = d.settings.darkMode === false; });
      }
    });
  }

  function setPressed(btn, on) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('off', !on);
  }

  function reflect(doc) {
    const s = doc.settings, L = s.layers ?? {};
    for (const btn of toggles) {
      const { layer, setting } = btn.dataset;
      if (layer)        setPressed(btn, L[layer] !== false);
      else if (setting) setPressed(btn, !!s[setting]);
    }
    if (darkBtn) {
      const dark  = s.darkMode !== false;
      const glyph = darkBtn.querySelector('.theme-glyph');
      if (glyph) glyph.textContent = dark ? '☾' : '☀';
      darkBtn.title = dark ? 'Canvas theme: dark (click for light)' : 'Canvas theme: light (click for dark)';
    }
  }

  store.subscribe(reflect);
  reflect(store.getDoc());
}

export function setupToolbar(store) {
  setupViewToggles(store);

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');

  undoBtn.addEventListener('click', () => store.undo());
  redoBtn.addEventListener('click', () => store.redo());

  store.subscribe(() => {
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
  });
  undoBtn.disabled = true;
  redoBtn.disabled = true;

  // ── Save ──────────────────────────────────────────────────────────────────

  document.getElementById('btn-save').addEventListener('click', () => {
    const doc  = store.getDoc();
    const json = JSON.stringify(doc, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    const title = (doc.layout?.title ?? 'layout').replace(/[/\\:*?"<>|]/g, '_');
    a.download  = `${title}.zonecad.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    store.markSaved();
    pushRecent(doc);
  });

  // ── Recent layouts dropdown ────────────────────────────────────────────────

  const recentBtn = document.getElementById('btn-recent');
  let recentMenu  = null;

  function closeRecentMenu() { if (recentMenu) { recentMenu.remove(); recentMenu = null; } }

  recentBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (recentMenu) { closeRecentMenu(); return; }
    const list = getRecent();
    recentMenu = document.createElement('div');
    recentMenu.className = 'recent-menu';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className   = 'recent-item recent-empty';
      empty.textContent = 'No recent layouts';
      recentMenu.appendChild(empty);
    } else {
      for (const entry of list) {
        const item = document.createElement('div');
        item.className = 'recent-item';
        const name = document.createElement('span');
        name.className   = 'recent-name';
        name.textContent = entry.name;
        const when = document.createElement('span');
        when.className   = 'recent-when';
        when.textContent = new Date(entry.savedAt).toLocaleString();
        item.append(name, when);
        item.addEventListener('click', () => {
          closeRecentMenu();
          if (entry.doc?.schema === 'zonecad/1') { store.setDoc(JSON.parse(JSON.stringify(entry.doc))); warnDocProblems(store.getDoc()); }
        });
        recentMenu.appendChild(item);
      }
    }
    const r = recentBtn.getBoundingClientRect();
    recentMenu.style.left = `${r.left}px`;
    recentMenu.style.top  = `${r.bottom + 2}px`;
    document.body.appendChild(recentMenu);
  });

  document.addEventListener('pointerdown', e => {
    if (recentMenu && !recentMenu.contains(e.target) && e.target !== recentBtn) closeRecentMenu();
  });

  // ── Examples dropdown (built-in sample layouts) ────────────────────────────

  const examplesBtn = document.getElementById('btn-examples');
  let examplesMenu  = null;

  function closeExamplesMenu() { if (examplesMenu) { examplesMenu.remove(); examplesMenu = null; } }

  examplesBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (examplesMenu) { closeExamplesMenu(); return; }
    examplesMenu = document.createElement('div');
    examplesMenu.className = 'recent-menu';
    examplesMenu.style.maxWidth = '300px';
    for (const ex of EXAMPLES) {
      const item = document.createElement('div');
      item.className = 'recent-item';
      item.style.flexDirection = 'column';
      item.style.alignItems = 'flex-start';
      item.style.gap = '2px';
      const name = document.createElement('span');
      name.className   = 'recent-name';
      name.textContent = ex.name;
      const desc = document.createElement('span');
      desc.className   = 'recent-when';
      desc.style.whiteSpace = 'normal';
      desc.textContent = ex.description ?? '';
      item.append(name, desc);
      item.title = ex.description ?? '';
      item.addEventListener('click', () => {
        closeExamplesMenu();
        if (ex.doc?.schema === 'zonecad/1') { store.setDoc(JSON.parse(JSON.stringify(ex.doc))); warnDocProblems(store.getDoc()); }
      });
      examplesMenu.appendChild(item);
    }
    const r = examplesBtn.getBoundingClientRect();
    examplesMenu.style.left = `${r.left}px`;
    examplesMenu.style.top  = `${r.bottom + 2}px`;
    document.body.appendChild(examplesMenu);
  });

  document.addEventListener('pointerdown', e => {
    if (examplesMenu && !examplesMenu.contains(e.target) && e.target !== examplesBtn) closeExamplesMenu();
  });

  // ── Load ──────────────────────────────────────────────────────────────────

  document.getElementById('btn-load').addEventListener('click', () => {
    const input   = document.createElement('input');
    input.type    = 'file';
    input.accept  = '.json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const loaded = JSON.parse(text);
        if (loaded.schema !== 'zonecad/1') throw new Error('Not a ZoneCAD file (expected schema "zonecad/1").');
        store.setDoc(loaded);
        warnDocProblems(store.getDoc());
      } catch (err) {
        alert('Load failed: ' + err.message);
      }
    };
    input.click();
  });

  // ── New ───────────────────────────────────────────────────────────────────

  const newModal  = document.getElementById('modal-new');
  const newForm   = document.getElementById('form-new');
  const newCancel = document.getElementById('btn-new-cancel');

  document.getElementById('btn-new').addEventListener('click', () => {
    const { layout } = store.getDoc();
    newForm.widthM.value  = layout.widthM;
    newForm.heightM.value = layout.heightM;
    newModal.showModal();
  });

  newCancel.addEventListener('click', () => newModal.close());
  newModal.addEventListener('click', e => { if (e.target === newModal) newModal.close(); });

  newForm.addEventListener('submit', e => {
    e.preventDefault();
    const w = parseFloat(newForm.widthM.value)  || 12;
    const h = parseFloat(newForm.heightM.value) || 8;
    const prev = store.getDoc();
    if (prev.objects.length) pushRecent(prev); // keep the outgoing layout accessible
    store.newDoc(w, h);
    newModal.close();
  });

  // ── Toolbar dropdowns (Background · Export · Help) ─────────────────────────
  // Static panels in the HTML: the trigger toggles its .tb-drop-menu; a click
  // inside the menu (an action button) closes it; an outside click closes any open one.

  const dropdowns = [...document.querySelectorAll('.tb-dropdown')];

  function closeDropdowns(except) {
    for (const dd of dropdowns) {
      if (dd === except) continue;
      dd.classList.remove('open');
      dd.querySelector('.tb-drop-menu')?.setAttribute('hidden', '');
    }
  }

  for (const dd of dropdowns) {
    const trigger = dd.querySelector('.tb-drop-trigger');
    const menu    = dd.querySelector('.tb-drop-menu');
    trigger?.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = menu.hasAttribute('hidden');
      closeDropdowns(dd);
      if (willOpen) { menu.removeAttribute('hidden'); dd.classList.add('open'); }
      else          { menu.setAttribute('hidden', ''); dd.classList.remove('open'); }
    });
    // Close after an action fires — but stay open for the opacity slider and for
    // Visibility rows, so several layers can be toggled in one visit.
    menu?.addEventListener('click', e => {
      if (e.target.closest('button') && !e.target.closest('.tb-vis-item')) closeDropdowns();
    });
  }

  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.tb-dropdown')) closeDropdowns();
  });
}
