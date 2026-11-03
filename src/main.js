import { Config } from './core/Config.js';
import { EventBus } from './core/EventBus.js';
import { Engine } from './core/Engine.js';
import { World } from './core/World.js';
import { Input } from './core/Input.js';
import { CameraController } from './core/CameraController.js';
import { AssetLoader } from './core/AssetLoader.js';
import { installDebugAPI } from './core/DebugAPI.js';
import { MODULES } from './modules/registry.js';
import { makeRng } from './shared/random.js';
import { createWorld, getSavedCity, applyCityState, restoreRoads, restoreZones, restoreBuildings, saveCity } from './core/SaveSystem.js';

const loadingBar = document.getElementById('loading-bar');
const loadingStatus = document.getElementById('loading-status');
let menuModule = null;

const setLoading = (fraction, text) => {
  if (loadingBar) loadingBar.style.width = `${Math.round(fraction * 100)}%`;
  if (loadingStatus && text) loadingStatus.textContent = text;
  try {
    menuModule?.setProgress?.(fraction, text);
  } catch (_) {}
};

async function boot() {
  const canvas = document.getElementById('game');
  const config = new Config();
  const events = new EventBus();
  const engine = new Engine({ canvas, config, events });
  const world = new World(config);
  const assets = new AssetLoader(engine.renderer, events);
  const input = new Input(canvas);
  const cameraController = new CameraController(engine.camera, input, world, canvas);

  const ctx = {
    engine,
    renderer: engine.renderer,
    scene: engine.scene,
    camera: engine.camera,
    world,
    events,
    assets,
    input,
    cameraController,
    config,
    modules: {},
    moduleStatus: {},
    uiRoot: document.getElementById('ui-root'),
  };

  const debug = installDebugAPI(ctx);

  engine.onUpdate(function coreInput(dt) {
    input.beginFrame();
    cameraController.update(dt);
  });

  engine.onAfterRender(() => input.endFrame());
  engine.start();

  if (config.menu) {
    try {
      const menu = await import('./modules/menu/index.js');
      ctx.modules.menu = menu;
      menuModule = menu;
      document.getElementById('loading')?.classList.add('hidden');

      const choice = await menu.showStartScreen(ctx);

      if (choice) {
        if (Number.isFinite(choice.seed)) {
          config.seed = choice.seed;
          world.seed = choice.seed;
          world.rng = makeRng(choice.seed);
        }

        if (choice.cityName) {
          world.economy.cityName = choice.cityName;
        }

        config.demo = choice.mode === 'demo';
        ctx.startChoice = choice;
        events.emit('game:start', choice);
      }

      document.getElementById('loading')?.classList.remove('hidden');
    } catch (err) {
      console.error('[main] start screen failed, continuing without it', err);
      ctx.moduleStatus.menu = {
        ok: false,
        error: String(err && err.stack || err)
      };
    }
  }

  let activeWorldId = null;
  let pendingSaveData = null;
  if (ctx.startChoice && ctx.startChoice.mode === 'load') {
    activeWorldId = ctx.startChoice.worldId;
    pendingSaveData = getSavedCity(activeWorldId);
    if (pendingSaveData) applyCityState(world, pendingSaveData);
  } else if (ctx.startChoice && ctx.startChoice.mode !== 'demo') {
    const record = createWorld(ctx.startChoice.cityName, ctx.startChoice.seed, ctx.startChoice.mode);
    activeWorldId = record.id;
  }

  const list = [...MODULES]
    .sort((a, b) => a.order - b.order)
    .filter((m) => !config.focus || config.focus.includes(m.name));

  let i = 0;

  for (const entry of list) {
    setLoading(
      (i / (list.length + 1)) * 0.9,
      `Loading ${entry.name}`
    );

    const t0 = performance.now();

    try {
      const mod = await entry.load();

      ctx.modules[entry.name] = mod;

      if (typeof mod.init === 'function') {
        await mod.init(ctx);
      }

      if (typeof mod.update === 'function') {
        const fn = (dt, elapsed) => mod.update(dt, elapsed);
        fn.moduleName = entry.name;
        engine.onUpdate(fn);
      }

      ctx.moduleStatus[entry.name] = {
        ok: true,
        ms: Math.round(performance.now() - t0)
      };

      events.emit(`module:ready:${entry.name}`, mod);
    } catch (err) {
      console.error(
        `[main] module "${entry.name}" failed to initialise`,
        err
      );

      ctx.moduleStatus[entry.name] = {
        ok: false,
        error: String(err && err.stack || err)
      };

      debug.errors.push(
        `module ${entry.name}: ${err && err.message}`
      );
    }

    i++;
  }

  events.emit('modules:ready');

  if (config.showcase) {
    const showcases = import.meta.glob('./modules/*/showcase.js');

    for (const name of config.showcase) {
      const key = `./modules/${name}/showcase.js`;

      setLoading(0.91, `Showcase ${name}`);

      try {
        if (!showcases[key]) {
          throw new Error(
            `no showcase.js for module "${name}"`
          );
        }

        const mod = await showcases[key]();

        await mod.showcase(ctx);

        ctx.moduleStatus[`showcase:${name}`] = {
          ok: true
        };
      } catch (err) {
        console.error(
          `[main] showcase "${name}" failed`,
          err
        );

        ctx.moduleStatus[`showcase:${name}`] = {
          ok: false,
          error: String(err && err.stack || err)
        };

        debug.errors.push(
          `showcase ${name}: ${err && err.message}`
        );
      }
    }
  }

  if (config.demo) {
    setLoading(0.92, 'Building city');

    try {
      const { buildDemoCity } = await import('./demo/DemoCity.js');

      await buildDemoCity(ctx);

      ctx.moduleStatus.demo = {
        ok: true
      };
    } catch (err) {
      console.error('[main] demo city failed', err);

      ctx.moduleStatus.demo = {
        ok: false,
        error: String(err && err.stack || err)
      };

      debug.errors.push(
        `demo: ${err && err.message}`
      );
    }
  }

  if (!config.demo && !config.showcase) {
    const spot = findBuildableStart(world);

    if (spot) {
      debug.presets.newcity = {
        target: {
          x: spot.x,
          z: spot.z
        },
        distance: 380,
        yaw: 0.6,
        pitch: 0.62
      };

      config.cam = 'newcity';

      if (config.debug) {
        console.log('[main] new-city start', spot);
      }
    }
  }

  if (pendingSaveData) {
    try {
      if (Number.isFinite(pendingSaveData.seed)) {
        world.seed = pendingSaveData.seed;
        config.seed = pendingSaveData.seed;
        world.rng = makeRng(pendingSaveData.seed);
      }
      restoreRoads(world, pendingSaveData);
      restoreZones(world, pendingSaveData);
      restoreBuildings(world, pendingSaveData);
      events.emit('city:loaded', pendingSaveData);
    } catch (err) {
      console.error('[main] saved city failed to load', err);
    }
  }

  let saveElapsed = 0;
  engine.onUpdate((dt) => {
    if (!activeWorldId || !debug.ready) return;
    saveElapsed += dt;
    if (saveElapsed >= 5) {
      saveElapsed = 0;
      saveCity(world, activeWorldId);
    }
  });
  const saveBeforeExit = () => {
    if (activeWorldId && debug.ready) saveCity(world, activeWorldId);
  };
  window.addEventListener('pagehide', saveBeforeExit);
  window.addEventListener('beforeunload', saveBeforeExit);

  debug.setCamera(config.cam, true) ||
    debug.setCamera('city', true);

  setLoading(1, 'Ready');

  await debug.waitStable(2);

  document.getElementById('loading')?.classList.add('hidden');

  debug.ready = true;

  events.emit('game:ready');

  if (config.debug) {
    console.log('[main] ready', debug.stats());
  }
}

function findBuildableStart(world) {
  const t = world.terrain;

  if (!t || !t.ready || typeof t.getHeight !== 'function') {
    return null;
  }

  const R = world.half * 0.62;
  const STEP = 120;
  const PROBE = 40;

  let best = null;

  for (let cz = -R; cz <= R; cz += STEP) {
    for (let cx = -R; cx <= R; cx += STEP) {
      let dry = 0;
      let total = 0;
      let maxDrop = 0;

      const h0 = t.getHeight(cx, cz);

      if (t.isWater && t.isWater(cx, cz)) {
        continue;
      }

      for (let dz = -200; dz <= 200; dz += PROBE) {
        for (let dx = -200; dx <= 200; dx += PROBE) {
          const x = cx + dx;
          const z = cz + dz;

          total++;

          if (t.isWater && t.isWater(x, z)) {
            continue;
          }

          dry++;

          maxDrop = Math.max(
            maxDrop,
            Math.abs(t.getHeight(x, z) - h0)
          );
        }
      }

      if (!total) {
        continue;
      }

      const dryness = dry / total;

      if (dryness < 0.85) {
        continue;
      }

      const flatness = 1 / (1 + maxDrop / 12);

      const centreBias =
        1 - Math.hypot(cx, cz) / (R * 1.6);

      const score =
        dryness * 0.45 +
        flatness * 0.45 +
        centreBias * 0.10;

      if (!best || score > best.score) {
        best = {
          x: cx,
          z: cz,
          score,
          dryness,
          maxDrop: +maxDrop.toFixed(1)
        };
      }
    }
  }

  return best;
}

boot().catch((err) => {
  console.error('[main] fatal', err);

  const el = document.getElementById('loading-status');

  if (el) {
    el.textContent =
      'Failed to start: ' +
      (err && err.message);
  }
});
