/**
 * Zone type catalogue — ids, display colours (CS2-like palette, matches ui/catalog.js) and the
 * lot-size rules used when painted cells are merged into parcels.
 *
 * `width` / `depth` are cell counts (1 cell = world.cellSize = 8 m). Lots are always 2..4 cells in
 * both directions and always touch the road with their front row; `depth` is the preferred range —
 * a lot always takes the full painted depth it can get (2 … 4 cells) so no painted cell is stranded.
 */
export const ZONE_TYPES = [
  { id: 'res-low', index: 1, label: 'Low-density residential', color: '#4ad19a', width: [2, 3], depth: [2, 4], demand: 'residential' },
  { id: 'res-high', index: 2, label: 'High-density residential', color: '#1f9d63', width: [3, 8], depth: [3, 8], demand: 'residential' },
  { id: 'com-low', index: 3, label: 'Low-density commercial', color: '#62c6ff', width: [2, 4], depth: [2, 4], demand: 'commercial' },
  { id: 'com-high', index: 4, label: 'High-density commercial', color: '#2b6fdc', width: [3, 8], depth: [3, 8], demand: 'commercial' },
  { id: 'ind', index: 5, label: 'Industrial', color: '#f1b634', width: [3, 4], depth: [3, 4], demand: 'industrial' },
  { id: 'office', index: 6, label: 'Office', color: '#b57cf0', width: [3, 4], depth: [3, 4], demand: 'office' },
];

/** id → type record */
export const ZONE_BY_ID = Object.fromEntries(ZONE_TYPES.map((t) => [t.id, t]));
/** index (1..6) → type record; index 0 = unzoned */
export const ZONE_BY_INDEX = [null, ...ZONE_TYPES];

export const ZONE_IDS = ZONE_TYPES.map((t) => t.id);

/** Resolve a zone type argument (id string, index, record or null) to an index 0..6; -1 when unknown. */
export function zoneIndexOf(type) {
  if (type == null || type === '' || type === 'none') return 0;
  if (typeof type === 'number') return type >= 0 && type <= ZONE_TYPES.length ? type | 0 : -1;
  if (typeof type === 'object' && type.index != null) return type.index;
  const rec = ZONE_BY_ID[type];
  return rec ? rec.index : -1;
}
