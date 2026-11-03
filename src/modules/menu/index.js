/**
 * menu module — the start screen.
 *
 * Unlike every other module this one is imported DIRECTLY by src/main.js *before* the module loop,
 * so the player's choice of seed reaches the terrain generator. Its `init()` is therefore a no-op:
 * by the time the registry gets here the screen has already been shown and dismissed.
 *
 * Contract (called by core):
 *   showStartScreen(ctx) -> Promise<{ mode:'new'|'demo', seed:number, cityName:string, quality?:string }>
 *   setProgress(fraction, text)   optional, mirrors the core loading bar
 *   hide()
 *
 * The screen is skipped entirely when the URL pins the world (?demo=, ?showcase=, ?headless=),
 * so all screenshot tooling keeps working. See Config.menu.
 *
 * Notes on two deliberate choices:
 *  - The overlay is appended to <body>, not ctx.uiRoot, because core re-shows its own #loading
 *    (z-index 100) as soon as the choice resolves. Sitting above it lets the panel keep showing
 *    progress instead of the player staring at a bare bar.
 *  - The promise resolves on click but the overlay stays up, turns into a loading card and mirrors
 *    core's progress, then fades out on `game:ready`.
 */
import { injectStyles } from './styles.js';
import { suggestName, randomSeed } from './names.js';
import { makeHeightSource } from './heightsource.js';
import { paintRelief } from './Minimap.js';
import { listWorlds, setActiveWorld, importLegacySave } from '../../core/SaveSystem.js';

export const name = 'menu';

const STORE_KEY = 'fable.menu.v2';
const QUALITIES = [
  ['low', 'Low', 'Fastest. No ambient occlusion, no reflections.'],
  ['medium', 'Medium', 'For laptops and integrated graphics.'],
  ['high', 'High', 'Recommended. Soft shadows, AO, water reflections.'],
  ['ultra', 'Ultra', '4K shadows and the longest draw distance.'],
];

let root = null;
let els = null;
let backdrop = null;
let source = null;
let resolveChoice = null;
let progress = { target: 0.02, shown: 0, text: 'Preparing', stamp: 0, timer: 0 };
let observers = [];
let cleanups = [];
let disposed = false;

export async function init() {
  /* the start screen already ran; nothing to do at module-init time */
}

export function update() {}

// -------------------------------------------------------------------------------------- contract

/**
 * Show the start screen and resolve once the player picks a world.
 * `opts.preview` (used by showcase.js) resolves and dismisses instead of entering the loading phase,
 * because in a showcase the world is already built.
 */
export function showStartScreen(ctx, opts = {}) {
  const { world, config, events } = ctx;
  const preview = !!opts.preview;
  disposed = false;
  injectStyles();

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const restored = readStore();
  const currentQuality = config.quality || 'high';
  const seed0 = clampSeed(restored && Number.isFinite(restored.seed) ? restored.seed : config.seed);
  const name0 = (restored && restored.cityName) || '';

  root = document.createElement('div');
  root.className = 'fm-root';
  root.dataset.phase = 'choose';
  root.innerHTML = markup(seed0, suggestName(seed0), name0, currentQuality);
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  els = {
    bg: $('#fm-bg'),
    fallback: $('#fm-bg-fallback'),
    form: $('#fm-form'),
    nameInput: $('#fm-name'),
    seedInput: $('#fm-seed'),
    reroll: $('#fm-reroll'),
    seedmap: $('#fm-seedmap'),
    seedTag: $('#fm-seed-tag'),
    qnote: $('#fm-qnote'),
    newBtn: $('#fm-new'),
    demoBtn: $('#fm-demo'),
    help: $('#fm-help'),
    helpNote: $('#fm-help-note'),
    loadName: $('#fm-load-name'),
    loadMeta: $('#fm-load-meta'),
    bar: $('#fm-bar'),
    status: $('#fm-status-text'),
    pct: $('#fm-pct'),
    applyTxt: $('#fm-apply-txt'),
    foot: $('#fm-foot-seed'),
  };

  // ---- backdrop + seed preview ------------------------------------------------------------
  bootVisuals(seed0, reduced);

  // ---- seed field -------------------------------------------------------------------------
  let mapTimer = 0;
  let bgTimer = 0;
  const onSeedChanged = (seed, immediate) => {
    els.seedTag.textContent = `Seed ${seed}`;
    els.foot.textContent = `Seed ${seed} · 2048 m`;
    if (!els.nameInput.value) els.nameInput.placeholder = suggestName(seed);
    clearTimeout(mapTimer);
    clearTimeout(bgTimer);
    mapTimer = setTimeout(() => refreshSource(seed, 'map'), immediate ? 0 : 140);
    bgTimer = setTimeout(() => refreshSource(seed, 'backdrop'), immediate ? 60 : 460);
  };
  on(els.seedInput, 'input', () => {
    const v = els.seedInput.value.trim();
    if (v === '') return;
    const parsed = parseInt(v, 10);
    const seed = clampSeed(parsed);
    // a number input ignores maxlength, so keep the field honest about what it is generating
    if (!Number.isFinite(parsed) || parsed !== seed) els.seedInput.value = String(seed);
    onSeedChanged(seed, false);
  });
  on(els.seedInput, 'blur', () => {
    const s = clampSeed(parseInt(els.seedInput.value, 10));
    els.seedInput.value = String(s);
    onSeedChanged(s, false);
  });
  on(els.reroll, 'click', () => {
    const s = randomSeed();
    els.seedInput.value = String(s);
    els.reroll.dataset.spin = '1';
    setTimeout(() => { if (els && els.reroll) delete els.reroll.dataset.spin; }, 520);
    onSeedChanged(s, true);
  });

  // ---- quality ----------------------------------------------------------------------------
  const setNote = (q, prefix) => {
    const row = QUALITIES.find((r) => r[0] === q);
    els.qnote.textContent = (prefix || '') + (row ? row[2] : '');
  };
  setNote(currentQuality);
  if (restored && restored.appliedQuality && restored.appliedQuality === currentQuality) {
    setNote(currentQuality, `${cap(currentQuality)} quality applied — `);
    els.qnote.dataset.ok = '1';
    setTimeout(() => { if (els) { setNote(currentQuality); delete els.qnote.dataset.ok; } }, 7000);
  }
  for (const input of root.querySelectorAll('input[name="fm-quality"]')) {
    on(input, 'change', () => {
      const q = input.value;
      setNote(q);
      if (q === currentQuality) return;
      applyQuality(q, ctx);
    });
  }

  // ---- choices ----------------------------------------------------------------------------
  const wasPaused = world.time.paused;
  const choose = (mode) => {
    if (!root || root.dataset.phase !== 'choose') return;
    const seed = clampSeed(parseInt(els.seedInput.value, 10));
    const cityName = (els.nameInput.value || els.nameInput.placeholder || 'New Fable').trim().slice(0, 28);
    world.time.paused = wasPaused;
    if (preview) { setTimeout(hide, 60); }
    else { enterLoading(mode, seed, cityName); watchCoreProgress(events); }
    const choice = { mode, seed, cityName, quality: currentQuality };
    if (resolveChoice) { const r = resolveChoice; resolveChoice = null; r(choice); }
  };
  on(els.newBtn, 'click', () => choose('new'));
  on(els.demoBtn, 'click', () => choose('demo'));

  importLegacySave();
  const savedWorlds = listWorlds();
  if (savedWorlds.length) {
    const section = document.createElement('section');
    section.className = 'fm-saved-worlds';
    const heading = document.createElement('div');
    heading.className = 'fm-saved-worlds__heading';
    heading.textContent = 'Continue a world';
    const note = document.createElement('span');
    note.textContent = 'Saved on this device';
    heading.appendChild(note);
    const list = document.createElement('div');
    list.className = 'fm-saved-worlds__list';
    for (const saved of savedWorlds) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fm-choice fm-saved-world';
      const body = document.createElement('span');
      body.className = 'fm-choice__body';
      const title = document.createElement('span');
      title.className = 'fm-choice__title';
      title.textContent = saved.name || 'Untitled world';
      const desc = document.createElement('span');
      desc.className = 'fm-choice__desc';
      desc.textContent = saved.updatedAt ? new Date(saved.updatedAt).toLocaleString() : 'Saved world';
      body.append(title, desc);
      const arrow = document.createElement('span');
      arrow.className = 'fm-choice__go';
      arrow.textContent = '›';
      button.append(body, arrow);
      button.addEventListener('click', () => {
        if (!setActiveWorld(saved.id)) return;
        world.time.paused = wasPaused;
        enterLoading('load', saved.seed, saved.name);
        watchCoreProgress(events);
        if (resolveChoice) {
          const resolve = resolveChoice;
          resolveChoice = null;
          resolve({ mode: 'load', seed: saved.seed, cityName: saved.name, worldId: saved.id, quality: currentQuality });
        }
      });
      list.appendChild(button);
    }
    section.append(heading, list);
    root.querySelector('.fm-choices')?.after(section);
  }

  on(els.form, 'submit', (e) => { e.preventDefault(); choose('new'); });

  // ---- keyboard -----------------------------------------------------------------------------
  on(root, 'keydown', (e) => {
    if (e.key !== 'Tab' || root.dataset.phase !== 'choose') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  on(window, 'resize', () => { if (backdrop) backdrop.resize(); });

  if (!preview) world.time.paused = true;
  setTimeout(() => { if (els && els.newBtn) els.newBtn.focus({ preventScroll: true }); }, 80);

  return new Promise((resolve) => { resolveChoice = resolve; });
}

/** Mirrors the core loading bar into the panel. Safe to call before or after the choice. */
export function setProgress(fraction, text) {
  if (Number.isFinite(fraction)) {
    progress.target = Math.max(progress.target, Math.min(1, Math.max(0, fraction)));
    progress.stamp = performance.now();
  }
  if (text) progress.text = String(text);
  paintProgress();
}

/** Tear the screen down (fade, then remove). Core may call this; the menu also calls it itself. */
export function hide() {
  if (!root || disposed) return;
  disposed = true;
  const el = root;
  el.dataset.hidden = '1';
  el.setAttribute('aria-hidden', 'true');
  for (const fn of cleanups) { try { fn(); } catch (e) { /* teardown must not throw */ } }
  cleanups = [];
  for (const o of observers) { try { o.disconnect(); } catch (e) { /* idem */ } }
  observers = [];
  clearInterval(progress.timer);
  progress.timer = 0;
  const bd = backdrop;
  backdrop = null;
  root = null;
  els = null;
  setTimeout(() => {
    if (bd) bd.dispose();
    el.remove();
    const canvas = document.getElementById('game');
    if (canvas && document.activeElement === document.body) canvas.focus({ preventScroll: true });
  }, 620);
}

// ------------------------------------------------------------------------------------- internals

function bootVisuals(seed, reduced) {
  makeHeightSource(seed).then(async (src) => {
    if (!root) return;
    source = src;
    paintSeedMap();
    const tier = (window.innerWidth * window.innerHeight) < 620000 || (navigator.hardwareConcurrency || 8) <= 4 ? 'low' : 'high';
    try {
      const { Backdrop } = await import('./Backdrop.js');
      if (!root) return;
      backdrop = new Backdrop(els.bg, { reducedMotion: reduced, tier });
      if (!backdrop.ok) { backdrop = null; return; }
      backdrop.resize();
      await backdrop.setSource(src);
      if (!root || !backdrop) return;
      root.dataset.bg = '1';
      if (!reduced) backdrop.start(); else backdrop.renderOnce();
    } catch (err) {
      // no WebGL for a second context — the CSS sky + the relief chart already carry the screen
      backdrop = null;
      console.info('[menu] 3D backdrop unavailable', err && err.message);
    }
  });
}

function refreshSource(seed, what) {
  makeHeightSource(seed).then((src) => {
    if (!root) return;
    source = src;
    if (what === 'map') paintSeedMap();
    else if (backdrop) backdrop.setSource(src);
  });
}

function paintSeedMap() {
  if (!els || !els.seedmap || !source) return;
  try { paintRelief(els.seedmap, source, { grid: 168 }); } catch (e) { /* preview is decorative */ }
}

function applyQuality(q, ctx) {
  // A reload is the only bulletproof way to change quality: Engine reads it once, at construction.
  writeStore({
    seed: clampSeed(parseInt(els.seedInput.value, 10)),
    cityName: els.nameInput.value.trim(),
    appliedQuality: q,
  });
  root.dataset.phase = 'applying';
  els.applyTxt.textContent = `Applying ${cap(q)} quality…`;
  const url = new URL(window.location.href);
  url.searchParams.set('quality', q);
  setTimeout(() => window.location.replace(url.toString()), 380);
}

function enterLoading(mode, seed, cityName) {
  root.dataset.phase = 'loading';
  els.loadName.textContent = cityName;
  els.loadMeta.textContent = mode === 'demo' ? `Demo city · seed ${seed}` : mode === 'load' ? `Saved world · seed ${seed}` : `Empty map · seed ${seed}`;
  els.help.dataset.emph = '1';
  els.helpNote.textContent = 'Read this while it builds';
  progress = { target: 0.03, shown: 0, text: mode === 'demo' ? 'Waking the city' : 'Shaping the land', stamp: performance.now(), timer: 0 };
  paintProgress();
  if (backdrop) backdrop.stop();          // a still frame costs nothing while the world is built
  progress.timer = setInterval(tickProgress, 180);
  if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
}

function tickProgress() {
  if (!root) return;
  const idle = (performance.now() - progress.stamp) / 1000;
  const creep = Math.min(0.09, idle * 0.018);
  const goal = Math.min(0.99, progress.target + creep);
  progress.shown += (goal - progress.shown) * 0.22;
  paintProgress();
}

function paintProgress() {
  if (!els || !els.bar) return;
  const shown = Math.max(progress.shown, Math.min(progress.target, 0.995));
  progress.shown = shown;
  els.bar.style.width = `${(shown * 100).toFixed(1)}%`;
  els.status.textContent = progress.text;
  els.pct.textContent = `${Math.round(shown * 100)}%`;
}

/**
 * Core does not call setProgress (see docs/requests/menu.md) — it writes into the #loading bar in
 * index.html. Mirror that read-only so the wait after the choice is never a blank screen.
 */
function watchCoreProgress(events) {
  const bar = document.getElementById('loading-bar');
  const status = document.getElementById('loading-status');
  const read = () => {
    const w = bar ? parseFloat(bar.style.width) : NaN;
    setProgress(Number.isFinite(w) ? w / 100 : undefined, status ? prettify(status.textContent) : undefined);
  };
  if (bar && window.MutationObserver) {
    const o = new MutationObserver(read);
    o.observe(bar, { attributes: true, attributeFilter: ['style'] });
    observers.push(o);
  }
  if (status && window.MutationObserver) {
    const o = new MutationObserver(read);
    o.observe(status, { childList: true, characterData: true, subtree: true });
    observers.push(o);
  }
  read();

  const finish = () => { setProgress(1, 'Ready'); setTimeout(hide, 420); };
  if (events && events.on) {
    events.on('game:ready', finish);
    if (events.off) cleanups.push(() => events.off('game:ready', finish));
  }
  // last resort: never leave a player stuck behind the overlay
  const bail = setTimeout(() => { if (root) hide(); }, 120000);
  cleanups.push(() => clearTimeout(bail));
}

function prettify(text) {
  if (!text) return undefined;
  const t = String(text).trim();
  if (!t || t === 'Ready') return t || undefined;
  return /[.…!?]$/.test(t) ? t : `${t}…`;
}

function focusables() {
  if (!root) return [];
  return Array.from(root.querySelectorAll('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  cleanups.push(() => target.removeEventListener(type, fn, opts));
}

function clampSeed(v) {
  const n = Number.isFinite(v) ? Math.abs(Math.round(v)) : 1337;
  return n % 1000000;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function readStore() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORE_KEY);
    return JSON.parse(raw);
  } catch (e) { return null; }
}
function writeStore(obj) {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(obj)); } catch (e) { /* private mode */ }
}

// ------------------------------------------------------------------------------------------ view

function markup(seed, suggested, cityName, quality) {
  const arrow = '<svg class="fm-choice__go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7"/></svg>';
  const q = QUALITIES.map(([id, label]) => `
        <input type="radio" name="fm-quality" id="fm-q-${id}" value="${id}"${id === quality ? ' checked' : ''}>
        <label for="fm-q-${id}">${label}</label>`).join('');

  return `
  <div id="fm-bg-fallback" class="fm-bg-fallback" aria-hidden="true"></div>
  <canvas id="fm-bg" class="fm-bg" aria-hidden="true"></canvas>
  <div class="fm-grade" aria-hidden="true"></div>

  <div class="fm-stage" role="dialog" aria-modal="true" aria-labelledby="fm-title" aria-describedby="fm-tag">
    <div class="fm-left">
      <div class="fm-brand">
        <div class="fm-kicker"><i></i>A city builder in your browser</div>
        <h1 class="fm-title" id="fm-title"><span>Fable</span><span>Cities</span></h1>
        <p class="fm-tag" id="fm-tag">Draw one road across empty land, and a city grows along it — traffic, districts, skyline and all.</p>
      </div>

      <div class="fm-help" id="fm-help">
        <div class="fm-help__hd"><b>Controls</b><em id="fm-help-note">Everything you need</em></div>
        <dl class="fm-keys">
          <dt><span class="fm-k">W</span><span class="fm-k">A</span><span class="fm-k">S</span><span class="fm-k">D</span></dt>
          <dd>Pan across the map</dd>
          <dt><span class="fm-k">Right-drag</span></dt>
          <dd>Rotate and tilt the camera</dd>
          <dt><span class="fm-k">Wheel</span></dt>
          <dd>Zoom in and out</dd>
          <dt><span class="fm-k">1</span><span class="fm-k">2</span><span class="fm-k">3</span><span class="fm-k">4</span></dt>
          <dd>Roads · Zoning · Services · Bulldoze</dd>
          <dt><span class="fm-k">Esc</span></dt>
          <dd>Cancel the current tool</dd>
        </dl>
        <p class="fm-help__tip"><b>Start here</b> Pick the road tool, click a start and an end point on the ground — then zone beside it. Nothing else can be built until a road exists.</p>
      </div>
    </div>

    <div class="fm-panel">
      <form id="fm-form" class="fm-choose" novalidate>
        <div class="fm-panel__hd"><h2>Start a world</h2><span>Step 1 of 1</span></div>

        <div class="fm-fields">
          <div class="fm-field">
            <label for="fm-name">City name</label>
            <input class="fm-input" id="fm-name" type="text" maxlength="28" autocomplete="off"
                   spellcheck="false" placeholder="${escapeAttr(suggested)}" value="${escapeAttr(cityName)}">
          </div>
          <div class="fm-field">
            <label for="fm-seed">Map seed</label>
            <div class="fm-seedrow">
              <input class="fm-input" id="fm-seed" type="number" inputmode="numeric" min="0" max="999999"
                     step="1" autocomplete="off" value="${seed}">
              <button class="fm-icon-btn" id="fm-reroll" type="button" title="Roll a new seed" aria-label="Roll a new map seed">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
              </button>
            </div>
          </div>
        </div>

        <fieldset class="fm-quality">
          <legend class="fm-legend">Graphics quality</legend>
          <div class="fm-seg">${q}</div>
          <p class="fm-qnote" id="fm-qnote"></p>
        </fieldset>

        <div class="fm-choices">
          <button class="fm-choice fm-choice--primary" id="fm-new" type="button">
            <span class="fm-choice__thumb">
              <canvas id="fm-seedmap" width="216" height="156" aria-hidden="true"></canvas>
              <span class="fm-choice__tag" id="fm-seed-tag">Seed ${seed}</span>
            </span>
            <span class="fm-choice__body">
              <span class="fm-choice__title">New city</span>
              <span class="fm-choice__desc">Empty land generated from your seed. You lay the first road.</span>
            </span>${arrow}
          </button>
          <button class="fm-choice" id="fm-demo" type="button">
            <span class="fm-choice__thumb">
              <img src="/assets/menu/demo-city.jpg" alt="" width="640" height="480" loading="eager" decoding="async">
              <span class="fm-choice__tag">Grown city</span>
            </span>
            <span class="fm-choice__body">
              <span class="fm-choice__title">Load demo city</span>
              <span class="fm-choice__desc">Thousands of residents, live traffic and services. Good for a look around.</span>
            </span>${arrow}
          </button>
        </div>

        <div class="fm-foot"><span id="fm-foot-seed">Seed ${seed} · 2048 m</span><span>Three.js r185</span></div>
      </form>

      <div class="fm-load" id="fm-load">
        <div class="fm-load__eyebrow">Building your world</div>
        <div class="fm-load__name" id="fm-load-name">New Fable</div>
        <div class="fm-load__meta" id="fm-load-meta"></div>
        <div class="fm-bar"><i id="fm-bar"></i></div>
        <div class="fm-status" role="status" aria-live="polite">
          <i aria-hidden="true"></i><span id="fm-status-text">Preparing</span><span class="fm-load__pct" id="fm-pct">0%</span>
        </div>
      </div>

      <div class="fm-apply" role="status" aria-live="polite">
        <div class="fm-apply__ring"></div>
        <div class="fm-apply__txt" id="fm-apply-txt">Applying quality…</div>
      </div>
    </div>
  </div>`;
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
