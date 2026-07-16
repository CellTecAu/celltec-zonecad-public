// Settings modal + Zone Configuration modal

export function setupSettings(store) {
  const modal    = document.getElementById('modal-settings');
  const form     = document.getElementById('form-settings');
  const closeBtn = document.getElementById('settings-close');

  document.getElementById('btn-settings').addEventListener('click', () => {
    populateForm(form, store.getDoc().settings);
    modal.showModal();
  });

  closeBtn.addEventListener('click', () => modal.close());
  modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });

  form.addEventListener('input', () => {
    store.mutate(doc => {
      doc.settings.panSensitivity  = parseFloat(form.panSensitivity.value)  || 1;
      doc.settings.zoomSensitivity = parseFloat(form.zoomSensitivity.value) || 1;
      doc.settings.zoomToCursor    = form.zoomToCursor.checked;
      doc.settings.snapEnabled     = form.snapEnabled.checked;
      doc.settings.snapMm          = parseFloat(form.snapMm.value)          || 50;
      doc.settings.rotSnapDeg      = parseFloat(form.rotSnapDeg.value)      ?? 5;
      doc.settings.polarSnapDeg    = Math.max(0, parseFloat(form.polarSnapDeg.value) || 0);
      doc.settings.traceSnapDeg    = parseFloat(form.traceSnapDeg.value)    || 45;
      doc.settings.displayUnit     = form.displayUnit.value;
      // darkMode / showPostLabels / dimensionPanels / layers → toolbar toggles.
      // maxPanelRunMm / panelDivisorMm → Zone Configuration (below).
      const lw = parseFloat(form.layoutWidthM.value);
      const lh = parseFloat(form.layoutHeightM.value);
      if (!isNaN(lw) && lw >= 1) doc.layout.widthM  = lw;
      if (!isNaN(lh) && lh >= 1) doc.layout.heightM = lh;
      updateSnapRow(form);
    });
  });

  function updateSnapRow(form) {
    const row = form.querySelector('.snap-spacing-row');
    if (row) row.style.display = form.snapEnabled.checked ? '' : 'none';
  }

  function populateForm(form, s) {
    form.panSensitivity.value   = s.panSensitivity;
    form.zoomSensitivity.value  = s.zoomSensitivity;
    form.zoomToCursor.checked   = s.zoomToCursor;
    form.snapEnabled.checked    = s.snapEnabled;
    form.snapMm.value           = s.snapMm;
    form.rotSnapDeg.value       = s.rotSnapDeg ?? 5;
    form.polarSnapDeg.value     = s.polarSnapDeg ?? 0;
    form.traceSnapDeg.value     = String(s.traceSnapDeg ?? 45);
    form.displayUnit.value      = s.displayUnit ?? 'm';
    const layout = store.getDoc().layout;
    form.layoutWidthM.value     = layout.widthM;
    form.layoutHeightM.value    = layout.heightM;
    updateSnapRow(form);
  }

  setupZoneConfig(store);
}

/**
 * Zone Configuration modal — inherent panel/zone variables (max panel run, panel divisor),
 * opened from the ? menu. A landing spot for other tunables we may want to tweak but hide later.
 */
function setupZoneConfig(store) {
  const modal    = document.getElementById('modal-zoneconfig');
  const form     = document.getElementById('form-zoneconfig');
  const openBtn  = document.getElementById('btn-zoneconfig');
  const closeBtn = document.getElementById('zoneconfig-close');
  if (!modal || !form) return;

  openBtn?.addEventListener('click', () => {
    const s = store.getDoc().settings;
    form.maxPanelRunMm.value  = s.maxPanelRunMm  ?? 2400;
    form.panelDivisorMm.value = s.panelDivisorMm ?? 100;
    modal.showModal();
  });
  closeBtn?.addEventListener('click', () => modal.close());
  modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });

  form.addEventListener('input', () => {
    store.mutate(doc => {
      doc.settings.maxPanelRunMm  = Math.max(500, parseFloat(form.maxPanelRunMm.value)  || 2400);
      doc.settings.panelDivisorMm = Math.max(1,   parseFloat(form.panelDivisorMm.value) || 100);
    });
  });
}
