// Bill of Materials — live parts worksheet with sortable columns + panel cut list

import { spanRunLength, spanHeight, ghostPanelSections, ghostPostCenters, panelConfig, spanHinges, handrailCutList, HANDRAIL } from '../spans.js';
import { fmtLen, BOLLARD } from '../model.js';

// Per-table sort state, preserved across re-renders (the BOM re-renders on every store
// change while open). Key = a column's data key; dir = 'asc' | 'desc'.
const sortStates = {
  posts:  { key: 'qty',   dir: 'desc' },
  panels: { key: 'runMm', dir: 'desc' },
  spans:  { key: 'runMm', dir: 'desc' },
};

// Human labels for span kinds (also used as the Panels "Type" column value).
const KIND_LABEL = {
  panel: 'Panel', hingedDoor: 'Hinged door', swingGate: 'Swing gate',
  slidingDoor: 'Sliding door', cantileverGate: 'Cantilever gate', gap: 'Gap',
  handrail: 'Handrail (HRK)', handrailGate: 'Handrail gate (HRSDK)',
};

export function setupBom(store) {
  const dialog  = document.getElementById('modal-bom');
  const content = document.getElementById('bom-content');
  let lastCsv   = '';
  let lastTitle = 'layout';

  document.getElementById('btn-bom').addEventListener('click', () => {
    renderBom(store.getDoc());
    dialog.showModal();
  });
  document.getElementById('bom-close').addEventListener('click', () => dialog.close());
  document.getElementById('bom-csv')?.addEventListener('click', () => {
    const blob = new Blob([lastCsv], { type: 'text/csv' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download  = `${lastTitle.replace(/[/\\:*?"<>|]/g, '_')}-bom.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  store.subscribe(doc => { if (dialog.open) renderBom(doc); });

  // Sortable headers: one delegated listener. Clicking a column toggles its direction
  // (or switches to it — numeric columns start descending, text ascending), then re-renders.
  content.addEventListener('click', e => {
    const th = e.target.closest('th.bom-sortable');
    if (!th) return;
    const { table, col, numeric } = th.dataset;
    const st = sortStates[table];
    if (!st) return;
    if (st.key === col) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
    else { st.key = col; st.dir = numeric ? 'desc' : 'asc'; }
    renderBom(store.getDoc());
  });

  function renderBom(doc) {
    const { objects, settings } = doc;
    const unit    = settings.displayUnit;
    const cfg     = panelConfig(settings);
    const fmt     = mm => fmtLen(mm, unit);
    const fmtArea = m2 => `${m2.toFixed(2)} m²`;

    const posts   = objects.filter(o => o.type === 'post');
    const spans   = objects.filter(o => o.type === 'span');
    const postMap = Object.fromEntries(posts.map(p => [p.id, p]));

    lastTitle = doc.layout?.title ?? 'layout';
    const csv = [];                                  // CSV lines, section by section
    const csvRow = (...cells) => csv.push(cells.map(csvCell).join(','));

    const parts = [];

    // ── Posts (real + ghost) ────────────────────────────────────────────────────
    // Ghost (intermediate) posts are real hardware — they must be ordered — but they live
    // only in the span geometry, not in objects[]. Synthesise one record per ghost so they
    // count here. They inherit post A's spec (same assumption render/dxf make).
    const ghostPosts = [];
    for (const s of spans) {
      if (s.spanKind !== 'panel') continue;
      const ref = postMap[s.postA] ?? postMap[s.postB];
      if (!ref) continue;
      for (let i = 0; i < ghostPostCenters(s, postMap, cfg).length; i++) {
        ghostPosts.push({ material: ref.material, heightMm: ref.heightMm, footplate: ref.footplate, kind: ref.kind });
      }
    }
    const allPosts = [...posts, ...ghostPosts];

    if (allPosts.length) {
      const groups = groupBy(allPosts, p => p.kind === 'bollard' ? `bollard|${p.heightMm}` : `${p.material}|${p.heightMm}|${p.footplate}`);
      const rows = [...groups.values()].map(g => {
        const p = g[0];
        const MAT_LABEL = { aluminium: 'aluminium 86×86', steel: 'steel 75×3 SHS', z65: 'Z65 65×2.0 SHS' };
        return {
          mat:      p.kind === 'bollard' ? 'bollard 165×3.2 CHS' : (MAT_LABEL[p.material] ?? p.material),
          heightMm: p.heightMm,
          plate:    p.kind === 'bollard' ? `${BOLLARD.plateOd} OD, ${BOLLARD.holes}×Ø${BOLLARD.holeDia} @ ${BOLLARD.pcd} PCD` : p.footplate,
          qty:      g.length,
        };
      });
      const cols = [
        { key: 'mat',      label: 'Material',    render: r => r.mat },
        { key: 'heightMm', label: 'Height',      numeric: true, render: r => fmt(r.heightMm) },
        { key: 'plate',    label: 'Footplate',   render: r => r.plate },
        { key: 'qty',      label: 'Qty', qty: true, numeric: true, render: r => r.qty },
      ];
      const { html, sorted } = renderSortable('posts', cols, rows);
      csv.push('Posts'); csvRow('Material', 'Height (mm)', 'Footplate', 'Qty');
      for (const r of sorted) csvRow(r.mat, Math.round(r.heightMm), r.plate, r.qty);
      csv.push('');
      parts.push(section('Posts', allPosts.length, html));
    }

    // ── Panels (physical) ────────────────────────────────────────────────────────
    // Every physical panel in the layout: plain panels expanded into their ghost
    // sub-panels, PLUS hinged-door / swing-gate / sliding-door leaves (each leaf is a 25×1.6
    // panel — the Type column labels which is which). Only cantilever gates keep a dedicated
    // hardware breakdown below.
    const panelEntries = [];
    for (const s of spans) {
      if (s.spanKind === 'panel') {
        for (const sec of ghostPanelSections(s, postMap, cfg))
          panelEntries.push({ type: KIND_LABEL.panel, runMm: sec.runMm, heightMm: sec.heightMm, meshSide: sec.meshSide });
      } else if (s.spanKind === 'hingedDoor' || s.spanKind === 'swingGate') {
        panelEntries.push({ type: KIND_LABEL[s.spanKind], runMm: spanRunLength(s, postMap), heightMm: spanHeight(s, postMap), meshSide: s.meshSide });
      } else if (s.spanKind === 'slidingDoor') {
        // Leaf covers at minimum the post centres (c-c) of its span, plus any gate extension.
        const pA = postMap[s.postA], pB = postMap[s.postB];
        const c2c = (pA && pB) ? Math.hypot(pB.x - pA.x, pB.y - pA.y) : spanRunLength(s, postMap);
        const gateExtend = Math.max(0, s.kindProps?.gateExtendMm ?? 0);
        panelEntries.push({ type: KIND_LABEL.slidingDoor, runMm: c2c + gateExtend, heightMm: spanHeight(s, postMap), meshSide: s.meshSide });
      }
    }
    if (panelEntries.length) {
      const groups = groupBy(panelEntries, r => `${r.type}|${Math.round(r.runMm)}|${Math.round(r.heightMm)}|${r.meshSide}`);
      const rows = [...groups.values()].map(g => ({ ...g[0], qty: g.length }));
      const cols = [
        { key: 'type',     label: 'Type',   render: r => r.type },
        { key: 'runMm',    label: 'Width',  numeric: true, render: r => fmt(r.runMm) },
        { key: 'heightMm', label: 'Height', numeric: true, render: r => fmt(r.heightMm) },
        { key: 'meshSide', label: 'Mesh',   render: r => `side ${r.meshSide}` },
        { key: 'qty',      label: 'Qty', qty: true, numeric: true, render: r => r.qty },
      ];
      const { html, sorted } = renderSortable('panels', cols, rows);
      csv.push('Panels'); csvRow('Type', 'Width (mm)', 'Height (mm)', 'Mesh', 'Qty');
      for (const r of sorted) csvRow(r.type, Math.round(r.runMm), Math.round(r.heightMm), r.meshSide, r.qty);
      csv.push('');
      parts.push(section('Panels', panelEntries.length, html));

      // Panel cut list (collapsed) — one grouped line per distinct panel, manufacturable.
      const cutGroups = groupBy(panelEntries, r => `${Math.round(r.runMm)}|${Math.round(r.heightMm)}|${r.meshSide}`);
      csv.push('Panel Cut List'); csvRow('Size', 'Verticals', 'Horizontals', 'Mesh area', 'Qty');
      let cutRows = '';
      for (const g of cutGroups.values()) {
        const r    = g[0];
        const hLen = Math.max(0, r.runMm - 50);
        const area = (r.runMm * r.heightMm) / 1e6;
        cutRows += `<tr>
          <td>${fmt(r.runMm)} × ${fmt(r.heightMm)}</td>
          <td>2 off ${fmt(r.heightMm)} 25×1.6 SHS</td>
          <td>3 off ${fmt(hLen)} 25×1.6 SHS</td>
          <td>${fmtArea(area)} side&nbsp;${r.meshSide}</td>
          <td class="bom-qty">${g.length}</td>
        </tr>`;
        csvRow(`${Math.round(r.runMm)}x${Math.round(r.heightMm)}`, `2 off ${Math.round(r.heightMm)} 25x1.6 SHS`,
               `3 off ${Math.round(hLen)} 25x1.6 SHS`, `${area.toFixed(2)} m2 side ${r.meshSide}`, g.length);
      }
      csv.push('');

      // Ghost-post advisory: any run longer than one max panel needs intermediate posts.
      let ghostPostCount = 0;
      for (const s of spans) {
        if (s.spanKind !== 'panel') continue;
        ghostPostCount += ghostPostCenters(s, postMap, cfg).length;
      }
      const ghostNote = ghostPostCount > 0
        ? `<p class="bom-empty" style="margin-top:6px">⚠ ${ghostPostCount} intermediate post${ghostPostCount > 1 ? 's' : ''} required (runs exceed one ${cfg.maxPanelRunMm} mm panel)</p>`
        : '';
      parts.push(`
        <details class="bom-cutlist">
          <summary>Panel Cut List (${cutGroups.size} size${cutGroups.size > 1 ? 's' : ''})</summary>
          <table class="bom-table">
            <thead><tr>${ths('Size (W × H)', 'Verticals', 'Horizontals', 'Mesh area', 'Qty')}</tr></thead>
            <tbody>${cutRows}</tbody>
          </table>
          ${ghostNote}
        </details>`);
    }

    // ── Spans (logical, collapsed) ────────────────────────────────────────────────
    // The raw post-to-post links (one row per span, not split into panels). Less useful
    // day-to-day than the Panels table, so it's collapsed by default.
    if (spans.length) {
      const spanEntries = spans.map(s => ({
        spanKind: KIND_LABEL[s.spanKind] ?? s.spanKind,
        heightMm: spanHeight(s, postMap),
        runMm:    spanRunLength(s, postMap),
        meshSide: s.meshSide,
      }));
      const groups = groupBy(spanEntries, r => `${r.spanKind}|${Math.round(r.heightMm)}|${Math.round(r.runMm)}|${r.meshSide}`);
      const rows = [...groups.values()].map(g => ({ ...g[0], qty: g.length }));
      const cols = [
        { key: 'spanKind', label: 'Kind',       render: r => r.spanKind },
        { key: 'heightMm', label: 'Height',     numeric: true, render: r => fmt(r.heightMm) },
        { key: 'runMm',    label: 'Run length', numeric: true, render: r => fmt(r.runMm) },
        { key: 'meshSide', label: 'Mesh',       render: r => `side ${r.meshSide}` },
        { key: 'qty',      label: 'Qty', qty: true, numeric: true, render: r => r.qty },
      ];
      const { html, sorted } = renderSortable('spans', cols, rows);
      csv.push('Spans (post-to-post)'); csvRow('Kind', 'Height (mm)', 'Run (mm)', 'Mesh', 'Qty');
      for (const r of sorted) csvRow(r.spanKind, Math.round(r.heightMm), Math.round(r.runMm), r.meshSide, r.qty);
      csv.push('');
      parts.push(`
        <details class="bom-cutlist">
          <summary>Spans — post-to-post links (${spans.length})</summary>
          ${html}
        </details>`);
    }

    // ── Handrail (HRK) — two SHS rails + UHR/LHR brackets per bay ────────────────
    // Rails are cut off the post CENTRES (brackets bolt to the post faces), not
    // the pin line, so this uses handrailCutList rather than the panel run.
    const handrailRows = [];
    for (const s of spans) {
      if (s.spanKind !== 'handrail') continue;
      const cl = handrailCutList(s, postMap);
      if (cl) handrailRows.push(cl);
    }
    if (handrailRows.length) {
      const hgroups = groupBy(handrailRows, r => `${r.bayMm}|${r.postHeightMm}`);
      csv.push('Handrail (HRK)');
      csvRow('Bay c-c (mm)', 'Post height (mm)', 'Upper rail 50 SHS (mm)', 'Lower rail 30 SHS (mm)', 'UHR', 'LHR', 'Qty');
      let hrRows = '';
      for (const g of hgroups.values()) {
        const r = g[0];
        hrRows += `<tr>
          <td>${fmt(r.bayMm)}</td>
          <td>${fmt(r.postHeightMm)}</td>
          <td>${fmt(r.upper.lengthMm)} — ${r.upper.section}</td>
          <td>${fmt(r.lower.lengthMm)} — ${r.lower.section}</td>
          <td>2 UHR · 2 LHR</td>
          <td class="bom-qty">${g.length}</td>
        </tr>`;
        csvRow(r.bayMm, r.postHeightMm, r.upper.lengthMm, r.lower.lengthMm, 2, 2, g.length);
      }
      csv.push('');
      parts.push(section('Handrail (HRK)', handrailRows.length, `
        <table class="bom-table">
          <thead><tr>${ths('Bay c-c', 'Post H', 'Upper rail', 'Lower rail', 'Brackets', 'Qty')}</tr></thead>
          <tbody>${hrRows}</tbody>
        </table>`));
    }

    // ── Handrail gates (HRSDK) — 30 box leaf, dia-30 bush hinges, HDS stop ───────
    const hrGateRows = [];
    for (const s of spans) {
      if (s.spanKind !== 'handrailGate') continue;
      const pA = postMap[s.postA], pB = postMap[s.postB];
      if (!pA || !pB) continue;
      const c2c = Math.round(Math.hypot(pB.x - pA.x, pB.y - pA.y));
      hrGateRows.push({
        c2cMm: c2c,
        leafMm: c2c - HANDRAIL.gateLeaf.gapMm,   // leaf = c-c − 100, as PNLD
        leafHMm: HANDRAIL.gateLeaf.heightMm,
        selfClosing: !!(s.kindProps?.selfClosing),
      });
    }
    if (hrGateRows.length) {
      const ggroups = groupBy(hrGateRows, r => `${r.c2cMm}|${r.leafMm}|${r.selfClosing}`);
      csv.push('Handrail Gates (HRSDK)');
      csvRow('Opening c-c (mm)', 'Leaf W (mm)', 'Leaf H (mm)', 'Self closing', 'Hinges', 'Stop', 'Qty');
      let ggRows = '';
      for (const g of ggroups.values()) {
        const r = g[0];
        ggRows += `<tr>
          <td>${fmt(r.c2cMm)}</td>
          <td>${fmt(r.leafMm)} × ${fmt(r.leafHMm)} — 30×30×1.6 SHS</td>
          <td>${r.selfClosing ? 'yes (−SC)' : 'no'}</td>
          <td>2 × HBK, Ø30 bush</td>
          <td>1 × HDS</td>
          <td class="bom-qty">${g.length}</td>
        </tr>`;
        csvRow(r.c2cMm, r.leafMm, r.leafHMm, r.selfClosing ? 'yes' : 'no', 2, 1, g.length);
      }
      csv.push('');
      parts.push(section('Handrail Gates (HRSDK)', hrGateRows.length, `
        <table class="bom-table">
          <thead><tr>${ths('Opening', 'Leaf (W×H)', 'Self closing', 'Hinges', 'Stop', 'Qty')}</tr></thead>
          <tbody>${ggRows}</tbody>
        </table>`));
    }

    // ── Cantilever gates — beam + leaf + rollers + catcher + endstop ──────────────
    const cantileverRows = [];
    for (const s of spans) {
      if (s.spanKind !== 'cantileverGate') continue;
      const h   = spanHinges(s, postMap);
      const len = h ? Math.hypot(h.hB.x - h.hA.x, h.hB.y - h.hA.y) : 0;
      const frontOff  = Math.max(0, s.kindProps?.frontWheelOffsetMm ?? 210);
      const rollerSpc = Math.max(100, s.kindProps?.rollerSpacingMm ?? 500);
      const tailOver  = Math.max(0, s.kindProps?.tailOverhangMm ?? 150);
      cantileverRows.push({ openMm: len, beamMm: len + frontOff + rollerSpc + tailOver, gateWMm: len, gateHMm: spanHeight(s, postMap), rollers: 2 });
    }
    if (cantileverRows.length) {
      const cgroups = groupBy(cantileverRows, r => `${Math.round(r.openMm)}|${Math.round(r.beamMm)}|${Math.round(r.gateWMm)}|${Math.round(r.gateHMm)}`);
      csv.push('Cantilever Gates');
      csvRow('Opening (mm)', 'Beam (mm)', 'Leaf W (mm)', 'Leaf H (mm)', 'Roller carriages', 'End catcher', 'Endstop', 'Qty');
      let cgRows = '';
      for (const g of cgroups.values()) {
        const r = g[0];
        cgRows += `<tr>
          <td>${fmt(r.openMm)}</td>
          <td>${fmt(r.beamMm)} track beam</td>
          <td>${fmt(r.gateWMm)} × ${fmt(r.gateHMm)}</td>
          <td>${r.rollers} carriages</td>
          <td>1 catcher · 1 endstop post</td>
          <td class="bom-qty">${g.length}</td>
        </tr>`;
        csvRow(Math.round(r.openMm), Math.round(r.beamMm), Math.round(r.gateWMm), Math.round(r.gateHMm), r.rollers, 1, '1 endstop post', g.length);
      }
      csv.push('');
      parts.push(section('Cantilever Gates', cantileverRows.length, `
        <table class="bom-table">
          <thead><tr>${ths('Opening', 'Beam', 'Leaf (W×H)', 'Rollers', 'Hardware', 'Qty')}</tr></thead>
          <tbody>${cgRows}</tbody>
        </table>`));
    }

    lastCsv = csv.join('\r\n');
    content.innerHTML = parts.length
      ? parts.join('')
      : '<p class="bom-empty">Layout is empty — add posts to get started.</p>';
  }
}

/** A titled BOM section with a count badge. */
function section(title, count, inner) {
  return `
    <section class="bom-section">
      <h3>${title} <span class="bom-count">${count}</span></h3>
      ${inner}
    </section>`;
}

/**
 * Build a sortable table. `cols` = [{key, label, numeric?, qty?, render(row)}]. Rows are
 * sorted by the table's current sortState. Returns { html, sorted } so the caller can emit
 * CSV in the same order the user sees.
 */
function renderSortable(tableKey, cols, rows) {
  const st  = sortStates[tableKey] || (sortStates[tableKey] = { key: cols[0].key, dir: 'asc' });
  const col = cols.find(c => c.key === st.key) || cols[0];
  const dir = st.dir === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    const av = a[col.key], bv = b[col.key];
    if (col.numeric) return (Number(av) - Number(bv)) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  const thead = cols.map(c => {
    const arrow = c.key === st.key ? (st.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="bom-sortable${c.qty ? ' bom-qty' : ''}" data-table="${tableKey}" data-col="${c.key}"${c.numeric ? ' data-numeric="1"' : ''}>${c.label}${arrow}</th>`;
  }).join('');
  const body = sorted.map(r =>
    '<tr>' + cols.map(c => `<td class="${c.qty ? 'bom-qty' : ''}">${c.render(r)}</td>`).join('') + '</tr>'
  ).join('');
  return { html: `<table class="bom-table"><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table>`, sorted };
}

/** Quote a CSV cell if it contains a comma, quote, or newline. */
function csvCell(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ths(...labels) {
  return labels.map((l, i) => `<th${i === labels.length - 1 ? ' class="bom-qty"' : ''}>${l}</th>`).join('');
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}
