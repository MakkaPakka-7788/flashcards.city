/**
 * zoning module — Cities: Skylines style zoning grid along roads (see ARCHITECTURE.md §4/§5).
 *
 * world.zones = { version, lots, api }
 *   api.paint(cells [{cx,cz}], zoneType|null)      paint / erase world cells (only cells the road grid covers)
 *   api.paintRect(x0, z0, x1, z1, zoneType|null)   paint every grid cell whose centre lies in the world rectangle
 *   api.lotsFor(zoneType?)                         merged 2×2 … 4×4 lots (see ZoneGrid for the record)
 *   api.setOverlayVisible(bool)                    coloured zone tiles; also auto-shown while the 'zone' tool
 *                                                  is active and for the 'zoning' info view
 * Extras for tools / UI: cellAt, cellsInRect, zoneAt, setHover, setBrush, setOpacity, clear, refresh, stats, types.
 * `stats()` also reports `coverage` = lotCells / zonedCells: painted cells the geometry cannot turn
 * into a 2×2 parcel are never handed out as lots and are drawn desaturated in the overlay.
 *
 * Lot record: { id, cells:[{cx,cz}], x, y, z, w, d, yaw, type, roadSegmentId, side, frontage:{x,z,nx,nz,t,length},
 *   buildingId|null, width, depth (cells), corners:[x,z ×4 — front-left, front-right, back-right, back-left] }.
 * `yaw` is the rotation about +Y that makes local +Z face the road (frontage normal points INTO the lot, away
 * from the road); `w` runs along the road, `d` away from it.
 */
import { ZoneGrid } from './ZoneGrid.js';
import { ZoneOverlay } from './ZoneOverlay.js';
import { ZoneGround } from './ZoneGround.js';
import { ZONE_TYPES, ZONE_BY_INDEX, zoneIndexOf } from './ZoneTypes.js';

export const name = 'zoning';

let ctxRef = null;
let grid = null;
let overlay = null;
let ground = null;
const offs = [];
const vis = { explicit: false, tool: false, info: false };
let sticky = null; // sticky hover set through api.setHover (until the real pointer moves)
let stickyBrush = null; // brush preview kept across overlay hide/show (setBrush)
const lastPointer = { x: 0, y: 0 };
let lastLotSig = '';
let selectedLotId = null;

function refreshVisible() {
  if (!overlay) return;
  const on = vis.explicit || vis.tool || vis.info;
  overlay.visible = on;
  // hiding the overlay must take the cursors with it — a hover ring or a brush rectangle left drawn
  // on bare grass is the tool leaking out of its mode. Both are restored when it comes back.
  if (!on) { overlay.setHover(-1); overlay.setBrush(null); }
  else {
    if (stickyBrush) overlay.setBrush(stickyBrush.rect, stickyBrush.type, stickyBrush.erase);
    if (sticky) { const c = grid.cellAt(sticky.x, sticky.z); overlay.setHover(c ? c.id : -1); }
  }
}

function publicCell(c) {
  if (!c) return null;
  const lot = c.lot >= 0 ? grid.lots[c.lot] : null;
  return {
    cx: c.cx, cz: c.cz, x: c.x, z: c.z, yaw: c.yaw, depth: c.k, side: c.side,
    type: c.type ? ZONE_BY_INDEX[c.type].id : null, segmentId: c.seg, lotId: lot ? lot.id : null,
    corners: c.corners.slice(),
  };
}

function lotSignature() {
  let s = '';
  for (const l of grid.lots) s += l.key + ';';
  return s;
}

function emitChanged(changed, reason) {
  const { world, events } = ctxRef;
  world.zones.version++;
  world.zones.lots = grid.lots;
  lastLotSig = lotSignature();
  events.emit('zones:changed', {
    version: world.zones.version,
    reason,
    lots: grid.lots.length,
    changed: changed.map((c) => ({ cx: c.cx, cz: c.cz, type: c.type ? ZONE_BY_INDEX[c.type].id : null })),
  });
}

function afterPaint(changed, reason) {
  ctxRef.world.zones.lots = grid.lots;
  if (!changed.length && lotSignature() === lastLotSig) return 0;
  overlay.updatePaint(null);
  if (ground) ground.markDirty();
  refreshSelection();
  emitChanged(changed, reason);
  return changed.length;
}

/** Roads changed → regenerate cells, geometry and lots; emit only when the lot set actually changed. */
function rebuildFromRoads(reason) {
  grid.rebuild();
  overlay.rebuildGeometry();
  if (ground) ground.markDirty();
  ctxRef.world.zones.lots = grid.lots;
  refreshSelection();
  if (lotSignature() !== lastLotSig) emitChanged([], reason);
}

function refreshSelection() {
  if (!overlay) return;
  if (selectedLotId == null) { overlay.setSelectedLot(-1); return; }
  const lot = grid.lotById(selectedLotId);
  overlay.setSelectedLot(lot ? lot.index : -1);
}

export async function init(ctx) {
  ctxRef = ctx;
  const { world, events, input } = ctx;
  grid = new ZoneGrid(world, events);
  overlay = new ZoneOverlay(ctx, grid);
  ground = new ZoneGround(ctx, grid);
  if (input) { lastPointer.x = input.pointer.x; lastPointer.y = input.pointer.y; }

  world.zones.version = world.zones.version || 0;
  world.zones.lots = grid.lots;
  world.zones.api = {
    types: ZONE_TYPES.map((t) => ({
      id: t.id, index: t.index, label: t.label, color: t.color, demand: t.demand,
      width: t.width.slice(), depth: t.depth.slice(),
    })),
    cellSize: world.cellSize,
    maxDepth: 12,

    paint(cells, zoneType) {
      if (!Array.isArray(cells)) return 0;
      const changed = grid.paintCells(cells, zoneType);
      return afterPaint(changed, 'paint');
    },
    paintRect(x0, z0, x1, z1, zoneType) {
      const changed = grid.paintRect(x0, z0, x1, z1, zoneType);
      return afterPaint(changed, 'paint');
    },
    lotsFor(zoneType) {
      grid.ensure();
      if (grid.dirty === false && ctx.world.zones.lots !== grid.lots) ctx.world.zones.lots = grid.lots;
      return zoneType ? grid.lots.filter((l) => l.type === zoneType) : grid.lots.slice();
    },
    setOverlayVisible(v) { vis.explicit = !!v; refreshVisible(); },
    isOverlayVisible() { return overlay.visible; },

    // --- extras (tools / UI helpers, safe to ignore) ---
    cellAt(x, z) { return publicCell(grid.cellAt(x, z)); },
    cellsInRect(x0, z0, x1, z1) { return grid.cellsInRect(x0, z0, x1, z1).map((c) => ({ cx: c.cx, cz: c.cz })); },
    zoneAt(x, z) { const c = grid.cellAt(x, z); return c && c.type ? ZONE_BY_INDEX[c.type].id : null; },
    lotById(id) { grid.ensure(); return grid.lotById(id); },
    lotAt(x, z) { const c = grid.cellAt(x, z); return c && c.lot >= 0 ? grid.lots[c.lot] : null; },
    /** Sticky hover highlight at a world point (null clears). The real pointer overrides it as soon as it moves. */
    setHover(x, z) {
      if (x == null) { sticky = null; overlay.setHover(-1); return; }
      const c = grid.cellAt(x, z);
      sticky = c ? { x: c.x, z: c.z } : { x, z };
      overlay.setHover(c ? c.id : -1);
    },
    /** Brush preview: rect {x0,z0,x1,z1} + zone type (null type = erase preview); setBrush(null) clears. */
    setBrush(rect, zoneType) {
      if (!rect) { stickyBrush = null; overlay.setBrush(null); return; }
      const ti = zoneIndexOf(zoneType);
      stickyBrush = { rect, type: Math.max(0, ti), erase: ti === 0 };
      if (overlay.visible) overlay.setBrush(rect, stickyBrush.type, stickyBrush.erase);
    },
    setOpacity(v) { overlay.setOpacity(v); },
    getPaint() { grid.ensure(); return [...grid.paint.entries()]; },
    clear() { const changed = grid.clear(); return afterPaint(changed, 'clear'); },
    refresh() { grid.dirty = true; rebuildFromRoads('refresh'); },
    stats() { return { ...grid.stats, drawn: overlay.visible ? 1 : 0, version: world.zones.version, frames: grid.frames.length, ground: ground ? ground.stats : null }; },
    /** Per-zone ground treatment (paving / aprons / yards / lawn). Visible independently of the overlay. */
    setGroundVisible(v) { if (ground) ground.setVisible(!!v); },
    groundStats() { return ground ? ground.stats : null; },
  };

  offs.push(events.on('roads:changed', () => { grid.dirty = true; }));
  offs.push(events.on('terrain:ready', () => { grid.geometryVersion++; if (ground) ground.markDirty(); }));
  // buildings supply the footprints the ground bakes contact occlusion against
  offs.push(events.on('building:added', () => { if (ground) ground.markDirty(); }));
  offs.push(events.on('building:removed', () => { if (ground) ground.markDirty(); }));
  offs.push(events.on('tool:changed', (tool, options) => {
    vis.tool = tool === 'zone' && !(options && options.overlay === false);
    if (!vis.tool) stickyBrush = null;
    refreshVisible();
  }));
  offs.push(events.on('infoview:changed', (p) => { vis.info = !!(p && p.view === 'zoning'); refreshVisible(); }));
  offs.push(events.on('entity:selected', (p) => {
    selectedLotId = p && p.kind === 'lot' ? p.id : null;
    refreshSelection();
  }));

  await ground.init();

  // roads may already exist (module order is roads → zoning, but be robust to re-init)
  if (world.roads && world.roads.segments && world.roads.segments.size) rebuildFromRoads('init');
  else grid.dirty = true;
  if (world.tool && world.tool.active === 'zone') { vis.tool = true; refreshVisible(); }
}

export function update(dt, elapsed) {
  if (!grid || !overlay) return;
  const { world, camera, input } = ctxRef;
  grid.now = elapsed;
  if (grid.dirty) rebuildFromRoads('roads');
  const night = world.env ? world.env.nightFactor : 0;
  overlay.update(elapsed, camera, night);
  if (ground) ground.update(dt, elapsed, night);

  if (!overlay.visible) { if (overlay.uniforms.uHover.value !== -1) overlay.setHover(-1); return; }
  let hover = -1;
  if (input && (input.pointer.x !== lastPointer.x || input.pointer.y !== lastPointer.y)) {
    lastPointer.x = input.pointer.x; lastPointer.y = input.pointer.y;
    sticky = null;
  }
  if (sticky) {
    const c = grid.cellAt(sticky.x, sticky.z);
    hover = c ? c.id : -1;
  } else if (input && input.groundValid && !input.pointerOverUI && input.pointerInside && world.tool && world.tool.active === 'zone') {
    const c = grid.cellAt(input.ground.x, input.ground.z);
    hover = c ? c.id : -1;
  }
  overlay.setHover(hover);
}

export function dispose() {
  for (const off of offs) { try { if (typeof off === 'function') off(); } catch (_) { /* ignore */ } }
  offs.length = 0;
  if (overlay) overlay.dispose();
  if (ground) ground.dispose();
  overlay = null; ground = null; grid = null; sticky = null;
  if (ctxRef) { ctxRef.world.zones.api = null; ctxRef.world.zones.lots = []; }
  ctxRef = null;
}
