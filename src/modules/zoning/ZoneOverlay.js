/**
 * ZoneOverlay — the Cities: Skylines II style zoning overlay.
 *
 * One terrain-conforming mesh of every oriented zoning cell, drawn twice (two draw calls, shared
 * geometry, no extra memory):
 *
 *   pass A — FILL, custom blending (dst = dst * (1 + src.rgb)). Outputs a per-pixel *lift*, so the zone
 *            colour brightens and hue-shifts the ground already in the HDR buffer instead of
 *            replacing or darkening it: paving, grass texture, tree shadows, the sun terminator and
 *            the whole night curve read straight through, exactly like CS2's district tint — and a
 *            tinted tile always ends at or above the luma of the surface it covers. Because it happens
 *            pre-tone-mapping the overlay dims with the world at night — no special-cased night hack.
 *   pass B — LINES, source-over. Everything that is UI and must stay readable: cell seams (dark,
 *            hue-tinted, deliberately quiet), parcel borders (mid), zone-type boundaries (strong),
 *            the bright white frontage bar at the kerb, hover (whole lot), brush preview (hard white
 *            outline around the footprint) and the paint-in flash. Value hierarchy: pure white is
 *            reserved for the frontage bar and the interactive cursors.
 *
 * The mesh is an *upper envelope* of the terrain (each vertex takes the max height of a small disc
 * around it, plus a lift) so sub-cell bumps can never punch through the tint.
 *
 * Static geometry (positions, cell index, depth row, neighbour mask, cell axes) only changes when the
 * cell set changes; paint state (type, lot, lot edges, zone edges, paint time) lives in small
 * per-vertex attributes patched in place.
 */
import * as THREE from 'three';
import { ZONE_TYPES } from './ZoneTypes.js';
import { DEPTH } from './ZoneGrid.js';

const SUB = 3; // subdivisions per cell edge → 4×4 vertices, 2.67 m sample spacing
const VPC = (SUB + 1) * (SUB + 1);
const IPC = SUB * SUB * 6;
const LIFT = 0.24; // metres above the terrain envelope
const KERB_LIFT = 0.08; // extra lift right at the kerb, where the road deck sits above the terrain
// (kept small: at a low camera pitch every centimetre of lift throws the front edge further over the
//  sidewalk, which is what made the frontage bar look like it spilled outside the footprint)
const ENV_R = 1.9; // radius of the terrain max-filter, metres

const varyings = /* glsl */ `
varying vec2 vLocal;
varying vec2 vCenter;
varying vec4 vAxis;
varying vec3 vWorld;
varying float vCell;
varying float vK;
varying float vNbr;
varying float vType;
varying float vEdges;
varying float vZbr;
varying float vStamp;
varying float vLot;
`;

const vertexShader = /* glsl */ `
attribute vec2 aLocal;
attribute vec2 aCenter;
attribute vec4 aAxis;
attribute float aCell;
attribute float aK;
attribute float aNbr;
attribute float aType;
attribute float aEdges;
attribute float aZbr;
attribute float aStamp;
attribute float aLot;
${varyings}
void main() {
  vLocal = aLocal; vCenter = aCenter; vAxis = aAxis; vCell = aCell; vK = aK; vNbr = aNbr;
  vType = aType; vEdges = aEdges; vZbr = aZbr; vStamp = aStamp; vLot = aLot;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const prelude = /* glsl */ `
precision highp float;
uniform vec3 uColors[7];
uniform vec3 uTints[7];
uniform float uCell;
uniform float uHover;
uniform float uHoverLot;
uniform float uSelLot;
uniform vec4 uBrush;
uniform float uBrushType;
uniform float uBrushErase;
uniform float uTime;
uniform float uNight;
uniform float uOpacity;
uniform float uFar;
uniform vec3 uCamPos;
${varyings}

bool bit(float mask, float b) { return mod(floor(mask / b + 0.001), 2.0) >= 1.0; }

/**
 * Analytic (box-filtered) coverage of a band |d| < w by one pixel that spans px metres.
 * Unlike a fixed-width smoothstep this never grows the line as the camera pulls back: the line keeps
 * its real width in metres and simply fades towards its area fraction, so a whole district does not
 * dissolve into white lace at 500 m.
 */
float band(float d, float w, float px) { return clamp((w - d) / px + 0.5, 0.0, 1.0); }
/** Coverage of the half-space d > w. */
float inner(float d, float w, float px) { return clamp((d - w) / px + 0.5, 0.0, 1.0); }
bool inBrush(vec2 p) { return p.x > uBrush.x && p.x < uBrush.z && p.y > uBrush.y && p.y < uBrush.w; }
`;

// ---------------------------------------------------------------- pass A: multiply tint
const fillShader = /* glsl */ `
${prelude}
void main() {
  float m = uCell;
  float dl = vLocal.x * m;            // distance to the "along-road minus" edge
  float dr = (1.0 - vLocal.x) * m;    // ... "along-road plus"
  float df = vLocal.y * m;            // ... towards the road
  float db = (1.0 - vLocal.y) * m;    // ... away from the road
  float e = min(min(dl, dr), min(df, db));
  float px = max(fwidth(e), 0.004);   // metres covered by one pixel
  int ti = int(vType + 0.5);
  bool zoned = ti > 0;
  bool road = vK < 0.5;

  // soft edge wherever the zonable grid stops
  float soft = 1.0;
  if (!bit(vNbr, 1.0)) soft = min(soft, smoothstep(0.0, 3.0, dl));
  if (!bit(vNbr, 2.0)) soft = min(soft, smoothstep(0.0, 3.0, dr));
  if (!bit(vNbr, 8.0)) soft = min(soft, smoothstep(0.0, 3.0, db));
  if (!road && !bit(vNbr, 4.0)) soft = min(soft, smoothstep(0.0, 3.0, df));

  // Cell gutters are a close-range read: past ~200 m they close up so a district becomes one solid
  // colour field instead of dissolving into graph paper (CS2 does exactly this as you zoom out).
  float dist = distance(uCamPos, vWorld);
  float lod = 1.0 - smoothstep(160.0, 420.0, dist);
  float tile = inner(e, 0.20 * lod, px);
  // The blend is dst *= (1 + src): a *chromatic lift*, never a darkening. uTints are hue-normalised
  // (max channel 1), so the tinted channels gain the most and the tile always ends at or above the
  // luma of the ground it covers — CS2's district tint, not a cloud shadow over the land.
  vec3 lift = vec3(0.0);
  if (zoned) {
    float k = 0.52 * tile * mix(0.45, 1.0, soft);
    if (vLot < -0.5) k *= 0.62;       // zoned, but too shallow/narrow to ever become a parcel
    lift = uTints[ti] * k;
  } else {
    // the bare zonable grid: a whisper of cool light — its white grid lines come from the line pass
    lift = vec3(0.62, 0.72, 0.92) * (0.10 * tile * mix(0.25, 1.0, soft));
  }

  // brush preview footprint (cells whose centre falls in the tool rectangle)
  if (uBrush.x < uBrush.z && inBrush(vCenter)) {
    vec3 bt = uBrushErase > 0.5 ? vec3(1.0, 0.42, 0.36) : uTints[int(uBrushType + 0.5)];
    lift = mix(lift, bt * (0.16 + 0.38 * tile), 0.88);
  }

  float fade = 1.0 - smoothstep(uFar, uFar * 2.0, dist);
  gl_FragColor = vec4(lift * (fade * uOpacity), 1.0);
}`;

// ---------------------------------------------------------------- pass B: lines / UI
const lineShader = /* glsl */ `
${prelude}
/** source-over compositing of one layer (colour c, coverage w) on top of (col, a). */
void layer(inout vec3 col, inout float a, vec3 c, float w) {
  w = clamp(w, 0.0, 1.0);
  float oa = w + a * (1.0 - w);
  if (oa > 1e-5) col = (c * w + col * a * (1.0 - w)) / oa;
  a = oa;
}

void main() {
  float m = uCell;
  float dl = vLocal.x * m;
  float dr = (1.0 - vLocal.x) * m;
  float df = vLocal.y * m;
  float db = (1.0 - vLocal.y) * m;
  float e = min(min(dl, dr), min(df, db));
  float px = max(fwidth(e), 0.004);
  int ti = int(vType + 0.5);
  bool zoned = ti > 0;
  bool road = vK < 0.5;
  bool lotted = vLot > -0.5;
  vec3 hue = uColors[ti];

  float soft = 1.0;
  if (!bit(vNbr, 1.0)) soft = min(soft, smoothstep(0.0, 3.0, dl));
  if (!bit(vNbr, 2.0)) soft = min(soft, smoothstep(0.0, 3.0, dr));
  if (!bit(vNbr, 8.0)) soft = min(soft, smoothstep(0.0, 3.0, db));
  if (!road && !bit(vNbr, 4.0)) soft = min(soft, smoothstep(0.0, 3.0, df));

  float dist = distance(uCamPos, vWorld);
  float lod = 1.0 - smoothstep(160.0, 420.0, dist);
  float tile = inner(e, 0.20 * lod, px);
  vec3 col = vec3(0.0);
  float a = 0.0;

  // ---- 1. colour presence -----------------------------------------------------------------
  // Only a whisper of hue by day — the multiply pass carries the colour. At night the ground is
  // black and has nothing left to modulate, so this takes over (and the whole block below is then
  // scaled right back down, so the district never glows).
  if (zoned) {
    layer(col, a, hue, (0.03 + 0.16 * uNight) * tile * mix(0.3, 1.0, soft));
  }

  // ---- 2. the grid itself: quiet dark seam + faint rim -------------------------------------
  // Keep the construction grid visible on empty land, but remove internal cell seams
  // from painted zones. Otherwise a continuous district reads as thin, disconnected strips.
  if (!zoned) {
    float seam = band(e, 0.17, px);
    layer(col, a, vec3(0.05, 0.06, 0.07), seam * 0.22 * soft * lod);
  }
  // only the *empty* grid gets a light inner rim — inside a painted zone the colour field must win
  if (!zoned) {
    float rim = band(e, 0.58, px) - band(e, 0.26, px);
    layer(col, a, vec3(0.82, 0.86, 0.90), rim * 0.30 * soft * mix(0.45, 1.0, lod));
  }

  // ---- 3. parcel (lot) borders — mid weight ------------------------------------------------
  float lb = 0.0;
  if (bit(vEdges, 1.0)) lb = max(lb, band(dl, 0.30, px));
  if (bit(vEdges, 2.0)) lb = max(lb, band(dr, 0.30, px));
  if (bit(vEdges, 8.0)) lb = max(lb, band(db, 0.30, px));
  layer(col, a, mix(hue, vec3(1.0), 0.55) * 0.80, lb * 0.34 * mix(0.4, 1.0, soft));

  // ---- 4. zone-type boundary ---------------------------------------------------------------
  if (zoned) {
    // only where the *type* actually changes — at the outer rim of the grid the soft fade and the
    // parcel border already carry the edge, and a hard white line there fights the frontage bar
    float zb = 0.0;
    if (bit(vZbr, 1.0) && bit(vNbr, 1.0)) zb = max(zb, band(dl, 0.46, px));
    if (bit(vZbr, 2.0) && bit(vNbr, 2.0)) zb = max(zb, band(dr, 0.46, px));
    if (bit(vZbr, 8.0) && bit(vNbr, 8.0)) zb = max(zb, band(db, 0.46, px));
    if (!road && bit(vZbr, 4.0) && bit(vNbr, 4.0)) zb = max(zb, band(df, 0.46, px));
    layer(col, a, mix(hue, vec3(1.0), 0.62) * 0.88, zb * 0.55);
  }

  // ---- 5. frontage: the brightest line in a painted block -----------------------------------
  if (road) {
    // No halo: cs2_01 has a hard edge that stops at the tile. A soft exponential glow here spilled
    // ~2.3 m over the sidewalk and turned a district into a web of glowing white grout at range.
    layer(col, a, mix(hue, vec3(1.0), 0.6) * 0.8, exp(-df * 2.2) * (zoned ? 0.07 : 0.02));
    // set a hair inside the kerb so the bar reads as a line drawn on the lot, not as the sidewalk
    float bar = band(abs(df - 0.42), max(0.17, px * 0.55), px);
    layer(col, a, vec3(0.88), bar * (lotted ? 0.90 : (zoned ? 0.50 : 0.30)));
  }

  // The district drawing above follows the world down at night: over a black ground even a faint
  // additive would glow, so tint and lines are scaled together and never outshine a street lamp.
  // Everything below this line is a *cursor* — interactive UI, and only follows half way down.
  col *= mix(1.0, 0.31, uNight);

  // ---- 6. paint-in animation ---------------------------------------------------------------
  if (vStamp > 0.0) {
    float age = clamp((uTime - vStamp) / 0.5, 0.0, 1.0);
    layer(col, a, vec3(0.9), (1.0 - age) * 0.55 * tile);
  }

  // ---- 7. selected lot ---------------------------------------------------------------------
  if (uSelLot >= 0.0 && abs(vLot - uSelLot) < 0.5) {
    float pulse = 0.5 + 0.5 * sin(uTime * 3.6);
    float lr = road ? band(df, 0.34, px) : 0.0;
    if (bit(vEdges, 1.0)) lr = max(lr, band(dl, 0.34, px));
    if (bit(vEdges, 2.0)) lr = max(lr, band(dr, 0.34, px));
    if (bit(vEdges, 8.0)) lr = max(lr, band(db, 0.34, px));
    layer(col, a, vec3(0.95, 0.82, 0.34), (0.14 + 0.08 * pulse) * tile);
    layer(col, a, vec3(0.98, 0.86, 0.46), lr * (0.78 + 0.14 * pulse));
  }

  // ---- 8. brush preview: hard white outline around the whole footprint -----------------------
  if (uBrush.x < uBrush.z && inBrush(vCenter)) {
    vec2 au = vAxis.xy * uCell, av = vAxis.zw * uCell;
    float o = 0.0;
    if (!inBrush(vCenter - au)) o = max(o, band(dl, 0.8, px));
    if (!inBrush(vCenter + au)) o = max(o, band(dr, 0.8, px));
    if (road || !inBrush(vCenter - av)) o = max(o, band(df, 0.8, px));
    if (!inBrush(vCenter + av)) o = max(o, band(db, 0.8, px));
    float pulse = 0.5 + 0.5 * sin(uTime * 3.4);
    vec3 bc = uBrushErase > 0.5 ? vec3(1.0, 0.30, 0.24) : uColors[int(uBrushType + 0.5)];
    layer(col, a, mix(bc, vec3(1.0), 0.25) * 0.9, (0.20 + 0.05 * pulse) * tile);
    layer(col, a, mix(vec3(0.95), bc * 1.2, uBrushErase * 0.8) * (0.94 + 0.05 * pulse), o * 1.0);
  }

  // ---- 9. pointer hover: the whole LOT lights up, as in CS2 ----------------------------------
  bool hovLot = uHoverLot >= 0.0 && abs(vLot - uHoverLot) < 0.5;
  bool hovCell = abs(vCell - uHover) < 0.5;
  if (hovLot || hovCell) {
    float pulse = 0.5 + 0.5 * sin(uTime * 3.0);
    float hr;
    if (hovLot) {
      hr = road ? band(df, 0.6, px) : 0.0;
      if (bit(vEdges, 1.0)) hr = max(hr, band(dl, 0.6, px));
      if (bit(vEdges, 2.0)) hr = max(hr, band(dr, 0.6, px));
      if (bit(vEdges, 8.0)) hr = max(hr, band(db, 0.6, px));
    } else {
      hr = band(e, 0.5, px);
    }
    layer(col, a, mix(hue, vec3(1.0), 0.6) * 1.0, (hovCell ? 0.34 : 0.26) * tile);
    layer(col, a, vec3(0.90 + 0.02 * pulse), hr * 0.96);
  }

  col *= mix(1.0, 0.35, uNight);   // → district ×0.11, cursors ×0.35 at midnight
  a *= 1.0 - smoothstep(uFar, uFar * 2.0, dist);
  if (!zoned) a *= 1.0 - smoothstep(uFar * 0.45, uFar * 0.9, dist);

  gl_FragColor = vec4(col, a * uOpacity);
  if (gl_FragColor.a < 0.004) discard;
}`;

/** Linear hue → multiply factor: partially normalised so bright zones tint without darkening the
 *  ground to mud, while dark zones (res-high, com-high) still read as visibly deeper. */
function tintOf(c) {
  const mx = Math.max(c.r, c.g, c.b, 1e-3);
  const k = 1 / Math.pow(mx, 0.6);
  return new THREE.Color(Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k));
}

export class ZoneOverlay {
  constructor(ctx, grid) {
    this.ctx = ctx;
    this.grid = grid;
    const { engine, scene } = ctx;
    const colors = [new THREE.Color('#dfe8ee'), ...ZONE_TYPES.map((t) => new THREE.Color(t.color))];
    const tints = colors.map(tintOf);
    this.uniforms = {
      uColors: { value: colors },
      uTints: { value: tints },
      uCell: { value: grid.cell },
      uHover: { value: -1 },
      uHoverLot: { value: -1 },
      uSelLot: { value: -1 },
      uBrush: { value: new THREE.Vector4(1, 1, 0, 0) },
      uBrushType: { value: 0 },
      uBrushErase: { value: 0 },
      uTime: { value: 0 },
      uNight: { value: 0 },
      uOpacity: { value: 1 },
      uFar: { value: 1300 },
      uCamPos: { value: new THREE.Vector3() },
    };
    const base = {
      uniforms: this.uniforms,
      vertexShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      toneMapped: false,
      fog: false,
      lights: false,
    };
    // explicit dst = dst * (1 + src.rgb) (alpha untouched) — the zone colour LIFTS the ground beneath
    // it toward the zone hue. A pure multiply could only darken, so every district read as a cloud
    // shadow and the dark-blue high-density blocks read as ponds.
    this.fillMaterial = new THREE.ShaderMaterial({
      ...base,
      fragmentShader: fillShader,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.fillMaterial.name = 'zoning-overlay-fill';
    this.fillMaterial.customProgramCacheKey = () => 'zoning-overlay-fill-v4';
    this.material = new THREE.ShaderMaterial({ ...base, fragmentShader: lineShader, blending: THREE.NormalBlending });
    this.material.name = 'zoning-overlay-lines';
    this.material.customProgramCacheKey = () => 'zoning-overlay-lines-v4';
    engine.registerMaterial(this.fillMaterial); // unlit → bookkeeping only, kept for the contract
    engine.registerMaterial(this.material);

    this.geometry = new THREE.BufferGeometry();
    this.group = new THREE.Group();
    this.group.name = 'zoning-overlay';
    this.group.visible = false;
    this.meshes = [];
    for (const [i, mat] of [this.fillMaterial, this.material].entries()) {
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.name = i ? 'zoning-overlay-lines' : 'zoning-overlay-fill';
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 40 + i;
      mesh.layers.set(engine.LAYER_NO_AO); // never in the GTAO pre-pass, shadows or water reflections
      mesh.matrixAutoUpdate = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.mesh = this.meshes[1];
    scene.add(this.group);
    this._geomVersion = -1;
    this._lotVersion = -1;
    this.cellCount = 0;
  }

  get visible() { return this.group.visible; }
  set visible(v) { this.group.visible = !!v; }

  /** Rebuild the static geometry from the grid's kept cells. */
  rebuildGeometry() {
    const grid = this.grid;
    const cells = grid.cells;
    const n = cells.length;
    const terrain = this.ctx.world.terrain;
    const h = terrain && terrain.getHeight ? (x, z) => terrain.getHeight(x, z) : () => 0;
    const nv = n * VPC;
    const pos = new Float32Array(nv * 3);
    const local = new Float32Array(nv * 2);
    const center = new Float32Array(nv * 2);
    const axis = new Float32Array(nv * 4);
    const cellIdx = new Float32Array(nv);
    const krow = new Float32Array(nv);
    const nbr = new Float32Array(nv);
    const type = new Float32Array(nv);
    const edges = new Float32Array(nv);
    const zbr = new Float32Array(nv);
    const stamp = new Float32Array(nv);
    const lot = new Float32Array(nv);
    const index = nv > 65535 ? new Uint32Array(n * IPC) : new Uint16Array(n * IPC);
    for (let ci = 0; ci < n; ci++) {
      const c = cells[ci];
      const q = c.corners;
      const vb = ci * VPC;
      // cell axes: u along the road (front edge), v away from it
      let ux = q[2] - q[0], uz = q[3] - q[1];
      let ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
      let vx = q[6] - q[0], vz = q[7] - q[1];
      let vl = Math.hypot(vx, vz) || 1; vx /= vl; vz /= vl;
      for (let vj = 0; vj <= SUB; vj++) {
        const v = vj / SUB;
        for (let uj = 0; uj <= SUB; uj++) {
          const u = uj / SUB;
          // bilinear over corners c0 (s0,k) c1 (s1,k) c2 (s1,k+1) c3 (s0,k+1)
          const fx = q[0] + (q[2] - q[0]) * u, fz = q[1] + (q[3] - q[1]) * u;
          const bx = q[6] + (q[4] - q[6]) * u, bz = q[7] + (q[5] - q[7]) * u;
          const x = fx + (bx - fx) * v, z = fz + (bz - fz) * v;
          // upper envelope of the terrain: no sub-cell bump can poke through the tint
          let y = h(x, z);
          y = Math.max(y, h(x + ux * ENV_R, z + uz * ENV_R), h(x - ux * ENV_R, z - uz * ENV_R));
          y = Math.max(y, h(x + vx * ENV_R, z + vz * ENV_R), h(x - vx * ENV_R, z - vz * ENV_R));
          const lift = LIFT + KERB_LIFT * (1 - Math.min(1, ((c.k + v) * grid.cell) / 3.0));
          const vi = vb + vj * (SUB + 1) + uj;
          pos[vi * 3] = x; pos[vi * 3 + 1] = y + lift; pos[vi * 3 + 2] = z;
          local[vi * 2] = u; local[vi * 2 + 1] = v;
          center[vi * 2] = c.x; center[vi * 2 + 1] = c.z;
          axis[vi * 4] = ux; axis[vi * 4 + 1] = uz; axis[vi * 4 + 2] = vx; axis[vi * 4 + 3] = vz;
          cellIdx[vi] = ci;
          krow[vi] = c.k;
          nbr[vi] = c.nbr;
          type[vi] = c.type;
          edges[vi] = c.edges;
          zbr[vi] = c.zbr;
          stamp[vi] = c.stamp;
          lot[vi] = c.lot;
        }
      }
      let ib = ci * IPC;
      for (let vj = 0; vj < SUB; vj++) for (let uj = 0; uj < SUB; uj++) {
        const a = vb + vj * (SUB + 1) + uj, b = a + 1, cc = a + SUB + 1, d = cc + 1;
        index[ib++] = a; index[ib++] = cc; index[ib++] = b;
        index[ib++] = b; index[ib++] = cc; index[ib++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aLocal', new THREE.BufferAttribute(local, 2));
    g.setAttribute('aCenter', new THREE.BufferAttribute(center, 2));
    g.setAttribute('aAxis', new THREE.BufferAttribute(axis, 4));
    g.setAttribute('aCell', new THREE.BufferAttribute(cellIdx, 1));
    g.setAttribute('aK', new THREE.BufferAttribute(krow, 1));
    g.setAttribute('aNbr', new THREE.BufferAttribute(nbr, 1));
    g.setAttribute('aType', new THREE.BufferAttribute(type, 1));
    g.setAttribute('aEdges', new THREE.BufferAttribute(edges, 1));
    g.setAttribute('aZbr', new THREE.BufferAttribute(zbr, 1));
    g.setAttribute('aStamp', new THREE.BufferAttribute(stamp, 1));
    g.setAttribute('aLot', new THREE.BufferAttribute(lot, 1));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
    const old = this.geometry;
    this.geometry = g;
    for (const mesh of this.meshes) mesh.geometry = g;
    if (old) old.dispose();
    this.cellCount = n;
    this._geomVersion = grid.geometryVersion;
    this._lotVersion = grid.lotVersion;
  }

  /** Patch paint / lot attributes for the given cells (or all cells when omitted). */
  updatePaint(changed) {
    if (this._geomVersion !== this.grid.geometryVersion) { this.rebuildGeometry(); return; }
    const g = this.geometry;
    const type = g.getAttribute('aType');
    if (!type) return;
    const edges = g.getAttribute('aEdges'), zbr = g.getAttribute('aZbr');
    const stamp = g.getAttribute('aStamp'), lot = g.getAttribute('aLot');
    const cells = changed || this.grid.cells;
    for (const c of cells) {
      const vb = c.id * VPC;
      for (let v = 0; v < VPC; v++) {
        type.array[vb + v] = c.type;
        edges.array[vb + v] = c.edges;
        zbr.array[vb + v] = c.zbr;
        stamp.array[vb + v] = c.stamp;
        lot.array[vb + v] = c.lot;
      }
    }
    type.needsUpdate = true; edges.needsUpdate = true; zbr.needsUpdate = true;
    stamp.needsUpdate = true; lot.needsUpdate = true;
    this._lotVersion = this.grid.lotVersion;
  }

  /** Per-frame sync: geometry / lot versions, uniforms. */
  update(elapsed, camera, nightFactor) {
    const grid = this.grid;
    if (this._geomVersion !== grid.geometryVersion) this.rebuildGeometry();
    else if (this._lotVersion !== grid.lotVersion) this.updatePaint(null);
    const u = this.uniforms;
    u.uTime.value = elapsed;
    u.uNight.value = nightFactor || 0;
    u.uCell.value = grid.cell;
    if (camera) u.uCamPos.value.copy(camera.position);
  }

  setHover(cellIndex) {
    const i = cellIndex == null ? -1 : cellIndex;
    this.uniforms.uHover.value = i;
    const c = i >= 0 ? this.grid.cells[i] : null;
    this.uniforms.uHoverLot.value = c && c.lot >= 0 ? c.lot : -1;
  }
  setSelectedLot(lotIndex) { this.uniforms.uSelLot.value = lotIndex == null ? -1 : lotIndex; }
  setBrush(rect, typeIndex, erase) {
    const v = this.uniforms.uBrush.value;
    if (!rect) { v.set(1, 1, 0, 0); return; }
    v.set(Math.min(rect.x0, rect.x1), Math.min(rect.z0, rect.z1), Math.max(rect.x0, rect.x1), Math.max(rect.z0, rect.z1));
    this.uniforms.uBrushType.value = typeIndex > 0 ? typeIndex : 0;
    this.uniforms.uBrushErase.value = erase ? 1 : 0;
  }
  setOpacity(v) { this.uniforms.uOpacity.value = Math.max(0, Math.min(1, v)); }

  dispose() {
    this.ctx.scene.remove(this.group);
    this.geometry.dispose();
    this.fillMaterial.dispose();
    this.material.dispose();
  }
}

export { DEPTH };
