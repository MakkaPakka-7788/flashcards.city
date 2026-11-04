/**
 * ZoneGrid — the Cities: Skylines style zoning grid derived from the road network.
 *
 * Every zonable road segment owns two *frames* (left / right side). A frame is a strip of oriented
 * cells: `count` columns of `cellSize` metres measured along the sidewalk outer edge, each up to
 * DEPTH (12) cells deep, stepping outwards along the edge normal. Cells are therefore rotated with
 * the road and follow curves as trapezoids (exactly like CS2's grid). Cells that overlap a road
 * footprint (rasterised from `segment.points`), water or a steeper cell of another frame are removed.
 *
 * Painting is stored per *world* cell (`world.toCell` of the oriented cell centre) so the public
 * API works in `{cx, cz}` world cells as the contract demands, and zoning survives road splits.
 * Painted cells of one type are merged into lots of 2×2 … 4×4 cells that always touch the road with
 * their front row; lot ids (and attached buildings) survive repaints while their footprint is unchanged.
 */
import { hash2, hashString, makeRng } from '../../shared/random.js';
import { ZONE_BY_INDEX, zoneIndexOf } from './ZoneTypes.js';

export const DEPTH = 12;
const EDGE_STEP = 2; // metres between road-edge samples
const MIN_AREA_FRAC = 0.42; // drop cells squashed below this fraction of a full cell (inner side of tight curves)
const CONFLICT_DIST = 6.4; // centre distance below which two cells of different frames are considered overlapping
const MAX_SLOPE = 10.5; // metres of height spread across one cell before it counts as a cliff (unzonable)
const NOT_ZONABLE = new Set(['path', 'highway']);

function pointInQuad(c, x, z) {
  let pos = 0, neg = 0;
  for (let e = 0; e < 4; e++) {
    const ax = c[e * 2], az = c[e * 2 + 1];
    const bx = c[((e + 1) % 4) * 2], bz = c[((e + 1) % 4) * 2 + 1];
    const cr = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (cr > 0) pos++; else if (cr < 0) neg++;
  }
  return pos === 0 || neg === 0;
}

export class ZoneGrid {
  constructor(world, events) {
    this.world = world;
    this.events = events;
    this.cell = world.cellSize || 8;
    this.cells = []; // kept oriented cells; cell.id === index
    this.frames = [];
    this.buckets = new Map(); // world-cell key → [cell]
    this.paint = new Map(); // world-cell key → zone index (authoritative paint state)
    this.lots = [];
    this.lotByKey = new Map();
    this._nextLot = 1;
    this.dirty = true;
    this.now = 0;
    this.geometryVersion = 0; // bumps when the cell set changes
    this.lotVersion = 0; // bumps when types / lots change
    this.stats = { cells: 0, blocked: 0, blockedRoad: 0, blockedWater: 0, blockedSlope: 0, conflicts: 0, lots: 0, lotCells: 0, zonedCells: 0, coverage: 1, buildMs: 0, lotMs: 0 };
    this._occ = null;
  }

  key(cx, cz) { return cz * 65536 + cx; }

  /** Rebuild cells if the road network changed since the last build. */
  ensure() { if (this.dirty) this.rebuild(); }

  // ------------------------------------------------------------------ cells
  rebuild() {
    const t0 = performance.now();
    const world = this.world;
    const roads = world.roads;
    const api = roads && roads.api;
    const oldBuckets = this.buckets;
    this.cells = [];
    this.frames = [];
    this.buckets = new Map();
    this.stats.blocked = 0; this.stats.blockedRoad = 0; this.stats.blockedWater = 0; this.stats.blockedSlope = 0;
    this.stats.conflicts = 0;
    if (api && roads.segments && roads.segments.size && typeof api.sampleEdge === 'function') {
      this._rasterise(roads);
      const candidates = [];
      for (const seg of roads.segments.values()) {
        if (NOT_ZONABLE.has(seg.type)) continue;
        for (const side of [-1, 1]) {
          const fr = this._buildFrame(seg, side, api);
          if (!fr) continue;
          this.frames.push(fr);
          for (const c of fr.cells) if (c) candidates.push(c);
        }
      }
      for (const c of candidates) if (this._blocked(c)) { c.blocked = true; this.stats.blocked++; }
      this._resolveConflicts(candidates);
      // A cell only counts as zonable when the whole strip in front of it survived: a cell that
      // cannot reach its own road through its own frame would be zoned land no building could ever
      // face, and it is what turns a blocked junction corner into a hole instead of a clean notch.
      for (const fr of this.frames) {
        for (let i = 0; i < fr.count; i++) {
          // how far the column survives, counted from the kerb outwards
          let run = 0;
          while (run < DEPTH) {
            const c = fr.cells[i * DEPTH + run];
            if (!c || c.blocked || c.dropped) break;
            run++;
          }
          // A single 8 m cell can never hold a lot (2×2 minimum) — the land belongs to whichever road
          // won the corner. Dropping those slivers squares the block off instead of fringing it.
          if (run < 2) run = 0;
          for (let k = 0; k < DEPTH; k++) {
            const j = i * DEPTH + k;
            const c = fr.cells[j];
            if (!c) continue;
            if (k >= run) { fr.cells[j] = null; continue; }
            c.id = this.cells.length;
            this.cells.push(c);
            let b = this.buckets.get(c.key);
            if (!b) this.buckets.set(c.key, (b = []));
            b.push(c);
          }
        }
      }
      this._occ = null;
      // restore paint: exact world cell first, else inherit from a previous painted cell nearby (road splits shift cells)
      const paint = this.paint;
      for (const c of this.cells) {
        let t = paint.get(c.key) || 0;
        if (!t && oldBuckets.size) {
          let bestD = 4.5 * 4.5;
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            const list = oldBuckets.get(this.key(c.cx + dx, c.cz + dz));
            if (!list) continue;
            for (const o of list) {
              if (!o.type) continue;
              const d = (o.x - c.x) ** 2 + (o.z - c.z) ** 2;
              if (d < bestD) { bestD = d; t = o.type; }
            }
          }
        }
        c.type = t;
      }
      paint.clear();
      for (const c of this.cells) if (c.type) paint.set(c.key, c.type);
      this._computeAdjacency();
    } else {
      this.paint.clear();
    }
    this.dirty = false;
    this.geometryVersion++;
    this.stats.cells = this.cells.length;
    this.stats.buildMs = Math.round((performance.now() - t0) * 10) / 10;
    this.rebuildLots();
  }

  _buildFrame(seg, side, api) {
    const world = this.world;
    const CELL = this.cell;
    const L = seg.length;
    if (!(L > 4)) return null;
    const n = Math.max(2, Math.ceil(L / EDGE_STEP) + 1);
    const ex = new Float64Array(n), ez = new Float64Array(n), ey = new Float64Array(n), enx = new Float64Array(n), enz = new Float64Array(n), es = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const e = api.sampleEdge(seg.id, j / (n - 1), side);
      if (!e) return null;
      ex[j] = e.x; ez[j] = e.z; ey[j] = e.y || 0; enx[j] = e.nx; enz[j] = e.nz;
      es[j] = j ? es[j - 1] + Math.hypot(e.x - ex[j - 1], e.z - ez[j - 1]) : 0;
    }
    const Le = es[n - 1];
    const count = Math.floor(Le / CELL + 1e-6);
    if (count < 1) return null;
    const frame = { seg: seg.id, side, count, maxDepth: Math.min(12, 2 + (Math.max(1, Math.min(5, seg.rank || 1)) * 2)), rank: seg.rank || 1, cells: new Array(count * DEPTH).fill(null), s: new Float64Array(count + 1), edgeY: new Float64Array(count + 1), length: Le, width: seg.width, type: seg.type, sign: 1 };
    let cursor = 1;
    const edgeAt = (s, out) => {
      while (cursor < n - 1 && es[cursor] < s) cursor++;
      while (cursor > 1 && es[cursor - 1] > s) cursor--;
      const a = cursor - 1, b = cursor;
      const span = es[b] - es[a];
      const f = span > 1e-9 ? Math.min(1, Math.max(0, (s - es[a]) / span)) : 0;
      out.x = ex[a] + (ex[b] - ex[a]) * f;
      out.z = ez[a] + (ez[b] - ez[a]) * f;
      out.y = ey[a] + (ey[b] - ey[a]) * f;
      let nx = enx[a] + (enx[b] - enx[a]) * f, nz = enz[a] + (enz[b] - enz[a]) * f;
      const l = Math.hypot(nx, nz) || 1;
      out.nx = nx / l; out.nz = nz / l;
    };
    const E0 = { x: 0, y: 0, z: 0, nx: 0, nz: 0 }, E1 = { x: 0, y: 0, z: 0, nx: 0, nz: 0 };
    for (let i = 0; i < count; i++) {
      const s0 = i * CELL, s1 = s0 + CELL;
      frame.s[i] = s0; frame.s[i + 1] = s1;
      edgeAt(s0, E0); edgeAt(s1, E1);
      frame.edgeY[i] = E0.y; frame.edgeY[i + 1] = E1.y;
      for (let k = 0; k < DEPTH; k++) {
        const d0 = k * CELL, d1 = d0 + CELL;
        const x0 = E0.x + E0.nx * d0, z0 = E0.z + E0.nz * d0; // (s0, k)
        const x1 = E1.x + E1.nx * d0, z1 = E1.z + E1.nz * d0; // (s1, k)
        const x2 = E1.x + E1.nx * d1, z2 = E1.z + E1.nz * d1; // (s1, k+1)
        const x3 = E0.x + E0.nx * d1, z3 = E0.z + E0.nz * d1; // (s0, k+1)
        const area = 0.5 * ((x0 * z1 - x1 * z0) + (x1 * z2 - x2 * z1) + (x2 * z3 - x3 * z2) + (x3 * z0 - x0 * z3));
        if (k === 0) frame.sign = area < 0 ? -1 : 1;
        if (area * frame.sign < MIN_AREA_FRAC * CELL * CELL) break; // squashed / flipped on the inner side of a curve
        const cx = (x0 + x1 + x2 + x3) * 0.25, cz = (z0 + z1 + z2 + z3) * 0.25;
        if (!world.inBounds(cx, cz)) break;
        const wc = world.toCell(cx, cz);
        const yaw = Math.atan2(-(E0.nx + E1.nx), -(E0.nz + E1.nz)); // local +Z faces the road
        frame.cells[i * DEPTH + k] = {
          id: -1, seg: seg.id, side, i, k, x: cx, z: cz, cx: wc.cx, cz: wc.cz, key: this.key(wc.cx, wc.cz), yaw,
          corners: [x0, z0, x1, z1, x2, z2, x3, z3], type: 0, lot: -1, edges: 0, zbr: 15, nbr: 0, nb: null, stamp: 0,
          blocked: false, dropped: false, width: seg.width, frame,
        };
      }
    }
    return frame;
  }

  /** Rasterise every road footprint (incl. junction fillets) into a 1 m occupancy grid. */
  _rasterise(roads) {
    const half = this.world.half;
    const N = Math.ceil(half * 2) + 2;
    const occ = new Uint8Array(N * N);
    const stamp = (x, z, r) => {
      const r2 = r * r;
      const gx0 = Math.max(0, Math.floor(x - r + half)), gx1 = Math.min(N - 1, Math.ceil(x + r + half));
      const gz0 = Math.max(0, Math.floor(z - r + half)), gz1 = Math.min(N - 1, Math.ceil(z + r + half));
      for (let gz = gz0; gz <= gz1; gz++) {
        const dz = gz - half - z;
        const row = gz * N;
        for (let gx = gx0; gx <= gx1; gx++) {
          const dx = gx - half - x;
          if (dx * dx + dz * dz <= r2) occ[row + gx] = 1;
        }
      }
    };
    for (const seg of roads.segments.values()) {
      const pts = seg.points;
      if (!pts || pts.length < 2) continue;
      const r = seg.width * 0.5 + 0.6;
      const step = Math.max(0.5, r * 0.5);
      for (let j = 1; j < pts.length; j++) {
        const a = pts[j - 1], b = pts[j];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        const m = Math.max(1, Math.ceil(d / step));
        for (let q = 0; q < m; q++) { const t = q / m; stamp(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, r); }
      }
      const last = pts[pts.length - 1];
      stamp(last.x, last.z, r);
    }
    if (roads.nodes) {
      for (const node of roads.nodes.values()) {
        if (!node.segments || node.segments.length < 3) continue;
        let w = 0;
        for (const id of node.segments) { const s = roads.segments.get(id); if (s) w = Math.max(w, s.width); }
        stamp(node.x, node.z, w * 0.5 + 3.0);
      }
    }
    this._occ = occ; this._occN = N; this._occHalf = half;
  }

  /**
   * A point counts as occupied only when all four surrounding raster samples are inside a footprint,
   * i.e. it lies ≥ ~0.1 m inside a road (the stamp radius carries a +0.6 m margin for the 1 m raster).
   * Points outside a footprint can never be flagged — no false positives from quantisation.
   */
  _occupied(x, z) {
    const fx = x + this._occHalf, fz = z + this._occHalf;
    const gx = Math.floor(fx), gz = Math.floor(fz), N = this._occN;
    if (gx < 0 || gz < 0 || gx + 1 >= N || gz + 1 >= N) return true;
    const o = this._occ, i = gz * N + gx;
    return o[i] === 1 && o[i + 1] === 1 && o[i + N] === 1 && o[i + N + 1] === 1;
  }

  _blocked(c) {
    const terrain = this.world.terrain;
    const st = this.stats;
    if (terrain && terrain.isWater && terrain.isWater(c.x, c.z)) { st.blockedWater++; return true; }
    const q = c.corners;
    if (this._occ) {
      if (this._occupied(c.x, c.z)) { st.blockedRoad++; return true; }
      const S = 0.93;
      for (let e = 0; e < 4; e++) {
        const ax = q[e * 2], az = q[e * 2 + 1];
        const bx = q[((e + 1) % 4) * 2], bz = q[((e + 1) % 4) * 2 + 1];
        if (this._occupied(c.x + (ax - c.x) * S, c.z + (az - c.z) * S)) { st.blockedRoad++; return true; }
        const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
        if (this._occupied(c.x + (mx - c.x) * S, c.z + (mz - c.z) * S)) { st.blockedRoad++; return true; }
      }
    }
    if (terrain && terrain.getHeight) {
      let lo = Infinity, hi = -Infinity;
      for (let e = 0; e < 4; e++) {
        const h = terrain.getHeight(q[e * 2], q[e * 2 + 1]);
        if (h < lo) lo = h; if (h > hi) hi = h;
        if (terrain.isWater && terrain.isWater(q[e * 2], q[e * 2 + 1])) { st.blockedWater++; return true; }
      }
      c.slope = hi - lo;
      if (hi - lo > MAX_SLOPE) { st.blockedSlope++; return true; }
    }
    return false;
  }

  _better(a, b) { // does cell a win over cell b?
    if (a.k !== b.k) return a.k < b.k;
    if (a.width !== b.width) return a.width > b.width;
    if (a.seg !== b.seg) return a.seg < b.seg;
    if (a.side !== b.side) return a.side < b.side;
    return a.i < b.i;
  }

  /**
   * Greedy priority-ordered independent set: shallower / wider-road cells win overlaps at junctions
   * and inner curves. A second-chance pass re-admits cells that lost to a rival which was itself
   * dropped later — without it a block ends up with holes in the middle instead of a clean edge.
   */
  _resolveConflicts(cands) {
    const alive = cands.filter((c) => !c.blocked);
    alive.sort((a, b) => (this._better(a, b) ? -1 : 1));
    const buckets = new Map();
    const R2 = CONFLICT_DIST * CONFLICT_DIST;
    const fits = (c) => {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const list = buckets.get(this.key(c.cx + dx, c.cz + dz));
        if (!list) continue;
        for (const o of list) {
          if (o.frame === c.frame && Math.abs(o.i - c.i) <= 1 && o.k === c.k) continue; // frame neighbours never conflict
          const d2 = (o.x - c.x) ** 2 + (o.z - c.z) ** 2;
          if (d2 < R2 || pointInQuad(o.corners, c.x, c.z) || pointInQuad(c.corners, o.x, o.z)) return false;
        }
      }
      return true;
    };
    const keep = (c) => { let b = buckets.get(c.key); if (!b) buckets.set(c.key, (b = [])); b.push(c); };
    const dropped = [];
    for (const c of alive) {
      if (fits(c)) keep(c);
      else { c.dropped = true; dropped.push(c); }
    }
    for (let pass = 0; pass < 3 && dropped.length; pass++) {
      let again = 0;
      for (const c of dropped) {
        if (!c.dropped || !fits(c)) continue;
        c.dropped = false; keep(c); again++;
      }
      if (!again) break;
    }
    let n = 0;
    for (const c of dropped) if (c.dropped) n++;
    this.stats.conflicts = n;
  }

  /**
   * Neighbour bookkeeping. `c.nb = [-i, +i, k-1, k+1]` and `c.nbr` is the matching bitmask
   * (1, 2, 4, 8). Neighbours inside the same frame are direct index lookups; where a frame ends
   * (or a cell was removed) a probe just outside the shared edge finds a cell of another frame, so
   * strips of parallel roads that meet still read as one continuous grid.
   */
  _computeAdjacency() {
    const CELL = this.cell;
    for (const fr of this.frames) {
      for (let i = 0; i < fr.count; i++) {
        for (let k = 0; k < DEPTH; k++) {
          const c = fr.cells[i * DEPTH + k];
          if (!c) continue;
          const nb = [
            i > 0 ? fr.cells[(i - 1) * DEPTH + k] : null,
            i + 1 < fr.count ? fr.cells[(i + 1) * DEPTH + k] : null,
            k > 0 ? fr.cells[i * DEPTH + k - 1] : null,
            k + 1 < DEPTH ? fr.cells[i * DEPTH + k + 1] : null,
          ];
          const q = c.corners;
          // edge midpoints: [-i] = c0..c3, [+i] = c1..c2, [k-1] = c0..c1, [k+1] = c2..c3
          const mid = [[0, 3], [1, 2], [0, 1], [2, 3]];
          for (let e = 0; e < 4; e++) {
            if (nb[e]) continue;
            if (e === 2 && k === 0) continue; // the road itself is never a neighbour
            const a = mid[e][0], b = mid[e][1];
            const mx = (q[a * 2] + q[b * 2]) * 0.5, mz = (q[a * 2 + 1] + q[b * 2 + 1]) * 0.5;
            let dx = mx - c.x, dz = mz - c.z;
            const l = Math.hypot(dx, dz) || 1;
            const px = mx + (dx / l) * CELL * 0.34, pz = mz + (dz / l) * CELL * 0.34;
            nb[e] = this._cellContaining(px, pz, c);
          }
          c.nb = nb;
          c.nbr = (nb[0] ? 1 : 0) | (nb[1] ? 2 : 0) | (nb[2] ? 4 : 0) | (nb[3] ? 8 : 0);
        }
      }
    }
  }

  /** Kept cell whose quad contains (x, z), ignoring `skip`; null when the grid has a hole there. */
  _cellContaining(x, z, skip) {
    const wc = this.world.toCell(x, z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = this.buckets.get(this.key(wc.cx + dx, wc.cz + dz));
      if (!list) continue;
      for (const c of list) if (c !== skip && pointInQuad(c.corners, x, z)) return c;
    }
    return null;
  }

  /** Per-cell mask of the sides where the zone type changes (or the grid ends) — drives the overlay outline. */
  _computeZoneEdges() {
    for (const c of this.cells) {
      const nb = c.nb;
      let m = 0;
      if (!nb) { c.zbr = 15; continue; }
      for (let e = 0; e < 4; e++) {
        const o = nb[e];
        if (!o || o.type !== c.type) m |= 1 << e;
      }
      c.zbr = m;
    }
  }

  // ------------------------------------------------------------------ queries
  /** Oriented cell under a world point, or null. */
  cellAt(x, z) {
    this.ensure();
    const wc = this.world.toCell(x, z);
    let best = null, bestD = 5.7 * 5.7;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = this.buckets.get(this.key(wc.cx + dx, wc.cz + dz));
      if (!list) continue;
      for (const c of list) {
        if (pointInQuad(c.corners, x, z)) return c;
        const d = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    return best;
  }

  /** Oriented cells whose centre lies inside the axis-aligned world rectangle. */
  cellsInRect(x0, z0, x1, z1) {
    this.ensure();
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    const a = this.world.toCell(x0, z0), b = this.world.toCell(x1, z1);
    const out = [];
    for (let cz = a.cz; cz <= b.cz; cz++) for (let cx = a.cx; cx <= b.cx; cx++) {
      const list = this.buckets.get(this.key(cx, cz));
      if (!list) continue;
      for (const c of list) if (c.x >= x0 && c.x <= x1 && c.z >= z0 && c.z <= z1) out.push(c);
    }
    return out;
  }

  // ------------------------------------------------------------------ painting
  /** Paint world cells. Returns the oriented cells whose type changed. */
  paintCells(list, type) {
    const ti = zoneIndexOf(type);
    if (ti < 0) { console.warn(`[zoning] unknown zone type "${type}"`); return []; }
    this.ensure();
    const changed = [];
    const seen = new Set();
    for (const wc of list) {
      if (!wc) continue;
      const k = this.key(wc.cx | 0, wc.cz | 0);
      if (seen.has(k)) continue;
      seen.add(k);
      const b = this.buckets.get(k);
      if (!b) continue;
      if (ti) this.paint.set(k, ti); else this.paint.delete(k);
      for (const c of b) if (c.type !== ti) { c.type = ti; c.stamp = this.now; changed.push(c); }
    }
    if (changed.length) this.rebuildLots();
    return changed;
  }

  paintRect(x0, z0, x1, z1, type) {
    const cells = this.cellsInRect(x0, z0, x1, z1);
    return this.paintCells(cells.map((c) => ({ cx: c.cx, cz: c.cz })), type);
  }

  clear() {
    const changed = [];
    for (const c of this.cells) if (c.type) { c.type = 0; c.stamp = this.now; changed.push(c); }
    this.paint.clear();
    if (changed.length) this.rebuildLots();
    return changed;
  }

  // ------------------------------------------------------------------ lots
  rebuildLots() {
    const t0 = performance.now();
    const prev = this.lotByKey;
    const lots = [], byKey = new Map();
    for (const c of this.cells) { c.lot = -1; c.edges = 0; }
    for (const fr of this.frames) {
      const n = fr.count;
      if (!n) continue;
      const colDepth = new Uint8Array(n), colType = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const front = fr.cells[i * DEPTH];
        if (!front || !front.type) continue;
        const T = front.type;
        let d = 1;
        while (d < fr.maxDepth) { const c = fr.cells[i * DEPTH + d]; if (!c || c.type !== T) break; d++; }
        colDepth[i] = d; colType[i] = T;
      }
      let i = 0;
      while (i < n) {
        if (colDepth[i] < 2) { i++; continue; }
        const T = colType[i];
        let end = i + 1;
        while (end < n && colType[end] === T && colDepth[end] >= 2) end++;
        const rec = ZONE_BY_INDEX[T];
        const L = end - i;
        // Exact left-to-right packing of this frontage run: a lot is a rectangle, so its depth is the
        // shallowest column it spans. Dynamic programming over the widths 2…4 maximises the number of
        // painted cells that actually become buildable parcels (no zoned cell is stranded unless the
        // geometry makes it impossible), while the seeded width preference keeps the type's character.
        const depthAt = (p, w) => { let dd = fr.maxDepth; for (let j = p; j < p + w; j++) dd = Math.min(dd, colDepth[i + j]); return dd; };
        const wantAt = (p) => {
          const a0 = fr.cells[(i + p) * DEPTH].corners;
          const rng = makeRng(hash2(hashString(`${Math.round(a0[0])},${Math.round(a0[1])},${T}`), this.world.seed | 0));
          return rec.width[0] + Math.floor(rng() * (rec.width[1] - rec.width[0] + 1));
        };
        const best = new Float64Array(L + 1);
        const choice = new Int8Array(L + 1);
        for (let p = L - 1; p >= 0; p--) {
          if (L - p < 2) { best[p] = -1.5; continue; } // a single leftover column can never be a lot
          const want = wantAt(p);
          let bs = -1e9, bw = 0;
          for (let w = 2; w <= Math.min(fr.maxDepth, L - p); w++) {
            const dd = depthAt(p, w);
            let sc = w * dd + best[p + w];
            if (w < rec.width[0] || w > rec.width[1]) sc -= 1.2;
            if (w === want) sc += 0.6;
            if (sc > bs) { bs = sc; bw = w; }
          }
          best[p] = bs; choice[p] = bw;
        }
        for (let p = 0; p < L && choice[p]; ) {
          const w = choice[p];
          const d = Math.max(2, Math.min(depthAt(p, w), fr.maxDepth));
          const lot = this._makeLot(fr, i + p, w, d, T, prev, byKey);
          lot.index = lots.length;
          lots.push(lot);
          byKey.set(lot.key, lot);
          p += w;
        }
        i = end;
      }
    }
    // stable ordering (frames iterate in Map order; segments Map keeps insertion order)
    for (const lot of lots) {
      for (const c of lot._cells) {
        c.lot = lot.index;
        let e = 4; // front (road side) — always a lot boundary
        if (c.i === lot.i0) e |= 1;
        if (c.i === lot.i0 + lot.width - 1) e |= 2;
        if (c.k === lot.depth - 1) e |= 8;
        c.edges = e;
      }
    }
    this.lots = lots;
    this.lotByKey = byKey;
    this._computeZoneEdges();
    this.lotVersion++;
    this.stats.lots = lots.length;
    let lc = 0, zc = 0;
    const uk = [0, 0, 0, 0];
    for (const c of this.cells) {
      if (c.type) { zc++; if (c.lot < 0) uk[Math.min(3, c.k)]++; }
      if (c.lot >= 0) lc++;
    }
    this.stats.unlotByK = uk;
    this.stats.lotCells = lc; this.stats.zonedCells = zc;
    this.stats.coverage = zc ? Math.round((lc / zc) * 1000) / 1000 : 1;
    this.stats.lotMs = Math.round((performance.now() - t0) * 10) / 10;
  }

  _makeLot(fr, i0, w, d, T, prev, byKey) {
    const CELL = this.cell;
    const cellsOut = [], oriented = [];
    const seen = new Set();
    for (let i = i0; i < i0 + w; i++) for (let k = 0; k < d; k++) {
      const c = fr.cells[i * DEPTH + k];
      oriented.push(c);
      if (!seen.has(c.key)) { seen.add(c.key); cellsOut.push({ cx: c.cx, cz: c.cz }); }
    }
    const a = fr.cells[i0 * DEPTH].corners, b = fr.cells[(i0 + w - 1) * DEPTH].corners;
    const ca = fr.cells[i0 * DEPTH + d - 1].corners, cb = fr.cells[(i0 + w - 1) * DEPTH + d - 1].corners;
    const fx0 = a[0], fz0 = a[1], fx1 = b[2], fz1 = b[3]; // frontage corners
    const bx0 = ca[6], bz0 = ca[7], bx1 = cb[4], bz1 = cb[5]; // back corners
    const x = (fx0 + fx1 + bx0 + bx1) * 0.25, z = (fz0 + fz1 + bz0 + bz1) * 0.25;
    const fx = (fx0 + fx1) * 0.5, fz = (fz0 + fz1) * 0.5;
    const bxm = (bx0 + bx1) * 0.5, bzm = (bz0 + bz1) * 0.5;
    let nx = bxm - fx, nz = bzm - fz;
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const yaw = Math.atan2(-nx, -nz); // rotation.y such that local +Z faces the road
    const wM = Math.hypot(fx1 - fx0, fz1 - fz0);
    const dM = nl;
    let key = `${Math.round(fx * 2)}:${Math.round(fz * 2)}:${Math.round(nx * 4)}:${Math.round(nz * 4)}:${w}:${d}:${T}`;
    if (byKey.has(key)) key += ':' + fr.seg + ':' + fr.side;
    const terrain = this.world.terrain;
    const y = terrain && terrain.getHeight ? terrain.getHeight(x, z) : 0;
    const t = fr.length > 0 ? Math.min(1, Math.max(0, (fr.s[i0] + fr.s[i0 + w]) * 0.5 / fr.length)) : 0.5;
    const old = prev.get(key);
    const lot = old || { id: 'lot' + this._nextLot++, buildingId: null };
    lot.key = key;
    lot.cells = cellsOut;
    lot._cells = oriented;
    lot.x = x; lot.y = y; lot.z = z;
    lot.w = Math.round(wM * 100) / 100; lot.d = Math.round(dM * 100) / 100;
    lot.width = w; lot.depth = d; lot.i0 = i0;
    lot.yaw = yaw;
    lot.type = ZONE_BY_INDEX[T].id;
    lot.roadRank = fr.rank;
    lot.roadSegmentId = fr.seg;
    lot.side = fr.side;
    const fy = fr.edgeY ? (fr.edgeY[i0] + fr.edgeY[i0 + w]) * 0.5 : y;
    lot.frontage = { x: fx, y: fy, z: fz, nx, nz, t, length: wM };
    lot.corners = [fx0, fz0, fx1, fz1, bx1, bz1, bx0, bz0];
    lot.cellSize = CELL;
    return lot;
  }

  lotById(id) { for (const l of this.lots) if (l.id === id) return l; return null; }
}
