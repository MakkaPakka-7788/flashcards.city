/**
 * buildings module — procedural zoned buildings + growth.
 *
 *   world.buildings = { version, list, api }
 *   api.spawn(lot, { level, seed, state, progress })   → building record (emits building:added)
 *   api.remove(id)                                      (emits building:removed)
 *   api.fastForward(gameSeconds)                        grow instantly according to world.economy.demand
 *   + extras: get, at(x,z), levelUp, setLevel, setLots (fallback lots when no zoning module), refresh,
 *     setInfoView, stats, internals
 *
 * Records: { id, lotId, type, level, x, y, z, yaw, w, d, height, floors, residents, jobs, state, progress,
 *            seed, age, stacks:[{x,y,z,r}], vents:[{x,y,z}] }   (stacks / vents in world coordinates — effects)
 * Events out: building:added, building:removed, building:levelup, building:completed.
 * Events in:  zones:changed (lots removed / rezoned → buildings removed), entity:selected, infoview:changed.
 *
 * Rendering: renderer.js pools (InstancedMesh per geometry × material). Building masses are persistent
 * static instances; rooftop / street detail is streamed for the buildings around the camera target
 * (two LOD rings). Growth advances with the game clock (world.time.elapsedGameSeconds).
 */
import * as THREE from 'three';
import { makeRng, hash2, hashString } from '../../shared/random.js';
import { createMaterials } from './materials.js';
import { makeGeometries } from './geometry.js';
import { BuildingRenderer } from './renderer.js';
import { generate, constructionMass, constructionDetail } from './generators.js';
import { generateLots, defaultTypeFor } from './lots.js';
import { FACADE_UNIFORMS } from './facadeShader.js';

export const name = 'buildings';

const DAY = 86400;
const DEMAND_KEY = { 'res-low': 'residential', 'res-high': 'residential', 'com-low': 'commercial', 'com-high': 'commercial', ind: 'industrial', office: 'office' };
const ZONE_COLORS = { 'res-low': '#8fd95a', 'res-high': '#2ea86f', 'com-low': '#62c6ff', 'com-high': '#2b6fdc', ind: '#f1b634', office: '#b57cf0' };
/**
 * Growth pacing. The clock runs at `world.time.secondsPerHour` = 20 real seconds per game hour at
 * speed 1, so ONE GAME HOUR IS TWENTY REAL SECONDS — the only unit that matters for whether a
 * first-time player sees anything. Everything below is therefore expressed in game HOURS, not days:
 * a house has to go empty lot → scaffolding → finished inside a couple of game hours or the visitor
 * who opened a link closes the tab before the first roof goes on.
 *
 * Construction time in game hours per type (× level factor). Kept strictly above 1 h so a single
 * bulk growth step (see LIVE_STEP / BULK_STEP) can never take a lot from empty to finished — that
 * is what leaves live scaffolding standing at the end of the demo city's final fast-forward.
 */
const BUILD_HOURS = { 'res-low': 1.1, 'res-high': 2.2, 'com-low': 1.5, 'com-high': 3.0, office: 3.0, ind: 1.9 };
/** Mean time (game hours) an empty lot waits for a builder at demand 1. */
const MEAN_FILL_HOURS = 10;
/**
 * A brand-new city has no neighbours to attract anyone, so the steady-state wait above would leave
 * the first player staring at empty grass. While the city is young the arrival rate is aimed at the
 * CITY, not at each lot: about STARTER_RATE builders per game hour turn up whether the player
 * painted four lots or forty, so the opening beat does not depend on how big a marquee they dragged.
 * It is a multiplier ON the demand-driven probability, never a replacement for it — at zero demand
 * a boosted lot is still a boosted zero — and it fades to 1 by the time the city has
 * STARTER_BUILDINGS buildings of its own.
 */
const STARTER_RATE = 3.5;
const STARTER_BUILDINGS = 8;
/** Growth granularity in game seconds: fine while the player watches, coarse when fast-forwarding. */
const LIVE_STEP = 240;
const BULK_STEP = 3600;
/** Game seconds between level-up rolls (the roll's odds are scaled so the per-day rate is unchanged). */
const LEVELUP_PERIOD = 6 * 3600;
/** How old (game seconds) a finished building must be before it can level up. */
const MATURE_AGE = 14 * 3600;
const CONSTRUCTION_STEPS = 8;
const TYPES = ['res-low', 'res-high', 'com-low', 'com-high', 'office', 'ind'];

let ctxRef = null;
let renderer = null;
let mats = null;
let rng = null;
let baseSeed = 0;
let nextId = 1;
const entries = new Map(); // id → { b, lot, recipe, refs, detail, detailStep }
const byLot = new Map(); // lotId → entry
const grid = new Map(); // spatial hash "cx:cz" (64 m) → entries
const GRID = 64;
let fallbackLots = null; // lots supplied by api.setLots when no zoning module exists
let offs = [];
let lastGameT = null;
let growthAcc = 0;
let dayAcc = 0;
let reconcileAcc = 0;
let lastZoneVersion = -1;
let detailDirty = true;
let bulk = false;
let infoView = null;
let infoOnBuildings = true;
let selectedId = null;
let growthRate = 1;
let constructionSpeed = 1;
const lastCam = new THREE.Vector3(Infinity, Infinity, Infinity);
const _v = new THREE.Vector3();
const _c = new THREE.Color();
let stats = { spawned: 0, completed: 0, levelUps: 0, removed: 0, detailInstances: 0, detailBuildings: 0 };

// ------------------------------------------------------------------------------------------------
// helpers

function gridKey(x, z) { return Math.floor(x / GRID) + ':' + Math.floor(z / GRID); }
function gridAdd(e) {
  const k = gridKey(e.b.x, e.b.z);
  let arr = grid.get(k);
  if (!arr) grid.set(k, (arr = []));
  arr.push(e);
  e.gridKey = k;
}
function gridRemove(e) {
  const arr = grid.get(e.gridKey);
  if (!arr) return;
  const i = arr.indexOf(e);
  if (i >= 0) arr.splice(i, 1);
  if (!arr.length) grid.delete(e.gridKey);
}

function terrainHeight(x, z) {
  const t = ctxRef.world.terrain;
  return t && typeof t.getHeight === 'function' ? t.getHeight(x, z) : 0;
}

function lotCorners(lot) {
  const c = Math.cos(lot.yaw), s = Math.sin(lot.yaw);
  const hw = lot.w / 2, hd = lot.d / 2;
  const out = [];
  for (const [lx, lz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
    out.push({ x: lot.x + lx * c + lz * s, z: lot.z - lx * s + lz * c });
  }
  return out;
}

/** Deterministic per-building noise in [0,1). */
function jitter(b, salt) { return makeRng(hash2(b.seed | 0, salt))(); }

function buildSeconds(type, level) { return (BUILD_HOURS[type] || 1.6) * (1 + 0.18 * (level - 1)) * 3600; }

function demandFor(type) {
  const eco = ctxRef.world.economy;
  const d = eco && eco.demand ? eco.demand[DEMAND_KEY[type]] : null;
  const v = Number.isFinite(d) ? d : 0.5;
  // Floor, not a timer: with the demand meter on the floor a lot still fills eventually
  // (100 game hours) so a temporary economic dip cannot freeze the city for good, but that
  // is 12× slower than the same lot at full demand. Growth follows the demand bars.
  return Math.max(0.10, Math.min(1.25, v * 1.5));
}

function currentLots() {
  const zones = ctxRef.world.zones;
  if (zones && zones.api && typeof zones.api.lotsFor === 'function') {
    try { return zones.api.lotsFor(); } catch (err) { /* zoning mid-rebuild */ }
    return zones.lots || [];
  }
  if (zones && Array.isArray(zones.lots) && zones.lots.length) return zones.lots;
  return fallbackLots || [];
}

// ------------------------------------------------------------------------------------------------
// mounting (static tier) + record bookkeeping

function toWorld(b, p) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return { x: b.x + p.x * c + p.z * s, y: b.y + p.y, z: b.z - p.x * s + p.z * c, r: p.r };
}

function staticParts(e) {
  const b = e.b;
  const parts = b.state === 'construction' ? constructionMass(e.recipe, b.progress) : e.recipe.mass;
  if (e.plinth) return parts.concat([e.plinth]);
  return parts;
}

function mount(e) {
  e.refs = [];
  for (const part of staticParts(e)) e.refs.push(renderer.addStatic(e.b, part));
  if (infoView && infoOnBuildings) applyTint(e);
}
function unmount(e) {
  for (const r of e.refs) renderer.removeStatic(r);
  e.refs = [];
}
function remount(e) { unmount(e); mount(e); e.detail = null; detailDirty = true; }

/** Terrain sampler in a building's local frame, clamped so a bad sample can never launch geometry. */
function groundFor(b) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return (lx, lz) => {
    const wx = b.x + lx * c + lz * s, wz = b.z - lx * s + lz * c;
    const h = terrainHeight(wx, wz);
    if (!Number.isFinite(h)) return 0;
    return Math.max(-3.5, Math.min(1.2, h - b.y));
  };
}

function applyRecipe(e) {
  const b = e.b;
  const r = generate(b, e.lot, makeRng(hash2(b.seed | 0, b.level)), { ground: groundFor(b) });
  e.recipe = r;
  b.height = Math.round(r.height * 100) / 100;
  b.floors = r.floors;
  b.residents = r.residents;
  b.jobs = r.jobs;
  b.stacks = r.stacks.map((s) => toWorld(b, s));
  b.vents = r.vents.map((v) => toWorld(b, v));
  b.chimneys = b.stacks; // alias consumed by effects
}

function detailParts(e) {
  const b = e.b;
  if (b.state !== 'construction') return e.recipe.detail;
  const step = Math.floor(b.progress * CONSTRUCTION_STEPS);
  if (!e.detail || e.detailStep !== step) {
    e.detail = constructionDetail(b, e.recipe, b.progress, makeRng(hash2(b.seed | 0, 991)));
    e.detailStep = step;
  }
  return e.detail;
}

function flattenLot(lot, y) {
  const t = ctxRef.world.terrain;
  if (!t || !t.api || typeof t.api.flattenRect !== 'function') return false;
  // only near-axis lots: the flatten rect is axis aligned and must not reach into the road bed
  const s2 = Math.abs(Math.sin(2 * lot.yaw));
  if (s2 > 0.25) return false;
  const c = lotCorners(lot);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of c) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  // pull the frontage edge back so the blend stays on the lot
  const fx = Math.sin(lot.yaw), fz = Math.cos(lot.yaw); // local +z (towards the road) in world
  const inset = 3.2;
  if (Math.abs(fx) > Math.abs(fz)) { if (fx > 0) x1 -= inset; else x0 += inset; } else { if (fz > 0) z1 -= inset; else z0 += inset; }
  x0 += 0.6; x1 -= 0.6; z0 += 0.6; z1 -= 0.6;
  if (x1 - x0 < 4 || z1 - z0 < 4) return false;
  try { t.api.flattenRect(x0, z0, x1, z1, y, 3); return true; } catch (err) { return false; }
}

/** Ground level for a lot: road-edge height, footprint spread and (if needed) a concrete plinth part. */
function siteLevel(lot) {
  const corners = lotCorners(lot);
  let minY = Infinity, maxY = -Infinity;
  for (const p of corners) { const h = terrainHeight(p.x, p.z); minY = Math.min(minY, h); maxY = Math.max(maxY, h); }
  const hc = terrainHeight(lot.x, lot.z);
  minY = Math.min(minY, hc); maxY = Math.max(maxY, hc);
  let fy = lot.frontage && lot.frontage.y != null ? lot.frontage.y : lot.frontage ? terrainHeight(lot.frontage.x, lot.frontage.z) : hc;
  const roads = ctxRef.world.roads && ctxRef.world.roads.api;
  if (roads && lot.frontage && typeof roads.surfaceHeight === 'function') {
    // sidewalk level right in front of the lot
    const sx = lot.frontage.x - lot.frontage.nx * 1.0, sz = lot.frontage.z - lot.frontage.nz * 1.0;
    const sh = roads.surfaceHeight(sx, sz);
    if (sh != null && Number.isFinite(sh)) fy = sh;
  }
  const wl = ctxRef.world.terrain && ctxRef.world.terrain.waterLevel != null ? ctxRef.world.terrain.waterLevel : -Infinity;
  let y = Math.max(fy, (minY + maxY) * 0.5 - 0.2, wl + 0.7);
  y = Math.round(y * 100) / 100;
  let plinth = null;
  if (maxY - minY > 0.14 || y - minY > 0.14) {
    const flattened = flattenLot(lot, y);
    const depth = Math.max(0.5, y - minY + 0.6);
    if (!flattened || y - minY > 0.9) {
      plinth = { geo: 'box', mat: 'concrete', x: 0, y: -depth, z: 0, w: lot.w - 0.5, h: depth + 0.02, d: lot.d - 0.5, p1: [3, 0, 0, 3], p2: [3, 0.5, 0.5, 4], color: [0.66, 0.66, 0.64] };
    }
  }
  return { y, plinth };
}

function emit(ev, b) { ctxRef.events.emit(ev, b); }
function bump() { ctxRef.world.buildings.version++; }

// ------------------------------------------------------------------------------------------------
// public operations

function spawn(lot, opts = {}) {
  if (!lot || !Number.isFinite(lot.x) || !Number.isFinite(lot.z) || !lot.w || !lot.d) return null;
  const existing = byLot.get(lot.id);
  if (existing) return existing.b;
  if (lot.buildingId != null && entries.has(lot.buildingId)) return entries.get(lot.buildingId).b;
  const type = TYPES.includes(lot.type) ? lot.type : 'res-low';
  const id = nextId++;
  const seed = Number.isFinite(opts.seed) ? opts.seed | 0 : hash2(baseSeed, id);
  const roadLevelCap = Math.min(5, Math.max(2, (lot.roadRank || 1) + 1));
  const level = Math.max(1, Math.min(roadLevelCap, Math.round(opts.level || 1)));
  const site = siteLevel(lot);
  const state = opts.state === 'construction' || (opts.state == null && opts.built !== true) ? 'construction' : 'built';
  const progress = state === 'built' ? 1 : Math.max(0, Math.min(0.999, opts.progress || 0));
  const b = {
    id, lotId: lot.id, type, level, x: lot.x, y: site.y, z: lot.z, yaw: lot.yaw || 0, w: lot.w, d: lot.d,
    height: 0, floors: 0, residents: 0, jobs: 0, state, progress, seed, age: 0, builtAt: null,
    roadSegmentId: lot.roadSegmentId != null ? lot.roadSegmentId : null, stacks: [], vents: [],
  };
  const e = { b, lot, recipe: null, refs: [], detail: null, detailStep: -1, plinth: site.plinth, duration: buildSeconds(type, level) };
  applyRecipe(e);
  entries.set(id, e);
  byLot.set(lot.id, e);
  lot.buildingId = id;
  ctxRef.world.buildings.list.push(b);
  gridAdd(e);
  mount(e);
  detailDirty = true;
  stats.spawned++;
  bump();
  emit('building:added', b);
  return b;
}

function remove(id) {
  const e = entries.get(id);
  if (!e) return false;
  unmount(e);
  entries.delete(id);
  if (byLot.get(e.b.lotId) === e) byLot.delete(e.b.lotId);
  if (e.lot && e.lot.buildingId === id) e.lot.buildingId = null;
  gridRemove(e);
  const list = ctxRef.world.buildings.list;
  const i = list.indexOf(e.b);
  if (i >= 0) list.splice(i, 1);
  if (selectedId === id) { selectedId = null; renderer.setSelection(null); }
  e.b.state = 'removed';
  detailDirty = true;
  stats.removed++;
  bump();
  emit('building:removed', e.b);
  return true;
}

function setLevel(id, level) {
  const e = entries.get(id);
  if (!e) return null;
  const roadLevelCap = Math.min(5, Math.max(2, ((e.lot && e.lot.roadRank) || 1) + 1));
  level = Math.max(1, Math.min(roadLevelCap, Math.round(level)));
  if (level === e.b.level) return e.b;
  const up = level > e.b.level;
  e.b.level = level;
  applyRecipe(e);
  remount(e);
  bump();
  if (up) { stats.levelUps++; emit('building:levelup', e.b); }
  return e.b;
}

function complete(e) {
  const b = e.b;
  b.state = 'built';
  b.progress = 1;
  b.builtAt = ctxRef.world.time ? ctxRef.world.time.totalDays || 0 : 0;
  remount(e);
  stats.completed++;
  bump();
  emit('building:completed', b);
}

/** Drop buildings whose lot vanished / changed type or size; re-link lot objects after a zoning rebuild. */
function reconcile(lots) {
  if (!entries.size) return;
  const map = new Map();
  for (const l of lots) map.set(l.id, l);
  const dead = [];
  for (const e of entries.values()) {
    const lot = map.get(e.b.lotId);
    if (!lot) { dead.push(e.b.id); continue; }
    if (lot.type !== e.b.type || Math.abs(lot.w - e.b.w) > 0.6 || Math.abs(lot.d - e.b.d) > 0.6 || Math.hypot(lot.x - e.b.x, lot.z - e.b.z) > 0.8) { dead.push(e.b.id); continue; }
    if (e.lot !== lot) { e.lot = lot; byLot.set(lot.id, e); }
    lot.buildingId = e.b.id;
  }
  for (const id of dead) remove(id);
}

/**
 * How much faster than steady state the next lot fills, given how small the city still is and how
 * few lots are competing for the same first builder. 1 once the city stands on its own feet — this
 * is an opening grace, not a permanent speed-up.
 */
function starterBoost(emptyLots) {
  const n = entries.size;
  if (n >= STARTER_BUILDINGS) return 1;
  const raw = Math.max(1, (STARTER_RATE * MEAN_FILL_HOURS) / Math.max(1, emptyLots));
  return 1 + (raw - 1) * (1 - n / STARTER_BUILDINGS);
}

/** One growth step of `dt` game seconds. */
function growthStep(dt) {
  const hours = dt / 3600;
  const lots = currentLots();
  // Live growth steps run ~15× more often than the old hourly one, and reconcile() is O(lots).
  // zones:changed already reconciles on edit; this is only the safety net for a silent mutation.
  const zv = ctxRef.world.zones ? ctxRef.world.zones.version : 0;
  reconcileAcc += dt;
  if (zv !== lastZoneVersion || reconcileAcc >= 3600) { lastZoneVersion = zv; reconcileAcc = 0; reconcile(lots); }
  const eco = ctxRef.world.economy || {};
  const landValue = Number.isFinite(eco.landValue) ? eco.landValue : 0.4;
  const happiness = Number.isFinite(eco.happiness) ? eco.happiness : 0.6;
  // new buildings on empty lots
  const boost = starterBoost(lots.length - entries.size);
  for (const lot of lots) {
    if (lot.buildingId != null || byLot.has(lot.id)) continue;
    if (!TYPES.includes(lot.type)) continue;
    const p = (hours / MEAN_FILL_HOURS) * demandFor(lot.type) * growthRate * boost;
    if (rng() >= p) continue;
    const t = ctxRef.world.terrain;
    if (t && typeof t.isWater === 'function' && t.isWater(lot.x, lot.z)) continue;
    let level = 1;
    if (rng() < landValue * 0.9) level++;
    if (rng() < landValue * 0.35) level++;
    spawn(lot, { level });
  }
  // construction progress and ageing
  for (const e of entries.values()) {
    const b = e.b;
    b.age += dt;
    if (b.state === 'construction') {
      const before = Math.floor(b.progress * CONSTRUCTION_STEPS);
      b.progress = Math.min(1, b.progress + (dt * constructionSpeed) / e.duration);
      if (b.progress >= 1) complete(e);
      else if (Math.floor(b.progress * CONSTRUCTION_STEPS) !== before) remount(e);
    }
  }
  // level-ups: mature buildings in happy, valuable neighbourhoods. Rolled every LEVELUP_PERIOD
  // (6 game hours = 2 real minutes at speed 1) rather than once per game day, with the odds scaled
  // by the same fraction — the per-day rate is unchanged, a player just does not have to sit
  // through eight real minutes to see the first one.
  dayAcc += dt;
  if (dayAcc >= LEVELUP_PERIOD) {
    const periods = Math.floor(dayAcc / LEVELUP_PERIOD);
    dayAcc -= periods * LEVELUP_PERIOD;
    const days = (periods * LEVELUP_PERIOD) / DAY;
    const chance = 0.06 * days * (0.35 + 0.65 * happiness) * (0.4 + 0.6 * landValue);
    for (const e of entries.values()) {
      const b = e.b;
      if (b.state !== 'built' || b.level >= 5 || b.age < MATURE_AGE) continue;
      const q = chance / (1 + 0.8 * (b.level - 1));
      if (rng() < q) setLevel(b.id, b.level + 1);
    }
  }
}

function advance(gameSeconds) {
  growthAcc += gameSeconds;
  // Live: 4 game minutes per step (1.3 real seconds at speed 1) so scaffolding creeps up smoothly
  // and the first builder can turn up seconds after the zone is painted, instead of the whole city
  // lurching once every 20 real seconds. Bulk (fastForward) keeps the cheap hourly step.
  const step = bulk ? BULK_STEP : LIVE_STEP;
  let guard = bulk ? 24 * 365 : 400;
  while (growthAcc >= step && guard-- > 0) { growthStep(step); growthAcc -= step; }
  if (guard <= 0) growthAcc = 0; // a monstrous dt (backgrounded tab) must not stall the next frames
}

function fastForward(gameSeconds) {
  if (!Number.isFinite(gameSeconds) || gameSeconds <= 0) return;
  bulk = true;
  try { advance(Math.min(gameSeconds, 400 * DAY)); } finally { bulk = false; }
  refreshDetail(true);
  // Warm up the programs for every pool that a whole city just created, so the first frames the
  // player (or a screenshot) sees are not one long shader-compile stall.
  try { ctxRef.renderer.compile(ctxRef.scene, ctxRef.camera); } catch (err) { /* non-fatal */ }
}

// ------------------------------------------------------------------------------------------------
// detail streaming (LOD)

function lodCentre(out) {
  const cc = ctxRef.cameraController;
  if (cc && cc.target) return out.copy(cc.target);
  return out.copy(ctxRef.camera.position);
}

function refreshDetail(force) {
  if (!renderer) return;
  const centre = lodCentre(_v);
  const moveEps = Math.max(6, ctxRef.camera.position.distanceTo(centre) * 0.05);
  if (!force && !detailDirty && centre.distanceToSquared(lastCam) < moveEps * moveEps) return;
  lastCam.copy(centre);
  detailDirty = false;
  const q = ctxRef.engine.quality || {};
  const density = Number.isFinite(q.density) ? q.density : 1;
  const camDist = ctxRef.camera.position.distanceTo(centre);
  // detail shrinks as the camera pulls back — at hero altitude it is sub-pixel anyway, and the
  // rebuild cost is what used to spike the frame time.
  const zoom = Math.max(0.30, Math.min(1, 190 / Math.max(camDist, 1)));
  const rFull = 130 * (0.7 + 0.3 * density) * zoom;
  const rBig = 250 * (0.6 + 0.4 * density) * zoom;
  const budget = Math.round(22000 * (0.5 + 0.5 * density));
  const r2f = rFull * rFull, r2b = rBig * rBig;
  const near = [];
  const cx0 = Math.floor((centre.x - rBig) / GRID), cx1 = Math.floor((centre.x + rBig) / GRID);
  const cz0 = Math.floor((centre.z - rBig) / GRID), cz1 = Math.floor((centre.z + rBig) / GRID);
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
    const arr = grid.get(cx + ':' + cz);
    if (!arr) continue;
    for (const e of arr) {
      const dx = e.b.x - centre.x, dz = e.b.z - centre.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= r2b) near.push({ e, d2 });
    }
  }
  near.sort((a, b) => a.d2 - b.d2);
  renderer.beginDynamic();
  let n = 0, nb = 0;
  for (const { e, d2 } of near) {
    const parts = detailParts(e);
    const full = d2 <= r2f || e.b.state === 'construction';
    nb++;
    for (const p of parts) {
      if (!full && (p.t != null ? p.t < 1 : Math.max(p.w, p.h, p.d) < 2.2)) continue;
      renderer.pushDynamic(e.b, p);
      n++;
    }
    if (n > budget) break;
  }
  renderer.endDynamic();
  stats.detailInstances = n;
  stats.detailBuildings = nb;
}

// ------------------------------------------------------------------------------------------------
// info views + selection

function gradient(v, out) {
  v = Math.max(0, Math.min(1, v));
  if (v < 0.5) return out.setRGB(0.85, 0.2 + 1.1 * v, 0.15).convertSRGBToLinear();
  return out.setRGB(0.95 - 1.4 * (v - 0.5), 0.75 + 0.1 * (v - 0.5), 0.2 + 0.3 * (v - 0.5)).convertSRGBToLinear();
}

function infoValue(b) {
  const w = ctxRef.world, eco = w.economy || {};
  const j = jitter(b, 17) - 0.5;
  switch (infoView) {
    case 'zoning': return null;
    case 'happiness': return (Number.isFinite(b.happiness) ? b.happiness : Number.isFinite(eco.happiness) ? eco.happiness : 0.6) + j * 0.2;
    case 'landvalue': {
      const base = Number.isFinite(b.landValue) ? b.landValue : Number.isFinite(eco.landValue) ? eco.landValue : 0.4;
      const bonus = b.type === 'office' || b.type === 'com-high' ? 0.15 : b.type === 'ind' ? -0.2 : 0;
      return base + bonus + (b.level - 1) * 0.05 + j * 0.15;
    }
    case 'pollution': {
      const p = b.type === 'ind' ? 0.85 : b.type.startsWith('com') ? 0.35 : b.type === 'office' ? 0.2 : 0.1;
      return 1 - Math.min(1, p + Math.max(0, Number.isFinite(eco.pollution) ? eco.pollution - 0.3 : 0) + j * 0.1);
    }
    default: {
      const svc = w.services && w.services.api;
      if (svc && typeof svc.coverageAt === 'function') {
        try { const c = svc.coverageAt(b.x, b.z, infoView); if (Number.isFinite(c)) return c; } catch (err) { /* view not a service */ }
      }
      return null;
    }
  }
}

function applyTint(e) {
  const b = e.b;
  let col = null;
  if (infoView === 'zoning') {
    const zt = ctxRef.world.zones && ctxRef.world.zones.api && ctxRef.world.zones.api.types;
    const rec = Array.isArray(zt) ? zt.find((t) => t.id === b.type) : null;
    col = _c.set((rec && rec.color) || ZONE_COLORS[b.type] || '#ffffff').convertSRGBToLinear();
  } else {
    const v = infoValue(b);
    if (v != null) col = gradient(v, _c);
  }
  if (!col) { for (const r of e.refs) r.pool.setTint(r, 1, 1, 1); return; }
  for (const r of e.refs) r.pool.setTint(r, col.r, col.g, col.b);
}

function refreshInfo() {
  const on = !!(infoView && infoOnBuildings && infoView !== 'traffic');
  FACADE_UNIFORMS.uInfo.value = on ? 1 : 0;
  if (!on) return;
  for (const e of entries.values()) applyTint(e);
}

function setInfoView(view, onBuildings = true) {
  infoView = view || null;
  infoOnBuildings = onBuildings !== false;
  refreshInfo();
}

function buildingAt(x, z) {
  const k0x = Math.floor(x / GRID), k0z = Math.floor(z / GRID);
  for (let cx = k0x - 1; cx <= k0x + 1; cx++) for (let cz = k0z - 1; cz <= k0z + 1; cz++) {
    const arr = grid.get(cx + ':' + cz);
    if (!arr) continue;
    for (const e of arr) {
      const b = e.b;
      const dx = x - b.x, dz = z - b.z;
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= b.w / 2 && Math.abs(lz) <= b.d / 2) return b;
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// module interface

export async function init(ctx) {
  ctxRef = ctx;
  const { engine, scene, world, events, config } = ctx;
  baseSeed = hash2(config.seed | 0, hashString('buildings'));
  rng = world.rng.fork(hashString('buildings-growth'));
  FACADE_UNIFORMS.uSunDir.value = new THREE.Vector3(-0.4, -0.85, -0.35).normalize();
  FACADE_UNIFORMS.uSunStrength.value = 1;
  // analytic sky dome for the glazing specular + the warm ground bounce (see updateSkyProbe)
  FACADE_UNIFORMS.uSkyUp.value = new THREE.Vector3(0.65, 0.93, 1.75);
  FACADE_UNIFORMS.uSkyHz.value = new THREE.Vector3(0.62, 0.66, 0.74);
  FACADE_UNIFORMS.uSkyDn.value = new THREE.Vector3(0.42, 0.42, 0.44);
  FACADE_UNIFORMS.uGndBounce.value = new THREE.Vector3(0.03, 0.026, 0.022);
  const created = await createMaterials(ctx);
  mats = created.mats;
  renderer = new BuildingRenderer({ scene, geometries: makeGeometries(), mats, layerReflected: engine.LAYER_REFLECTED, layerNoAo: engine.LAYER_NO_AO });

  world.buildings.version = world.buildings.version || 0;
  world.buildings.list = world.buildings.list || [];
  world.buildings.list.length = 0;
  const api = {
    types: TYPES,
    spawn,
    remove,
    fastForward,
    get: (id) => (entries.has(id) ? entries.get(id).b : null),
    at: buildingAt,
    levelUp: (id) => { const e = entries.get(id); return e ? setLevel(id, e.b.level + 1) : null; },
    setLevel,
    /** Fallback lots for a world without a zoning module (showcase / tests). */
    setLots: (lots) => { fallbackLots = Array.isArray(lots) ? lots : null; detailDirty = true; },
    /** Generate fallback lots from the road network (no zoning module). */
    autoZone: (opts = {}) => {
      const lots = generateLots(world, { rng: world.rng.fork(hashString('buildings-autozone')), typeFor: opts.typeFor || defaultTypeFor(world, config.seed), existing: fallbackLots || [], idStart: (fallbackLots ? fallbackLots.length : 0) + 1 });
      fallbackLots = (fallbackLots || []).concat(lots);
      return lots;
    },
    refresh: () => { detailDirty = true; refreshDetail(true); },
    setInfoView,
    setGrowthRate: (m) => { growthRate = Math.max(0, m); },
    setConstructionSpeed: (m) => { constructionSpeed = Math.max(0, m); },
    /** Live counts for HUD / critics. */
    stats: () => {
      const byType = {}, byState = { construction: 0, built: 0 };
      let residents = 0, jobs = 0;
      for (const e of entries.values()) {
        const b = e.b;
        byType[b.type] = (byType[b.type] || 0) + 1;
        byState[b.state] = (byState[b.state] || 0) + 1;
        if (b.state === 'built') { residents += b.residents; jobs += b.jobs; }
      }
      let pools = 0, instances = 0;
      for (const p of renderer.pools.values()) { pools++; instances += p.count; }
      return { buildings: entries.size, byType, ...byState, residents, jobs, pools, instances, ...stats, version: world.buildings.version };
    },
    internals: () => ({ entries, renderer, mats, grid, fallbackLots }),
  };
  world.buildings.api = api;

  offs.push(events.on('zones:changed', () => { detailDirty = true; reconcile(currentLots()); }));
  offs.push(events.on('entity:selected', (p) => {
    const id = p && p.kind === 'building' ? p.id : null;
    selectedId = id;
    renderer.setSelection(id != null && entries.has(id) ? entries.get(id).b : null);
  }));
  offs.push(events.on('infoview:changed', (p) => setInfoView(p && p.view ? p.view : null, !p || p.buildings !== false)));
  offs.push(events.on('terrain:ready', () => {
    // terrain (re)built after us: re-seat every building on the new ground
    for (const e of entries.values()) {
      const site = siteLevel(e.lot);
      if (Math.abs(site.y - e.b.y) > 0.05 || !!site.plinth !== !!e.plinth) { e.b.y = site.y; e.plinth = site.plinth; applyRecipe(e); remount(e); }
    }
  }));
  if (config.debug) console.log('[buildings] ready', Object.keys(mats).length, 'materials');
}

/**
 * Radiances for the glazing's analytic sky dome (facadeShader SKY_PARS_GLSL).
 *
 * `world.env.skyColor` is a hemisphere-light COLOUR (an irradiance-ish quantity); the sky's actual
 * radiance — what a mirror pointed at it returns — is ~2.7x that, which is the constant below. The
 * downward lobe is what a vertical pane sees from any camera above street level, so it is floored at
 * ~52 % of the sky's luminance: that is the "8-15 % of sky luminance" specular floor the material
 * target asks for once the fresnel ramp (0.115 at normal incidence) is applied on top.
 */
const SKY_RADIANCE = 2.70;
const _sv = new THREE.Vector3();
/** Pull a radiance `k` of the way towards neutral, keeping its luminance. */
function desaturate(v, k) {
  const y = 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
  v.set(v.x + (y - v.x) * k, v.y + (y - v.y) * k, v.z + (y - v.z) * k);
}
function updateSkyProbe(env, night) {
  const U = FACADE_UNIFORMS;
  if (!env || !U.uSkyUp.value) return;
  const sky = env.skyColor, hz = env.horizonColor, gnd = env.groundColor;
  if (!sky) return;
  // Night: the dome dims, and its chromaticity is pulled a quarter of the way to neutral. A pure
  // hemisphere-blue reflection on every unlit pane turns a downtown into one saturated blue block.
  const dim = SKY_RADIANCE * (1 - 0.34 * night);
  U.uSkyUp.value.set(sky.r, sky.g, sky.b).multiplyScalar(dim);
  desaturate(U.uSkyUp.value, 0.17 + 0.20 * night);
  const skyY = 0.2126 * U.uSkyUp.value.x + 0.7152 * U.uSkyUp.value.y + 0.0722 * U.uSkyUp.value.z;
  // horizon: the fog/haze band, warmed by the low sun and never darker than 45 % of the zenith
  if (hz) U.uSkyHz.value.set(hz.r, hz.g, hz.b).multiplyScalar(dim * 1.15);
  else U.uSkyHz.value.copy(U.uSkyUp.value).multiplyScalar(0.7);
  const hzY = Math.max(1e-4, 0.2126 * U.uSkyHz.value.x + 0.7152 * U.uSkyHz.value.y + 0.0722 * U.uSkyHz.value.z);
  if (hzY < skyY * 0.45) U.uSkyHz.value.multiplyScalar((skyY * 0.45) / hzY);
  // downward lobe: ground + the city's own bounce. Warm, and floored well above black — a pane that
  // reflects the street must not go to zero, which is exactly what the sky-only PMREM probe did.
  if (gnd) _sv.set(gnd.r, gnd.g, gnd.b); else _sv.set(0.09, 0.08, 0.07);
  _sv.multiplyScalar(4.2 * (1 - 0.30 * night));
  const gY = Math.max(1e-4, 0.2126 * _sv.x + 0.7152 * _sv.y + 0.0722 * _sv.z);
  const floorY = skyY * 0.62;
  if (gY < floorY) _sv.multiplyScalar(floorY / gY);
  desaturate(_sv, 0.30);
  U.uSkyDn.value.copy(_sv);
  // warm bounce added to facade indirect diffuse, so a shadowed wall keeps its own hue
  const b = 0.42 * (1 - 0.65 * night);
  U.uGndBounce.value.set(_sv.x * 0.052 * b, _sv.y * 0.046 * b, _sv.z * 0.038 * b);
}

export function update(dt) {
  if (!ctxRef || !renderer) return;
  const world = ctxRef.world;
  // night lights + sign glow
  const night = world.env && Number.isFinite(world.env.nightFactor) ? world.env.nightFactor : 0;
  FACADE_UNIFORMS.uNight.value = night;
  FACADE_UNIFORMS.uTime.value = ctxRef.engine.elapsed || 0;
  // real sun vector drives the shadow the window reveal casts onto its own glass
  const sd = world.env && world.env.sunDirection;
  if (sd && FACADE_UNIFORMS.uSunDir.value) FACADE_UNIFORMS.uSunDir.value.copy(sd);
  FACADE_UNIFORMS.uSunStrength.value = Math.max(0, 1 - night * 1.35);
  updateSkyProbe(world.env, night);
  if (mats.sign) mats.sign.emissiveIntensity = 0.03 + 0.85 * night;
  if (mats.lamp) mats.lamp.emissiveIntensity = 0.02 + 2.4 * night;
  if (mats.beacon) {
    // slow aviation-warning blink, in phase across the city. The daytime floor is high enough that
    // the lens reads as a lit lamp rather than a red cube (critique p4, major #3).
    const t = ctxRef.engine.elapsed || 0;
    mats.beacon.emissiveIntensity = (1.15 + 4.2 * night) * (0.34 + 0.66 * Math.pow(Math.max(0, Math.sin(t * 1.6)), 6));
  }
  // game clock → growth
  const t = world.time || {};
  let gameDt;
  if (Number.isFinite(t.elapsedGameSeconds)) {
    if (lastGameT == null) lastGameT = t.elapsedGameSeconds;
    gameDt = t.elapsedGameSeconds - lastGameT;
    lastGameT = t.elapsedGameSeconds;
  } else {
    const mult = t.paused ? 0 : [0, 1, 2, 4][t.speed | 0] || 1;
    gameDt = dt * mult * (3600 / (t.secondsPerHour || 20));
  }
  if (gameDt > 0) advance(Math.min(gameDt, 120 * DAY));
  refreshDetail(false);
}

export function dispose() {
  for (const off of offs) if (typeof off === 'function') off();
  offs = [];
  if (renderer) renderer.dispose();
  renderer = null;
  entries.clear(); byLot.clear(); grid.clear();
  if (ctxRef) { ctxRef.world.buildings.list.length = 0; ctxRef.world.buildings.api = null; }
  ctxRef = null;
  lastGameT = null;
}
