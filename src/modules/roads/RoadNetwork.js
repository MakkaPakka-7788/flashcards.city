/**
 * Road network graph: nodes + segments, snapping, splitting at crossings, terrain-following height
 * profiles, spatial queries and the lane graph for traffic. Pure data — no rendering here.
 *
 * Every mutation goes through build()/remove(), which:
 *   1. changes topology, 2. re-solves the affected junctions (trims, corner fillets, markings),
 *   3. refreshes lanes of touched segments, 4. bumps world.roads.version and emits `roads:changed`.
 * Dirty sets are consumed by the renderer (RoadRenderer.flush) so only affected geometry is rebuilt.
 */
import * as THREE from 'three';
import { ROAD_TYPES, BED, surfaceOffset, bedDrop } from './RoadTypes.js';
import { makeCurvePieces, anchorIndices, segSegIntersect, closestOnPolyline, headingOf, wrapPi } from './curves.js';
import { computeJunction } from './Junctions.js';
import { hash2, hashString, makeRng } from '../../shared/random.js';

const SAMPLE_DS = 2; // metres between dense centreline samples (also the height profile resolution)
const SMOOTH_HALF = 18; // metres: half-width of the triangular height-smoothing kernel
const LANE_DS = 4; // metres between lane centreline points
const POINT_DS = 3; // metres between contract `points`
const MAX_PAD_GRADE = 0.06; // junction pads follow the main road grade up to 6 %

class SpatialGrid {
  constructor(cell = 64) {
    this.cell = cell;
    this.cells = new Map();
    this.boxes = new Map();
  }
  _keys(b) {
    const c = this.cell;
    const x0 = Math.floor(b.minX / c), x1 = Math.floor(b.maxX / c), z0 = Math.floor(b.minZ / c), z1 = Math.floor(b.maxZ / c);
    const keys = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) keys.push(x + ',' + z);
    return keys;
  }
  insert(id, box) {
    this.remove(id);
    this.boxes.set(id, box);
    for (const k of this._keys(box)) {
      let s = this.cells.get(k);
      if (!s) { s = new Set(); this.cells.set(k, s); }
      s.add(id);
    }
  }
  remove(id) {
    const box = this.boxes.get(id);
    if (!box) return;
    for (const k of this._keys(box)) {
      const s = this.cells.get(k);
      if (s) { s.delete(id); if (s.size === 0) this.cells.delete(k); }
    }
    this.boxes.delete(id);
  }
  query(box, out = new Set()) {
    for (const k of this._keys(box)) {
      const s = this.cells.get(k);
      if (s) for (const id of s) out.add(id);
    }
    return out;
  }
}

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();

export class RoadNetwork {
  constructor(world, events) {
    this.world = world;
    this.events = events;
    this.types = ROAD_TYPES;
    this.nodes = world.roads.nodes;
    this.segments = world.roads.segments;
    this._nextNode = 1;
    this._nextSeg = 1;
    this.grid = new SpatialGrid(64);
    // dirty tracking consumed by the renderer
    this.dirtySegments = new Set();
    this.dirtyNodes = new Set();
    this.removedSegments = new Set();
    this.removedNodes = new Set();
    this._touchedNodes = new Set();
    this._batchAdded = [];
    this._batchRemoved = [];
    this._laneGraphCache = null;
    this.flattenCalls = 0;
    // info-texture slots (1..4095) for shader tinting; 0 = untinted
    this._nextSlot = 1;
    this._freeSlots = [];
  }

  // ------------------------------------------------------------------ terrain / heights
  /** Road bed height at (x,z): terrain + BED, but never below a causeway level above water. */
  terrainY(x, z) {
    return Math.max(this.world.terrain.getHeight(x, z), this.minGround()) + BED;
  }
  minGround() {
    const wl = this.world.terrain.waterLevel;
    return Number.isFinite(wl) ? wl + 0.75 : -Infinity;
  }
  /** Road surface height at the centreline, `s` metres from node a. */
  heightAt(seg, s) {
    const h = seg.heights;
    if (!h || h.length < 2) return seg.y0 || 0;
    const f = Math.min(Math.max(s, 0), seg.length) / seg.heightStep;
    const i = Math.min(Math.floor(f), h.length - 2);
    const r = f - i;
    return h[i] * (1 - r) + h[i + 1] * r;
  }
  /** Surface height at (s, lateral) including camber. */
  surfaceY(seg, s, lat) {
    return this.heightAt(seg, s) + surfaceOffset(ROAD_TYPES[seg.type], lat);
  }

  _createNode(x, z) {
    const id = 'n' + this._nextNode++;
    const node = { id, x, y: this.terrainY(x, z), z, segments: [], junction: null };
    this.nodes.set(id, node);
    this._touchedNodes.add(id);
    this.dirtyNodes.add(id);
    return node;
  }

  _sample(seg) {
    const L = seg.length;
    const n = Math.max(2, Math.ceil(L / SAMPLE_DS));
    const ds = L / n;
    const xs = new Float64Array(n + 1), zs = new Float64Array(n + 1);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i <= n; i++) {
      seg.curve.getPointAt(i / n, _p);
      xs[i] = _p.x; zs[i] = _p.z;
      if (_p.x < minX) minX = _p.x; if (_p.x > maxX) maxX = _p.x;
      if (_p.z < minZ) minZ = _p.z; if (_p.z > maxZ) maxZ = _p.z;
    }
    const pad = seg.width * 0.5 + 2;
    seg.samples = { xs, zs, ds, n };
    seg.bbox = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  }

  _computeHeights(seg) {
    const { xs, zs, n, ds } = seg.samples;
    const raw = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) raw[i] = this.terrainY(xs[i], zs[i]);
    const K = Math.max(1, Math.round(SMOOTH_HALF / ds));
    const sm = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      let sum = 0, wsum = 0;
      for (let j = -K; j <= K; j++) {
        const k = Math.min(n, Math.max(0, i + j));
        const w = 1 - Math.abs(j) / (K + 1);
        sum += raw[k] * w; wsum += w;
      }
      sm[i] = sum / wsum;
    }
    const ya = this.nodes.get(seg.a).y, yb = this.nodes.get(seg.b).y;
    const h = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      h[i] = sm[i] + (1 - f) * (ya - sm[0]) + f * (yb - sm[n]);
    }
    seg.rawHeights = h;
    seg.heights = Float32Array.from(h);
    seg.heightStep = ds;
    seg.y0 = ya;
  }

  /**
   * Fit the junction pad plane: gradient (dh/dx, dh/dz) through node.y that best matches the arms'
   * natural slopes near the node (least squares, regularised toward flat, clamped to 6 %). Arms then
   * blend onto this plane over their approach so the fan is planar (no tent between mouths).
   */
  _nodeGradient(node) {
    const J = node.junction;
    node.grad = null;
    if (!J || !J.pad) return;
    const lambda = 0.35;
    let a11 = lambda, a12 = 0, a22 = lambda, b1 = 0, b2 = 0;
    for (const e of J.ends) {
      const seg = this.segments.get(e.segId);
      if (!seg) continue;
      const L = Math.max(4, Math.min(seg.length, e.trim + 10));
      const sEval = e.end === 'a' ? L : seg.length - L;
      const hRaw = this._rawHeightAt(seg, sEval);
      const slope = Math.max(-0.12, Math.min(0.12, (hRaw - node.y) / L));
      const { dx, dz } = e.frame;
      a11 += dx * dx; a12 += dx * dz; a22 += dz * dz; b1 += dx * slope; b2 += dz * slope;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-9) return;
    let gx = (b1 * a22 - b2 * a12) / det, gz = (a11 * b2 - a12 * b1) / det;
    const m = Math.hypot(gx, gz);
    if (m > MAX_PAD_GRADE) { gx *= MAX_PAD_GRADE / m; gz *= MAX_PAD_GRADE / m; }
    node.grad = { gx, gz };
  }

  _rawHeightAt(seg, s) {
    const h = seg.rawHeights || seg.heights;
    if (!h || h.length < 2) return seg.y0 || 0;
    const f = Math.min(Math.max(s, 0), seg.length) / seg.heightStep;
    const i = Math.min(Math.floor(f), h.length - 2);
    const r = f - i;
    return h[i] * (1 - r) + h[i + 1] * r;
  }

  /** Blend the segment's height profile onto the pad planes of its end junctions (see _nodeGradient). */
  _applyPads(seg) {
    const raw = seg.rawHeights;
    if (!raw) return;
    const h = Float32Array.from(raw);
    const n = h.length - 1, ds = seg.heightStep, L = seg.length;
    const padEnd = (node, trim, yEnd, fromA) => {
      if (!node || !node.junction || !node.junction.pad) return;
      seg.curve.getTangentAt(fromA ? 0 : 1, _t);
      let tx = _t.x, tz = _t.z;
      if (!fromA) { tx = -tx; tz = -tz; }
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const g = node.grad ? node.grad.gx * tx + node.grad.gz * tz : 0;
      const blend = Math.max(14, trim * 1.5);
      for (let i = 0; i <= n; i++) {
        const s = fromA ? i * ds : L - i * ds;
        if (s >= trim + blend) continue;
        const pad = yEnd + g * s;
        if (s <= trim) { h[i] = pad; continue; }
        const u = (s - trim) / blend;
        const w = u * u * (3 - 2 * u);
        h[i] = pad * (1 - w) + h[i] * w;
      }
    };
    padEnd(this.nodes.get(seg.a), seg.trimA, this.nodes.get(seg.a).y, true);
    padEnd(this.nodes.get(seg.b), seg.trimB, this.nodes.get(seg.b).y, false);
    seg.heights = h;
  }

  _buildPoints(seg) {
    const L = seg.length;
    const n = Math.max(1, Math.ceil(L / POINT_DS));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * L;
      seg.curve.getPointAt(i / n, _p);
      pts.push(new THREE.Vector3(_p.x, this.heightAt(seg, s), _p.z));
    }
    seg.points = pts;
  }

  _addSegment(nodeA, nodeB, type, curve) {
    const id = 's' + this._nextSeg++;
    const length = curve.getLength();
    const seg = {
      id, a: nodeA.id, b: nodeB.id, type: type.id, rank: type.rank || 1, width: type.width, length, curve,
      points: [], lanes: [], pedestrianLanes: [],
      trimA: 0, trimB: 0, gapA: 0, gapB: 0, capA: true, capB: true, bridgeA: false, bridgeB: false,
      kindA: 'dead', kindB: 'dead', flagsA: 0, flagsB: 0,
      phase: 0, samples: null, heights: null, heightStep: 1, bbox: null, slot: 0, traffic: 0,
    };
    seg.slot = this._freeSlots.length ? this._freeSlots.pop() : this._nextSlot < 4096 ? this._nextSlot++ : 0;
    seg.phase = Math.floor(makeRng(hash2(this.world.seed, hashString(id)))() * 40) * 1.5;
    this._sample(seg);
    this._computeHeights(seg);
    this._buildPoints(seg);
    nodeA.segments.push(id);
    nodeB.segments.push(id);
    this.segments.set(id, seg);
    this.grid.insert(id, seg.bbox);
    this.dirtySegments.add(id);
    this._touchedNodes.add(nodeA.id);
    this._touchedNodes.add(nodeB.id);
    this._batchAdded.push(id);
    return seg;
  }

  _removeSegmentInternal(seg) {
    for (const nid of [seg.a, seg.b]) {
      const node = this.nodes.get(nid);
      if (!node) continue;
      const i = node.segments.indexOf(seg.id);
      if (i >= 0) node.segments.splice(i, 1);
      this._touchedNodes.add(nid);
    }
    this.grid.remove(seg.id);
    if (seg.slot) this._freeSlots.push(seg.slot);
    this.segments.delete(seg.id);
    this.dirtySegments.delete(seg.id);
    this.removedSegments.add(seg.id);
    this._batchRemoved.push(seg.id);
  }

  /** Split a segment at sorted arc-length fractions. Returns the new nodes (in order). */
  _splitSegment(seg, ts) {
    const type = ROAD_TYPES[seg.type];
    const L = seg.length;
    const clean = [];
    for (const t of [...ts].sort((a, b) => a - b)) {
      if (t * L < 1.0 || (1 - t) * L < 1.0) continue;
      if (clean.length && (t - clean[clean.length - 1]) * L < 1.0) continue;
      clean.push(t);
    }
    if (!clean.length) return [];
    const nodes = clean.map((t) => { seg.curve.getPointAt(t, _p); return this._createNode(_p.x, _p.z); });
    const chain = [this.nodes.get(seg.a), ...nodes, this.nodes.get(seg.b)];
    const us = [0, ...clean, 1];
    this._removeSegmentInternal(seg);
    for (let i = 0; i < chain.length - 1; i++) this._addSegment(chain[i], chain[i + 1], type, seg.curve.slice(us[i], us[i + 1]));
    return nodes;
  }

  _nearestNode(x, z, r) {
    let best = null, bd = r * r;
    for (const node of this.nodes.values()) {
      const d = (node.x - x) ** 2 + (node.z - z) ** 2;
      if (d < bd) { bd = d; best = node; }
    }
    return best;
  }

  /** Turn an input point into a node: snap to node, snap/split a segment, or create a new node. */
  _resolveAnchor(p, snapR, result) {
    const node = this._nearestNode(p.x, p.z, snapR);
    if (node) return node;
    const hit = this.nearest(p.x, p.z, Math.max(snapR, 20));
    if (hit && hit.distance <= Math.max(snapR, hit.segment.width * 0.5 + 1)) {
      const seg = hit.segment;
      const endDist = Math.min(hit.t, 1 - hit.t) * seg.length;
      if (endDist < Math.max(3, snapR)) return this.nodes.get(hit.t < 0.5 ? seg.a : seg.b);
      const [n] = this._splitSegment(seg, [hit.t]);
      if (n) { result.nodes.push(n.id); return n; }
    }
    const n = this._createNode(p.x, p.z);
    result.nodes.push(n.id);
    return n;
  }

  /** Crossings of a new curve with existing segments → sorted cuts [{ u, nodeId }]. */
  _findCrossings(curve, nodeAId, nodeBId, snapR, result) {
    const L = curve.getLength();
    const n = Math.max(2, Math.ceil(L / SAMPLE_DS));
    const xs = new Float64Array(n + 1), zs = new Float64Array(n + 1);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i <= n; i++) {
      curve.getPointAt(i / n, _p);
      xs[i] = _p.x; zs[i] = _p.z;
      if (_p.x < minX) minX = _p.x; if (_p.x > maxX) maxX = _p.x;
      if (_p.z < minZ) minZ = _p.z; if (_p.z > maxZ) maxZ = _p.z;
    }
    const cands = this.grid.query({ minX: minX - 1, maxX: maxX + 1, minZ: minZ - 1, maxZ: maxZ + 1 });
    const hits = [];
    for (const segId of cands) {
      const seg = this.segments.get(segId);
      if (!seg) continue;
      const S = seg.samples;
      for (let i = 0; i < n; i++) {
        const ax = xs[i], az = zs[i], bx = xs[i + 1], bz = zs[i + 1];
        const lo = Math.min(ax, bx) - 0.01, hi = Math.max(ax, bx) + 0.01, lz = Math.min(az, bz) - 0.01, hz = Math.max(az, bz) + 0.01;
        if (hi < seg.bbox.minX || lo > seg.bbox.maxX || hz < seg.bbox.minZ || lz > seg.bbox.maxZ) continue;
        for (let j = 0; j < S.n; j++) {
          const cx = S.xs[j], cz = S.zs[j], dx = S.xs[j + 1], dz = S.zs[j + 1];
          if (Math.max(cx, dx) < lo || Math.min(cx, dx) > hi || Math.max(cz, dz) < lz || Math.min(cz, dz) > hz) continue;
          const r = segSegIntersect(ax, az, bx, bz, cx, cz, dx, dz);
          if (!r) continue;
          const u = (i + r.t) / n, t = (j + r.u) / S.n;
          hits.push({ u, t, x: ax + (bx - ax) * r.t, z: az + (bz - az) * r.t, seg });
        }
      }
    }
    hits.sort((a, b) => a.u - b.u);
    const cuts = [];
    const splits = new Map(); // segId → [t]
    let lastU = -1;
    for (const h of hits) {
      if (h.u * L < 1.0 || (1 - h.u) * L < 1.0) continue; // touching at our own end points
      if ((h.u - lastU) * L < 1.5) continue; // tangential double hit
      const na = this.nodes.get(h.seg.a), nb = this.nodes.get(h.seg.b);
      const da = Math.hypot(na.x - h.x, na.z - h.z), db = Math.hypot(nb.x - h.x, nb.z - h.z);
      const attachR = Math.min(snapR, 3.5);
      if (da < attachR || db < attachR) {
        const node = da <= db ? na : nb;
        if (node.id === nodeAId || node.id === nodeBId) continue;
        cuts.push({ u: h.u, nodeId: node.id });
      } else {
        if (!splits.has(h.seg.id)) splits.set(h.seg.id, []);
        splits.get(h.seg.id).push(h.t);
        cuts.push({ u: h.u, pending: h.seg.id, t: h.t });
      }
      lastU = h.u;
    }
    for (const [segId, ts] of splits) {
      const seg = this.segments.get(segId);
      if (!seg) continue;
      const sorted = [...ts].sort((a, b) => a - b);
      const nodes = this._splitSegment(seg, sorted);
      // map each pending cut to its node (by order of t)
      let k = 0;
      for (const t of sorted) {
        const node = nodes[k++];
        const cut = cuts.find((c) => c.pending === segId && c.t === t);
        if (cut && node) { cut.nodeId = node.id; result.nodes.push(node.id); }
      }
    }
    return cuts.filter((c) => c.nodeId).sort((a, b) => a.u - b.u);
  }

  // ------------------------------------------------------------------ public mutations
  build(points, typeId = 'local', opts = {}) {
    const type = ROAD_TYPES[typeId];
    if (!type) throw new Error(`[roads] unknown road type "${typeId}"`);
    const result = { segments: [], nodes: [] };
    if (!Array.isArray(points) || points.length < 2) return result;
    this._beginMutation();
    const pts = [];
    for (const p of points) {
      const v = this.world.clampToMap({ x: +p.x || 0, z: +p.z || 0 });
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(v.x - last.x, v.z - last.z) > 0.5) pts.push(v);
    }
    if (pts.length < 2) return result;
    const mode = opts.curve || 'straight';
    const snapR = Math.max(4, type.width * 0.45);
    const anchors = new Map();
    for (const i of anchorIndices(pts.length, mode)) {
      const node = this._resolveAnchor(pts[i], snapR, result);
      anchors.set(i, node.id);
      pts[i].x = node.x; pts[i].z = node.z;
    }
    const pieces = makeCurvePieces(pts, mode);
    for (const piece of pieces) {
      const nodeA = anchors.get(piece.ia), nodeB = anchors.get(piece.ib);
      if (nodeA === nodeB) continue;
      const cuts = this._findCrossings(piece.curve, nodeA, nodeB, snapR, result);
      let prevNode = nodeA, prevU = 0;
      for (const cut of [...cuts, { u: 1, nodeId: nodeB }]) {
        if (cut.nodeId === prevNode) { prevU = cut.u; continue; }
        if ((cut.u - prevU) * piece.curve.getLength() < 1.0) { prevNode = cut.nodeId; prevU = cut.u; continue; }
        const a = this.nodes.get(prevNode), b = this.nodes.get(cut.nodeId);
        if (a && b) {
          const seg = this._addSegment(a, b, type, piece.curve.slice(prevU, cut.u));
          result.segments.push(seg.id);
        }
        prevNode = cut.nodeId; prevU = cut.u;
      }
    }
    this._finishMutation();
    return result;
  }

  remove(segmentId) {
    const seg = this.segments.get(segmentId);
    if (!seg) return false;
    this._beginMutation();
    this._removeSegmentInternal(seg);
    this._finishMutation();
    return true;
  }

  /** Remove everything (used by showcase resets). */
  clear() {
    this._beginMutation();
    for (const seg of [...this.segments.values()]) this._removeSegmentInternal(seg);
    this._finishMutation();
  }

  _beginMutation() {
    this._touchedNodes.clear();
    this._batchAdded = [];
    this._batchRemoved = [];
  }

  _finishMutation() {
    // drop orphan nodes
    for (const nid of this._touchedNodes) {
      const node = this.nodes.get(nid);
      if (node && node.segments.length === 0) {
        this.nodes.delete(nid);
        this.dirtyNodes.delete(nid);
        this.removedNodes.add(nid);
      }
    }
    // re-solve junctions at touched nodes; their segments need new meshes
    const touchedSegs = new Set();
    const touched = [];
    for (const nid of this._touchedNodes) {
      const node = this.nodes.get(nid);
      if (!node) continue;
      touched.push(node);
      for (const sid of node.segments) touchedSegs.add(sid);
    }
    // 1. natural (unpadded) height profiles; 2. trims; 3. pad planes; 4. blend profiles onto the pads;
    // 5. re-solve so mouth frames and corner heights sit on the pads
    for (const sid of touchedSegs) { const seg = this.segments.get(sid); if (seg) this._computeHeights(seg); }
    for (const node of touched) computeJunction(node, this);
    for (const node of touched) this._nodeGradient(node);
    for (const sid of touchedSegs) { const seg = this.segments.get(sid); if (seg) this._applyPads(seg); }
    for (const node of touched) {
      computeJunction(node, this);
      this._clearJunctionVegetation(node);
      this.dirtyNodes.add(node.id);
    }
    this._alignPhases(this._touchedNodes);
    for (const sid of touchedSegs) {
      const seg = this.segments.get(sid);
      if (!seg) continue;
      this._buildPoints(seg);
      this._refreshLanes(seg);
      this.dirtySegments.add(sid);
    }
    this._conformTerrainFor(touchedSegs, this._touchedNodes);
    this._laneGraphCache = null;
    this.world.roads.version++;
    const added = this._batchAdded.filter((id) => this.segments.has(id));
    this.events.emit('roads:changed', { version: this.world.roads.version, added, removed: this._batchRemoved.slice() });
  }

  /**
   * At two-way continuation nodes (a curve split into spans, or a road split by a later crossing) the
   * texture / dash phase of the outgoing segment continues the incoming one so no seam shows: the
   * asphalt's "along" coordinate is s + phase, so along_B(node) must equal along_A(node).
   */
  _alignPhases(nodeIds) {
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const nid of nodeIds) {
        const node = this.nodes.get(nid);
        if (!node || node.segments.length !== 2) continue;
        const A = this.segments.get(node.segments[0]), B = this.segments.get(node.segments[1]);
        if (!A || !B || A.type !== B.type) continue;
        const atA = (seg) => (seg.a === nid ? seg.trimA : seg.length - seg.trimB); // along value (without phase) at the node
        const want = A.phase + atA(A) - atA(B);
        if (Math.abs(B.phase - want) > 1e-4) { B.phase = want; this.dirtySegments.add(B.id); changed = true; }
      }
      if (!changed) break;
    }
  }

  /**
   * Cities: Skylines style terrain conforming. The terrain api only offers axis-aligned rectangles with
   * one height and a falloff that blends *outside* the rectangle, so a road is conformed as a chain of
   * runs of similar height. Because a run's falloff would lift the terrain inside a neighbouring lower run
   * (and through that road's surface), all operations of a mutation are collected first and applied from
   * the highest bed level to the lowest — later falloffs can then only dig gentle dips under a road,
   * which the sloped grass skirt hides.
   */
  _collectSegmentOps(seg, ops) {
    const type = ROAD_TYPES[seg.type];
    const L = seg.length;
    const half = seg.width * 0.5 + 0.6;
    // the terrain must stay below the asphalt *edges* (camber) → flatten to bed level minus the crown drop
    const drop = bedDrop(type);
    const n = Math.max(1, Math.ceil(L / 4));
    let run = null;
    const flush = () => {
      if (!run) return;
      ops.push({ x0: run.minX - half, z0: run.minZ - half, x1: run.maxX + half, z1: run.maxZ + half, y: run.minY - drop, probes: run.probes, tol: 0.5 });
      run = null;
    };
    for (let i = 0; i <= n; i++) {
      const s = (L * i) / n;
      seg.curve.getPointAt(i / n, _p);
      seg.curve.getTangentAt(i / n, _t);
      const y = this.heightAt(seg, s);
      // axis-aligned roads can use long rectangles; diagonal ones need short ones or the edges stair-step
      const axisAligned = Math.abs(_t.x) < 0.08 || Math.abs(_t.z) < 0.08;
      const maxRun = axisAligned ? 48 : Math.max(6, half * 0.9);
      // drops of up to ~1 m are hidden by the sloped grass skirt; long runs keep the terrain queue short
      if (run && (Math.abs(y - run.y0) > 1.0 || s - run.s0 > maxRun || _t.x * run.tx + _t.z * run.tz < 0.94)) flush();
      if (!run) run = { minX: _p.x, maxX: _p.x, minZ: _p.z, maxZ: _p.z, y0: y, minY: y, s0: s, tx: _t.x, tz: _t.z, probes: [] };
      if (_p.x < run.minX) run.minX = _p.x; if (_p.x > run.maxX) run.maxX = _p.x;
      if (_p.z < run.minZ) run.minZ = _p.z; if (_p.z > run.maxZ) run.maxZ = _p.z;
      if (y < run.minY) run.minY = y;
      const rx = -_t.z * half * 0.75, rz = _t.x * half * 0.75;
      run.probes.push([_p.x, _p.z], [_p.x + rx, _p.z + rz], [_p.x - rx, _p.z - rz]);
    }
    flush();
  }

  /** Junction fans reach beyond the segment corridors on skewed junctions → one low disc per node. */
  _collectJunctionOp(node, ops) {
    const J = node.junction;
    if (!J || J.k < 2) return;
    let r = 0, minY = node.y;
    for (const e of J.ends) { r = Math.max(r, e.trim + e.type.width * 0.5); minY = Math.min(minY, e.frame.y); }
    if (r < 4) return;
    const probes = [];
    for (let a = 0; a < 8; a++) probes.push([node.x + Math.cos(a * 0.785) * r * 0.6, node.z + Math.sin(a * 0.785) * r * 0.6]);
    ops.push({ x0: node.x - r, z0: node.z - r, x1: node.x + r, z1: node.z + r, y: minY - 0.35 - BED, probes, tol: 0.6 });
  }

  _applyConformOps(ops) {
    const api = this.world.terrain.api;
    if (!api || typeof api.flattenRect !== 'function' || !ops.length) return;
    const terrain = this.world.terrain;
    ops.sort((a, b) => b.y - a.y);
    for (const op of ops) {
      const { x0, z0, x1, z1, y } = op;
      // already conformed (flat ground, or a corridor the parent segment flattened before a split)?
      let lo = Infinity, hi = -Infinity;
      for (const [x, z] of op.probes) { const h = terrain.getHeight(x, z); if (h < lo) lo = h; if (h > hi) hi = h; }
      if (hi <= y + 0.06 && lo >= y - op.tol) continue;
      // gentler cut/fill slopes when the terrain is far from the road level (≈ 1:1.5 embankment)
      let diff = 0;
      for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [(x0 + x1) / 2, z0], [(x0 + x1) / 2, z1], [x0, (z0 + z1) / 2], [x1, (z0 + z1) / 2]]) {
        diff = Math.max(diff, Math.abs(terrain.getHeight(x, z) - y));
      }
      api.flattenRect(x0, z0, x1, z1, y, Math.min(22, Math.max(4, 3 + diff * 1.5)));
      this.flattenCalls++;
    }
  }

  /**
   * Contract path (ARCHITECTURE §5): one conformPath per touched segment (dense centreline samples at bed
   * height, corridor = road width + shoulders) and one conformDisc per junction, so skewed junction fans
   * never float above or sink into the ground.
   */
  _conformPaths(segIds, nodeIds, api) {
    // Junction pads first, segment corridors second. conformDisc can only take ONE height, so a sloped pad
    // has to be dug to its lowest corner; doing it before the corridors lets each arm pull its own strip
    // back up to bed level, which removes the 1 m retaining-wall step that used to appear under the
    // sidewalks around every junction on a grade. Only the fillet corners keep the lower pad level, and
    // the corner sidewalks' embankment skirts cover that.
    if (typeof api.conformDisc === 'function') {
      for (const nid of nodeIds) {
        const node = this.nodes.get(nid);
        const J = node && node.junction;
        if (!J || J.k < 2) continue;
        const r = J.padRadius + 1.0;
        if (r < 4) continue;
        const grade = node.grad ? Math.hypot(node.grad.gx, node.grad.gz) : 0;
        api.conformDisc(node.x, node.z, r, node.y - grade * r * 0.85 - bedDrop(J.dominant), 22);
        this.flattenCalls++;
      }
    }
    for (const sid of segIds) {
      const seg = this.segments.get(sid);
      if (!seg || !seg.points.length) continue;
      const drop = bedDrop(ROAD_TYPES[seg.type]);
      // grade cuts and fills more gently where the corridor sits deep in a hillside: an 8 m falloff on a
      // 4 m cut is a 1:2 raw dirt wall, so the blend widens to 16 m as the side drop grows (CS2 grades its verges)
      const pts = seg.points, th = this.world.terrain, half = seg.width / 2 + 4;
      let diff = 0;
      for (let i = 0; i < pts.length; i += 3) {
        const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
        let tx = q.x - o.x, tz = q.z - o.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const hR = th.getHeight(p.x - tz * half, p.z + tx * half), hL = th.getHeight(p.x + tz * half, p.z - tx * half);
        diff = Math.max(diff, Math.abs(hR - p.y), Math.abs(hL - p.y));
      }
      // The terrain paints dirt above slope ≈0.12 and rock above ≈0.19, so a cut/fill of `diff` metres
      // needs ≈ diff/0.09 metres of blend to stay a grassy bank instead of a scorched scar. Capped at
      // 34 m so a road never flattens a whole hillside; the mesher's embankment skirt covers the rest.
      const falloff = Math.min(26, Math.max(9, 7 + diff / 0.11));
      api.conformPath(pts.map((p) => ({ x: p.x, y: p.y - drop, z: p.z })), seg.width + 1.2, falloff);
      this.flattenCalls++;
      // keep trees off the verge: conformPath only clears width + 3, which leaves pines against the rail
      if (typeof api.clearVegetationPath === 'function') {
        const extra = seg.type === 'highway' ? 9 : ROAD_TYPES[seg.type].lamps ? 6 : 3;
        api.clearVegetationPath(pts, seg.width + extra);
      }
    }
  }

  /** Conform terrain for the touched segments/nodes plus neighbours whose corridors a falloff could touch. */
  _conformTerrainFor(segIds, nodeIds) {
    const api = this.world.terrain.api;
    if (!api) return;
    if (typeof api.conformPath === 'function') return this._conformPaths(segIds, nodeIds, api);
    if (typeof api.flattenRect !== 'function') return;
    const ops = [];
    const seen = new Set();
    let bb = null;
    for (const sid of segIds) {
      const seg = this.segments.get(sid);
      if (!seg) continue;
      seen.add(sid);
      this._collectSegmentOps(seg, ops);
      const b = seg.bbox;
      if (!bb) bb = { ...b };
      else { bb.minX = Math.min(bb.minX, b.minX); bb.maxX = Math.max(bb.maxX, b.maxX); bb.minZ = Math.min(bb.minZ, b.minZ); bb.maxZ = Math.max(bb.maxZ, b.maxZ); }
    }
    if (bb) {
      const pad = 24;
      for (const sid of this.grid.query({ minX: bb.minX - pad, maxX: bb.maxX + pad, minZ: bb.minZ - pad, maxZ: bb.maxZ + pad })) {
        if (seen.has(sid)) continue;
        const seg = this.segments.get(sid);
        if (seg) this._collectSegmentOps(seg, ops);
      }
    }
    for (const nid of nodeIds) {
      const node = this.nodes.get(nid);
      if (node) this._collectJunctionOp(node, ops);
    }
    this._applyConformOps(ops);
  }

  /** Junction fans reach beyond the segment corridors — keep trees off them. */
  _clearJunctionVegetation(node) {
    const api = this.world.terrain.api;
    if (!api || typeof api.clearVegetationCircle !== 'function' || !node.junction) return;
    api.clearVegetationCircle(node.x, node.z, node.junction.padRadius + 2.5);
  }

  /** Recompute all heights (terrain changed) and mark everything dirty. */
  refreshAll() {
    this._beginMutation();
    for (const node of this.nodes.values()) { node.y = this.terrainY(node.x, node.z); this._touchedNodes.add(node.id); }
    for (const seg of this.segments.values()) { this._computeHeights(seg); this._buildPoints(seg); }
    this._finishMutation();
  }

  clearDirty() {
    this.dirtySegments.clear();
    this.dirtyNodes.clear();
    this.removedSegments.clear();
    this.removedNodes.clear();
  }

  // ------------------------------------------------------------------ lanes
  _lanePoints(seg, lat, dir) {
    const L = seg.length;
    const s0 = Math.min(seg.trimA, L), s1 = Math.max(s0, L - seg.trimB);
    const n = Math.max(1, Math.ceil((s1 - s0) / LANE_DS));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      const u = L > 0 ? s / L : 0;
      seg.curve.getPointAt(u, _p);
      seg.curve.getTangentAt(u, _t);
      const l = Math.hypot(_t.x, _t.z) || 1;
      const rx = -_t.z / l, rz = _t.x / l;
      pts.push(new THREE.Vector3(_p.x + rx * lat, this.surfaceY(seg, s, lat), _p.z + rz * lat));
    }
    if (dir < 0) pts.reverse();
    return pts;
  }
  _refreshLanes(seg) {
    const type = ROAD_TYPES[seg.type];
    const lanes = [];
    type.laneOffsets.forEach((off, rank) => {
      for (const dir of [1, -1]) {
        const lat = dir * off;
        lanes.push({
          id: `${seg.id}:${dir > 0 ? 'f' : 'r'}${rank}`, segmentId: seg.id, dir, rank, lateral: lat,
          points: this._lanePoints(seg, lat, dir), speed: type.speed, width: type.laneWidth,
          from: dir > 0 ? seg.a : seg.b, to: dir > 0 ? seg.b : seg.a, kind: 'vehicle',
        });
      }
    });
    seg.lanes = lanes;
    const ped = [];
    type.pedestrianOffsets.forEach((off, rank) => {
      for (const dir of [1, -1]) {
        const lat = dir * off;
        ped.push({
          id: `${seg.id}:p${dir > 0 ? 'f' : 'r'}${rank}`, segmentId: seg.id, dir, rank, lateral: lat,
          points: this._lanePoints(seg, lat, dir).map((p) => { p.y += type.hasCurb ? 0.2 : 0; return p; }),
          speed: 5, width: 1.5, from: dir > 0 ? seg.a : seg.b, to: dir > 0 ? seg.b : seg.a, kind: 'pedestrian',
        });
      }
    });
    seg.pedestrianLanes = ped;
  }

  /** Outgoing (away from node) unit direction of a segment end at the node. */
  _outDir(seg, nodeId) {
    const atA = seg.a === nodeId;
    seg.curve.getTangentAt(atA ? 0 : 1, _t);
    let dx = _t.x, dz = _t.z;
    if (!atA) { dx = -dx; dz = -dz; }
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  laneGraph() {
    const version = this.world.roads.version;
    if (this._laneGraphCache && this._laneGraphCache.version === version) return this._laneGraphCache.graph;
    const lanes = [], connections = new Map();
    const pLanes = [], pConnections = new Map();
    for (const seg of this.segments.values()) {
      for (const l of seg.lanes) { lanes.push(l); connections.set(l.id, []); }
      for (const l of seg.pedestrianLanes) { pLanes.push(l); pConnections.set(l.id, []); }
    }
    const classify = (travel, out) => {
      const rel = wrapPi(headingOf(out.x, out.z) - headingOf(travel.x, travel.z));
      const a = Math.abs(rel);
      if (a <= Math.PI / 6) return 'S';
      if (a >= (5 * Math.PI) / 6) return 'U';
      return rel > 0 ? 'R' : 'L';
    };
    for (const node of this.nodes.values()) {
      const ends = node.segments.map((id) => this.segments.get(id)).filter(Boolean).map((seg) => ({ seg, dir: this._outDir(seg, node.id) }));
      const vEnds = ends.filter((e) => e.seg.lanes.length);
      for (const e of vEnds) {
        const incoming = e.seg.lanes.filter((l) => l.to === node.id);
        if (!incoming.length) continue;
        const n = incoming.length;
        const travel = { x: -e.dir.x, z: -e.dir.z };
        const others = vEnds.filter((o) => o !== e).map((o) => ({ ...o, cls: classify(travel, o.dir), out: o.seg.lanes.filter((l) => l.from === node.id).sort((a, b) => a.rank - b.rank) }));
        for (const lane of incoming) {
          const r = lane.rank;
          const conn = connections.get(lane.id);
          const connectMatched = (out) => {
            if (!out.length) return;
            const m = out.length;
            conn.push(out[Math.min(r, m - 1)].id);
            if (r === n - 1) for (let k = r + 1; k < m; k++) conn.push(out[k].id);
          };
          if (vEnds.length === 1) {
            const back = e.seg.lanes.filter((l) => l.from === node.id).sort((a, b) => a.rank - b.rank);
            if (back.length) conn.push(back[Math.min(r, back.length - 1)].id);
          } else if (vEnds.length === 2) {
            connectMatched(others[0].out);
          } else {
            for (const o of others) {
              if (o.cls === 'S') connectMatched(o.out);
              else if (o.cls === 'L' && (r === 0 || n === 1) && o.out.length) conn.push(o.out[0].id);
              else if (o.cls === 'R' && (r === n - 1 || n === 1) && o.out.length) conn.push(o.out[o.out.length - 1].id);
            }
            if (!conn.length) for (const o of others) if (o.cls !== 'U') connectMatched(o.out);
            if (!conn.length) for (const o of others) connectMatched(o.out);
          }
        }
      }
      // pedestrians: any incoming → any outgoing (including turning back)
      const pIn = [], pOut = [];
      for (const e of ends) for (const l of e.seg.pedestrianLanes) { if (l.to === node.id) pIn.push(l); if (l.from === node.id) pOut.push(l); }
      for (const l of pIn) pConnections.set(l.id, pOut.map((o) => o.id));
    }
    const graph = { lanes, connections, pedestrian: { lanes: pLanes, connections: pConnections }, version };
    this._laneGraphCache = { version, graph };
    return graph;
  }

  // ------------------------------------------------------------------ queries
  nearest(x, z, maxDist = 30) {
    const cands = this.grid.query({ minX: x - maxDist, maxX: x + maxDist, minZ: z - maxDist, maxZ: z + maxDist });
    let best = null, bestD2 = maxDist * maxDist;
    for (const id of cands) {
      const seg = this.segments.get(id);
      if (!seg) continue;
      const c = closestOnPolyline(seg.samples.xs, seg.samples.zs, seg.samples.ds, seg.length, x, z);
      if (c.d2 < bestD2) { bestD2 = c.d2; best = { seg, c }; }
    }
    if (!best) return null;
    const { seg, c } = best;
    seg.curve.getPointAt(c.t, _p);
    seg.curve.getTangentAt(c.t, _t);
    const l = Math.hypot(_t.x, _t.z) || 1;
    return {
      segment: seg, t: c.t, distance: Math.sqrt(bestD2),
      point: { x: _p.x, y: this.heightAt(seg, c.t * seg.length), z: _p.z },
      tangent: { x: _t.x / l, z: _t.z / l },
    };
  }

  snap(x, z, radius = 8) {
    const node = this._nearestNode(x, z, radius);
    if (node) return { x: node.x, z: node.z, y: node.y, nodeId: node.id };
    const hit = this.nearest(x, z, radius);
    if (hit) return { x: hit.point.x, z: hit.point.z, y: hit.point.y, segmentId: hit.segment.id, t: hit.t };
    return { x, z, y: this.terrainY(x, z) };
  }

  sampleEdge(segmentId, t, side = 1) {
    const seg = this.segments.get(segmentId);
    if (!seg) return null;
    const type = ROAD_TYPES[seg.type];
    t = Math.min(1, Math.max(0, t));
    seg.curve.getPointAt(t, _p);
    seg.curve.getTangentAt(t, _t);
    const l = Math.hypot(_t.x, _t.z) || 1;
    const rx = -_t.z / l, rz = _t.x / l;
    const lat = Math.sign(side || 1) * seg.width * 0.5;
    const s = t * seg.length;
    const y = this.heightAt(seg, s) + surfaceOffset(type, Math.sign(lat) * type.cwHalf) + (type.hasCurb ? 0.20 : 0);
    return { x: _p.x + rx * lat, y, z: _p.z + rz * lat, nx: Math.sign(lat) * rx, nz: Math.sign(lat) * rz };
  }

  /** Road surface height at (x,z) when the point lies on a road (asphalt, kerb or sidewalk), else null. */
  surfaceHeight(x, z) {
    const hit = this.nearest(x, z, 20);
    if (!hit) return null;
    const seg = hit.segment, type = ROAD_TYPES[seg.type];
    if (hit.distance > seg.width * 0.5) return null;
    const lat = -(x - hit.point.x) * hit.tangent.z + (z - hit.point.z) * hit.tangent.x;
    const base = this.heightAt(seg, hit.t * seg.length);
    const a = Math.abs(lat);
    if (a <= type.cwHalf) return base + surfaceOffset(type, lat);
    const edge = base + surfaceOffset(type, Math.sign(lat) * type.cwHalf);
    return type.hasCurb ? edge + (a < type.cwHalf + 0.2 ? 0.17 : 0.20) : edge;
  }

  segmentsInRadius(x, z, r) {
    const cands = this.grid.query({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });
    const out = [];
    for (const id of cands) {
      const seg = this.segments.get(id);
      if (!seg) continue;
      const c = closestOnPolyline(seg.samples.xs, seg.samples.zs, seg.samples.ds, seg.length, x, z);
      const reach = r + seg.width * 0.5;
      if (c.d2 <= reach * reach) out.push(seg);
    }
    return out;
  }
}
