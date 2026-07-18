// Properties dialog — post and span fields, plus constraints panel

import { spanRunLength, spanHeight } from '../spans.js';
import { fmtLen, normDeg } from '../model.js';
import { constraintLabel } from '../constraints.js';
import { openAddConstraint } from './add-constraint.js';

export function setupProperties(store, getSelection) {
  const dialog    = document.getElementById('modal-props');
  const closeBtn  = document.getElementById('props-close');
  const postSec   = document.getElementById('props-post');
  const spanSec   = document.getElementById('props-span');
  const zoneSec   = document.getElementById('props-zone');
  const mixedMsg  = document.getElementById('props-mixed');
  const formPost  = document.getElementById('form-props-post');
  const formSpan  = document.getElementById('form-props-span');
  const formZone  = document.getElementById('form-props-zone');

  closeBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  // ── Post quick-set buttons ────────────────────────────────────────────────

  formPost.querySelectorAll('[data-height]').forEach(btn => {
    btn.addEventListener('click', () => {
      formPost.heightMm.value = btn.dataset.height;
      applyPostForm();
    });
  });

  formPost.querySelectorAll('[data-fpr]').forEach(btn => {
    btn.addEventListener('click', () => {
      formPost.footplateRotationDeg.value = btn.dataset.fpr;
      applyPostForm();
    });
  });

  formPost.addEventListener('change', applyPostForm);
  formSpan.addEventListener('change', applySpanForm);
  if (formZone) {
    // 'change' (not 'input') — per-keystroke commits would push one undo entry per digit typed.
    formZone.addEventListener('change', applyZoneForm);
    formZone.addEventListener('change', () => {
      const shape = formZone.zoneShape?.value;
      if (!shape) return;
      const isCircle = shape === 'circle';
      document.getElementById('z-rect-rows').style.display  = isCircle ? 'none' : '';
      document.getElementById('z-rect-h-row').style.display = isCircle ? 'none' : '';
      document.getElementById('z-circle-row').style.display = isCircle ? '' : 'none';
    });
  }

  // Door angle quick-set buttons
  formSpan.querySelectorAll('[data-angle]').forEach(btn => {
    btn.addEventListener('click', () => {
      formSpan.doorOpenAngle.value = btn.dataset.angle;
      applySpanForm();
    });
  });

  // Door hinge-position 4-button picker
  document.querySelectorAll('.hinge-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hinge-pos-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applySpanForm();
    });
  });

  // ADB (adjustable door brace) toggle — injected into the door fieldset so it lives
  // inside formSpan (its `change` bubbles to the form's applySpanForm listener).
  const doorFields = document.getElementById('props-door-fields');
  if (doorFields && !doorFields.querySelector('input[name="adb"]')) {
    const row = document.createElement('div');
    row.className = 'form-row';
    row.innerHTML =
      '<label for="d-adb">ADB (adjustable door brace)</label>' +
      '<input id="d-adb" type="checkbox" name="adb">';
    doorFields.appendChild(row);
  }

  // Constraint add buttons — handlers are re-bound each time populateConstraints
  // runs so the postId is always captured from the current dialog state, not
  // re-queried from selection (which can be stale while a modal is open).
  const _pcaTie    = document.getElementById('pca-tie');
  const _pcaDim    = document.getElementById('pca-dim');
  const _pcaAlignH = document.getElementById('pca-align-h');
  const _pcaAlignV = document.getElementById('pca-align-v');

  // ── Apply ──────────────────────────────────────────────────────────────────

  function applyPostForm() {
    const sel = getSelection();
    store.mutate(doc => {
      const targets = doc.objects.filter(o => o.type === 'post' && sel.has(o.id));
      if (!targets.length) return;
      if (formPost.material.value)
        targets.forEach(p => p.material = formPost.material.value);
      const h = parseFloat(formPost.heightMm.value);
      if (!isNaN(h) && formPost.heightMm.value !== '')
        targets.forEach(p => p.heightMm = h);
      if (formPost.footplate.value)
        targets.forEach(p => p.footplate = formPost.footplate.value);
      const fpr = parseFloat(formPost.footplateRotationDeg.value);
      if (!isNaN(fpr) && formPost.footplateRotationDeg.value !== '')
        targets.forEach(p => p.footplateRotationDeg = normDeg(fpr));
    });
  }

  function applySpanForm() {
    const sel = getSelection();
    store.mutate(doc => {
      const targets = doc.objects.filter(o => o.type === 'span' && sel.has(o.id));
      if (!targets.length) return;
      if (formSpan.spanKind.value)
        targets.forEach(s => s.spanKind = formSpan.spanKind.value);
      if (formSpan.meshSide.value)
        targets.forEach(s => s.meshSide = formSpan.meshSide.value);
      const fc = parseFloat(formSpan.floorClearanceMm.value);
      if (!isNaN(fc) && formSpan.floorClearanceMm.value !== '')
        targets.forEach(s => s.floorClearanceMm = fc);
      // Door / gate kindProps
      const kind = formSpan.spanKind.value;
      if (kind === 'hingedDoor' || kind === 'swingGate') {
        const angle      = parseFloat(formSpan.doorOpenAngle.value);
        const activeBtn  = document.querySelector('#d-hinge-pos .hinge-pos-btn.active');
        const hingePos   = activeBtn ? activeBtn.dataset.pos : null;
        const adb        = formSpan.adb ? formSpan.adb.checked : false;
        targets.forEach(s => {
          if (!s.kindProps) s.kindProps = {};
          if (hingePos)       s.kindProps.hingePos     = hingePos;
          if (!isNaN(angle))  s.kindProps.openAngleDeg = angle;
          s.kindProps.adb = adb;
        });
      }
      if (kind === 'slidingDoor') {
        const trackExt = parseFloat(formSpan.trackExtendMm.value);
        const gateExt  = parseFloat(formSpan.gateExtendMm.value);
        targets.forEach(s => {
          if (!s.kindProps) s.kindProps = {};
          if (formSpan.slideEnd.value)   s.kindProps.slideEnd   = formSpan.slideEnd.value;
          if (formSpan.trackSide.value)  s.kindProps.trackSide  = formSpan.trackSide.value;
          if (formSpan.trackExtendMm.value !== '') s.kindProps.trackExtendMm = isNaN(trackExt) ? 0 : Math.max(0, trackExt);
          if (formSpan.gateExtendMm.value  !== '') s.kindProps.gateExtendMm  = isNaN(gateExt)  ? 0 : Math.max(0, gateExt);
        });
      }
      if (kind === 'cantileverGate') {
        const fOff = parseFloat(formSpan.frontWheelOffsetMm.value);
        const rSpc = parseFloat(formSpan.rollerSpacingMm.value);
        const tOv  = parseFloat(formSpan.tailOverhangMm.value);
        const cOff = parseFloat(formSpan.catcherOffsetMm.value);
        targets.forEach(s => {
          if (!s.kindProps) s.kindProps = {};
          if (formSpan.retractEnd.value)  s.kindProps.retractEnd = formSpan.retractEnd.value;
          if (formSpan.cgTrackSide.value) s.kindProps.trackSide  = formSpan.cgTrackSide.value;
          if (formSpan.frontWheelOffsetMm.value !== '') s.kindProps.frontWheelOffsetMm = isNaN(fOff) ? 130 : Math.max(0, fOff);
          if (formSpan.rollerSpacingMm.value    !== '') s.kindProps.rollerSpacingMm    = isNaN(rSpc) ? 500 : Math.max(100, rSpc);
          if (formSpan.tailOverhangMm.value     !== '') s.kindProps.tailOverhangMm     = isNaN(tOv)  ? 150 : Math.max(0, tOv);
          if (formSpan.catcherOffsetMm.value    !== '') s.kindProps.catcherOffsetMm    = isNaN(cOff) ? 0   : cOff;
        });
      }
    });
  }

  // ── Open & populate ────────────────────────────────────────────────────────

  function open() {
    const doc     = store.getDoc();
    const sel     = getSelection();
    const selObjs = doc.objects.filter(o => sel.has(o.id));
    if (!selObjs.length) return;
    populate(selObjs, doc);
    dialog.showModal();
  }

  function populate(selObjs, doc) {
    const posts   = selObjs.filter(o => o.type === 'post');
    const spans   = selObjs.filter(o => o.type === 'span');
    const zones   = selObjs.filter(o => o.type === 'zone');
    const typeCount = (posts.length ? 1 : 0) + (spans.length ? 1 : 0) + (zones.length ? 1 : 0);
    const hasBoth = typeCount > 1;

    postSec.style.display  = (!hasBoth && posts.length) ? '' : 'none';
    spanSec.style.display  = (!hasBoth && spans.length) ? '' : 'none';
    if (zoneSec) zoneSec.style.display = (!hasBoth && zones.length) ? '' : 'none';
    mixedMsg.style.display = hasBoth ? '' : 'none';

    const title = document.querySelector('.props-title');
    const n = selObjs.length;
    title.textContent = hasBoth
      ? `Properties (${n} mixed)`
      : posts.length
        ? (n === 1 ? 'Post Properties' : `Post Properties (${n})`)
        : zones.length
          ? (n === 1 ? 'Zone Properties' : `Zone Properties (${n})`)
          : (n === 1 ? 'Span Properties' : `Span Properties (${n})`);

    if (posts.length && !hasBoth) {
      populatePostForm(posts);
      populateConstraints(posts, doc);
    }
    if (spans.length && !hasBoth) populateSpanForm(spans, doc);
    if (zones.length && !hasBoth) populateZoneForm(zones);
  }

  function populatePostForm(posts) {
    const u = key => uniq(posts, key);
    // Bollards are fixed-spec (165 CHS, 220 OD plate) — only height applies to them.
    const allBollards = posts.every(p => p.kind === 'bollard');
    const legend = document.getElementById('p-legend');
    if (legend) legend.textContent = allBollards ? 'Bollard — 165×3.2 CHS, 220 OD plate' : 'Post';
    for (const rowId of ['p-row-material', 'p-row-footplate', 'p-row-fpr']) {
      const row = document.getElementById(rowId);
      if (row) row.style.display = allBollards ? 'none' : '';
    }
    setSelectVal(formPost.material,          u('material'));
    setNumVal(formPost.heightMm,             u('heightMm'));
    setSelectVal(formPost.footplate,         u('footplate'));
    setNumVal(formPost.footplateRotationDeg, u('footplateRotationDeg'));
  }

  function populateConstraints(posts, doc) {
    const section   = document.getElementById('props-constraint-section');
    const listEl    = document.getElementById('props-constraint-list');
    const isSingle  = posts.length === 1;
    const isTwo     = posts.length === 2;

    section.style.display = (isSingle || isTwo) ? '' : 'none';
    if (!isSingle && !isTwo) return;

    const postId  = posts[0].id;
    const otherId = isTwo ? posts[1].id : null;

    const legend = document.getElementById('props-constraint-legend');
    legend.textContent = isTwo ? 'Relational Constraints' : 'Constraints';

    if (isSingle) {
      // Single post: full constraint list + all 4 add buttons
      _pcaTie.style.display    = '';
      _pcaTie.onclick    = () => openAddConstraint('tieEdge',   postId);
      _pcaDim.onclick    = () => openAddConstraint('dimension', postId);
      _pcaAlignH.onclick = () => openAddConstraint('alignH',   postId);
      _pcaAlignV.onclick = () => openAddConstraint('alignV',   postId);

      const constrs = doc.constraints.filter(c => c.child === postId);
      listEl.innerHTML = '';
      if (!constrs.length) {
        listEl.innerHTML = '<p class="no-constraints">No constraints.</p>';
      } else {
        for (const c of constrs) {
          const row = document.createElement('div');
          row.className = 'constraint-row';
          row.innerHTML =
            `<span class="constraint-desc">${constraintLabel(c, doc.objects)}</span>` +
            `<button type="button" class="btn btn-sm constraint-remove" data-cid="${c.id}">×</button>`;
          listEl.appendChild(row);
        }
        listEl.querySelectorAll('.constraint-remove').forEach(btn => {
          btn.addEventListener('click', () => {
            const cid = btn.dataset.cid;
            store.mutate(d => { d.constraints = d.constraints.filter(c => c.id !== cid); });
          });
        });
      }
    } else {
      // Two posts: relational constraints only (no Tie to Edge, no list)
      _pcaTie.style.display    = 'none';
      listEl.innerHTML = '<p class="no-constraints">Constraining first post relative to second.</p>';
      _pcaDim.onclick    = () => openAddConstraint('dimension', postId, otherId);
      _pcaAlignH.onclick = () => openAddConstraint('alignH',   postId, otherId);
      _pcaAlignV.onclick = () => openAddConstraint('alignV',   postId, otherId);
    }
  }

  function populateSpanForm(spans, doc) {
    const u = key => uniq(spans, key);
    setSelectVal(formSpan.spanKind,      u('spanKind'));
    setSelectVal(formSpan.meshSide,      u('meshSide'));
    setNumVal(formSpan.floorClearanceMm, u('floorClearanceMm'));

    // Door / gate fields
    const doorFields       = document.getElementById('props-door-fields');
    const slidingFields    = document.getElementById('props-sliding-fields');
    const cantileverFields = document.getElementById('props-cantilever-fields');
    const kind = u('spanKind');
    const isDoor           = kind === 'hingedDoor' || kind === 'swingGate';
    const isSlidingDoor    = kind === 'slidingDoor';
    const isCantilever     = kind === 'cantileverGate';
    doorFields.style.display       = isDoor        ? '' : 'none';
    slidingFields.style.display    = isSlidingDoor ? '' : 'none';
    cantileverFields.style.display = isCantilever  ? '' : 'none';
    if (isDoor) {
      // Resolve hingePos — prefer new field, fall back to legacy hingeEnd+swingSide
      let resolvedPos = uniqKp(spans, 'hingePos');
      if (!resolvedPos) {
        const kpHinge = uniqKp(spans, 'hingeEnd')  || 'A';
        const kpSide  = uniqKp(spans, 'swingSide') || 'left';
        resolvedPos   = kpHinge + (kpSide === 'left' ? 'l' : 'r');
      }
      document.querySelectorAll('.hinge-pos-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.pos === resolvedPos);
      });
      setNumVal(formSpan.doorOpenAngle, uniqKp(spans, 'openAngleDeg') || '90');
      // ADB checkbox: checked only when every selected door has adb === true.
      if (formSpan.adb) formSpan.adb.checked = uniqKp(spans, 'adb') === 'true';
    }
    if (isSlidingDoor) {
      const kpSlideEnd  = uniqKp(spans, 'slideEnd');
      const kpTrackSide = uniqKp(spans, 'trackSide');
      setSelectVal(formSpan.slideEnd,  kpSlideEnd  || 'B');
      setSelectVal(formSpan.trackSide, kpTrackSide || 'left');
      setNumVal(formSpan.trackExtendMm, uniqKp(spans, 'trackExtendMm'));
      setNumVal(formSpan.gateExtendMm,  uniqKp(spans, 'gateExtendMm'));
    }
    if (isCantilever) {
      setSelectVal(formSpan.retractEnd,  uniqKp(spans, 'retractEnd') || 'A');
      setSelectVal(formSpan.cgTrackSide, uniqKp(spans, 'trackSide')  || 'left');
      setNumVal(formSpan.frontWheelOffsetMm, uniqKp(spans, 'frontWheelOffsetMm'));
      setNumVal(formSpan.rollerSpacingMm,    uniqKp(spans, 'rollerSpacingMm'));
      setNumVal(formSpan.tailOverhangMm,     uniqKp(spans, 'tailOverhangMm'));
      setNumVal(formSpan.catcherOffsetMm,    uniqKp(spans, 'catcherOffsetMm'));
    }

    const postMap = Object.fromEntries(
      doc.objects.filter(o => o.type === 'post').map(p => [p.id, p])
    );
    if (spans.length === 1) {
      const s    = spans[0];
      const run  = spanRunLength(s, postMap);
      const ht   = spanHeight(s, postMap);
      const unit = doc.settings.displayUnit;
      formSpan.querySelector('.span-run-display').textContent = fmtLen(run, unit);
      formSpan.querySelector('.span-ht-display').textContent  = fmtLen(ht, unit);
    } else {
      formSpan.querySelector('.span-run-display').textContent = '—';
      formSpan.querySelector('.span-ht-display').textContent  = '—';
    }
  }

  function populateZoneForm(zones) {
    if (!formZone) return;
    const u     = key => uniq(zones, key);
    const shape = u('shape') || 'rect';
    const isCircle = shape === 'circle';
    if (formZone.zoneShape)    formZone.zoneShape.value    = shape;
    if (formZone.zoneName)     formZone.zoneName.value     = u('name')     ?? '';
    if (formZone.zoneWidthMm)  formZone.zoneWidthMm.value  = u('widthMm')  ?? '';
    if (formZone.zoneHeightMm) formZone.zoneHeightMm.value = u('heightMm') ?? '';
    if (formZone.zoneRadiusMm) formZone.zoneRadiusMm.value = u('radiusMm') ?? '';
    // Show/hide shape-specific fields
    const rectW = document.getElementById('z-rect-rows');
    const rectH = document.getElementById('z-rect-h-row');
    const circ  = document.getElementById('z-circle-row');
    if (rectW) rectW.style.display = isCircle ? 'none' : '';
    if (rectH) rectH.style.display = isCircle ? 'none' : '';
    if (circ)  circ.style.display  = isCircle ? '' : 'none';
  }

  function applyZoneForm() {
    if (!formZone) return;
    const sel = getSelection();
    store.mutate(doc => {
      const targets = doc.objects.filter(o => o.type === 'zone' && sel.has(o.id));
      if (!targets.length) return;
      const name = formZone.zoneName?.value?.trim();
      if (name) targets.forEach(z => z.name = name);
      const shape = formZone.zoneShape?.value;
      if (shape) targets.forEach(z => z.shape = shape);
      if (shape === 'circle') {
        const r = parseFloat(formZone.zoneRadiusMm?.value);
        if (!isNaN(r) && r > 0) targets.forEach(z => { z.radiusMm = r; z.widthMm = r * 2; z.heightMm = r * 2; });
      } else {
        const w = parseFloat(formZone.zoneWidthMm?.value);
        if (!isNaN(w) && w > 0) targets.forEach(z => z.widthMm = w);
        const h = parseFloat(formZone.zoneHeightMm?.value);
        if (!isNaN(h) && h > 0) targets.forEach(z => z.heightMm = h);
      }
    });
  }

  store.subscribe(() => {
    if (!dialog.open) return;
    const doc     = store.getDoc();
    const sel     = getSelection();
    const selObjs = doc.objects.filter(o => sel.has(o.id));
    if (selObjs.length) populate(selObjs, doc);
    else dialog.close();
  });

  document.addEventListener('zc:openprops', open);

  return { open };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uniq(arr, key) {
  const vals = [...new Set(arr.map(o => o[key]))];
  return vals.length === 1 ? String(vals[0]) : '';
}

function uniqKp(spans, key) {
  const vals = [...new Set(spans.map(s => s.kindProps?.[key]))].filter(v => v !== undefined);
  return vals.length === 1 ? String(vals[0]) : '';
}

function setSelectVal(el, value) {
  let mixed = el.querySelector('option[value=""]');
  if (!mixed) {
    mixed = document.createElement('option');
    mixed.value = ''; mixed.textContent = '— mixed —'; mixed.disabled = true;
    el.insertBefore(mixed, el.firstChild);
  }
  el.value = value;
}

function setNumVal(el, value) {
  el.value       = value;
  el.placeholder = value === '' ? '—' : '';
}
