/**
 * Road type catalogue — Cities: Skylines II style cross-sections.
 *
 * All profile coordinates are metres. `lat` is the signed lateral offset from the road
 * centreline (positive = right of a→b travel, i.e. the side that carries a→b traffic with
 * right-hand driving). Profile heights are relative to the road surface at the centreline.
 *
 * Edge strips are defined as offsets from the carriageway (asphalt) edge and are evaluated with
 * a variable sidewalk width `sw`, so the same profile can be stretched around junction corners.
 * A profile point is `[off, y, alpha?, dark?]`: `y` may be the marker `SURFACE` (sits on the terrain) or
 * `TERRAIN` (buried below the terrain); `alpha` (default 1) is the vertex opacity used by the
 * skirt material so the embankment fades into the ground instead of showing a seam; `dark` (default 0)
 * is baked ambient occlusion (0..1 darkening) for kerb faces and gutters, read by the paved shader.
 *
 * `lamps` describes the street lighting that is part of the road asset (as in CS2): spacing along
 * the road, pole lateral offset from the centreline (0 = median mast), arm length toward the
 * carriageway, mounting height, colour and pool radius. The asphalt/sidewalk shaders paint the
 * light pools analytically from the same numbers, so pools and poles always line up.
 */
export const TERRAIN = 'T';
export const SURFACE = 'S';
/** Road surface sits this far above the terrain. */
export const BED = 0.05;
/** Skirts are buried this far below the terrain. */
export const BURY = 0.45;
/** SURFACE points sit this far above the terrain. */
export const SKIN = 0.035;
/** Verge (alpha-faded skirt) width beyond the sidewalk — only the slope-fill region next to the road.
 * Kept short and dark: a long bright lawn skirt reads as a halo hugging every kerb. */
export const VERGE = 3.0;
/** How far the roadside dirt/gravel band reaches out from the sidewalk edge (baked into the skirt tint). */
export const SHOULDER_DIRT = 1.5;

/** Standard kerb + sidewalk + verge/skirt edge, parametrised by sidewalk width. */
function curbEdge(sw) {
  return [
    // 17 cm kerb: AO-darkened vertical face, 3 cm chamfer that catches the sun, flat top.
    // The face is deliberately much darker than both the gutter and the kerb top so the edge reads as a
    // 3-tone shadow line (dark gutter → black face → bright chamfer/top) at 60 m, not as a painted seam.
    { mat: 'curb', uv: 'along', pts: [[0, 0, 1, 0.82], [0.02, 0.13, 1, 0.62], [0.05, 0.17, 1, 0.0], [0.2, 0.17, 1, 0.0]] },
    { mat: 'sidewalk', uv: 'road', pts: [[0.2, 0.17, 1, 0.12], [0.2 + sw, 0.20]] },
    // the verge is never fully opaque and never wide: the fade starts at the sidewalk edge and is over
    // within 3 m, so no lawn-coloured halo can form against the turf
    { mat: 'skirt', uv: 'road', pts: [[0.2 + sw, 0.20, 0.88], [0.45 + sw, SURFACE, 0.66], [1.1 + sw, SURFACE, 0.34], [1.9 + sw, SURFACE, 0.14], [0.2 + sw + VERGE, TERRAIN, 0]] },
  ];
}
/** Motorway edge: hard shoulder is asphalt (see asphaltPts); then a concrete verge strip, W-beam guard rail and the grass verge. */
function highwayEdge() {
  return [
    { mat: 'verge', uv: 'along', pts: [[0, -0.01], [0.7, 0.03]] },
    { mat: 'skirt', uv: 'road', pts: [[0.7, 0.03, 0.86], [1.1, SURFACE, 0.62], [1.9, SURFACE, 0.30], [2.9, SURFACE, 0.12], [0.7 + VERGE, TERRAIN, 0]] },
    // W-beam with a real 26 cm depth and a flat top flange, so it reads as steel from the air instead of a hairline
    { mat: 'guardrail', uv: 'along', closed: true, cast: true, pts: [[0.30, 0.44], [0.20, 0.53], [0.30, 0.62], [0.20, 0.71], [0.30, 0.80], [0.46, 0.83], [0.46, 0.44], [0.30, 0.44]] },
  ];
}
function pathEdge() {
  return [
    // 10 cm granite kerb edging the setts: a dark AO-tucked reveal, a lit chamfer and a 24 cm top face
    { mat: 'granite', uv: 'along', pts: [[0, -0.01, 1, 0.86], [0.02, 0.06, 1, 0.5], [0.05, 0.10, 1, 0.12], [0.29, 0.098, 1, 0.06], [0.32, 0.05, 1, 0.42]] },
    { mat: 'skirt', uv: 'road', pts: [[0.32, 0.03, 0.86], [0.62, SURFACE, 0.6], [1.25, SURFACE, 0.26], [2.6, TERRAIN, 0]] },
  ];
}

// warm high-pressure-sodium / warm-white LED street lighting (~3000 K), linear RGB
const STREET_LAMP = (cwHalf, radius) => ({ kind: 'street', spacing: 32, alternate: true, poleLat: cwHalf + 0.85, arm: 2.0, height: 9.0, radius, color: [1.0, 0.70, 0.40] });

export const ROAD_TYPES = {
  local: {
    id: 'local', name: 'Two-lane road', width: 12, lanes: 2, speed: 50, laneWidth: 3.8,
    cwHalf: 3.8, medianHalf: 0, sidewalk: 2.0, hasCurb: true, crosswalks: true, stopLines: true, grime: 1.0,
    asphaltMat: 'asphalt_local', rank: 2,
    asphaltPts: [[-3.8, -0.076], [0, 0], [3.8, -0.076]],
    edge: curbEdge,
    centre: [],
    centreGap: { intersection: 0, deadEnd: 0 },
    laneOffsets: [1.9],
    // dashed yellow centre + solid white edge lines 45 cm off the kerb (CS2's NA two-lane theme)
    lines: [{ off: 0, hw: -0.06, on: 3, period: 6 }, { off: 3.35, hw: 0.055, on: 1, period: 1 }],
    arrowLanes: [1.9],
    pedestrianOffsets: [5.0],
    cornerRadius: 3.0,
    shoulderLat: 0,
    lamps: STREET_LAMP(3.8, 11.0),
  },
  avenue: {
    id: 'avenue', name: 'Four-lane avenue with median', width: 24, lanes: 4, speed: 60, laneWidth: 3.75,
    cwHalf: 9.0, medianHalf: 1.5, sidewalk: 2.8, hasCurb: true, crosswalks: true, stopLines: true, grime: 1.0,
    asphaltMat: 'asphalt_avenue', rank: 3,
    asphaltPts: [[-9.0, -0.15], [-1.5, 0], [1.5, 0], [9.0, -0.15]],
    edge: curbEdge,
    // planted median: kerb, an AO-dark inner reveal, then turf sunk 6 cm below the kerb top
    centre: [
      { mat: 'curb', uv: 'along', pts: [[-1.5, 0, 1, 0.62], [-1.47, 0.12, 1, 0.32], [-1.43, 0.17], [-1.26, 0.17], [-1.21, 0.11, 1, 0.72]] },
      { mat: 'median', uv: 'road', pts: [[-1.21, 0.11, 1, 0.55], [-0.92, 0.128, 1, 0.16], [0.92, 0.128, 1, 0.16], [1.21, 0.11, 1, 0.55]] },
      { mat: 'curb', uv: 'along', pts: [[1.21, 0.11, 1, 0.72], [1.26, 0.17], [1.43, 0.17], [1.47, 0.12, 1, 0.32], [1.5, 0, 1, 0.62]] },
    ],
    centreGap: { intersection: 4.6, deadEnd: 0.8 },
    trees: { spacing: 13, jitter: 2.5, minFromEnd: 8, pit: 0.75 },
    laneOffsets: [3.375, 7.125],
    lines: [
      { off: 1.75, hw: -0.06, on: 1, period: 1 },
      { off: 5.25, hw: 0.06, on: 3, period: 9 },
      { off: 8.55, hw: 0.075, on: 1, period: 1 },
    ],
    arrowLanes: [3.375, 7.125],
    pedestrianOffsets: [10.6],
    cornerRadius: 6.0,
    shoulderLat: 0,
    lamps: STREET_LAMP(9.0, 13.0),
  },
  highway: {
    id: 'highway', name: 'Motorway (2×3 lanes)', width: 32, lanes: 6, speed: 110, laneWidth: 3.5,
    // carriageway: 1.6 m median half | 3 × 3.5 m lanes | 2.9 m hard shoulder → asphalt to ±15.4
    cwHalf: 15.4, medianHalf: 1.6, sidewalk: 0.0, hasCurb: false, crosswalks: false, stopLines: false, grime: 0.55,
    verge: 0.7,
    asphaltMat: 'asphalt_highway', rank: 4,
    asphaltPts: [[-15.4, -0.3], [-1.6, 0], [1.6, 0], [15.4, -0.3]],
    edge: highwayEdge,
    // 3.2 m median: kerbs, dark concrete apron and a 1 m Jersey barrier with an AO-darkened base
    centre: [
      { mat: 'curb', uv: 'along', pts: [[-1.6, 0, 1, 0.55], [-1.58, 0.12, 1, 0.3], [-1.55, 0.15], [-1.4, 0.15]] },
      { mat: 'apron', uv: 'road', pts: [[-1.4, 0.15], [-0.42, 0.15]] },
      { mat: 'barrier_base', uv: 'along', cast: true, pts: [[-0.42, 0.15], [-0.42, 0.30], [-0.30, 0.46]] },
      { mat: 'barrier', uv: 'along', cast: true, pts: [[-0.30, 0.46], [-0.12, 1.02], [0.12, 1.02], [0.30, 0.46]] },
      { mat: 'barrier_base', uv: 'along', cast: true, pts: [[0.30, 0.46], [0.42, 0.30], [0.42, 0.15]] },
      { mat: 'apron', uv: 'road', pts: [[0.42, 0.15], [1.4, 0.15]] },
      { mat: 'curb', uv: 'along', pts: [[1.4, 0.15], [1.55, 0.15], [1.58, 0.12, 1, 0.3], [1.6, 0, 1, 0.55]] },
    ],
    centreGap: { intersection: 6.0, deadEnd: 0 },
    posts: { spacing: 4, lateral: 0.36, size: [0.12, 0.78, 0.16] },
    laneOffsets: [3.75, 7.25, 10.75],
    lines: [
      { off: 2.0, hw: -0.075, on: 1, period: 1 },
      { off: 5.5, hw: 0.07, on: 3, period: 12 },
      { off: 9.0, hw: 0.07, on: 3, period: 12 },
      { off: 12.5, hw: 0.1, on: 1, period: 1 },
    ],
    arrowLanes: [],
    pedestrianOffsets: [],
    cornerRadius: 8.0,
    shoulderLat: 12.6,
    lamps: { kind: 'mast', spacing: 46, alternate: false, poleLat: 0, arm: 2.6, height: 14.0, radius: 21, color: [1.0, 0.84, 0.62] },
  },
  path: {
    id: 'path', name: 'Pedestrian path', width: 3, lanes: 0, speed: 5, laneWidth: 1.2,
    cwHalf: 1.2, medianHalf: 0, sidewalk: 0.0, hasCurb: false, crosswalks: false, stopLines: false, grime: 0,
    asphaltMat: 'path', rank: 1,
    asphaltPts: [[-1.2, -0.012], [0, 0.01], [1.2, -0.012]],
    edge: pathEdge,
    centre: [],
    centreGap: { intersection: 0, deadEnd: 0 },
    laneOffsets: [],
    lines: [],
    arrowLanes: [],
    pedestrianOffsets: [0.5],
    cornerRadius: 1.2,
    shoulderLat: 0,
    lamps: null,
  },
};

/** Scale an existing cross-section into a wider urban road while preserving its visual language. */
function scaledUrbanRoad(base, id, name, factor, rank) {
  const t = {
    ...base, id, name, rank,
    width: base.width * factor,
    cwHalf: base.cwHalf * factor,
    medianHalf: base.medianHalf * factor,
    sidewalk: base.sidewalk * Math.min(1.35, factor),
    laneWidth: base.laneWidth * Math.min(1.12, factor),
    cornerRadius: base.cornerRadius * factor,
    asphaltPts: base.asphaltPts.map(([x, y]) => [x * factor, y]),
    centre: base.centre.map((part) => ({ ...part, pts: part.pts.map((p) => [p[0] * factor, ...p.slice(1)]) })),
    lines: base.lines.map((line) => ({ ...line, off: line.off * factor, hw: line.hw * factor })),
    laneOffsets: base.laneOffsets.map((v) => v * factor),
    arrowLanes: base.arrowLanes.map((v) => v * factor),
    pedestrianOffsets: base.pedestrianOffsets.map((v) => v * factor),
    shoulderLat: base.shoulderLat * factor,
    lamps: base.lamps ? { ...base.lamps, poleLat: base.lamps.poleLat * factor, arm: base.lamps.arm * factor, radius: base.lamps.radius * factor } : null,
  };
  return t;
}

// Five buildable road tiers. The existing road profiles are extended rather than replaced,
// so the same asphalt, kerbs, sidewalks, markings and lighting remain consistent.
ROAD_TYPES.street = scaledUrbanRoad(ROAD_TYPES.local, 'street', 'Small street', 0.80, 1);
ROAD_TYPES.local.rank = 2;
ROAD_TYPES.avenue.rank = 3;
ROAD_TYPES.boulevard = scaledUrbanRoad(ROAD_TYPES.avenue, 'boulevard', 'Boulevard', 1.30, 4);
ROAD_TYPES.grand = scaledUrbanRoad(ROAD_TYPES.avenue, 'grand', 'Grand avenue', 1.65, 5);

/** Height of the asphalt surface at lateral offset `lat` relative to the centreline (crown/camber). */
export function surfaceOffset(type, lat) {
  const p = type.asphaltPts;
  if (lat <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (lat <= p[i][0]) {
      const f = (lat - p[i - 1][0]) / (p[i][0] - p[i - 1][0]);
      return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * f;
    }
  }
  return p[p.length - 1][1];
}

/** How far the terrain is cut below the centreline surface in the corridor (keeps it under the cambered edges). */
export function bedDrop(type) {
  return Math.abs(surfaceOffset(type, type.cwHalf)) + BED + 0.05;
}

/** Lateral position of a type's lamp heads (pool centre) — shared by the mesher and the shaders. */
export function lampHeadLat(type) {
  const lm = type.lamps;
  if (!lm) return 0;
  return lm.kind === 'mast' ? 0 : lm.poleLat - lm.arm;
}

/** Public, contract-shaped `types` object ({ local:{ width, lanes, speed }, … }) plus the full definition. */
export function publicTypes() {
  const out = {};
  for (const [k, t] of Object.entries(ROAD_TYPES)) {
    out[k] = { id: t.id, name: t.name, width: t.width, lanes: t.lanes, speed: t.speed, laneWidth: t.laneWidth, sidewalk: t.sidewalk, carriageway: t.cwHalf * 2, definition: t };
  }
  return out;
}
