// ZoneCAD — data model factories and constants

export const POST_PROFILE = {
  aluminium: { w: 86, h: 86 },              // 86×86 T-slot extrusion
  steel:     { w: 75, h: 75, wall: 5 },     // 75×75×5 SHS (post.py steel weldment)
  z65:       { w: 65, h: 65, wall: 2.5 },   // Z65 range — 65×65×2.5 SHS (post.py Z65)
};

export const FOOTPLATE = {
  FPM4: { w: 180, h: 180, holes: 4, offsetX:  0, offsetY:   0 },
  FPM2: { w: 100, h: 180, holes: 2, offsetX:  0, offsetY:   0 }, // portrait 100×180
  FPC:  { w: 180, h: 180, holes: 3, offsetX: 43, offsetY: -43, holeDia: 14 }, // post at upper-left of plate; anchors Ø14
  FPO:  { w: 180, h: 180, holes: 4, offsetX:  0, offsetY: -43 }, // post offset −Y (post.py POST_OFFSET FPO = (0,−43))
  FPZ:  { w: 75,  h: 180, holes: 2, offsetX:  0, offsetY:   0, holeDia: 14 }, // Z65 integral welded flat foot 75×180×8, 2×D14 (post.py:173,198)
};

export const HOLE_INSET = 20;     // mm from plate edge to bolt hole centre (r=6.5 → Ø13mm)
export const HOLE_DIA   = 13;     // mm, Ø13

// Pin centre depth from the post face = half panel-SHS (12.5) + post-face↔panel gap
// (7 alu / 12 steel / 7.5 z65). Z65: pin offset from post centre = 32.5 + 20 = 52.5,
// so opposing pins sit 105 mm across the post.
export const BRACKET_CLEARANCE = { aluminium: 19.5, steel: 24.5, z65: 20 };
export const PANEL_FRAME_SHS   = { w: 25, t: 1.6 };
export const HINGE_PIN_OD      = 20; // mm — PB spigot into the 25 SHS bore (bay.py)

// NOTE: FLOOR_CLEARANCE is the post-top → panel-top DROP (175 under a 2000 post yields
// the correct 1825 panel top), NOT the ground gap. The true panel-bottom → floor gap
// varies by span kind — see GROUND_CLEARANCE below.
export const FLOOR_CLEARANCE   = 175; // mm default (post-top drop)

// True ground clearance (panel-bottom → floor) by span kind, per zoneforge:
// fence bays 100 (bay.py), hinged doors 170 (door.py), sliders/cantilever ~174 (slider.py).
export const GROUND_CLEARANCE  = {
  panel:          100,
  gap:            100,
  hingedDoor:     170,
  swingGate:      170,
  slidingDoor:    174,
  cantileverGate: 174,
};
export function groundClearance(spanKind) {
  return GROUND_CLEARANCE[spanKind] ?? GROUND_CLEARANCE.panel;
}

// Bump when default settings change in a way every existing user should pick up.
// migrateSettings() applies a one-time reset (currently: grid snap → off) for any
// doc stamped with an older version. v2: snap off by default.
export const SETTINGS_VERSION  = 2;

let _uid = 1;
export function uid(prefix = 'o') { return `${prefix}${_uid++}`; }
export function resetUid(n = 1)   { _uid = n; }
export function setUid(n)         { if (n >= _uid) _uid = n; }

// ─── Document ────────────────────────────────────────────────────────────────

export function createDocument(widthM = 12, heightM = 8) {
  return {
    schema:   'zonecad/1',
    units:    'mm',
    layout:   { id: 'layout', widthM, heightM, title: 'Untitled layout' },
    background: null, // { dataUrl, x, y, widthMm, heightMm, opacity } — y = top edge, Y-up
    objects:  [],
    constraints: [],
    settings: {
      panSensitivity:  1.0,
      zoomSensitivity: 1.0,
      zoomToCursor:    true,
      snapEnabled:     false,   // grid snap off by default (object/align snapping still on)
      snapMm:          100,
      rotSnapDeg:      5,
      polarSnapDeg:    0,      // 0 = off; snaps drag/placement angle to this increment
      traceSnapDeg:    45,     // Trace tool: quantize sketched edges to this angle increment
      maxPanelRunMm:   2400,   // largest standard panel; runs longer auto-insert ghost posts
      panelDivisorMm:  100,    // long-run bays are split near-equal and rounded to this increment
      displayUnit:     'm',
      darkMode:        true,
      showPostLabels:  false,
      dimensionPanels: true,   // dimension every physical panel (incl. ghost sub-panels) on canvas + DXF
      layers:          { zones: true, background: true, constraints: true, mesh: true },
      settingsVersion: SETTINGS_VERSION,
    },
    view: { panX: 0, panY: 0, scale: 0.1 },
  };
}

/**
 * Normalise a loaded doc's settings against the current schema: fill any keys added
 * since the doc was saved, and apply one-time resets for docs from before
 * SETTINGS_VERSION (v2: force grid snap off). Mutates and returns the doc. Runs on
 * every load path via store.setDoc, so autosave / file / recent / examples are all covered.
 */
export function migrateSettings(doc) {
  if (!doc || !doc.settings) return doc;
  const defs = createDocument().settings;
  const s    = doc.settings;
  for (const k of Object.keys(defs)) if (!(k in s)) s[k] = defs[k];
  s.layers = { ...defs.layers, ...(s.layers ?? {}) };
  if ((s.settingsVersion ?? 0) < SETTINGS_VERSION) s.snapEnabled = false;
  s.settingsVersion = SETTINGS_VERSION;
  return doc;
}

// ─── Objects ─────────────────────────────────────────────────────────────────

export function createPost(x, y, opts = {}) {
  const bollard = opts.kind === 'bollard';
  const nb      = opts.nb ?? 100;                        // NB bollard size: 65 | 100 | 150
  const p = {
    id:                  uid('p'),
    type:                'post',
    x, y,
    material:            opts.material             ?? 'aluminium',
    heightMm:            opts.heightMm             ?? (bollard ? (NB[nb]?.stdH ?? 1000) : 2000),
    footplate:           opts.footplate            ?? 'FPM4',
    footplateRotationDeg: opts.footplateRotationDeg ?? 0,
  };
  if (bollard) { p.kind = 'bollard'; p.nb = nb; } // absent = ordinary square post
  return p;
}

/**
 * NB bollard family (bollard.py). Each entry: NB-nominal steel pipe on a SQUARE welded
 * baseplate — 4 anchor holes inset from the plate edge + a centre hole, and a rolled cap
 * disc overhanging the pipe OD. Keyed by NB nominal bore (65 | 100 | 150).
 */
export const NB = {
  65:  { od: 76.1,  wall: 3.6, plate: 200, plateT: 10, anchorDia: 18, anchorInset: 30, centreDia: 20, capOverhang: 14, stdH: 900  },
  100: { od: 114.3, wall: 4.5, plate: 250, plateT: 10, anchorDia: 18, anchorInset: 30, centreDia: 20, capOverhang: 14, stdH: 1000 },
  150: { od: 168.3, wall: 4.9, plate: 300, plateT: 10, anchorDia: 18, anchorInset: 30, centreDia: 20, capOverhang: 14, stdH: 1200 },
};

/**
 * Legacy alias — NB100 exposed under the old single-`BOLLARD` field names so modules that
 * still read BOLLARD.{od,wall,plateOd,holes,holeDia,pcd} keep working. New code should read
 * the NB table above (square plates, D18 anchors @ inset 30, centre D20).
 */
export const BOLLARD = {
  ...NB[100],
  od:      NB[100].od,
  wall:    NB[100].wall,
  plateOd: NB[100].plate,                       // square plate size, reused where a plate radius is needed
  holes:   4,
  holeDia: NB[100].anchorDia,                    // Ø18 anchors
  pcd:     NB[100].plate - 2 * NB[100].anchorInset, // 190 — square anchor spacing (edge inset 30)
};

export function isBollard(o) {
  return !!o && o.type === 'post' && o.kind === 'bollard';
}

export function createSpan(postAId, postBId, opts = {}) {
  return {
    id:              uid('s'),
    type:            'span',
    spanKind:        opts.spanKind        ?? 'panel',
    postA:           postAId,
    postB:           postBId,
    faceA:           opts.faceA           ?? null,
    faceB:           opts.faceB           ?? null,
    heightMm:        null,                             // null = derived
    floorClearanceMm: opts.floorClearanceMm ?? 175,
    meshSide:        opts.meshSide        ?? 'A',
    kindProps:       opts.kindProps       ?? {},
  };
}

export function createZone(x, y, opts = {}) {
  const shape    = opts.shape ?? 'rect';
  const radiusMm = opts.radiusMm ?? null;
  return {
    id:       uid('z'),
    type:     'zone',
    shape,                               // 'rect' | 'circle'
    x, y,
    widthMm:  shape === 'circle' ? (radiusMm ?? 500) * 2 : (opts.widthMm  ?? 1000),
    heightMm: shape === 'circle' ? (radiusMm ?? 500) * 2 : (opts.heightMm ?? 1000),
    radiusMm: shape === 'circle' ? (radiusMm ?? 500) : null,
    name:     opts.name  ?? 'Zone',
    color:    opts.color ?? null,
  };
}

export function createLabel(x, y, opts = {}) {
  return {
    id:   uid('l'),
    type: 'label',
    x, y,
    text: opts.text ?? 'Label',
  };
}

export function createDimAnnotation(x0, y0, x1, y1) {
  return { id: uid('d'), type: 'dim', x0, y0, x1, y1 };
}

/** Reference (driven) dimension between two posts — shows the live distance, never moves them. */
export function createRefDimension(postAId, postBId, opts = {}) {
  return { id: uid('r'), type: 'refdim', postA: postAId, postB: postBId, offsetMm: opts.offsetMm ?? 400 };
}

export function createAccessory(accKind, hostId, opts = {}) {
  return {
    id:      uid('a'),
    type:    'accessory',
    accKind,
    host:    hostId,
    side:    opts.side ?? 'A',
    x:       opts.x ?? null,
    y:       opts.y ?? null,
  };
}

export function createConstraint(kind, childId, parentRef, valueMm = 0, valueDeg = null) {
  return {
    id:       uid('c'),
    kind,
    child:    childId,
    parent:   parentRef,
    valueMm,
    valueDeg,
    dim:      { refParent: 'centre', refChild: 'centre' },
  };
}

// ─── Coordinate helpers (used by render, hit, interaction, input) ─────────────

export function canvasToModel(cx, cy, view, layoutH) {
  return {
    x: (cx - view.panX) / view.scale,
    y: layoutH - (cy - view.panY) / view.scale,
  };
}

export function modelToCanvas(mx, my, view, layoutH) {
  return {
    x: view.panX + mx * view.scale,
    y: view.panY + (layoutH - my) * view.scale,
  };
}

export function snapPoint(x, y, settings) {
  if (!settings.snapEnabled) return { x, y };
  const s = settings.snapMm;
  return { x: Math.round(x / s) * s, y: Math.round(y / s) * s };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert the stored doc's uid counter to be safe after loading */
export function syncUidFromDoc(doc) {
  const nums = doc.objects.concat(doc.constraints)
    .map(o => parseInt(o.id.slice(1), 10))
    .filter(n => !isNaN(n));
  if (nums.length) setUid(Math.max(...nums) + 1);
}

export function layoutMm(layout) {
  return { w: layout.widthM * 1000, h: layout.heightM * 1000 };
}

export function postProfile(material) {
  return POST_PROFILE[material] ?? POST_PROFILE.aluminium;
}

/** id → post lookup for every post in `objects` (the one true copy of this loop). */
export function buildPostMap(objects) {
  const m = {};
  for (const o of objects) if (o.type === 'post') m[o.id] = o;
  return m;
}

/** Normalise an angle to [0, 360). */
export function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

/** Display-format a length in the user's unit ('mm' → whole mm, else metres to 3dp). */
export function fmtLen(mm, unit) {
  return unit === 'mm' ? `${Math.round(mm)} mm` : `${(mm / 1000).toFixed(3)} m`;
}

// Dimension/angle annotation geometry shared by render (drawing) and hit (picking) —
// one source of truth so moving a label can never strand its click target.

/** Perpendicular offset of a dimension line from its posts (stored, else zoom-adaptive). */
export function dimLineOffset(o, scale) {
  return (typeof o.offsetMm === 'number') ? o.offsetMm : Math.min(300, Math.max(40, 60 / scale));
}

/** Arc radius + label anchor of an angle annotation at its parent post. */
export function angleLabelAnchor(parent, scale) {
  const r = 40 / scale;
  return { r, x: parent.x + r * 1.4, y: parent.y + r * 0.4 };
}

/** Point on the layout edge that a tieEdge constraint's dashed line lands on, or null. */
export function tieEdgePoint(c, child, lw, lh) {
  switch (c.parent.split(':')[1]) {
    case 'left':   return { x: 0,       y: child.y };
    case 'right':  return { x: lw,      y: child.y };
    case 'bottom': return { x: child.x, y: 0 };
    case 'top':    return { x: child.x, y: lh };
  }
  return null;
}
