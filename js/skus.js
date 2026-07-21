// Product-code (SKU) derivation for the BOM.
//
// Conventions mirror celltec-zoneforge — the source of truth for the Zone catalogue
// (data/product-rules.json; generator/panel.py STD_H; generator/post.py FOOTPLATE map).
// Keep any rule change in sync with zoneforge, not the other way round.

export const STD_PANEL_H = 1825; // PNL{W} implies this height; others carry a -{H} suffix
export const STD_POST_H  = 2000; // PST codes imply this length; others carry a -{h} suffix

// Post codes are named for their footplate (PSTM4 carries an FPM4, etc.).
const PLATE_SUFFIX = { FPM4: 'M4', FPM2: 'M2', FPO: 'O', FPC: 'C' };

/**
 * Catalogue code for a post: PSTM4 / PSTM2 / PSTO / PSTC, `-S` for the steel-post
 * variant, `-{h}` when not the standard 2000 length; Z65 posts are Z65-PST[-{h}]
 * (their FPZ flat foot is integral). Bollards have no PST code — returns null.
 */
export function postCode(post) {
  if (post.kind === 'bollard') return null;
  const h = Math.round(post.heightMm);
  const hSuffix = h === STD_POST_H ? '' : `-${h}`;
  if (post.material === 'z65') return `Z65-PST${hSuffix}`;
  const suffix = PLATE_SUFFIX[post.footplate];
  if (!suffix) return null;
  return `PST${suffix}${post.material === 'steel' ? '-S' : ''}${hSuffix}`;
}

/**
 * Catalogue code for a physical panel / leaf: PNL{W} at the standard 1825 height,
 * PNL{W}-{H} otherwise. Hinged-door and swing-gate leaves use the PNLD door-panel
 * sub-code with the same width/height grammar.
 */
export function panelCode(spanKind, runMm, heightMm) {
  const w = Math.round(runMm), h = Math.round(heightMm);
  const prefix = (spanKind === 'hingedDoor' || spanKind === 'swingGate') ? 'PNLD' : 'PNL';
  return `${prefix}${w}${h === STD_PANEL_H ? '' : `-${h}`}`;
}

/** Panel bracket code by the material of the post the bracket mounts to. */
export const PB_CODE = { aluminium: 'PB', z65: 'Z65-PB', steel: 'PBS' };

/** Hardware-summary descriptions, keyed by code. */
export const HARDWARE_DESC = {
  'PB':     'Panel bracket — T-slot, alloy post (2 per panel end)',
  'Z65-PB': 'Panel bracket — Z65 keyhole mount (2 per panel end)',
  'PBS':    'Panel bracket — steel post (2 per panel end)',
  'HDK':    'Hinge door kit (1 per doorway)',
  'TB1275': 'Through-bolt M12×75 (1 per footplate anchor hole)',
  'EC-PST': 'Post end cap — alloy 86×86 (1 per post)',
  'CSS825': 'M8×25 CSK socket screw — footplate to post (4 per alloy post)',
  'TBC':    'Bollard baseplate anchor (product code to confirm)',
};
