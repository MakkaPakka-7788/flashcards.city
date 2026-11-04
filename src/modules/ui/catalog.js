/**
 * HUD catalogue: tool categories, sub-menu items, zone colours, service buildings, info-view legends,
 * shortcuts. Costs are display values and are forwarded to the tools module in the `tool:select` options.
 * Service ids / costs mirror src/modules/simulation/services.js so `world.services.api.place(type, x, z)`
 * receives the same ids the HUD shows.
 */

/** Cities: Skylines II style zone colour chips (light/dark density). */
export const ZONE_COLORS = {
  'res-low': '#8fd95a',
  'res-high': '#2ea86f',
  'com-low': '#62c6ff',
  'com-high': '#2b6fdc',
  ind: '#f1b634',
  office: '#b57cf0',
};

export const ZONE_LABELS = {
  'res-low': 'Low Density Residential',
  'res-high': 'High Density Residential',
  'com-low': 'Low Density Commercial',
  'com-high': 'High Density Commercial',
  ind: 'Industrial',
  office: 'Office',
};

/** Compact density-last labels for tight rows (selection-panel kind line). */
export const ZONE_SHORT = {
  'res-low': 'Residential · Low',
  'res-high': 'Residential · High',
  'com-low': 'Commercial · Low',
  'com-high': 'Commercial · High',
  ind: 'Industrial',
  office: 'Office',
};

/** `capacity` = vehicles per hour both directions, `upkeep` = ₡ per metre per budget period (display values forwarded to tools). */
export const ROAD_TYPES = {
  street: { label: 'Small Street · Level 1', kind: 'Street', icon: 'road', color: '#c4d0dc', cost: 140, upkeep: 1.5, capacity: 900, width: 9.6, lanes: 2, speed: 40, desc: 'Narrow local street for houses and small shops.' },
  local: { label: 'Two-Lane Road · Level 2', kind: 'Street', icon: 'road', color: '#d3dbe6', cost: 180, upkeep: 2, capacity: 1200, width: 12, lanes: 2, speed: 50, desc: 'Standard street for neighbourhoods and everyday buildings.' },
  avenue: { label: 'Four-Lane Avenue · Level 3', kind: 'Avenue', icon: 'avenue', color: '#8fd0ff', cost: 420, upkeep: 4, capacity: 2800, width: 24, lanes: 4, speed: 60, desc: 'Wide divided avenue for apartments and busy shops.' },
  boulevard: { label: 'Boulevard · Level 4', kind: 'Boulevard', icon: 'avenue', color: '#70b8ed', cost: 680, upkeep: 6, capacity: 3600, width: 31.2, lanes: 4, speed: 65, desc: 'Extra-wide boulevard for large blocks and high-density districts.' },
  grand: { label: 'Grand Avenue · Level 5', kind: 'Grand Avenue', icon: 'avenue', color: '#4c9bd9', cost: 980, upkeep: 9, capacity: 5200, width: 39.6, lanes: 4, speed: 70, desc: 'The widest zonable road. Supports the largest mall plots and tallest apartment blocks.' },
  highway: { label: 'Highway', kind: 'Highway', icon: 'highway', color: '#ffb35c', cost: 900, upkeep: 8, capacity: 6000, width: 32, lanes: 6, speed: 100, desc: 'High-speed, no pedestrians, no zoning. Connect districts and the outside world.' },
  path: { label: 'Pedestrian Path', kind: 'Footpath', icon: 'path', color: '#9fe38f', cost: 60, upkeep: 0.5, capacity: 0, width: 3, lanes: 0, speed: 5, desc: 'Paved walkway for citizens. Boosts land value and park access.' },
};

/** Ids, costs and upkeep match simulation/services.js SERVICE_TYPES. */
export const SERVICES = {
  power: { label: 'Coal Power Plant', icon: 'power', color: '#f4b942', cost: 120000, upkeep: 6400, radius: 640, desc: 'Supplies electricity to homes and businesses within 640 m. Pollutes — keep it away from housing.' },
  water: { label: 'Water Tower', icon: 'water', color: '#4fc3f7', cost: 32000, upkeep: 1500, radius: 480, desc: 'Pumps fresh water to the surrounding district. Serves 6,000 citizens.' },
  sewage: { label: 'Sewage Treatment', icon: 'sewage', color: '#c9a27e', cost: 60000, upkeep: 2800, radius: 600, desc: 'Treats waste water for 7,000 citizens. Place it downwind of housing.' },
  garbage: { label: 'Landfill Site', icon: 'garbage', color: '#9ccc65', cost: 45000, upkeep: 2400, radius: 560, desc: 'Collects household and industrial garbage. Trucks need road access.' },
  police: { label: 'Police Station', icon: 'police', color: '#8c9cf0', cost: 50000, upkeep: 3400, radius: 400, desc: 'Reduces crime and raises land value within 400 m.' },
  fire: { label: 'Fire House', icon: 'fire', color: '#ff7b6b', cost: 42000, upkeep: 3200, radius: 380, desc: 'Fire protection for homes and businesses. Response time matters.' },
  health: { label: 'Medical Clinic', icon: 'health', color: '#ff9fb6', cost: 70000, upkeep: 4800, radius: 420, desc: 'Healthcare for 4,000 citizens. Raises life expectancy and happiness.' },
  education: { label: 'Elementary School', icon: 'education', color: '#ffa726', cost: 55000, upkeep: 4200, radius: 360, desc: 'Educated citizens fill office jobs, earn more and unlock higher building levels.' },
};

/**
 * Info views. `legend` drives the left-side legend panel: a gradient (stops) from `low` to `high`,
 * or categorical `chips`. `stat` names the world.economy field that gives the city average (0..1),
 * `service` maps to a simulation coverage overlay (world.services.api.setInfoView).
 */
export const INFO_VIEWS = {
  traffic: { label: 'Traffic Flow', icon: 'traffic', color: '#ff8a65', desc: 'Colour roads by congestion — green free-flowing, red jammed.', legend: { low: 'Free flow', high: 'Jammed', stops: ['#3ddc84', '#ffd54f', '#ff7043', '#d50000'] }, stat: 'congestion', invert: true },
  landvalue: { label: 'Land Value', icon: 'landvalue', color: '#ffd66b', desc: 'Where the city is worth the most. Parks, water and services raise it.', legend: { low: 'Low', high: 'High', stops: ['#1e3a5f', '#2b8ac6', '#6fe08c', '#ffd66b'] }, stat: 'landValue' },
  pollution: { label: 'Pollution', icon: 'pollution', color: '#b58cff', desc: 'Ground and air pollution from industry, traffic and landfills.', legend: { low: 'Clean', high: 'Toxic', stops: ['#2ea86f', '#c8b560', '#9b6b3f', '#5d2e8c'] }, stat: 'pollution', invert: true },
  happiness: { label: 'Happiness', icon: 'happiness', color: '#6fe08c', desc: 'How content each household is. Fix the red blocks first.', legend: { low: 'Unhappy', high: 'Delighted', stops: ['#ff5252', '#ffc247', '#8fd95a', '#2ea86f'] }, stat: 'happiness' },
  power: { label: 'Electricity', icon: 'power', color: '#f4b942', desc: 'Power plant coverage. Buildings outside the glow have no electricity.', legend: { low: 'No power', high: 'Powered', stops: ['#1b1b2f', '#5a4a1c', '#c99a2e', '#ffe082'] }, stat: 'coverage.power', service: 'power' },
  water: { label: 'Water & Sewage', icon: 'water', color: '#4fc3f7', desc: 'Water tower and sewage treatment coverage.', legend: { low: 'Dry', high: 'Served', stops: ['#1b1b2f', '#1f4d6e', '#2b8ac6', '#8fe0ff'] }, stat: 'coverage.water', service: 'water' },
  zoning: { label: 'Zoning', icon: 'zone', color: '#8fd95a', desc: 'Show all zoned lots and their density.', legend: { chips: Object.entries(ZONE_LABELS).map(([id, label]) => ({ id, label, color: ZONE_COLORS[id] })) } },
};

export const CATEGORIES = [
  {
    id: 'roads', label: 'Roads', icon: 'crossroads', key: '1', color: '#9fc4e8',
    desc: 'Five road levels, from small streets to grand avenues, plus highways and paths.',
    items: Object.entries(ROAD_TYPES).map(([id, r]) => ({
      id, tool: 'road', label: r.label, icon: r.icon, color: r.color, cost: r.cost, unit: '/m', desc: r.desc,
      stats: [`${r.lanes ? r.lanes + ' lanes' : 'walk only'}`, `${r.speed} km/h`, `${r.width} m wide`],
      rows: [
        { k: 'Upkeep', v: `−⁠₡${r.upkeep}/m`, per: true, cls: 'upkeep' },
        { k: 'Capacity', v: r.capacity ? `${r.capacity.toLocaleString('en-US')} veh/h` : 'Pedestrians only' },
      ],
      options: { type: id, cost: r.cost, upkeep: r.upkeep, capacity: r.capacity },
    })),
  },
  {
    id: 'zoning', label: 'Zoning', icon: 'zone', key: '2', color: '#8fd95a',
    desc: 'Paint zones next to roads. Buildings grow where there is demand.',
    items: Object.entries(ZONE_LABELS).map(([id, label]) => ({ id, tool: 'zone', label, icon: zoneIcon(id), color: ZONE_COLORS[id], cost: 0, desc: zoneDesc(id), options: { type: id } })),
  },
  {
    id: 'services', label: 'Services', icon: 'services', key: '3', color: '#4fc3f7',
    desc: 'Power, water, safety, health and education buildings.',
    items: Object.entries(SERVICES).map(([id, s]) => ({ id, tool: 'service', label: s.label, icon: s.icon, color: s.color, cost: s.cost, upkeep: s.upkeep, desc: s.desc, stats: [`${s.radius} m radius`], options: { type: id, cost: s.cost, upkeep: s.upkeep } })),
  },
  {
    id: 'bulldoze', label: 'Bulldoze', icon: 'bulldoze', key: '4', tool: 'bulldoze', hue: 'danger', color: '#ff6b6b',
    desc: 'Demolish roads, buildings and zoning. Refunds 50 % of build cost.', options: { refund: 0.5 },
  },
  {
    id: 'info', label: 'Info Views', icon: 'info', key: '5', color: '#b57cf0',
    desc: 'Overlay city data: traffic, land value, pollution, happiness…',
    items: Object.entries(INFO_VIEWS).map(([id, v]) => ({ id, thumbId: `view:${id}`, tool: 'info', label: v.label, icon: v.icon, color: v.color, cost: null, desc: v.desc, options: { view: id } })),
  },
];

export function zoneIcon(id) {
  return { 'res-low': 'house', 'res-high': 'apartments', 'com-low': 'shop', 'com-high': 'tower', ind: 'industry', office: 'office' }[id] || 'zone';
}
function zoneDesc(id) {
  return {
    'res-low': 'Detached houses and small homes. Quiet streets, families with cars.',
    'res-high': 'Apartment blocks. Dense housing, needs good transit and services.',
    'com-low': 'Corner shops, cafés and small stores serving the neighbourhood.',
    'com-high': 'Malls, hotels and downtown retail. Big traffic, big tax income.',
    ind: 'Factories and warehouses. Jobs for uneducated workers; pollutes.',
    office: 'Clean high-tech jobs for educated citizens. No pollution.',
  }[id];
}

export const SHORTCUTS = [
  { group: 'Camera', keys: [['W', 'A', 'S', 'D'], ['Arrows']], desc: 'Pan the camera' },
  { group: 'Camera', keys: [['Q'], ['E']], desc: 'Rotate left / right' },
  { group: 'Camera', keys: [['R'], ['F']], desc: 'Tilt up / down' },
  { group: 'Camera', keys: [['Wheel']], desc: 'Zoom towards the cursor' },
  { group: 'Camera', keys: [['RMB drag']], desc: 'Orbit' },
  { group: 'Camera', keys: [['MMB drag'], ['Alt', 'LMB']], chord: true, desc: 'Grab-the-ground pan' },
  { group: 'Camera', keys: [['Home']], desc: 'Reset the view' },
  { group: 'Tools', keys: [['1']], desc: 'Roads' },
  { group: 'Tools', keys: [['2']], desc: 'Zoning' },
  { group: 'Tools', keys: [['3']], desc: 'Services' },
  { group: 'Tools', keys: [['4']], desc: 'Bulldoze' },
  { group: 'Tools', keys: [['5']], desc: 'Info views' },
  { group: 'Tools', keys: [['Esc']], desc: 'Cancel tool / close panel' },
  { group: 'Tools', keys: [['Tab']], desc: 'Cycle items in the open sub-menu' },
  { group: 'Simulation', keys: [['Space']], desc: 'Pause / resume' },
  { group: 'Simulation', keys: [['+'], ['−']], desc: 'Faster / slower' },
  { group: 'Simulation', keys: [['Shift', '1-3']], chord: true, desc: 'Speed steps 1 · 2 · 3' },
  { group: 'Interface', keys: [['H']], desc: 'Hide / show the HUD (cinematic)' },
  { group: 'Interface', keys: [['O']], desc: 'Settings' },
  { group: 'Interface', keys: [['N']], desc: 'Notifications' },
  { group: 'Interface', keys: [['?'], ['F1']], desc: 'This shortcut list' },
];

export const WEATHERS = ['clear', 'cloudy', 'rain', 'fog', 'snow'];
export const QUALITIES = ['low', 'medium', 'high', 'ultra'];
