const WORLD_KEY = 'fableCitiesWorlds.v1';
const LEGACY_KEY = 'fableCitiesSave';
const ACTIVE_KEY = 'fableCitiesActiveWorld';

function clean(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clean);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (['curve', 'base', 'mesh', 'group', 'material', 'geometry', 'api'].includes(k)) continue;
    if (typeof v === 'function') continue;
    try { out[k] = clean(v); } catch {}
  }
  return out;
}
function readWorlds() {
  try { const v = JSON.parse(localStorage.getItem(WORLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}
function writeWorlds(v) { localStorage.setItem(WORLD_KEY, JSON.stringify(v)); }
function makeId() { return 'world-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

export function listWorlds() { return Object.values(readWorlds()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
export function getWorld(id) { return readWorlds()[id] || null; }
export function createWorld(name, seed, mode = 'new') {
  const worlds = readWorlds(), worldId = makeId(), now = Date.now();
  const record = { id: worldId, name: String(name || 'New Fable').trim().slice(0, 28) || 'New Fable', seed: Number.isFinite(seed) ? seed : 1337, mode, createdAt: now, updatedAt: now, data: null };
  worlds[worldId] = record; writeWorlds(worlds); localStorage.setItem(ACTIVE_KEY, worldId); return record;
}
export function renameWorld(worldId, name) {
  const worlds = readWorlds(); if (!worlds[worldId]) return false;
  worlds[worldId].name = String(name || '').trim().slice(0, 28) || worlds[worldId].name;
  worlds[worldId].updatedAt = Date.now(); writeWorlds(worlds); return true;
}
export function deleteWorld(worldId) {
  const worlds = readWorlds(); if (!worlds[worldId]) return false;
  delete worlds[worldId]; writeWorlds(worlds);
  if (localStorage.getItem(ACTIVE_KEY) === worldId) localStorage.removeItem(ACTIVE_KEY);
  return true;
}
export function setActiveWorld(worldId) {
  if (!readWorlds()[worldId]) return false;
  localStorage.setItem(ACTIVE_KEY, worldId); return true;
}
export function getActiveWorldId() { return localStorage.getItem(ACTIVE_KEY) || null; }

function snapshot(world) {
  const paint = world.zones?.api?.getPaint?.() || [];
  return {
    version: 3, seed: world.seed, cityName: world.economy?.cityName || 'New Fable',
    economy: clean(world.economy), time: clean(world.time), env: clean(world.env),
    roads: [...(world.roads?.segments?.values?.() || [])].map(seg => ({
      id: seg.id, type: seg.type || 'local',
      points: (seg.points || []).map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 }))
    })).filter(seg => seg.points.length >= 2),
    zones: paint, buildings: clean(world.buildings?.list || [])
  };
}
export function saveCity(world, worldId = getActiveWorldId()) {
  if (!worldId) return false;
  const worlds = readWorlds(), record = worlds[worldId]; if (!record) return false;
  record.data = snapshot(world); record.name = world.economy?.cityName || record.name; record.updatedAt = Date.now();
  worlds[worldId] = record;
  try { writeWorlds(worlds); return true; } catch (err) { console.error('[SaveSystem] save failed', err); return false; }
}
export function getSavedCity(worldId = getActiveWorldId()) {
  const record = worldId ? getWorld(worldId) : null;
  if (record?.data) return record.data;
  try { const raw = localStorage.getItem(LEGACY_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function restoreRoads(world, data) {
  const roads = world.roads?.api; if (!roads || !Array.isArray(data?.roads)) return false;
  roads.clear();
  for (const saved of data.roads) {
    if (!Array.isArray(saved.points) || saved.points.length < 2) continue;
    try { roads.build(saved.points.map(p => ({ x: p.x, z: p.z })), saved.type || 'local', { curve: 'straight' }); }
    catch (err) { console.error('[SaveSystem] road restore failed', saved, err); }
  }
  roads.flush?.(); return true;
}
export function restoreZones(world, data) {
  const api = world.zones?.api;
  if (!api || !Array.isArray(data?.zones)) return false;
  api.clear();
  const types = new Map([[1, 'res-low'], [2, 'res-high'], [3, 'com-low'], [4, 'com-high'], [5, 'ind'], [6, 'office']]);
  const groups = new Map();
  for (const [key, value] of data.zones) {
    const n = Number(key), type = types.get(Number(value));
    if (!Number.isFinite(n) || !type) continue;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ cx: n % 65536, cz: Math.floor(n / 65536) });
  }
  for (const [type, cells] of groups) api.paint(cells, type);
  api.refresh?.();
  return true;
}
export function restoreBuildings(world, data) {
  const api = world.buildings?.api; if (!api || !Array.isArray(data?.buildings)) return false;
  const lots = world.zones?.api?.lotsFor?.() || world.zones?.lots || [];
  const byLot = new Map(lots.map(lot => [lot.id, lot]));
  for (const saved of data.buildings) {
    const lot = byLot.get(saved.lotId); if (!lot) continue;
    try {
      const b = api.spawn(lot, { level: saved.level, seed: saved.seed, state: saved.state, progress: saved.progress });
      if (b) { b.age = saved.age || 0; b.builtAt = saved.builtAt ?? null; }
    } catch (err) { console.error('[SaveSystem] building restore failed', saved, err); }
  }
  return true;
}
export function applyCityState(world, data) {
  if (!data) return false;
  if (data.economy) Object.assign(world.economy, data.economy);
  if (data.time) Object.assign(world.time, data.time);
  if (data.env) {
    for (const [key, value] of Object.entries(data.env)) {
      const current = world.env[key];
      if (current && typeof current.set === 'function' && value && typeof value === 'object') {
        if ('r' in value && 'g' in value && 'b' in value) current.setRGB(value.r, value.g, value.b);
        else if ('x' in value && 'y' in value && 'z' in value) current.set(value.x, value.y, value.z);
        else world.env[key] = value;
      } else world.env[key] = value;
    }
  }
  if (Number.isFinite(data.seed)) world.seed = data.seed;
  return true;
}
export function importLegacySave() {
  if (listWorlds().length) return;
  let data = null; try { data = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); } catch {}
  if (!data) return;
  const record = createWorld(data.cityName || 'My City', data.seed || 1337);
  const worlds = readWorlds(); worlds[record.id].data = data; writeWorlds(worlds);
}
