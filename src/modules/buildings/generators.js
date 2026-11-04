/**
 * Procedural building recipes. generate(b, lot, rng, env) turns a building record + lot into a list of
 * instanced parts in the building's local frame (origin = lot centre at ground level, +x along the
 * road, +z towards the road / lot frontage):
 *   mass   — walls, roofs, tanks, ground quads, coarse roof clutter, doors, gutters (static tier,
 *            always drawn, so a roof still reads at hero altitude)
 *   detail — fine rooftop plant, balcony rails, awnings, signs, fences, scaffolding … (dynamic tier)
 * Detail parts carry `t`: 0 = near ring only, 1 = keep out to the mid ring (default is by size).
 * `env.ground(lx, lz)` returns the terrain height at a local point relative to the building origin, so
 * fences and garden walls step with the slope instead of floating.
 * Everything is deterministic from the rng passed in.
 */
import { STYLE, doorCentre, bayLayout, dockLayout } from './facadeShader.js';

/**
 * Metres covered by one tile of each wall set. Calibrated against real coursing: the brick sets carry
 * ~14 courses per tile, so 1.5 m ≈ a 10 cm course — at 2.6 m they read as 18 cm blocks.
 */
const TEX_SCALE = {
  brick_red: 1.5, brick_yellow: 1.5, brick_white: 1.7, plaster: 3.2, plaster_rough: 3.0,
  plaster_painted: 3.0, concrete_wall: 3.6, concrete: 4.0, corrugated: 2.0, siding: 1.5, glass: 1,
};
/** Residential renders / stucco — pale AND mid-value saturated tones (CS2 suburbs are not all white). */
const PLASTER_TINTS = [
  [0.60, 0.52, 0.42], [0.62, 0.58, 0.52], [0.52, 0.44, 0.36], [0.66, 0.54, 0.34], [0.58, 0.36, 0.26],
  [0.46, 0.48, 0.40], [0.44, 0.48, 0.52], [0.60, 0.48, 0.42], [0.40, 0.42, 0.44], [0.42, 0.44, 0.36],
  [0.54, 0.36, 0.28], [0.36, 0.40, 0.43], [0.64, 0.50, 0.32], [0.44, 0.50, 0.48], [0.68, 0.46, 0.34],
];
/** Painted timber siding — clapboard palette. */
const SIDING_TINTS = [
  [0.62, 0.60, 0.55], [0.54, 0.55, 0.52], [0.42, 0.48, 0.50], [0.34, 0.40, 0.38], [0.28, 0.33, 0.36],
  [0.50, 0.32, 0.26], [0.34, 0.25, 0.21], [0.60, 0.54, 0.42], [0.40, 0.44, 0.36], [0.24, 0.29, 0.32],
];
const MODERN_TINTS = [
  [0.62, 0.60, 0.56], [0.54, 0.55, 0.56], [0.52, 0.46, 0.38], [0.36, 0.38, 0.40], [0.60, 0.55, 0.48],
  [0.44, 0.45, 0.46], [0.50, 0.40, 0.31], [0.40, 0.43, 0.38], [0.56, 0.49, 0.37], [0.31, 0.34, 0.37],
];
// Curtain-wall carrier tints. These now also set the pane's colour family (facadeShader: paneFamily),
// so the list carries real glazing families — blue, green, bronze, champagne and neutral silver —
// rather than six shades of the same blue-grey.
const GLASS_TINTS = [[0.30, 0.34, 0.40], [0.32, 0.39, 0.35], [0.25, 0.27, 0.31], [0.42, 0.40, 0.34], [0.28, 0.31, 0.42], [0.40, 0.42, 0.44], [0.44, 0.38, 0.29], [0.31, 0.36, 0.33]];
/**
 * Profiled-steel cladding is a METAL now (roughness 0.45, metalness 0.95 per MATERIAL_TARGET), and a
 * metal's albedo is its F0 — a warm pastel tint on a metal reflecting a blue sky comes back pink.
 * These are the real coated-steel colours: galvanised, zinc, champagne, slate, bronze, silver-grey.
 */
const CORRUGATED_TINTS = [[0.74, 0.76, 0.78], [0.56, 0.60, 0.64], [0.66, 0.58, 0.44], [0.44, 0.50, 0.52], [0.52, 0.42, 0.34], [0.66, 0.67, 0.67]];
const AWNING = [[0.30, 0.09, 0.08], [0.08, 0.17, 0.12], [0.09, 0.14, 0.24], [0.36, 0.28, 0.10], [0.46, 0.45, 0.42], [0.20, 0.11, 0.10], [0.10, 0.10, 0.11], [0.28, 0.21, 0.14]];
/** Asphalt-shingle tints (the base map is very dark, so these multipliers run high). */
const SHINGLE = [
  [2.35, 2.26, 2.15], [2.18, 1.81, 1.49], [2.84, 2.18, 1.65], [1.62, 1.68, 1.81],
  [1.90, 1.78, 1.61], [2.57, 1.91, 1.45], [1.45, 1.48, 1.49], [2.23, 1.99, 1.70],
];
const TILE_TINTS = [[0.86, 0.84, 0.81], [0.79, 0.74, 0.71], [0.67, 0.70, 0.73], [0.96, 0.82, 0.68], [0.60, 0.60, 0.62], [0.91, 0.73, 0.62]];
const CONTAINER = [[0.6, 0.2, 0.15], [0.15, 0.3, 0.55], [0.2, 0.45, 0.3], [0.7, 0.55, 0.15], [0.55, 0.55, 0.58]];
const HEDGE_TINTS = [[0.17, 0.30, 0.13], [0.22, 0.36, 0.16], [0.13, 0.25, 0.12], [0.26, 0.34, 0.18]];
const PICKET_TINTS = [[0.68, 0.66, 0.62], [0.60, 0.58, 0.53], [0.50, 0.51, 0.49], [0.64, 0.61, 0.55]];
const BOARD_TINTS = [[0.34, 0.30, 0.26], [0.30, 0.29, 0.27], [0.40, 0.35, 0.29], [0.25, 0.25, 0.24], [0.36, 0.32, 0.29]];
const DOOR_TINTS = [[0.20, 0.11, 0.07], [0.14, 0.18, 0.22], [0.10, 0.22, 0.18], [0.42, 0.14, 0.12], [0.30, 0.30, 0.32], [0.55, 0.50, 0.42]];
/** Eaves, fascia, barge boards and gutters — warm off-whites and painted timber, never pure white. */
const FASCIA_TINTS = [
  [0.62, 0.60, 0.55], [0.55, 0.53, 0.49], [0.47, 0.46, 0.43], [0.58, 0.52, 0.44],
  [0.38, 0.40, 0.40], [0.50, 0.44, 0.37], [0.42, 0.44, 0.42], [0.60, 0.56, 0.47],
];
const RIDGE_MAT = { tiles_a: 'tiles_ridge', tiles_b: 'tiles_ridge_b', shingle: 'shingle_ridge', corrugated_roof: 'metal_ridge' };
const WHITE = [0.84, 0.80, 0.75];
const GREY = [0.48, 0.49, 0.50];
const CONCRETE_RAW = [0.54, 0.53, 0.51];

/** Per-recipe side outputs (chimney stacks / rooftop vents for the effects module), set by generate(). */
let CUR = { stacks: [], vents: [] };
/** Terrain sampler in the building's local frame (set per generate() call). */
let GROUND = () => 0;

function P(list, geo, mat, x, y, z, w, h, d, o) {
  const part = { geo, mat, x, y, z, w, h, d };
  if (o) {
    if (o.ry) part.ry = o.ry;
    if (o.rx) part.rx = o.rx;
    if (o.rz) part.rz = o.rz;
    if (o.color) part.color = o.color;
    if (o.p1) part.p1 = o.p1;
    if (o.p2) part.p2 = o.p2;
    if (o.variant) part.variant = o.variant;
    if (o.t != null) part.t = o.t;
  }
  list.push(part);
  return part;
}
function fp(mat, style, floorH, groundH, bayW, winFrac, litBias, seed) {
  return { p1: [floorH, style, seed, groundH], p2: [bayW, winFrac, litBias, TEX_SCALE[mat] || 3] };
}
const plain = (mat) => fp(mat, STYLE.PLAIN, 3, 3, 3, 0.5, 0.5, 0);

/** Flat-roof parapet+gravel is drawn by the facade shader on the box's top face. */
function wallBox(list, mat, x, z, w, h, d, params, color, ry = 0) {
  return P(list, 'box', mat, x, 0, z, w, h, d, { ...params, color, ry });
}

// ---------------------------------------------------------------------------------------------
// rooftop plant. Coarse volumes go to `mass` so they survive to hero altitude; fine plant (louvres,
// rails, small pipes, ducting) goes to `det`.

const AC_TINTS = [[0.31, 0.32, 0.33], [0.26, 0.27, 0.28], [0.36, 0.36, 0.35], [0.23, 0.24, 0.26]];

function rooftopUnits(mass, det, rng, x0, z0, w, d, top, count, opts = {}) {
  const area = Math.max(1, w * d);
  // guarantee a minimum clutter budget (~1 item per 70 m2) so big roofs are never bare
  const n = Math.max(count, Math.min(7, Math.round(area / 110)));
  for (let i = 0; i < n; i++) {
    const ux = x0 + rng.range(-w / 2 + 1.4, w / 2 - 1.4), uz = z0 + rng.range(-d / 2 + 1.4, d / 2 - 1.4);
    const s = rng.range(1.1, 2.1);
    const ry = rng.range(-0.25, 0.25);
    const col = rng.pick(AC_TINTS);
    // coarse: plinth + casing (static)
    P(mass, 'box', 'paint', ux, top, uz, s * 1.05, 0.16, s * 0.95, { ry, color: [0.22, 0.22, 0.23] });
    P(mass, 'box', 'paint', ux, top + 0.16, uz, s, s * 0.66, s * 0.9, { color: col, ry });
    // fine: lid, fan cowl, grille, ducting (streamed). Values stay near the roof's own value —
    // a near-black primitive on a pale roof reads as a hole, not as plant.
    P(det, 'box', 'paint', ux, top + 0.16 + s * 0.66, uz, s * 0.94, 0.06, s * 0.84, { ry, color: [0.30, 0.30, 0.29], t: 1 });
    P(det, 'cylLow', 'paint', ux, top + 0.12 + s * 0.66, uz, s * 0.62, 0.18, s * 0.62, { color: [0.21, 0.22, 0.23] });
    P(det, 'cylLow', 'paint', ux, top + 0.24 + s * 0.66, uz, s * 0.48, 0.05, s * 0.48, { color: [0.16, 0.17, 0.18] });
    P(det, 'cylLow', 'paint', ux, top + 0.30 + s * 0.66, uz, s * 0.54, 0.04, s * 0.54, { color: [0.40, 0.40, 0.39] });
    // louvre bands on two sides so the casing is not one flat value
    P(det, 'box', 'paint', ux, top + 0.32, uz + s * 0.46, s * 0.72, s * 0.34, 0.05, { ry, color: [0.18, 0.19, 0.20] });
    P(det, 'box', 'paint', ux, top + 0.34, uz - s * 0.46, s * 0.72, s * 0.30, 0.05, { ry, color: [0.18, 0.19, 0.20] });
    if (opts.vents !== false) CUR.vents.push({ x: ux, y: top + s * 0.66 + 0.3, z: uz });
    if (rng.chance(0.5)) { // insulated duct run to the next unit
      const dl = rng.range(1.8, 4.2);
      P(det, 'box', 'paint', ux + rng.range(-0.4, 0.4), top + 0.38, uz - s * 0.8 - dl / 2, 0.55, 0.5, dl, { color: [0.44, 0.44, 0.42], ry, t: 1 });
    }
  }
  if (opts.parapetVent && w > 6) {
    for (let i = 0; i < 2; i++) {
      P(det, 'cylLow', 'steel', x0 + (i ? 1 : -1) * w * 0.3, top, z0 - d * 0.35, 0.34, rng.range(0.7, 1.3), 0.34, { color: [0.46, 0.47, 0.48] });
    }
  }
  if (opts.antennas) {
    for (let i = 0; i < opts.antennas; i++) {
      const ax = x0 + rng.range(-w / 2 + 0.8, w / 2 - 0.8), az = z0 + rng.range(-d / 2 + 0.8, d / 2 - 0.8);
      const ah = rng.range(2.5, 6);
      P(det, 'cylLow', 'metal_dark', ax, top, az, 0.1, ah, 0.1, { t: 1 });
      if (rng.chance(0.5)) P(det, 'box', 'metal_dark', ax, top + ah * 0.7, az, 0.9, 0.06, 0.06, { ry: rng.range(0, 3) });
      else P(det, 'cylLow', 'steel', ax, top + ah * 0.72, az, 1.1, 0.08, 1.1, { rx: rng.range(0.5, 0.9), color: [0.78, 0.78, 0.76] });
    }
  }
  if (opts.tank) {
    const tx = x0 + rng.range(-w / 2 + 2, w / 2 - 2), tz = z0 + rng.range(-d / 2 + 2, d / 2 - 2);
    // legs, banded shell, lid and a side ladder — never a smooth black cylinder
    for (let l = 0; l < 4; l++) {
      const a = (l + 0.5) * Math.PI / 2;
      P(mass, 'box', 'paint', tx + Math.cos(a) * 0.95, top, tz + Math.sin(a) * 0.95, 0.16, 0.9, 0.16, { color: [0.38, 0.39, 0.40] });
    }
    P(mass, 'cylLow', 'paint', tx, top + 0.82, tz, 2.5, 0.14, 2.5, { color: [0.30, 0.30, 0.31] });
    P(mass, 'cyl', 'metal_tank', tx, top + 0.9, tz, 2.4, 2.0, 2.4, { color: [1.10, 1.11, 1.10] });
    for (let bnd = 0; bnd < 2; bnd++) P(det, 'cylLow', 'steel', tx, top + 1.35 + bnd * 0.72, tz, 2.52, 0.09, 2.52, { color: [0.52, 0.53, 0.54], t: 1 });
    P(mass, 'dome', 'metal_tank', tx, top + 2.9, tz, 2.4, 0.55, 2.4, { color: [1.20, 1.20, 1.18] });
    P(det, 'box', 'steel', tx + 1.28, top + 0.9, tz, 0.06, 2.2, 0.42, { color: [0.55, 0.56, 0.56], t: 1 });
  }
  if (opts.solar) {
    const rows = Math.max(1, Math.floor((d - 3) / 2.2)), cols = Math.max(1, Math.floor((w - 3) / 1.8));
    const nS = Math.min(rows * cols, opts.solar);
    let k = 0;
    for (let r = 0; r < rows && k < nS; r++) for (let c = 0; c < cols && k < nS; c++, k++) {
      P(mass, 'box', 'solar', x0 - w / 2 + 1.5 + c * 1.8 + 0.8, top + 0.35, z0 - d / 2 + 1.5 + r * 2.2 + 0.6, 1.6, 0.06, 1.0, { rx: -0.42 });
    }
  }
}

/**
 * Aviation warning light: a dark housing with a small emissive lens on top. The lens material's
 * emissiveIntensity is driven in index.js so it blinks and stays visibly lit by day — the previous
 * 0.5 m flat red cube was the single most eye-catching wrong thing in the p4 night hero.
 */
function beaconLamp(mass, det, x, y, z) {
  P(det, 'cylLow', 'metal_dark', x, y, z, 0.30, 0.22, 0.30, { color: [0.16, 0.17, 0.18], t: 1 });
  P(mass, 'dome', 'beacon', x, y + 0.20, z, 0.30, 0.26, 0.30);
}

/**
 * Tower crown. Six archetypes, picked per instance, so a downtown block never repeats one
 * silhouette forty times: flat parapet, stepped setback, pitched/chamfered cap, projecting cornice
 * with a lantern, a mast + beacons, and a glazed lightbox. Returns the new apex height.
 */
function crown(mass, det, rng, kind, cx, cz, cw, cd, top, mat, tint, mkParams) {
  const par = [0.44, 0.45, 0.46];
  const cap = [0.50, 0.50, 0.49];
  if (kind === 0) {                                     // flat: parapet ring + coping
    P(mass, 'box', 'pave_concrete', cx, top - 0.9, cz, cw + 0.5, 1.05, cd + 0.5, { color: par });
    P(mass, 'box', 'pave_concrete', cx, top + 0.15, cz, cw + 0.9, 0.16, cd + 0.9, { color: cap });
    return top + 0.31;
  }
  if (kind === 1) {                                     // stepped setback
    let y = top, w = cw, d = cd;
    for (let t = 0; t < 2; t++) {
      const hh = rng.range(2.8, 4.6), sc = t === 0 ? 0.74 : 0.50;
      w = cw * sc; d = cd * sc;
      P(mass, 'box', mat, cx, y - 0.05, cz, w, hh, d, { ...mkParams(0.6 + t * 0.31), color: tint });
      P(mass, 'box', 'pave_concrete', cx, y + hh - 0.18, cz, w + 0.6, 0.20, d + 0.6, { color: cap });
      y += hh;
    }
    return y + 0.2;
  }
  if (kind === 2) {                                     // pitched / chamfered cap
    const hh = Math.min(cw, cd) * rng.range(0.22, 0.34);
    P(mass, 'box', 'pave_concrete', cx, top - 0.7, cz, cw + 0.4, 0.85, cd + 0.4, { color: par });
    P(mass, cw > cd * 1.25 ? 'hip25' : 'hip50', 'corrugated_roof', cx, top + 0.15, cz, cw + 0.5, hh, cd + 0.5, { color: rng.pick([[0.34, 0.36, 0.38], [0.44, 0.44, 0.43], [0.30, 0.33, 0.36]]) });
    return top + 0.15 + hh;
  }
  if (kind === 3) {                                     // projecting cornice + lantern
    P(mass, 'box', 'pave_concrete', cx, top - 0.55, cz, cw + 1.5, 0.75, cd + 1.5, { color: cap });
    P(mass, 'box', 'pave_concrete', cx, top + 0.20, cz, cw + 0.6, 0.9, cd + 0.6, { color: par });
    const lw = cw * 0.42, ld = cd * 0.42, lh = rng.range(3.2, 5.4);
    P(mass, 'box', 'glass', cx, top + 1.1, cz, lw, lh, ld, { ...mkParams(1.9), color: [0.13, 0.16, 0.19] });
    P(mass, 'box', 'pave_concrete', cx, top + 1.1 + lh, cz, lw + 0.7, 0.22, ld + 0.7, { color: cap });
    return top + 1.32 + lh;
  }
  if (kind === 4) {                                     // mast + beacons
    P(mass, 'box', 'pave_concrete', cx, top - 0.9, cz, cw + 0.5, 1.05, cd + 0.5, { color: par });
    const mh = rng.range(9, 20);
    // galvanised tube with red/white aviation banding, not one flat colour field
    P(mass, 'cyl', 'metal_dark', cx, top + 0.2, cz, 0.44, mh, 0.44, { color: [0.52, 0.53, 0.55] });
    const bands = Math.max(3, Math.round(mh / 3.2));
    for (let i = 0; i < bands; i += 2) {
      P(det, 'cyl', 'paint', cx, top + 0.24 + (i / bands) * mh, cz, 0.47, (mh / bands) * 0.94, 0.47, { color: [0.44, 0.13, 0.10], t: 1 });
    }
    for (let i = 1; i <= 2; i++) P(det, 'cylLow', 'steel', cx, top + 0.2 + mh * (i / 3), cz, 1.5, 0.08, 1.5, { color: [0.62, 0.63, 0.64], t: 1 });
    // beacon: a small emissive lens in a dark housing, not a 0.5 m unlit red cube
    beaconLamp(mass, det, cx, top + 0.2 + mh * 0.62, cz);
    beaconLamp(mass, det, cx, top + 0.2 + mh + 2.2, cz);
    P(det, 'cone', 'metal_dark', cx, top + 0.2 + mh, cz, 0.44, 2.2, 0.44, { color: [0.50, 0.51, 0.53], t: 1 });
    return top + 0.2 + mh;
  }
  // kind 5: glazed lightbox crown (two glass floors set back, lit at night)
  const bh = rng.range(3.4, 5.8);
  P(mass, 'box', 'glass', cx, top - 0.05, cz, cw * 0.9, bh, cd * 0.9, { ...mkParams(2.6), color: [0.12, 0.15, 0.18] });
  P(mass, 'box', 'pave_concrete', cx, top + bh - 0.2, cz, cw * 0.9 + 0.9, 0.24, cd * 0.9 + 0.9, { color: cap });
  return top + bh + 0.24;
}

/** Stair / lift overrun bulkhead — the single most recognisable roof volume from the air. */
function bulkhead(mass, det, rng, x, z, top, w, d, h, tint) {
  P(mass, 'box', 'plaster', x, top - 0.08, z, w, h, d, { ...plain('plaster'), color: tint || [0.66, 0.66, 0.65] });
  P(mass, 'box', 'metal_dark', x, top - 0.08 + h, z, w + 0.3, 0.16, d + 0.3, { color: [0.30, 0.31, 0.33] });
  P(det, 'box', 'metal_dark', x, top + h * 0.35, z + d / 2 + 0.02, w * 0.35, h * 0.5, 0.06, { color: [0.22, 0.23, 0.25] });
}

// ---------------------------------------------------------------------------------------------
// fences / hedges / garden walls — stepped onto the terrain, varied per lot, never a saturated ribbon

/** One straight fence run split into terrain-following segments. */
function fenceRun(det, kind, x0, z0, x1, z1, h, color, opts = {}) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.6) return;
  const ry = Math.atan2(dx, dz) + Math.PI / 2; // box x axis along the run
  const seg = kind === 'hedge' ? 2.6 : kind === 'chain' ? 4.0 : 2.4;
  const n = Math.max(1, Math.round(len / seg));
  const s = len / n;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const mx = x0 + dx * t, mz = z0 + dz * t;
    const gy = GROUND(mx, mz);
    if (kind === 'hedge') {
      const th = opts.thick || 0.78;
      const hh = h * (0.88 + 0.24 * ((i * 7 + 3) % 5) / 5);
      P(det, 'box', 'hedge', mx, gy - 0.12, mz, s + 0.18, hh - 0.06, th, { ry, color });
      P(det, 'blob', 'hedge', mx, gy + hh - 0.24, mz, s + 0.20, 0.34, th + 0.06, { ry, color });
    } else if (kind === 'chain') {
      P(det, 'panel', 'chain', mx, gy, mz, s, h, 1, { ry, color });
      P(det, 'cylLow', 'steel', x0 + dx * (i / n), GROUND(x0 + dx * (i / n), z0 + dz * (i / n)), z0 + dz * (i / n), 0.1, h + 0.1, 0.1);
    } else if (kind === 'wall') {
      P(det, 'box', 'wall_stone', mx, gy - 0.15, mz, s + 0.06, h + 0.15, 0.30, { ry, color, t: 1 });
      P(det, 'box', 'paint', mx, gy + h, mz, s + 0.06, 0.09, 0.40, { ry, color: [0.80, 0.79, 0.76] });
    } else if (kind === 'picket') {
      P(det, 'panel', 'picket', mx, gy, mz, s, h, 1, { ry, color });
      P(det, 'box', 'paint', mx, gy + h - 0.13, mz, s, 0.07, 0.05, { ry, color });
      P(det, 'box', 'paint', mx, gy + h * 0.34, mz, s, 0.06, 0.045, { ry, color });
    } else { // board / weathered timber
      P(det, 'box', 'wood', mx, gy, mz, s, h, 0.045, { ry, color });
      P(det, 'box', 'wood', mx, gy + h * 0.62, mz, s, 0.07, 0.075, { ry, color });
    }
  }
  if (kind !== 'hedge') {
    const posts = Math.max(1, Math.round(len / (kind === 'chain' ? 4.0 : 2.4)));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      const pxp = x0 + dx * t, pzp = z0 + dz * t;
      if (kind === 'chain') continue;
      const pMat = kind === 'wall' ? 'wall_stone' : kind === 'picket' ? 'paint' : 'wood';
      P(det, 'box', pMat, pxp, GROUND(pxp, pzp) - 0.15,
        pzp, kind === 'wall' ? 0.42 : 0.10, h + (kind === 'wall' ? 0.32 : 0.20), kind === 'wall' ? 0.42 : 0.10, { color });
    }
  }
}

function lotPerimeterFence(det, w, d, h, kind, color, gate) {
  const hw = w / 2 - 0.3, hd = d / 2 - 0.3;
  fenceRun(det, kind, -hw, -hd, hw, -hd, h, color);
  fenceRun(det, kind, -hw, -hd, -hw, hd, h, color);
  fenceRun(det, kind, hw, -hd, hw, hd, h, color);
  if (gate) {
    fenceRun(det, kind, -hw, hd, -hw + Math.max(1, hw - gate / 2), hd, h, color);
    fenceRun(det, kind, hw - Math.max(1, hw - gate / 2), hd, hw, hd, h, color);
  }
}

/** Small planted things: shrub domes and a mulch bed. Cheap, breaks up empty lawn. */
function shrubs(det, rng, x, z, n, spread) {
  for (let i = 0; i < n; i++) {
    const sx = x + rng.range(-spread, spread), sz = z + rng.range(-spread * 0.5, spread * 0.5);
    const r = rng.range(0.5, 1.05);
    P(det, 'blob', 'hedge', sx, GROUND(sx, sz) - 0.1, sz, r * 2, r * 1.6, r * 2, { color: rng.pick(HEDGE_TINTS) });
  }
}

// ---------------------------------------------------------------------------------------------
// res-low: detached houses
function house(b, lot, rng, mass, det) {
  const L = b.level, w = lot.w, d = lot.d, seed = rng();
  const floors = L <= 1 ? 1 : L === 2 ? rng.int(1, 2) : L >= 5 ? rng.int(2, 3) : 2;
  const floorH = 2.9;
  const wallH = floors * floorH + 0.3;
  // a garage (or at least a carport + driveway) on the large majority of suburban lots — a bare
  // box on a lawn is the single biggest reason our res-low read below cs2_04
  const hasGarage = w >= 12.5 && rng.chance(L >= 2 ? 0.93 : 0.62);
  const gw = hasGarage ? (L >= 4 && w >= 23 ? 6.0 : w >= 17 ? 3.5 : 3.05) : 0;
  const aw = w - 3.0;
  let hw = Math.min(Math.max(6.6, w * rng.range(0.42, 0.58)), 15, aw - gw);
  if (L <= 1) hw = Math.min(hw, 9.5);
  const sb = Math.min(Math.max(3.5, d * rng.range(0.2, 0.3)), 7);
  const hd = Math.min(Math.max(7, d - sb - Math.max(4, d * 0.3)), 13);
  const tw = hw + gw;
  const hx = -(tw / 2) + hw / 2 + (hasGarage ? 0 : rng.range(-1, 1) * Math.max(0, (aw - tw) / 4));
  const hz = d / 2 - sb - hd / 2;
  // material family varies as well as tint: render, brick and painted timber siding
  const fam = rng();
  let mat, tint;
  if (fam < 0.30) { mat = 'siding'; tint = rng.pick(SIDING_TINTS); }
  else if (fam < 0.55) { mat = rng.pick(['brick_red', 'brick_yellow', 'brick_white']); tint = rng.chance(0.35) ? [0.66, 0.63, 0.60] : WHITE; }
  else if (fam < 0.80) { mat = rng.pick(['plaster_painted', 'plaster_rough']); tint = rng.pick(PLASTER_TINTS); }
  else { mat = 'plaster'; tint = rng.pick(PLASTER_TINTS); }
  const bayW = rng.range(2.15, 2.75);
  const params = fp(mat, STYLE.HOUSE, floorH, floorH, bayW, 0.42, 0.7, seed);
  wallBox(mass, mat, hx, hz, hw, wallH, hd, params, tint);

  // ---- roof: eaves, fascia, gutter, ridge cap ----
  const ridgeAlongX = hw >= hd;
  const ov = rng.range(0.42, 0.62);
  const span = (ridgeAlongX ? hd : hw) + 2 * ov;
  const pitch = rng.range(0.5, 0.68);
  const rh = span / 2 * Math.tan(pitch);
  const roofMat = L >= 3 && rng.chance(0.45) ? 'shingle' : rng.pick(['tiles_a', 'tiles_b', 'shingle']);
  const fasciaCol = rng.pick(FASCIA_TINTS);
  const gutterCol = fasciaCol.map((c) => c * 0.80);
  const roofColor = roofMat === 'shingle' ? rng.pick(SHINGLE) : rng.pick(TILE_TINTS);
  const hip = L >= 3 && rng.chance(0.45);
  const rw = hw + 2 * ov, rd = hd + 2 * ov;
  const ratio = Math.min(rw, rd) / Math.max(rw, rd);
  const roofGeo = hip ? (ratio > 0.85 ? 'hip50' : ratio > 0.62 ? 'hip35' : 'hip25') : 'gable';
  if (ridgeAlongX) P(mass, roofGeo, roofMat, hx, wallH, hz, rw, rh, rd, { color: roofColor });
  else P(mass, roofGeo, roofMat, hx, wallH, hz, rd, rh, rw, { color: roofColor, ry: Math.PI / 2 });
  // fascia / soffit board under the eave — static so the shadow line survives at distance
  P(mass, 'box', 'paint', hx, wallH - 0.23, hz, rw, 0.22, rd, { color: fasciaCol });
  // gutters + downpipe along the two eave sides
  if (ridgeAlongX) {
    P(mass, 'box', 'paint', hx, wallH - 0.36, hz + rd / 2 - 0.06, rw + 0.06, 0.13, 0.14, { color: gutterCol });
    P(det, 'box', 'paint', hx, wallH - 0.36, hz - rd / 2 + 0.06, rw + 0.06, 0.13, 0.14, { color: gutterCol, t: 1 });
    P(mass, 'box', 'paint', hx + hw / 2 - 0.2, 0, hz + hd / 2 + 0.07, 0.10, wallH - 0.34, 0.10, { color: gutterCol });
  } else {
    P(mass, 'box', 'paint', hx + rw / 2 - 0.06, wallH - 0.36, hz, 0.14, 0.13, rd + 0.06, { color: gutterCol });
    P(det, 'box', 'paint', hx - rw / 2 + 0.06, wallH - 0.36, hz, 0.14, 0.13, rd + 0.06, { color: gutterCol, t: 1 });
    P(mass, 'box', 'paint', hx + hw / 2 + 0.07, 0, hz + hd / 2 - 0.2, 0.10, wallH - 0.34, 0.10, { color: gutterCol });
  }
  // ridge cap — always in the roof's own material so the tint multiplier stays calibrated
  const ridgeMat = RIDGE_MAT[roofMat] || 'tiles_ridge';
  {
    // hip roofs keep a (shorter) ridge cap: a bare hip apex reads as an untextured colour field
    const shrink = hip ? (roofGeo === 'hip50' ? 0.34 : roofGeo === 'hip35' ? 0.52 : 0.68) : 1;
    if (ridgeAlongX) P(mass, 'box', ridgeMat, hx, wallH + rh - 0.06, hz, rw * shrink, 0.17, 0.36, { color: roofColor });
    else P(mass, 'box', ridgeMat, hx, wallH + rh - 0.06, hz, 0.36, 0.17, rd * shrink, { color: roofColor });
  }

  // ---- projecting front gable wing (breaks the "box with a hat" silhouette) ----
  const dx0 = doorCentre(hw, bayW);
  const doorX = hx + dx0, doorZ = hz + hd / 2;
  if (hw > 9 && rng.chance(0.45)) {
    const ww = Math.min(rng.range(0.30, 0.42) * hw, 5.2);
    const wd = rng.range(1.7, 2.8);
    const side = doorX >= hx ? -1 : 1;
    const wx = hx + side * (hw / 2 - ww / 2 - 0.25);
    const wz = hz + hd / 2 + wd / 2 - 0.25;
    const wh = floors > 1 && rng.chance(0.55) ? wallH : Math.min(wallH, floorH + 0.3);
    wallBox(mass, mat, wx, wz, ww, wh, wd + 0.5, fp(mat, STYLE.HOUSE, floorH, floorH, bayW, 0.42, 0.7, seed * 1.7), tint);
    const wov = 0.4, wrh = (ww + 2 * wov) / 2 * Math.tan(pitch);
    P(mass, 'box', 'paint', wx, wh - 0.23, wz, wd + 0.5 + 2 * wov, 0.22, ww + 2 * wov, { color: fasciaCol, ry: Math.PI / 2 });
    P(mass, 'gable', roofMat, wx, wh, wz, wd + 0.5 + 2 * wov, wrh, ww + 2 * wov, { color: roofColor, ry: Math.PI / 2 });
  }

  // ---- dormers on a steep front slope ----
  if (floors >= 2 && !hip && ridgeAlongX && rng.chance(0.34)) {
    const nD = rng.int(1, 2);
    for (let i = 0; i < nD; i++) {
      const t = nD === 1 ? 0 : (i - 0.5) * 2;
      const dxp = hx + t * hw * 0.26 + (nD === 1 ? rng.range(-1, 1) : 0);
      const dzp = hz + rd * 0.26;
      const dy = wallH + rh * (1 - 2 * 0.26);
      P(mass, 'box', mat, dxp, dy - 0.9, dzp, 1.5, 1.7, 1.5, fp(mat, STYLE.HOUSE, floorH, floorH, 1.5, 0.5, 0.7, seed * 2.3), tint);
      P(mass, 'gable', roofMat, dxp, dy + 0.8, dzp, 1.9, 0.62, 1.9, { color: roofColor, ry: Math.PI / 2 });
    }
  }

  // ---- front door (aligned with the shader's door bay), step, canopy, lamp ----
  const doorCol = rng.pick(DOOR_TINTS);
  const trim = fasciaCol;
  P(mass, 'box', 'paint', doorX, 0.00, doorZ + 0.03, 1.36, 2.42, 0.08, { color: trim });                    // architrave slab
  P(mass, 'box', 'paint', doorX, 0.03, doorZ + 0.06, 1.06, 2.22, 0.07, { color: doorCol });                 // leaf (proud of the reveal)
  P(det, 'box', 'steel', doorX + 0.36, 1.05, doorZ + 0.09, 0.05, 0.30, 0.05, { color: [0.72, 0.68, 0.5] });
  P(mass, 'box', 'pave_concrete', doorX, 0, doorZ + 0.12, 1.9, 0.16, 0.85, { color: [0.60, 0.59, 0.57] });  // step
  P(mass, 'box', 'paint', doorX, 2.44, doorZ + 0.14, 1.9, 0.14, 0.90, { color: trim });                     // canopy
  P(det, 'box', 'lamp', doorX + 0.85, 2.05, doorZ + 0.10, 0.16, 0.26, 0.14, { color: [1, 0.86, 0.62] });
  // path from the door to the street
  const pathLen = Math.max(1.2, d / 2 - doorZ);
  P(mass, 'plane', 'pave_slabs', doorX, 0.05, doorZ + pathLen / 2, 1.3, 1, pathLen, { color: [0.64, 0.64, 0.62] });

  // ---- chimney (static: 0.7 m boxes disappear if streamed) ----
  if (rng.chance(0.82)) {
    const cx = hx + (ridgeAlongX ? hw * rng.range(-0.35, 0.35) : 0), cz = hz + (ridgeAlongX ? 0 : hd * rng.range(-0.35, 0.35));
    const off = ridgeAlongX ? Math.abs(cz - hz) : Math.abs(cx - hx);
    const base = wallH + rh * (1 - off / (span / 2)) - 0.8;
    P(mass, 'box', 'brick_red', cx, base, cz, 0.72, wallH + rh + 0.95 - base, 0.72, plain('brick_red'));
    P(mass, 'box', 'metal_dark', cx, wallH + rh + 0.95, cz, 0.86, 0.10, 0.86, { color: [0.34, 0.34, 0.36] });
  }

  // ---- garage + driveway ----
  let driveX = null;
  if (hasGarage) {
    const gx = tw / 2 - gw / 2, gd = 6.2, gz = hz + hd / 2 - gd / 2 + rng.range(-0.5, 1.2);
    wallBox(mass, mat, gx, gz, gw, 2.9, gd, plain(mat), tint);
    const gov = 0.35, grw = gw + 2 * gov, grd = gd + 2 * gov;
    P(mass, 'box', 'paint', gx, 2.9 - 0.21, gz, grw, 0.20, grd, { color: fasciaCol });
    P(mass, 'gable', roofMat, gx, 2.9, gz, grw, grd / 2 * Math.tan(pitch * 0.62), grd, { color: roofColor });
    // recessed garage door with a header
    P(mass, 'box', 'paint', gx, 0.04, gz + gd / 2 + 0.02, gw - 0.55, 2.28, 0.08, { color: rng.pick([[0.64, 0.63, 0.60], [0.52, 0.52, 0.50], [0.28, 0.24, 0.21], [0.42, 0.38, 0.33]]) });
    for (let i = 0; i < 4; i++) P(det, 'box', 'paint', gx, 0.22 + i * 0.55, gz + gd / 2 + 0.07, gw - 0.62, 0.035, 0.03, { color: [0.34, 0.34, 0.33] });
    // header + reveal jamb so the garage door is an opening, not a decal
    P(mass, 'box', 'paint', gx, 2.30, gz + gd / 2 + 0.05, gw - 0.30, 0.20, 0.14, { color: fasciaCol.map((c) => c * 0.72) });
    const drvLen = d / 2 - (gz + gd / 2);
    driveX = gx;
    P(mass, 'plane', 'yard_asphalt', gx, 0.04, gz + gd / 2 + drvLen / 2, gw + 0.4, 1, drvLen + 0.4, { color: [0.52, 0.52, 0.53] });
  } else if (w >= 15) {
    const px = hx + hw / 2 + Math.min(2.4, (w / 2 - (hx + hw / 2)) * 0.5), pl = d / 2 - hz;
    driveX = px;
    P(mass, 'plane', 'yard_asphalt', px, 0.04, hz + pl / 2, 3.1, 1, pl, { color: [0.50, 0.50, 0.51] });
  }

  // ---- porch (aligned to the door) ----
  if (L >= 3) {
    P(mass, 'box', 'paint', doorX, 2.72, doorZ + 1.0, 3.0, 0.18, 2.0, { color: fasciaCol });
    P(mass, 'box', 'pave_concrete', doorX, 0.02, doorZ + 1.0, 3.0, 0.16, 2.0, { color: [0.60, 0.59, 0.57] });
    P(det, 'cylLow', 'paint', doorX - 1.3, 0.16, doorZ + 1.85, 0.15, 2.6, 0.15, { color: fasciaCol, t: 1 });
    P(det, 'cylLow', 'paint', doorX + 1.3, 0.16, doorZ + 1.85, 0.15, 2.6, 0.15, { color: fasciaCol, t: 1 });
  }

  // ---- garden: mulch bed, shrubs, a couple of planters ----
  const bedZ = doorZ + 0.9;
  P(mass, 'plane', 'garden', hx - hw / 2 + 1.2, 0.045, bedZ, Math.max(2.0, hw * 0.45), 1, 1.5, { color: [0.50, 0.42, 0.34] });
  shrubs(det, rng, hx - hw / 2 + 1.2, bedZ, rng.int(2, 4), Math.max(0.8, hw * 0.2));
  if (rng.chance(0.6)) shrubs(det, rng, hx + hw / 2 - 1.0, doorZ + 0.8, rng.int(1, 2), 0.8);
  if (rng.chance(0.5)) shrubs(det, rng, rng.range(-w / 2 + 2, w / 2 - 2), -d / 2 + rng.range(2, 4), rng.int(1, 3), 1.4);

  // ---- fencing: varied per lot, stepped on the terrain, front mostly open ----
  const kindRoll = rng();
  let kind, fCol, fh;
  if (kindRoll < 0.24) { kind = 'none'; fCol = GREY; fh = 0; }
  else if (kindRoll < 0.50) { kind = 'hedge'; fCol = rng.pick(HEDGE_TINTS); fh = rng.range(0.9, 1.45); }
  else if (kindRoll < 0.72) { kind = 'board'; fCol = rng.pick(BOARD_TINTS); fh = rng.range(1.25, 1.7); }
  else if (kindRoll < 0.90) { kind = 'picket'; fCol = rng.pick(PICKET_TINTS); fh = rng.range(0.95, 1.2); }
  else { kind = 'wall'; fCol = rng.pick([[0.58, 0.56, 0.52], [0.50, 0.47, 0.43], [0.44, 0.41, 0.38]]); fh = rng.range(0.65, 0.95); }
  if (kind !== 'none') {
    const hwid = w / 2 - 0.45, hdep = d / 2 - 0.45;
    const frontStop = Math.min(hdep - 0.2, hz + hd / 2 - 0.5);
    fenceRun(det, kind, -hwid, -hdep, hwid, -hdep, fh, fCol);
    fenceRun(det, kind, -hwid, -hdep, -hwid, frontStop, fh, fCol);
    fenceRun(det, kind, hwid, -hdep, hwid, frontStop, fh, fCol);
    // low front boundary only for hedges and picket, always broken by the path (and driveway)
    if ((kind === 'hedge' || kind === 'picket') && rng.chance(0.65)) {
      const fy = Math.min(fh, 0.85);
      const gapL = Math.min(doorX, driveX == null ? doorX : Math.min(doorX, driveX)) - 1.9;
      const gapR = Math.max(doorX, driveX == null ? doorX : Math.max(doorX, driveX)) + 1.9;
      fenceRun(det, kind, -hwid, hdep, Math.max(-hwid, gapL), hdep, fy, fCol);
      fenceRun(det, kind, Math.min(hwid, gapR), hdep, hwid, hdep, fy, fCol);
    }
  }

  // ---- utilities and rooftop solar ----
  P(det, 'box', 'paint', hx - hw / 2 - 0.30, 0.4, hz + rng.range(-hd / 3, hd / 3), 0.42, 0.72, 0.82, { color: [0.56, 0.56, 0.55] });
  if (L >= 4 && !hip && rng.chance(0.7)) {
    const n = rng.int(3, 6);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      const zz = hz + (ridgeAlongX ? rd * 0.22 : t * (hw - 2) * 0.9), xx = hx + (ridgeAlongX ? t * (hw - 2) * 0.9 : rw * 0.22);
      const yy = wallH + rh * 0.55 + 0.12;
      if (ridgeAlongX) P(det, 'box', 'solar', xx, yy, zz, 1.6, 0.05, 1.0, { rx: -pitch, t: 1 });
      else P(det, 'box', 'solar', xx, yy, zz, 1.0, 0.05, 1.6, { rz: pitch, t: 1 });
    }
  }
  const hh = 2 + Math.floor(rng.range(0, 3)) + (L >= 4 ? 1 : 0);
  return { height: wallH + rh, floors, residents: hh, jobs: 0, main: { x: hx, z: hz, w: hw, d: hd, h: wallH } };
}

// ---------------------------------------------------------------------------------------------
// res-high: apartment blocks
function apartment(b, lot, rng, mass, det) {
  const L = b.level, w = lot.w, d = lot.d, seed = rng();
  // Apartment slabs use nearly the whole zoned parcel. Keep only a modest entrance
  // setback and narrow side clearances so larger road tiers produce genuinely larger buildings.
  const sm = Math.min(1.8, Math.max(0.7, w * 0.025));
  const fm = Math.min(2.6, Math.max(1.2, d * 0.035));
  const bm = Math.min(1.6, Math.max(0.8, d * 0.02));
  const hw = Math.max(4, w - 2 * sm);
  const hd = Math.max(4, d - fm - bm);
  const hz = d / 2 - fm - hd / 2;
  const maxF = Math.min(60, 3 + Math.floor((w * d) / 70));
  const rank = lot.roadRank || 1;
  const grandTowerBonus = rank >= 5 && L >= 5
    ? Math.min(40, Math.max(22, Math.round((w * d) / 105)))
    : rank >= 5 ? 6 : 0;
  const baseFloors = [3, 5, 8, 12, 18][L - 1];
  const floors = Math.max(3, Math.min(maxF, baseFloors + grandTowerBonus + rng.int(-1, 2)));
  const floorH = 3.0;
  const retail = L >= 3 && lot.avenue && rng.chance(0.7);
  const groundH = retail ? 4.2 : 3.4;
  const wallH = groundH + (floors - 1) * floorH + 0.6;
  const matsByLevel = [
    ['concrete_wall', 'brick_red', 'plaster_rough', 'brick_yellow'],
    ['brick_yellow', 'plaster_rough', 'brick_red', 'plaster_painted'],
    ['plaster', 'brick_white', 'plaster_painted', 'brick_red'],
    ['plaster', 'brick_white', 'plaster_painted', 'concrete_wall'],
    ['glass', 'plaster', 'plaster', 'brick_white'],
  ];
  const mat = rng.pick(matsByLevel[L - 1]);
  const tint = mat === 'glass' ? rng.pick(GLASS_TINTS) : mat.startsWith('brick') || mat === 'concrete_wall' ? WHITE : L >= 4 ? rng.pick(MODERN_TINTS) : rng.pick(PLASTER_TINTS);
  const style = mat === 'glass' ? STYLE.CURTAIN : retail ? STYLE.RETAIL : STYLE.APARTMENT;
  const bayW = mat === 'glass' ? rng.range(1.6, 2.2) : rng.range(3.0, 4.2);
  const params = fp(mat, style, floorH, groundH, bayW, rng.range(0.42, 0.55), 0.6, seed);
  wallBox(mass, mat, 0, hz, hw, wallH, hd, params, tint);
  // protruding wing / stair core breaks the slab silhouette
  if (L >= 2 && rng.chance(0.7)) {
    const ww = hw * rng.range(0.28, 0.45), wx = rng.range(-hw / 2 + ww / 2 + 1, hw / 2 - ww / 2 - 1);
    const wingMat = rng.chance(0.5) ? mat : rng.pick(['plaster', 'concrete_wall', 'brick_white']);
    const wingTint = wingMat === mat ? (Array.isArray(tint) ? tint.map((c) => c * 0.86) : tint) : rng.pick(MODERN_TINTS);
    const wingParams = fp(wingMat, wingMat === 'glass' ? STYLE.CURTAIN : STYLE.APARTMENT, floorH, groundH, bayW, 0.5, 0.6, seed * 0.7);
    wallBox(mass, wingMat, wx, hz + 0.9, ww, wallH + (L >= 4 ? 1.2 : 0), hd + 0.1, wingParams, wingTint);
  }
  // penthouse / roof core
  if (L >= 4) wallBox(mass, mat === 'glass' ? 'plaster' : mat, rng.range(-hw * 0.1, hw * 0.1), hz, hw * 0.55, 3.2, hd * 0.6, fp(mat, STYLE.APARTMENT, 3.0, 3.0, bayW, 0.6, 0.6, seed * 1.3), mat === 'glass' ? MODERN_TINTS[0] : tint, 0);
  const top = wallH;
  bulkhead(mass, det, rng, hw * 0.3, hz - hd * 0.2, top, 3.2, 3.0, 3.0);
  rooftopUnits(mass, det, rng, 0, hz, hw, hd, top, rng.int(1, 3) + (L >= 3 ? 1 : 0), { antennas: rng.int(1, 3), tank: L <= 3 && rng.chance(0.6), solar: L >= 4 ? rng.int(4, 12) : 0 , vents: false });
  // balconies: slab + rail near, solid parapet band far (rails alias into speckle otherwise)
  const nb = Math.max(1, Math.floor((hw - 1.1) / bayW));
  const bay = (hw - 1.1) / nb;
  const every = floors * nb > 40 ? 2 : 1;
  const faces = floors * nb * 2 > 90 ? [1] : [1, -1];
  const balW = Math.min(bay * 0.62, 3.2);
  // Solid balustrades, not thin rails: a rail grid collapses into black speckle past ~150 m, a pale
  // parapet keeps reading as a balcony at hero altitude (and is what CS2 blocks actually use).
  const glassRail = L >= 4;
  const balMat = glassRail ? 'glass_dark' : 'paint';
  const balCol = glassRail ? [0.13, 0.16, 0.19] : rng.pick([[0.44, 0.42, 0.39], [0.38, 0.37, 0.35], [0.34, 0.34, 0.33]]);
  // Slab albedo sits INSIDE the wall's colour family (0.62-0.78x the wall tint) instead of the old
  // near-white 0.82 card: the p4 critique measured the balcony band at p90 Y 0.72, brighter than
  // anything else in frame. Depth, presence and clutter vary per bay so seven rows never repeat.
  const wallT = Array.isArray(tint) ? tint : [0.55, 0.53, 0.50];
  const slabCol = [wallT[0] * 0.72 + 0.06, wallT[1] * 0.72 + 0.06, wallT[2] * 0.70 + 0.055];
  const soffit = [slabCol[0] * 0.52, slabCol[1] * 0.52, slabCol[2] * 0.52];
  const PLANT = [[0.20, 0.33, 0.15], [0.26, 0.38, 0.18], [0.16, 0.28, 0.13]];
  const CLUTTER = [[0.36, 0.30, 0.24], [0.30, 0.33, 0.36], [0.42, 0.38, 0.30], [0.24, 0.26, 0.28]];
  for (let f = 1; f < floors; f++) {
    const y = groundH + (f - 1) * floorH;
    for (let i = 0; i < nb; i++) {
      if ((i + f) % every !== 0) continue;
      const x = -hw / 2 + 0.55 + (i + 0.5) * bay;
      for (const side of faces) {
        // ~26 % of bays are recessed loggias with no slab at all, which breaks the perfect grid
        if (rng.chance(0.26)) continue;
        const dep = rng.chance(0.30) ? 1.05 : 1.4;                 // shallow French balcony or full slab
        const wj = balW * rng.range(0.86, 1.0);
        const z = hz + side * (hd / 2 + dep / 2);
        P(det, 'box', 'paint', x, y - 0.02, z, wj, 0.18, dep, { color: slabCol, t: 1 });
        P(det, 'box', 'paint', x, y - 0.20, z, wj * 0.96, 0.18, dep * 0.94, { color: soffit, t: 1 });
        P(det, 'box', balMat, x, y + 0.16, z + side * (dep / 2 - 0.06), wj, 0.94, 0.10, { color: balCol, t: 1 });
        P(det, 'box', balMat, x - wj / 2 + 0.05, y + 0.16, z, 0.10, 0.94, dep * 0.93, { color: balCol });
        P(det, 'box', balMat, x + wj / 2 - 0.05, y + 0.16, z, 0.10, 0.94, dep * 0.93, { color: balCol });
        P(det, 'box', 'steel', x, y + 1.10, z + side * (dep / 2 - 0.06), wj, 0.07, 0.14, { color: [0.62, 0.62, 0.61] });
        // lived-in clutter: a planter, a chair or a drying rack on roughly a third of the balconies
        const r = rng();
        if (r < 0.20) P(det, 'box', 'hedge', x + rng.range(-wj * 0.3, wj * 0.3), y + 0.16, z, 0.42, 0.62, 0.42, { color: rng.pick(PLANT) });
        else if (r < 0.34) P(det, 'box', 'paint', x + rng.range(-wj * 0.28, wj * 0.28), y + 0.16, z - side * 0.18, 0.52, 0.72, 0.48, { ry: rng.range(-0.4, 0.4), color: rng.pick(CLUTTER) });
      }
    }
  }
  // ---- ground floor: plinth, entrance portal + lit lobby, canopy ----
  P(mass, 'box', 'pave_concrete', 0, 0, hz, hw + 0.26, 0.78, hd + 0.26, { color: [0.38, 0.37, 0.35] });
  P(mass, 'box', 'pave_concrete', 0, 0.78, hz, hw + 0.38, 0.12, hd + 0.38, { color: [0.48, 0.47, 0.45] });
  P(mass, 'box', 'pave_concrete', 0, 0, hz + hd / 2 + 0.04, 5.6, groundH - 0.25, 0.42, { color: [0.42, 0.41, 0.39] });
  P(mass, 'box', 'glass_dark', 0, 0.05, hz + hd / 2 + 0.26, 4.4, groundH - 0.85, 0.14, { color: [0.11, 0.13, 0.15] });
  P(det, 'box', 'lamp', 0, groundH - 1.15, hz + hd / 2 + 0.36, 1.7, 0.22, 0.12, { color: [1, 0.88, 0.66], t: 1 });
  // entrance canopy
  P(mass, 'box', 'paint', 0, 3.1, hz + hd / 2 + 1.0, 4.4, 0.24, 2.2, { color: [0.56, 0.55, 0.53] });
  P(det, 'cylLow', 'steel', -1.8, 0, hz + hd / 2 + 1.9, 0.15, 3.1, 0.15, { t: 1 });
  P(det, 'cylLow', 'steel', 1.8, 0, hz + hd / 2 + 1.9, 0.15, 3.1, 0.15, { t: 1 });
  // ground: from level 3 up the whole lot is hard-standing — a dense block sitting on bright lawn
  // is what made our aerials read as "buildings on a golf course"
  if (L >= 3) P(mass, 'plane', 'pave_concrete', 0, 0.040, 0, w - 0.5, 1, d - 0.5, { color: [0.47, 0.47, 0.46] });
  P(mass, 'plane', 'pave_slabs', 0, 0.045, d / 2 - fm / 2 - 0.2, w - 0.6, 1, fm + 0.4, { color: [0.62, 0.62, 0.61] });
  if (L <= 2) P(mass, 'plane', 'yard_asphalt', 0, 0.04, -d / 2 + bm / 2 + 0.2, w - 0.6, 1, bm + 0.4, { color: [0.50, 0.50, 0.50] });
  shrubs(det, rng, -w / 2 + sm * 0.6, hz, 3, hd * 0.3);
  shrubs(det, rng, w / 2 - sm * 0.6, hz, 3, hd * 0.3);
  const units = Math.max(2, Math.round((hw * hd) / 95)) * floors;
  const residents = Math.round(units * rng.range(1.8, 2.6));
  const jobs = retail ? Math.round(hw * 0.8) : 0;
  return { height: wallH + (L >= 4 ? 3.2 : 0), floors, residents, jobs, main: { x: 0, z: hz, w: hw, d: hd, h: wallH } };
}

/** Shopfront awning with real thickness, a valance and two support arms. */
function awning(det, x, y, z, wid, col, rng) {
  P(det, 'wedge', 'fabric', x, y, z + 0.78, wid, 0.62, 1.55, { color: col, t: 1 });
  P(det, 'box', 'fabric', x, y - 0.34, z + 1.52, wid, 0.36, 0.05, { color: col });        // valance
  P(det, 'box', 'metal_dark', x - wid / 2 + 0.05, y - 0.02, z + 0.8, 0.05, 0.06, 1.5, { color: [0.28, 0.28, 0.3] });
  P(det, 'box', 'metal_dark', x + wid / 2 - 0.05, y - 0.02, z + 0.8, 0.05, 0.06, 1.5, { color: [0.28, 0.28, 0.3] });
}

// ---------------------------------------------------------------------------------------------
// com-low: shops
function shop(b, lot, rng, mass, det) {
  const L = b.level, w = lot.w, d = lot.d, seed = rng();
  const sm = rng.range(0.5, 1.1), fm = 0.8;
  const hw = w - 2 * sm;
  const hd = Math.min(Math.max(8, d * rng.range(0.55, 0.72)), (lot.roadRank || 1) >= 5 ? 42 : 22);
  const hz = d / 2 - fm - hd / 2;
  const floors = [1, rng.int(1, 2), 2, rng.int(2, 3), 3][L - 1];
  const groundH = 4.2, floorH = 3.2;
  const wallH = groundH + (floors - 1) * floorH + 0.55;
  const mats = [['concrete', 'brick_red'], ['brick_yellow', 'plaster_painted'], ['plaster', 'brick_red', 'plaster_painted'], ['plaster', 'brick_white', 'plaster'], ['plaster', 'brick_white', 'glass']][L - 1];
  const mat = rng.pick(mats);
  const tint = mat === 'glass' ? rng.pick(GLASS_TINTS) : mat.startsWith('brick') ? WHITE : L >= 4 ? rng.pick(MODERN_TINTS) : rng.pick(PLASTER_TINTS);
  const bayW = rng.range(3.4, 4.4);
  wallBox(mass, mat, 0, hz, hw, wallH, hd, fp(mat, mat === 'glass' ? STYLE.CURTAIN : STYLE.RETAIL, floorH, groundH, bayW, 0.55, 0.75, seed), tint);
  // awnings and signs per shopfront bay
  const lay = bayLayout(hw, bayW);
  const nb = lay.nB, bay = lay.bay;
  const awnCol = rng.pick(AWNING);
  const awnings = rng.chance(0.9);
  const frontZ = hz + hd / 2;
  const unitBays = Math.max(1, Math.round(nb / rng.int(1, 3)));
  // cornice above the shopfront fascia (real shadow line onto the glass below)
  P(mass, 'box', 'paint', 0, groundH - 0.06, frontZ + 0.10, hw, 0.20, 0.34, { color: [0.44, 0.43, 0.41] });
  for (let i = 0; i < nb; i++) {
    const x = lay.x0 + (i + 0.5) * bay;
    if (awnings && (i % 3 !== 2 || nb <= 2)) awning(det, x, groundH - 1.45, frontZ, bay - 0.5, (Math.floor(i / unitBays)) % 2 < 1 ? awnCol : rng.pick(AWNING), rng);
  }
  for (let u = 0; u < nb; u += unitBays) {
    const nBays = Math.min(unitBays, nb - u);
    const x = lay.x0 + (u + nBays / 2) * bay;
    const sw = Math.min(nBays * bay - 0.6, 4.2);
    P(mass, 'panel', 'sign', x, groundH - 0.80, frontZ + 0.08, sw, sw / 5, 1, { variant: rng.int(0, 7) });
  }
  if (L >= 3 && rng.chance(0.7)) {
    // rooftop billboard
    const sw = Math.min(hw * 0.6, 9);
    P(mass, 'box', 'metal_dark', 0, wallH + 0.6, hz - hd * 0.2, sw + 0.3, sw / 5 + 0.4, 0.16, { color: [0.28, 0.29, 0.31] });
    P(mass, 'panel', 'sign', 0, wallH + 0.8, hz - hd * 0.2 + 0.11, sw, sw / 5, 1, { variant: rng.int(0, 7) });
    P(det, 'cylLow', 'steel', -sw * 0.35, wallH, hz - hd * 0.2, 0.12, 0.7, 0.12);
    P(det, 'cylLow', 'steel', sw * 0.35, wallH, hz - hd * 0.2, 0.12, 0.7, 0.12);
  }
  bulkhead(mass, det, rng, -hw * 0.28, hz - hd * 0.25, wallH, 2.6, 2.4, 2.4);
  rooftopUnits(mass, det, rng, 0, hz, hw, hd, wallH, rng.int(1, 3), { antennas: rng.int(0, 2), tank: rng.chance(0.35) , vents: false });
  // rear yard: asphalt, dumpster, chain fence
  const yardD = d - fm - hd - 0.6;
  if (yardD > 3) {
    P(mass, 'plane', 'yard_asphalt', 0, 0.04, -d / 2 + yardD / 2 + 0.3, w - 0.6, 1, yardD, { color: [0.52, 0.52, 0.52] });
    P(det, 'box', 'paint', -w / 2 + 1.6, 0, -d / 2 + 1.4, 1.8, 1.3, 1.1, { color: rng.pick([[0.15, 0.4, 0.2], [0.2, 0.3, 0.55], [0.35, 0.35, 0.35]]), t: 1 });
    fenceRun(det, 'chain', -w / 2 + 0.3, -d / 2 + 0.3, w / 2 - 0.3, -d / 2 + 0.3, 2.0, GREY);
  }
  if (L >= 3) P(mass, 'plane', 'pave_concrete', 0, 0.038, 0, w - 0.5, 1, d - 0.5, { color: [0.47, 0.47, 0.46] });
  P(mass, 'plane', 'pave_slabs', 0, 0.045, d / 2 - fm / 2, w - 0.4, 1, fm + 0.3, { color: [0.62, 0.62, 0.61] });
  const jobs = Math.max(3, Math.round((hw * hd) / 42 + (floors - 1) * hw * hd / 60));
  return { height: wallH, floors, residents: 0, jobs, main: { x: 0, z: hz, w: hw, d: hd, h: wallH } };
}

// ---------------------------------------------------------------------------------------------
// com-high: mixed-use towers on a retail podium
function mixed(b, lot, rng, mass, det) {
  const L = b.level, w = lot.w, d = lot.d, seed = rng();
  const pw = w - 2.4, pd = d - 2.2, pz = d / 2 - 1.2 - pd / 2;
  const pf = L <= 2 ? 2 : 3;
  const groundH = 4.5, floorH = 3.6;
  const podH = groundH + (pf - 1) * floorH + 0.6;
  const podMat = rng.pick(['plaster', 'concrete_wall', 'brick_white', 'plaster_painted']);
  const podTint = podMat === 'concrete_wall' || podMat === 'brick_white' ? WHITE : rng.pick(MODERN_TINTS);
  const bayW = rng.range(3.6, 4.8);
  wallBox(mass, podMat, 0, pz, pw, podH, pd, fp(podMat, STYLE.RETAIL, floorH, groundH, bayW, 0.6, 0.7, seed), podTint);
  const lay = bayLayout(pw, bayW);
  const nb = lay.nB, bay = lay.bay, frontZ = pz + pd / 2;
  P(mass, 'box', 'paint', 0, groundH - 0.06, frontZ + 0.10, pw, 0.22, 0.36, { color: [0.42, 0.41, 0.39] });
  for (let i = 0; i < nb; i++) {
    const x = lay.x0 + (i + 0.5) * bay;
    if (i % 2 === 1 && rng.chance(0.7)) awning(det, x, groundH - 1.45, frontZ, bay - 0.5, rng.pick(AWNING), rng);
    if (i % 2 === 0) P(mass, 'panel', 'sign', x, groundH - 0.78, frontZ + 0.08, Math.min(bay - 0.6, 6), Math.min(bay - 0.6, 6) / 5, 1, { variant: rng.int(0, 7) });
  }
  // tower
  // plan archetype: thin slab, square point tower or a chunky block — plus a random 90 deg turn.
  // Forty clones of one extrusion is what made our downtown read as a carpet of boxes.
  const planRoll = rng();
  let tw, td;
  if (planRoll < 0.32) { tw = pw * rng.range(0.80, 0.94); td = pd * rng.range(0.34, 0.48); }
  else if (planRoll < 0.62) { tw = pw * rng.range(0.44, 0.58); td = pd * rng.range(0.46, 0.62); }
  else { tw = pw * rng.range(0.58, 0.80); td = pd * rng.range(0.62, 0.88); }
  if (planRoll < 0.32 && rng.chance(0.45)) { const t = tw; tw = Math.min(pw * 0.92, td); td = Math.min(pd * 0.92, t); }
  const tx = rng.range(-(pw - tw) / 2 + 0.5, (pw - tw) / 2 - 0.5), tz = pz + rng.range(-(pd - td) / 2 + 0.5, (pd - td) / 2 - 0.5);
  const maxF = 5 + Math.floor((w * d) / 32);
  const tf = Math.max(4, Math.min(maxF, [5, 8, 12, 18, 26][L - 1] + rng.int(-1, 3)));
  const tFloorH = 3.1;
  const towerH = tf * tFloorH + 0.6;
  const glass = (L >= 4 && rng.chance(0.62)) || (L === 3 && rng.chance(0.35));
  const tMat = glass ? 'glass' : rng.pick(['plaster', 'brick_white', 'concrete_wall', 'plaster_painted']);
  const tTint = glass ? rng.pick(GLASS_TINTS) : tMat === 'brick_white' || tMat === 'concrete_wall' ? WHITE : rng.pick(MODERN_TINTS);
  const tParams = fp(tMat, glass ? STYLE.CURTAIN : STYLE.APARTMENT, tFloorH, tFloorH, glass ? rng.range(1.5, 2.1) : rng.range(2.8, 3.8), 0.6, 0.6, seed * 0.5);
  P(mass, 'box', tMat, tx, podH - 0.05, tz, tw, towerH, td, { ...tParams, color: tTint });
  if (L >= 4) {
    const sw = tw * 0.4, sTint = glass ? MODERN_TINTS[3] : rng.pick(GLASS_TINTS);
    const sMat = glass ? 'plaster' : 'glass';
    P(mass, 'box', sMat, tx + (rng.chance(0.5) ? 1 : -1) * (tw / 2 - sw / 2 + 0.6), podH - 0.05, tz, sw, towerH + 3.0, td * 0.7, { ...fp(sMat, sMat === 'glass' ? STYLE.CURTAIN : STYLE.APARTMENT, tFloorH, tFloorH, sMat === 'glass' ? 1.8 : 3.2, 0.55, 0.6, seed * 0.3), color: sTint });
  }
  const top = podH - 0.05 + towerH;
  const crownKind = [0, 1, 2, 3, 4, 5][Math.min(5, Math.floor(rng() * (L >= 4 ? 6 : 4)))];
  const crownTop = crown(mass, det, rng, crownKind, tx, tz, tw, td, top, tMat, tTint,
    (k) => fp(tMat, glass ? STYLE.CURTAIN : STYLE.APARTMENT, tFloorH, tFloorH, glass ? 1.8 : 3.2, 0.6, 0.6, seed * k));
  if (crownKind !== 4) bulkhead(mass, det, rng, tx + tw * 0.22, tz - td * 0.18, top, tw * 0.34, td * 0.34, 3.0, [0.44, 0.45, 0.47]);
  rooftopUnits(mass, det, rng, tx, tz, tw, td, top, rng.int(2, 4), { antennas: rng.int(1, 3), vents: false });
  if (crownTop > 45) { beaconLamp(mass, det, tx, crownTop + 0.4, tz); beaconLamp(mass, det, tx + tw * 0.4, top + 0.2, tz - td * 0.4); }
  if (L >= 4 && (crownKind === 0 || crownKind === 4)) {
    P(mass, 'box', 'metal_dark', tx, top + 1.0, tz - td * 0.1, Math.min(tw * 0.7, 12) + 0.3, 2.6, 0.2, { color: [0.24, 0.25, 0.27] });
    P(mass, 'panel', 'sign', tx, top + 1.2, tz - td * 0.1 + 0.12, Math.min(tw * 0.7, 12), 2.2, 1, { variant: rng.int(0, 7) });
  }
  // podium roof garden + units
  rooftopUnits(mass, det, rng, tx > 0 ? -pw / 4 : pw / 4, pz, pw / 2 - 1, pd - 2, podH, rng.int(1, 3), { vents: false });
  for (let i = 0; i < 4; i++) P(det, 'box', 'hedge', (tx > 0 ? -pw / 2 + 2 : pw / 2 - 2), podH, pz - pd / 2 + 2 + i * ((pd - 4) / 3), 1.6, 0.6, 1.6, { color: rng.pick(HEDGE_TINTS), t: 1 });
  P(mass, 'plane', 'pave_slabs', 0, 0.045, 0, w - 0.4, 1, d - 0.4, { color: [0.60, 0.60, 0.59] });
  const jobs = Math.round((pw * pd * pf) / 45 + (tw * td * tf) / 60);
  const residents = glass ? 0 : Math.round((tw * td * tf) / 110);
  return { height: Math.max(crownTop, top + (L >= 4 ? 3 : 0)), floors: pf + tf, residents, jobs, main: { x: tx, z: tz, w: tw, d: td, h: top } };
}

// ---------------------------------------------------------------------------------------------
// office: curtain-wall towers with setbacks
function office(b, lot, rng, mass, det) {
  const L = b.level, w = lot.w, d = lot.d, seed = rng();
  const bw = Math.min(w - 4, 40), bd = Math.min(d - 5, 32), bz = d / 2 - 3.2 - bd / 2;
  const floorH = 3.7, groundH = 4.6;
  const maxF = 8 + Math.floor((w * d) / 24);
  let top;
  if (L <= 2) {
    const floors = Math.min(maxF, L === 1 ? rng.int(3, 4) : rng.int(5, 7));
    const glassy = L === 2 && rng.chance(0.5);
    const mat = glassy ? 'glass' : rng.pick(['concrete_wall', 'plaster', 'brick_white', 'concrete']);
    const tint = glassy ? rng.pick(GLASS_TINTS) : mat === 'plaster' ? rng.pick(MODERN_TINTS) : WHITE;
    const h = groundH + (floors - 1) * floorH + 0.7;
    wallBox(mass, mat, 0, bz, bw, h, bd, fp(mat, glassy ? STYLE.CURTAIN : STYLE.APARTMENT, floorH, groundH, glassy ? 1.8 : rng.range(2.6, 3.4), 0.72, 0.55, seed), tint);
    top = h;
    bulkhead(mass, det, rng, bw * 0.2, bz, top, 4.2, 3.6, 2.8, [0.56, 0.57, 0.59]);
    rooftopUnits(mass, det, rng, 0, bz, bw, bd, top, rng.int(2, 4), { antennas: rng.int(1, 2), solar: rng.chance(0.5) ? rng.int(6, 14) : 0 , vents: false });
    P(mass, 'plane', 'pave_slabs', 0, 0.045, 0, w - 0.4, 1, d - 0.4, { color: [0.60, 0.60, 0.59] });
    return { height: top, floors, residents: 0, jobs: Math.round((bw * bd * floors) / 20), main: { x: 0, z: bz, w: bw, d: bd, h: top } };
  }
  const total = Math.max(8, Math.min(maxF, [0, 0, rng.int(10, 16), rng.int(16, 26), rng.int(26, 40)][L - 1]));
  const tiers = L >= 4 ? 3 : 2;
  const split = tiers === 3 ? [0.4, 0.35, 0.25] : [0.55, 0.45];
  const scales = tiers === 3 ? [1, 0.78, 0.58] : [1, 0.72];
  const tint = rng.pick(GLASS_TINTS);
  const mullionBay = rng.range(1.4, 2.0);
  const accent = rng.chance(0.5);
  let y = 0, floorsLeft = total;
  const centres = [];
  let topMat = 'glass', topTint = tint;
  for (let t = 0; t < tiers; t++) {
    const fl = t === tiers - 1 ? floorsLeft : Math.max(2, Math.round(total * split[t]));
    floorsLeft -= fl;
    const tw = bw * scales[t], td = bd * scales[t];
    const ox = t === 0 ? 0 : rng.range(-(bw - tw) / 2 * 0.6, (bw - tw) / 2 * 0.6);
    const oz = t === 0 ? bz : bz + rng.range(-(bd - td) / 2 * 0.6, (bd - td) / 2 * 0.6);
    const h = (t === 0 ? groundH - floorH : 0) + fl * floorH + 0.7;
    const mat = accent && t === 1 ? 'plaster' : 'glass';
    const params = fp(mat, mat === 'glass' ? STYLE.CURTAIN : STYLE.APARTMENT, floorH, t === 0 ? groundH : floorH, mat === 'glass' ? mullionBay : 3.0, 0.7, 0.55, seed * (1 + t * 0.37));
    P(mass, 'box', mat, ox, y - (t ? 0.05 : 0), oz, tw, h, td, { ...params, color: mat === 'glass' ? tint : MODERN_TINTS[3] });
    topMat = mat; topTint = mat === 'glass' ? tint : MODERN_TINTS[3];
    centres.push({ x: ox, z: oz, w: tw, d: td, top: y + h });
    y += h - 0.05;
  }
  top = y + 0.05;
  const c = centres[centres.length - 1];
  // crown: mast, stepped setback, cornice + lantern, chamfer or lightbox — picked per instance
  const oKind = [4, 1, 3, 0, 5, 2][Math.floor(rng() * 6)];
  const crownTop = crown(mass, det, rng, oKind, c.x, c.z, c.w, c.d, top, topMat, topTint,
    (k) => fp('glass', STYLE.CURTAIN, floorH, floorH, mullionBay, 0.7, 0.55, seed * k));
  if (oKind !== 4) bulkhead(mass, det, rng, c.x + c.w * 0.2, c.z - c.d * 0.16, top, c.w * 0.34, c.d * 0.34, 3.4, [0.44, 0.46, 0.49]);
  if (crownTop > 45) beaconLamp(mass, det, c.x + c.w * 0.42, top + 0.2, c.z + c.d * 0.42);
  top = Math.max(top, crownTop);
  // 0.8 m parapet + coping round the crown deck: without it the slab ends at a razor edge and reads
  // as floating (critique p4, major #4)
  P(mass, 'box', 'pave_concrete', c.x, top, c.z, c.w + 0.34, 0.86, c.d + 0.34, { color: [0.44, 0.44, 0.43] });
  P(mass, 'box', 'pave_concrete', c.x, top + 0.86, c.z, c.w + 0.52, 0.13, c.d + 0.52, { color: [0.52, 0.52, 0.50] });
  P(mass, 'box', 'pave_concrete', c.x, top + 0.10, c.z, c.w - 0.34, 0.06, c.d - 0.34, { color: [0.36, 0.36, 0.35] });
  for (let i = 0; i < rng.int(2, 3); i++) {
    const cx = c.x + rng.range(-c.w / 2 + 2, c.w / 2 - 2), cz = c.z + rng.range(-c.d / 2 + 2, c.d / 2 - 2);
    const ch = rng.range(2.2, 3.1), cr = rng.range(2.0, 2.6);
    // cooling-tower / tank body: the metalplates PBR set (albedo + normal + roughness at 0.45/0.95)
    // instead of a smooth featureless 'paint' cylinder, plus ribs, a fan cowl and a side ladder
    P(mass, 'cyl', 'metal_tank', cx, top, cz, cr, ch, cr, { color: [1.24, 1.25, 1.24] });
    P(det, 'cylLow', 'steel', cx, top + ch * 0.34, cz, cr + 0.10, 0.11, cr + 0.10, { color: [0.60, 0.61, 0.62], t: 1 });
    P(det, 'cylLow', 'steel', cx, top + ch * 0.70, cz, cr + 0.10, 0.11, cr + 0.10, { color: [0.60, 0.61, 0.62], t: 1 });
    P(mass, 'cylLow', 'metal_dark', cx, top + ch, cz, cr * 0.86, 0.14, cr * 0.86, { color: [0.34, 0.35, 0.36] });
    P(det, 'cylLow', 'steel', cx, top + ch + 0.14, cz, cr * 0.62, 0.30, cr * 0.62, { color: [0.30, 0.31, 0.32], t: 1 });
    // side ladder + a low handrail ring so the deck plant has real scale cues
    P(det, 'box', 'steel', cx + cr, top, cz, 0.08, ch + 0.5, 0.46, { color: [0.58, 0.59, 0.60], t: 1 });
    for (let r = 0; r < 4; r++) P(det, 'cylLow', 'steel', cx, top + ch + 0.9, cz + (r - 1.5) * cr * 0.55, 0.06, 0.9, 0.06, { color: [0.56, 0.57, 0.58], t: 1 });
  }
  if (L >= 5 && c.w > 16 && c.d > 16) P(mass, 'cyl', 'pave_concrete', c.x + c.w * 0.25, top, c.z + c.d * 0.2, 9, 0.3, 9, { color: [0.44, 0.44, 0.43] });
  // lower tier roofs get units too
  for (let t = 0; t < centres.length - 1; t++) {
    const ct = centres[t];
    rooftopUnits(mass, det, rng, ct.x + (ct.w - centres[t + 1].w) / 2 * (rng.chance(0.5) ? 1 : -1) * 0.8, ct.z, (ct.w - centres[t + 1].w) * 0.7 + 3, ct.d * 0.6, ct.top, rng.int(1, 3), { vents: false });
  }
  // ---- ground floor: plinth, entrance portal, revolving doors, canopy, signage, bollards ----
  const fz = bz + bd / 2;
  P(mass, 'box', 'pave_concrete', 0, 0, bz, bw + 0.30, 0.95, bd + 0.30, { color: [0.40, 0.39, 0.37] });      // stone plinth
  P(mass, 'box', 'pave_concrete', 0, 0.95, bz, bw + 0.42, 0.14, bd + 0.42, { color: [0.50, 0.49, 0.47] });    // plinth coping
  P(mass, 'box', 'pave_concrete', 0, 0, fz + 0.05, 10.4, groundH - 0.15, 0.55, { color: [0.44, 0.43, 0.41] }); // portal surround
  P(mass, 'box', 'glass_dark', 0, 0.05, fz + 0.34, 9.0, groundH - 0.75, 0.16, { color: [0.10, 0.12, 0.14] });  // lobby glazing
  P(mass, 'cyl', 'glass_dark', 0, 0.05, fz + 0.45, 2.6, 2.7, 2.6, { color: [0.12, 0.14, 0.17] });              // revolving door drum
  P(mass, 'box', 'glass_dark', 0, groundH - 0.3, fz + 2.2, 9, 0.3, 4.4, { color: [0.13, 0.15, 0.18] });        // canopy
  P(det, 'cylLow', 'steel', -3.6, 0, fz + 4.0, 0.22, groundH - 0.3, 0.22, { t: 1 });
  P(det, 'cylLow', 'steel', 3.6, 0, fz + 4.0, 0.22, groundH - 0.3, 0.22, { t: 1 });
  P(mass, 'panel', 'sign', -bw / 2 + 3.2, groundH - 1.5, fz + 0.62, 3.4, 0.68, 1, { variant: rng.int(0, 7) });
  for (let i = 0; i < 4; i++) P(det, 'cylLow', 'steel', -5.4 + i * 3.6, 0, fz + 4.6, 0.18, 0.95, 0.18, { color: [0.48, 0.49, 0.50], t: 1 });
  P(mass, 'plane', 'pave_slabs', 0, 0.045, 0, w - 0.4, 1, d - 0.4, { color: [0.60, 0.60, 0.59] });
  for (let i = 0; i < 3; i++) P(det, 'box', 'hedge', -w / 2 + 2.5 + i * ((w - 5) / 2), 0, d / 2 - 1.6, 1.8, 0.6, 1.2, { color: rng.pick(HEDGE_TINTS), t: 1 });
  const area = centres.reduce((n, ct) => n + ct.w * ct.d, 0) / centres.length;
  return { height: top + 1.2, floors: total, residents: 0, jobs: Math.round((area * total) / 22), main: { x: centres[0].x, z: centres[0].z, w: centres[0].w, d: centres[0].d, h: top } };
}

// ---------------------------------------------------------------------------------------------
// ind: warehouses, factories, tanks, chimneys, loading docks
function industrial(b, lot, rng, mass, det) {
  const L = b.level, w = lot.w, d = lot.d, seed = rng();
  P(mass, 'plane', 'yard_asphalt', 0, 0.04, 0, w - 0.6, 1, d - 0.6, { color: [0.52, 0.52, 0.52] });
  const sm = rng.range(2.5, 4);
  const hw = Math.min(w - 2 * sm, 44), hd = Math.min(Math.max(10, d * rng.range(0.48, 0.62)), 26);
  const hz = -d / 2 + 2.5 + hd / 2;
  const hallH = [5.5, 6.5, 8, 9.5, 11][L - 1] + rng.range(-0.5, 0.8);
  const modern = L >= 4;
  const mat = L <= 2 ? rng.pick(['brick_red', 'concrete_wall', 'corrugated']) : L === 3 ? rng.pick(['corrugated', 'corrugated', 'concrete']) : rng.pick(['plaster', 'corrugated', 'plaster']);
  const tint = mat === 'corrugated' ? rng.pick(CORRUGATED_TINTS) : mat === 'plaster' ? rng.pick(MODERN_TINTS) : WHITE;
  const style = L <= 2 && mat === 'brick_red' ? STYLE.APARTMENT : mat === 'corrugated' ? STYLE.INDUSTRIAL_METAL : STYLE.INDUSTRIAL;
  wallBox(mass, mat, 0, hz, hw, hallH, hd, fp(mat, style, style === STYLE.APARTMENT ? 4.0 : hallH, style === STYLE.APARTMENT ? 4.0 : hallH, rng.range(4, 5.5), 0.75, 0.35, seed), tint);
  let roofTop = hallH;
  if (!modern) {
    const rh = hd / 2 * Math.tan(rng.range(0.14, 0.24));
    // metal roof tints stay neutral-to-cool: a warm tint on a 0.95-metalness surface multiplies the
    // blue sky it mirrors and comes back lilac (R and B lifted, G not), which is not a roof colour
    P(mass, 'gable', 'corrugated_roof', 0, hallH - 0.05, hz, hw + 0.6, rh, hd + 0.6, { color: rng.pick([[1.02, 1.04, 1.06], [0.78, 0.81, 0.85], [0.58, 0.61, 0.64]]) });
    roofTop = hallH + rh;
    for (let i = 0; i < Math.floor(hw / 9); i++) {
      P(mass, 'cylLow', 'steel', -hw / 2 + 4.5 + i * 9, hallH + rh - 0.3, hz, 0.8, 1.5, 0.8, { color: [0.6, 0.6, 0.62] });
      CUR.vents.push({ x: -hw / 2 + 4.5 + i * 9, y: hallH + rh + 1.2, z: hz });
    }
  } else {
    for (let i = 0; i < Math.floor(hw / 8); i++) P(mass, 'box', 'glass_dark', -hw / 2 + 4 + i * 8, hallH, hz, 2.4, 0.5, hd * 0.6, { color: [0.42, 0.48, 0.54] });
    rooftopUnits(mass, det, rng, 0, hz, hw, hd, hallH, rng.int(2, 5), { solar: rng.chance(0.5) ? rng.int(10, 24) : 0 });
  }
  // ---- loading docks on the front face ----
  // The roller-door leaves themselves are drawn by the facade shader (recessed, ribbed, with a
  // lintel and a reveal shadow); here we hang the physical dock furniture on the same layout.
  const frontZ = hz + hd / 2;
  const dl = dockLayout(hw);
  P(mass, 'box', 'concrete', 0, 0, frontZ + 1.2, hw * 0.88, 1.12, 2.4, plain('concrete'));
  P(mass, 'box', 'paint', 0, 1.02, frontZ + 2.40, hw * 0.88, 0.12, 0.14, { color: [0.62, 0.56, 0.18] });   // dock edge stripe
  if (style === STYLE.INDUSTRIAL) {
    for (let i = 0; i < dl.nD; i++) {
      const x = dl.centre(i);
      // rubber bumpers, dock leveller lip, canopy and a bollard: the reference kit for a loading bay
      for (const sgn of [-1, 1]) P(mass, 'box', 'metal_dark', x + sgn * (dl.doorW / 2 + 0.18), 0.72, frontZ + 0.12, 0.26, 0.42, 0.26, { color: [0.13, 0.13, 0.14] });
      P(det, 'box', 'metal_dark', x, 1.02, frontZ + 2.42, dl.doorW - 0.5, 0.10, 0.30, { color: [0.20, 0.20, 0.21], t: 1 });
      P(mass, 'box', 'paint', x, Math.min(hallH - 0.5, 4.62), frontZ + 0.5, dl.doorW + 0.5, 0.16, 1.15, { color: [0.46, 0.45, 0.43] });
      P(det, 'cylLow', 'paint', x + dl.doorW / 2 + 0.9, 0, frontZ + 1.9, 0.22, 1.0, 0.22, { color: [0.60, 0.50, 0.14], t: 1 });
    }
  } else {
    const nDoors = Math.max(1, Math.floor((hw - 4) / 5.5));
    for (let i = 0; i < nDoors; i++) {
      const x = -hw / 2 + 2 + (i + 0.5) * ((hw - 4) / nDoors);
      P(mass, 'box', 'paint', x, 1.15, frontZ + 0.06, 3.0, 3.4, 0.12, { color: rng.pick([[0.22, 0.26, 0.32], [0.36, 0.36, 0.37], [0.18, 0.18, 0.19], [0.40, 0.22, 0.15]]) });
      P(det, 'box', 'metal_dark', x, 0.2, frontZ + 2.45, 3.0, 0.5, 0.12, { color: [0.12, 0.12, 0.12], t: 1 });
      P(det, 'box', 'paint', x, 4.55, frontZ + 0.5, 3.2, 0.18, 1.0, { color: [0.50, 0.49, 0.47] });
    }
  }
  // eaves gutter + corner downpipes with a splash block: the classic warehouse rain kit
  const gutC = [0.44, 0.45, 0.46];
  P(mass, 'box', 'paint', 0, hallH - 0.32, frontZ + 0.10, hw + 0.2, 0.16, 0.18, { color: gutC });
  for (const sgn of [-1, 1]) {
    P(mass, 'box', 'paint', sgn * (hw / 2 - 0.35), 0, frontZ + 0.10, 0.16, hallH - 0.30, 0.16, { color: gutC });
    P(det, 'box', 'paint', sgn * (hw / 2 - 0.35), 0, hz - hd / 2 - 0.10, 0.16, hallH - 0.30, 0.16, { color: gutC, t: 1 });
    P(det, 'box', 'pave_concrete', sgn * (hw / 2 - 0.35), 0, frontZ + 0.32, 0.6, 0.10, 0.5, { color: [0.48, 0.47, 0.45], t: 1 });
  }
  // company signage over the docks
  {
    const sw = Math.min(hw * 0.34, 7.5);
    P(mass, 'box', 'metal_dark', -hw * 0.24, hallH - 1.5, frontZ + 0.10, sw + 0.24, sw / 5 + 0.24, 0.10, { color: [0.24, 0.25, 0.26] });
    P(mass, 'panel', 'sign', -hw * 0.24, hallH - 1.4, frontZ + 0.17, sw, sw / 5, 1, { variant: rng.int(0, 7) });
  }
  // office annex at the front corner
  const aw = Math.min(10, hw * 0.35), ah = L >= 3 ? 6.8 : 3.6;
  const aMat = rng.pick(['plaster', 'brick_white', 'concrete_wall']);
  wallBox(mass, aMat, -hw / 2 + aw / 2 + 0.5, frontZ + 3.0, aw, ah, 6, fp(aMat, STYLE.APARTMENT, 3.2, 3.2, 3.0, 0.6, 0.5, seed * 0.6), aMat === 'plaster' ? rng.pick(MODERN_TINTS) : WHITE);
  // chimney
  if (L >= 3 && rng.chance(L >= 4 ? 0.42 : 0.24)) {
    const ch = rng.range(18, 34), cd = rng.range(1.4, 2.4);
    const cMat = L <= 3 ? 'brick_cyl' : 'concrete_cyl';
    P(mass, 'cyl', cMat, hw / 2 - 2.5, 0, hz - hd / 2 + 2.5, cd, ch, cd);
    P(mass, 'cyl', 'metal_dark', hw / 2 - 2.5, ch, hz - hd / 2 + 2.5, cd + 0.3, 0.6, cd + 0.3, { color: [0.3, 0.3, 0.32] });
    CUR.stacks.push({ x: hw / 2 - 2.5, y: ch + 0.6, z: hz - hd / 2 + 2.5, r: cd / 2 });
  }
  // tanks and silos in the yard
  const yardX = w / 2 - sm / 2 - 1;
  if (L >= 2 && sm > 3.2) {
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const dia = Math.min(sm - 1.2, rng.range(3.5, 6)), th = rng.range(5, 9);
      const tz = hz - hd / 2 + 3 + i * (dia + 1.5);
      if (tz + dia / 2 > frontZ) break;
      P(mass, 'cyl', 'metal_tank', yardX, 0, tz, dia, th, dia, { color: [1.02, 1.04, 1.05] });
      P(mass, 'dome', 'metal_tank', yardX, th, tz, dia, dia * 0.22, dia, { color: [1.12, 1.13, 1.12] });
      P(det, 'cylLow', 'steel', yardX - dia / 2 - 0.4, 0, tz, 0.3, th * 0.9, 0.3, { t: 1 });
      P(det, 'cylLow', 'steel', yardX - dia / 2 - 0.4 - (yardX - dia / 2 - 0.4 - hw / 2) / 2, th * 0.8, tz, 0.3, yardX - dia / 2 - 0.4 - hw / 2, 0.3, { rz: Math.PI / 2 });
    }
  }
  if (L >= 4 && d - hd - 5 > 8) {
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const sx = -hw / 2 + 3 + i * 3.6, sz = frontZ + 9;
      if (sz > d / 2 - 2) break;
      P(mass, 'cyl', 'paint', sx, 0, sz, 3.0, rng.range(11, 15), 3.0, { color: [0.60, 0.59, 0.56] });
      P(mass, 'cone', 'metal_dark', sx, 13, sz, 3.2, 1.6, 3.2, { color: [0.6, 0.6, 0.62] });
    }
  }
  // yard clutter: containers, pallets
  const clutter = rng.int(1, 4);
  for (let i = 0; i < clutter; i++) {
    const cx = rng.range(-w / 2 + 4, w / 2 - 4), cz = rng.range(frontZ + 4, d / 2 - 4);
    if (cz < frontZ + 3.5) continue;
    if (rng.chance(0.6)) P(mass, 'box', 'paint', cx, 0, cz, rng.chance(0.5) ? 6.0 : 12.0, 2.6, 2.4, { color: rng.pick(CONTAINER), ry: rng.chance(0.5) ? 0 : Math.PI / 2 });
    else for (let k = 0; k < 3; k++) P(det, 'box', 'wood', cx + k * 1.3, 0, cz, 1.2, rng.range(0.6, 1.4), 1.2);
  }
  lotPerimeterFence(det, w, d, 2.2, 'chain', GREY, 9);
  const jobs = Math.max(4, Math.round((hw * hd) / (L >= 4 ? 90 : 60) + 6));
  return { height: roofTop, floors: 1 + (L >= 3 ? 1 : 0), residents: 0, jobs, main: { x: 0, z: hz, w: hw, d: hd, h: hallH } };
}

const GENERATORS = { 'res-low': house, 'res-high': apartment, 'com-low': shop, 'com-high': mixed, office, ind: industrial };

/**
 * Build the recipe for a building record on its lot.
 * @param {object} env  { ground(lx, lz) → terrain height relative to the building origin }
 * @returns {{ mass: object[], detail: object[], height:number, floors:number, residents:number, jobs:number, main:object }}
 */
export function generate(b, lot, rng, env) {
  const gen = GENERATORS[b.type] || GENERATORS['res-low'];
  const mass = [], detail = [];
  CUR = { stacks: [], vents: [] };
  GROUND = env && typeof env.ground === 'function' ? env.ground : () => 0;
  const info = gen(b, lot, rng, mass, detail);
  const out = { mass, detail, ...info, stacks: CUR.stacks, vents: CUR.vents };
  CUR = { stacks: [], vents: [] };
  GROUND = () => 0;
  return out;
}

/** Construction-site parts: raw frame growing with progress (static) + scaffolding/crane/fence (dynamic). */
export function constructionMass(recipe, progress) {
  const out = [];
  const p = Math.max(0.05, Math.min(1, progress));
  const RAW = { mat: 'concrete', p1: [3, 0, 0, 3], p2: [3, 0.5, 0.5, 4] };
  for (const part of recipe.mass) {
    if (part.geo === 'plane') { out.push({ ...part, mat: 'dirt', color: [0.9, 0.85, 0.8] }); continue; }
    if (part.geo !== 'box' || !TEX_SCALE[part.mat]) continue;
    const h = Math.max(0.35, part.h * Math.min(1, p * 1.15));
    // slimmer core so the protruding floor plates read as a frame, not a solid block
    out.push({ ...part, ...RAW, color: CONCRETE_RAW, h, w: part.w * 0.94, d: part.d * 0.94 });
    const nf = Math.min(16, Math.floor(h / 3.3));
    for (let k = 1; k <= nf; k++) {
      out.push({ ...part, ...RAW, color: [0.80, 0.79, 0.76], y: (part.y || 0) + k * 3.3 - 0.13, h: 0.26, w: part.w + 0.5, d: part.d + 0.5 });
    }
  }
  return out;
}

export function constructionDetail(b, recipe, progress, rng) {
  const det = [];
  const p = Math.max(0.05, Math.min(1, progress));
  const m = recipe.main;
  const curH = Math.max(0.5, m.h * Math.min(1, p * 1.15));
  // scaffolding around the main volume
  const off = 0.8, sx = m.w / 2 + off, sz = m.d / 2 + off;
  const levels = Math.max(1, Math.floor(curH / 2.0));
  const along = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / 2.5));
    const ry = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      det.push({ geo: 'cylLow', mat: 'steel', x: x0 + (x1 - x0) * t, y: 0, z: z0 + (z1 - z0) * t, w: 0.09, h: curH + 1.6, d: 0.09, t: 1 });
    }
    for (let l = 1; l <= levels; l++) {
      det.push({ geo: 'box', mat: 'steel', x: (x0 + x1) / 2, y: l * 2.0, z: (z0 + z1) / 2, w: len, h: 0.06, d: 0.06, ry, t: 1 });
      if (l % 2 === 0) det.push({ geo: 'box', mat: 'wood', x: (x0 + x1) / 2, y: l * 2.0 + 0.04, z: (z0 + z1) / 2, w: len, h: 0.05, d: 0.9, ry, color: [0.8, 0.7, 0.55], t: 1 });
    }
  };
  along(m.x - sx, m.z - sz, m.x + sx, m.z - sz);
  along(m.x + sx, m.z - sz, m.x + sx, m.z + sz);
  along(m.x + sx, m.z + sz, m.x - sx, m.z + sz);
  along(m.x - sx, m.z + sz, m.x - sx, m.z - sz);
  // safety netting on the top scaffold level
  det.push({ geo: 'box', mat: 'fabric', x: m.x, y: Math.max(0, curH - 1.6), z: m.z, w: m.w + 2 * off + 0.2, h: 1.8, d: 0.05, color: [0.2, 0.55, 0.3], t: 1 });
  // tower crane for anything taller than a house
  if (m.h > 12) {
    const cx = m.x + m.w / 2 + 4.5, cz = m.z - m.d / 2 + 2, mastH = m.h + 14;
    // A tower crane is a LATTICE, not a slab. The old 1.8 m painted box read as an untextured
    // pale-yellow placeholder at the top of the downtown silhouette (critique p4, major #3), so the
    // mast is now four chords + bracing in a desaturated safety yellow, on the painted-steel
    // material (roughness 0.40) rather than a flat colour field.
    const yellow = [0.66, 0.47, 0.10];
    const grey = [0.42, 0.43, 0.44];
    const CH = 0.85;                                   // half the chord spacing
    det.push({ geo: 'box', mat: 'pave_concrete', x: cx, y: 0, z: cz, w: 5, h: 0.6, d: 5, color: [0.46, 0.46, 0.45], t: 1 });
    for (let c = 0; c < 4; c++) {
      const ox = (c & 1 ? 1 : -1) * CH, oz = (c & 2 ? 1 : -1) * CH;
      det.push({ geo: 'box', mat: 'paint', x: cx + ox, y: 0.6, z: cz + oz, w: 0.20, h: mastH - 0.6, d: 0.20, color: yellow, t: 1 });
    }
    const bays = Math.max(3, Math.round((mastH - 0.6) / 2.6));
    for (let i = 1; i <= bays; i++) {
      const by = 0.6 + (i / bays) * (mastH - 0.6);
      det.push({ geo: 'box', mat: 'paint', x: cx, y: by, z: cz - CH, w: CH * 2, h: 0.13, d: 0.13, color: yellow, t: 1 });
      det.push({ geo: 'box', mat: 'paint', x: cx, y: by, z: cz + CH, w: CH * 2, h: 0.13, d: 0.13, color: yellow, t: 1 });
      det.push({ geo: 'box', mat: 'paint', x: cx - CH, y: by, z: cz, w: 0.13, h: 0.13, d: CH * 2, color: yellow, t: 1 });
      det.push({ geo: 'box', mat: 'paint', x: cx + CH, y: by, z: cz, w: 0.13, h: 0.13, d: CH * 2, color: yellow, t: 1 });
      // one diagonal per bay per visible face, alternating direction — reads as bracing at 150 m
      const dz = i % 2 ? 1 : -1;
      det.push({ geo: 'box', mat: 'paint', x: cx, y: by - 1.3, z: cz - CH, w: 2.9, h: 0.11, d: 0.11, rz: dz * 0.63, color: yellow, t: 1 });
      det.push({ geo: 'box', mat: 'paint', x: cx - CH, y: by - 1.3, z: cz, w: 0.11, h: 0.11, d: 2.9, rx: -dz * 0.63, color: yellow, t: 1 });
    }
    const jibLen = Math.max(m.w, m.d) * 0.8 + 14, ry = rng.range(0, Math.PI * 2);
    det.push({ geo: 'box', mat: 'paint', x: cx, y: mastH, z: cz, w: 1.3, h: 1.4, d: 1.3, color: grey, t: 1 });
    // jib: two chords with a tie rod above, so the boom is not a solid bar either
    for (const s of [-1, 1]) {
      det.push({ geo: 'box', mat: 'paint', x: cx - Math.sin(ry) * (jibLen / 2 - 3) + Math.cos(ry) * s * 0.42, y: mastH + 1.2, z: cz - Math.cos(ry) * (jibLen / 2 - 3) - Math.sin(ry) * s * 0.42, w: 0.22, h: 0.22, d: jibLen, ry, color: yellow, t: 1 });
    }
    det.push({ geo: 'box', mat: 'paint', x: cx - Math.sin(ry) * (jibLen / 2 - 3), y: mastH + 2.5, z: cz - Math.cos(ry) * (jibLen / 2 - 3), w: 0.14, h: 0.14, d: jibLen * 0.9, ry, color: yellow, t: 1 });
    det.push({ geo: 'box', mat: 'paint', x: cx + Math.sin(ry) * 5, y: mastH + 1.2, z: cz + Math.cos(ry) * 5, w: 0.9, h: 1.1, d: 8, ry, color: yellow, t: 1 });
    det.push({ geo: 'box', mat: 'metal_dark', x: cx + Math.sin(ry) * 8.5, y: mastH + 0.6, z: cz + Math.cos(ry) * 8.5, w: 2.2, h: 2.4, d: 2.2, ry, color: [0.34, 0.35, 0.36], t: 1 });
    det.push({ geo: 'box', mat: 'glass_dark', x: cx - Math.sin(ry) * 1.2, y: mastH + 1.4, z: cz - Math.cos(ry) * 1.2, w: 1.6, h: 1.8, d: 1.8, ry, color: [0.13, 0.15, 0.17], t: 1 });
    // aviation warning lens on the jib head
    det.push({ geo: 'dome', mat: 'beacon', x: cx, y: mastH + 2.9, z: cz, w: 0.34, h: 0.30, d: 0.34, t: 1 });
    const hookD = rng.range(0.35, 0.8) * jibLen * 0.8;
    const hx = cx - Math.sin(ry) * hookD, hz = cz - Math.cos(ry) * hookD;
    det.push({ geo: 'cylLow', mat: 'metal_dark', x: hx, y: curH + 3, z: hz, w: 0.05, h: mastH - curH - 2, d: 0.05, t: 1 });
    det.push({ geo: 'box', mat: 'metal_dark', x: hx, y: curH + 1.5, z: hz, w: 1.4, h: 1.5, d: 1.4, color: [0.48, 0.48, 0.49], t: 1 });
  }
  // unfinished columns + starter bars above the last pour — the silhouette that says "site"
  const RAW = { mat: 'concrete', color: CONCRETE_RAW, p1: [3, 0, 0, 3], p2: [3, 0.5, 0.5, 4] };
  const nCol = 8;
  for (let i = 0; i < nCol; i++) {
    const a = (i / nCol) * Math.PI * 2;
    const cx2 = m.x + Math.cos(a) * m.w * 0.42, cz2 = m.z + Math.sin(a) * m.d * 0.42;
    det.push({ geo: 'box', ...RAW, x: cx2, y: curH - 0.5, z: cz2, w: 0.6, h: 3.4, d: 0.6, t: 1 });
    det.push({ geo: 'cylLow', mat: 'steel', x: cx2, y: curH + 2.8, z: cz2, w: 0.07, h: 1.2, d: 0.07, t: 1 });
  }
  // site fence, container, materials
  lotPerimeterFence(det, b.w, b.d, 2.0, 'chain', GREY, 8);
  det.push({ geo: 'box', mat: 'paint', x: -b.w / 2 + 2.2, y: 0, z: b.d / 2 - 4.5, w: 2.4, h: 2.6, d: 6.0, ry: Math.PI / 2, color: [0.2, 0.35, 0.6], t: 1 });
  det.push({ geo: 'cone', mat: 'fabric', x: b.w / 2 - 3, y: 0, z: b.d / 2 - 3.5, w: 4.5, h: 1.6, d: 4.5, color: [0.55, 0.45, 0.35], t: 1 });
  for (let k = 0; k < 3; k++) det.push({ geo: 'box', mat: 'wood', x: b.w / 2 - 6 - k * 1.4, y: 0, z: b.d / 2 - 2.8, w: 1.2, h: 0.9 + 0.2 * k, d: 1.2, color: [0.75, 0.68, 0.55] });
  // work lights: the site keeps glowing after dark
  for (let k = 0; k < 3; k++) {
    const t = (k + 0.5) / 3;
    det.push({ geo: 'box', mat: 'lamp', x: m.x - m.w / 2 + t * m.w, y: Math.max(1.5, curH - 0.6), z: m.z + m.d / 2 + off, w: 0.5, h: 0.34, d: 0.28, color: [1, 0.92, 0.74], t: 1 });
  }
  return det;
}
