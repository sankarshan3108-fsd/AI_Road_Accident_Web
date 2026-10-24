/* ==========================================================================
   Road scene renderer
   --------------------------------------------------------------------------
   A perspective "traffic camera" view of an illustrative Coimbatore arterial
   road (not an exact map). The camera hangs 6.5 m above the median looking
   down the road. A point (x, y, z) in metres projects to the screen as
        sx = cx + f * x / z          sy = horizonY + f * (camH - y) / z

   Drawing order (painter's algorithm, far to near):
     1. static FAR layer   (cached)  hills, ground, road, markings, buildings
     2. roadside objects beyond the junction (trees, poles, bus stop, people)
     3. cross-street vehicles + main-road vehicles beyond the junction
     4. static NEAR layer  (cached)  buildings before the junction
     5. roadside objects before the junction
     6. main-road vehicles before the junction and median lamp posts
     7. day/night lighting, then sky behind everything ('destination-over')
     8. emissive lights ('lighter'), rain, fog, vignette
   Roadside objects can never hide a vehicle on the carriageway (they are
   always further from the camera's line of sight), which is why this
   simple layering is enough.

   The cached static layers are redrawn only when the weather, visibility or
   lighting changes, so a normal frame is cheap.
   ========================================================================== */
(function (root) {
  'use strict';
  const A = root.SceneAssets;
  const T = root.Traffic;
  const G = T.GEOM;
  const { makeCanvas, rgb, mix, shade, hexToRgb } = A;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- Looks for each weather and lighting option ---------------------------
  const WEATHER_LOOK = {
    sunny:  { top: [63, 142, 219],  bot: [207, 229, 244], sun: 1,    cloud: 0.25, grey: 0,    rain: 0, wet: 0, mist: 0, overcast: 0,    head: 0 },
    cloudy: { top: [124, 152, 180], bot: [212, 220, 228], sun: 0.3,  cloud: 0.85, grey: 0.45, rain: 0, wet: 0, mist: 0, overcast: 0.08, head: 0 },
    rainy:  { top: [92, 110, 129],  bot: [168, 180, 192], sun: 0,    cloud: 1,    grey: 0.9,  rain: 1, wet: 1, mist: 0.15, overcast: 0.18, head: 0.7 },
    foggy:  { top: [182, 191, 199], bot: [222, 226, 229], sun: 0.12, cloud: 0.4,  grey: 0.3,  rain: 0, wet: 0.2, mist: 1, overcast: 0.04, head: 0.8 },
  };
  const LIGHT_LOOK = {
    day:       { mix: 0,    top: [0, 0, 0],    bot: [0, 0, 0],     dark: 0,    darkCol: [30, 36, 46], lamps: 0,   head: 0,   dusk: 0, night: 0 },
    dusk:      { mix: 0.68, top: [52, 70, 111], bot: [242, 158, 92], dark: 0.24, darkCol: [72, 40, 50], lamps: 0.75, head: 0.6, dusk: 1, night: 0.2 },
    nightLit:  { mix: 0.94, top: [10, 18, 34], bot: [46, 47, 66],   dark: 0.72, darkCol: [6, 12, 30],  lamps: 1,   head: 1,   dusk: 0, night: 1 },
    nightDark: { mix: 0.97, top: [5, 9, 19],   bot: [17, 22, 36],   dark: 0.85, darkCol: [3, 6, 16],   lamps: 0,   head: 1,   dusk: 0, night: 1 },
  };
  const ENV_KEYS = ['sun', 'cloud', 'grey', 'rain', 'wet', 'mist', 'dark', 'lamps', 'headlights', 'dusk', 'night', 'visLog', 'wind'];
  const ENV_COLORS = ['skyTop', 'skyBot', 'darkCol'];

  const GLOW_COLORS = {
    head: [255, 244, 222], tail: [255, 46, 34], brake: [255, 36, 24], lamp: [255, 222, 168],
    red: [255, 60, 46], amber: [255, 176, 40], green: [70, 255, 150], window: [255, 200, 130],
  };

  const PASTELS = ['#efe3c8', '#f3d9b1', '#dce6ee', '#f1e4d7', '#e5eedb', '#f6eddc', '#ead8cc', '#dfe2ea', '#f0dc9c', '#d6e6e1', '#f4cfc0', '#e9e4f0'];
  const WALL_COLORS = ['#e8dcc4', '#d9c7a6', '#e6d3bf', '#cfd8d0', '#efe6d0'];

  // ---------------------------------------------------------------------
  // World layout (deterministic, so the street looks the same every visit)
  // ---------------------------------------------------------------------
  function buildLayout(rng) {
    const L = { buildings: [], cross: [], roadside: [], medianLamps: [], potholes: [], cones: [], barricades: [], poles: [], patches: [] };
    let shopIdx = 0;
    const nextShop = () => A.SHOP_SIGNS[shopIdx++ % A.SHOP_SIGNS.length];
    const ranges = [[2, 52.5], [72.5, 395]];

    for (const side of [-1, 1]) {
      for (const [zStart, zEnd] of ranges) {
        let z = zStart;
        while (z < zEnd - 3) {
          let width = 7 + rng() * 9;
          if (zEnd - (z + width) < 5) width = zEnd - z;
          const corner = (zEnd === 52.5 && z + width >= 52.5) || (zStart === 72.5 && z === 72.5);
          const r = rng();
          const kind = corner ? 'shop' : r < 0.56 ? 'shop' : r < 0.86 ? 'house' : 'plot';
          const depth = 10 + rng() * 5;
          const color = PASTELS[Math.floor(rng() * PASTELS.length)];
          if (kind === 'shop') {
            const floors = 2 + Math.floor(rng() * 3);
            L.buildings.push({ side, kind, z0: z, z1: z + width, xIn: G.BUILD_LINE, depth, floors, h: floors * 3.2 + 0.7, color,
              shop: nextShop(), tank: rng() < 0.65, corner });
          } else {
            const wallCol = WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)];
            L.buildings.push({ side, kind: 'wall', z0: z, z1: z + width, xIn: G.BUILD_LINE, depth: 0.25, floors: 1, h: 1.9, color: wallCol });
            if (kind === 'house') {
              const floors = 1 + Math.floor(rng() * 3);
              const setback = 13.6 + rng() * 2;
              L.buildings.push({ side, kind: 'house', z0: z + 1, z1: z + width - 1, xIn: setback, depth, floors, h: floors * 3.1 + 0.6, color, tank: rng() < 0.75 });
            }
            // Trees inside the compound (coconut palms are very common here).
            if (rng() < (kind === 'plot' ? 0.95 : 0.45)) {
              L.roadside.push({ type: 'tree', x: side * (12.4 + rng() * (kind === 'plot' ? 5 : 1)), z: z + width * (0.3 + rng() * 0.4), kind: rng() < 0.65 ? 'palm' : 'neem', v: Math.floor(rng() * 3), phase: rng() * 6 });
            }
          }
          z += width;
        }
      }
      // Avenue trees along the footpath.
      for (let z = 15 + rng() * 6; z < 390; z += 15 + rng() * 12) {
        if (z > 40 && z < 86) continue;
        if (side < 0 && z > G.BUS_STOP_Z[0] - 8 && z < G.BUS_STOP_Z[1] + 8) continue;   // bus stop
        const r = rng();
        L.roadside.push({ type: 'tree', x: side * (9.7 + rng() * 0.4), z, kind: r < 0.42 ? 'neem' : r < 0.6 ? 'rain' : 'palm', v: Math.floor(rng() * 3), phase: rng() * 6 });
      }
    }

    // Far side of the cross street, seen through the junction.
    for (const side of [-1, 1]) {
      let x = 12;
      while (x < 75) {
        const w = 7 + rng() * 7;
        const floors = 1 + Math.floor(rng() * 3);
        L.cross.push({ side, x0: x, x1: x + w, z0: G.CROSS_Z[1] + 2.4, z1: G.CROSS_Z[1] + 14, floors, h: floors * 3.2 + 0.6, color: PASTELS[Math.floor(rng() * PASTELS.length)], shop: nextShop(), tank: rng() < 0.6 });
        x += w;
      }
    }

    // Utility poles (right side) carrying overhead wires.
    for (let z = 12; z < 400; z += 32 + rng() * 6) {
      if (z > 44 && z < 82) continue;
      L.poles.push({ x: 10.35, z });
    }
    for (const p of L.poles) L.roadside.push({ type: 'pole', x: p.x, z: p.z });

    // Median lamp posts with twin arms.
    for (let z = 30; z < 410; z += 34) {
      if (z > 40 && z < 86) continue;
      L.medianLamps.push({ z });
    }

    // Potholes (only drawn when the surface is "Potholes").
    const laneXs = [-5.85, -2.35, 2.35, 5.85];
    for (let i = 0; i < 18; i++) {
      let z = 11 + rng() * 240;
      if (z > 44 && z < 82) z += 40;
      L.potholes.push({ x: laneXs[i % 4] + (rng() - 0.5) * 1.6, z, rx: 0.35 + rng() * 0.45, rz: 0.3 + rng() * 0.45, rot: rng() });
    }
    // Asphalt repair patches (always present: real roads are patched).
    for (let i = 0; i < 9; i++) {
      L.patches.push({ x: laneXs[Math.floor(rng() * 4)] + (rng() - 0.5), z: 14 + rng() * 220, w: 1.2 + rng() * 1.6, l: 2 + rng() * 4 });
    }

    // Work zone: taper of cones into lane 0, then a closed stretch.
    const wz = G.WORK_ZONE;
    for (let z = wz.z0 - 12; z <= wz.z0; z += 1.5) L.cones.push({ x: lerp(-7.3, -4.35, (z - (wz.z0 - 12)) / 12), z });
    for (let z = wz.z0 + 3; z <= wz.z1; z += 3.5) L.cones.push({ x: -4.35, z });
    L.barricades.push({ x0: -7.4, x1: -4.6, z: wz.z0 + 0.6 }, { x0: -7.4, x1: -4.6, z: wz.z1 });

    // Fixed roadside furniture.
    L.roadside.push({ type: 'busStop', x: -9.6, z: G.BUS_STOP_Z[0] });
    L.roadside.push({ type: 'dirBoard', x: -9.2, z: 236 });
    L.roadside.push({ type: 'workSign', x: -8.8, z: wz.z0 - 13 });
    L.roadside.push({ type: 'signalNear', x: -9.1, z: G.STOP_AWAY - 0.6 });
    L.roadside.push({ type: 'signalFar', x: 9.1, z: G.STOP_ON + 1.6 });
    return L;
  }

  // ---------------------------------------------------------------------
  class RoadScene {
    constructor(canvas, sim, opts) {
      this.canvas = canvas;
      this.main = canvas.getContext('2d');
      this.ctx = this.main;
      this.sim = sim;
      this.camH = G.CAMERA_H;
      this.reducedMotion = !!(opts && opts.reducedMotion);
      this.running = false;            // set by the app; splashes only animate while running
      this.decoTime = 0;
      this.lights = []; this.beams = []; this.countdowns = []; this.vehicleList = [];
      const rng = T.mulberry32(7);
      this.sprites = A.buildTreeSprites(rng);
      this.cloudSprites = A.buildCloudSprites(rng);
      this.noise = A.buildNoise(rng, 128);
      this.glows = this.buildGlows();
      this.mistSprite = this.buildMist(rng);
      this.painter = new root.VehiclePainter(this);
      this.layout = buildLayout(T.mulberry32(11));
      this.layout.roadside.sort((a, b) => b.z - a.z);
      this.cloudList = Array.from({ length: 11 }, (_, i) => ({ x: rng() * 1.3 - 0.15, y: 0.08 + rng() * 0.5, s: 0.55 + rng() * 0.9, shape: i % 4, speed: 0.004 + rng() * 0.006, order: rng() }))
        .sort((a, b) => a.order - b.order);
      this.walkers = this.makeWalkers(T.mulberry32(5));
      this.conditions = { weather: 'sunny', lighting: 'day', visibility: 2000, surface: 'dry', density: 40 };
      this.env = this.targetEnv(this.conditions);
      this.envTarget = this.targetEnv(this.conditions);
      this.staticKey = '';
      this.buildTextures();
      this.resize();
    }

    // ---- assets -----------------------------------------------------------
    buildGlows() {
      const out = {};
      for (const [k, c] of Object.entries(GLOW_COLORS)) {
        const cv = makeCanvas(64, 64);
        const g = cv.getContext('2d');
        const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grd.addColorStop(0, rgb(mix(c, [255, 255, 255], 0.6), 1));
        grd.addColorStop(0.18, rgb(c, 0.85));
        grd.addColorStop(0.45, rgb(c, 0.25));
        grd.addColorStop(1, rgb(c, 0));
        g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
        out[k] = cv;
      }
      return out;
    }

    buildMist(rng) {
      const c = makeCanvas(1024, 200);
      const g = c.getContext('2d');
      for (let i = 0; i < 70; i++) {
        const x = rng() * 1024, y = 60 + rng() * 90, r = 40 + rng() * 90;
        for (const dx of [-1024, 0, 1024]) {          // tile seamlessly
          const grd = g.createRadialGradient(x + dx, y, 0, x + dx, y, r);
          grd.addColorStop(0, 'rgba(255,255,255,0.32)');
          grd.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grd; g.fillRect(x + dx - r, y - r, r * 2, r * 2);
        }
      }
      // Fade the top and bottom edges so the bands never show a hard line.
      const mask = g.createLinearGradient(0, 0, 0, c.height);
      mask.addColorStop(0, 'rgba(0,0,0,0)'); mask.addColorStop(0.35, 'rgba(0,0,0,1)');
      mask.addColorStop(0.7, 'rgba(0,0,0,1)'); mask.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = mask; g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-over';
      return c;
    }

    /** (Re)builds facade textures. Called again once web fonts have loaded. */
    buildTextures() {
      const rng = T.mulberry32(23);
      for (const b of this.layout.buildings) {
        const width = b.z1 - b.z0;
        if (b.kind === 'wall') { b.tex = A.buildWall(width, b.h, b.color, rng); continue; }
        b.tex = A.buildFacade({ widthM: width, heightM: b.h, floors: b.floors, color: b.color, shop: b.kind === 'shop' ? b.shop : null, rng });
        b.texFront = A.buildFacade({ widthM: b.depth, heightM: b.h, floors: b.floors, color: b.color, shop: b.corner ? b.shop : null, rng, isFront: true });
      }
      for (const b of this.layout.cross) {
        b.tex = A.buildFacade({ widthM: b.x1 - b.x0, heightM: b.h, floors: b.floors, color: b.color, shop: b.shop, rng });
      }
      this.signs = {
        busStop: A.buildSign([{ text: 'பேருந்து நிறுத்தம்', tamil: true, scale: 0.6 }, { text: 'BUS STOP', scale: 0.6 }], { w: 240, h: 90, bg: '#1d5e9e', fg: '#ffffff' }),
        poster: A.buildSign([{ text: 'தலைக்கவசம் அணிவோம்', tamil: true, scale: 0.5 }, { text: 'WEAR A HELMET', scale: 0.42 }, { text: 'Road Safety Week', scale: 0.32, weight: 500 }], { w: 260, h: 150, bg: '#f7f3ea', fg: '#7a1d1d', border: '#c0392b' }),
        dirBoard: A.buildSign([
          { text: '↑  காந்திபுரம்  Gandhipuram', tamil: true, scale: 0.5, align: 'left' },
          { text: '←  டவுன் ஹால்  Town Hall', tamil: true, scale: 0.5, align: 'left' },
          { text: 'பீளமேடு  Peelamedu  →', tamil: true, scale: 0.5, align: 'right' },
        ], { w: 420, h: 220, bg: '#1f5aa6', fg: '#ffffff', border: '#ffffff' }),
        workSign: A.buildSign([{ text: 'MEN AT WORK', scale: 0.5 }, { text: 'வேலை நடைபெறுகிறது', tamil: true, scale: 0.4 }], { w: 260, h: 110, bg: '#f2c230', fg: '#1d1d1d', border: '#1d1d1d' }),
      };
      this.staticKey = '';
    }

    makeWalkers(rng) {
      const shirts = ['#c0392b', '#2e86c1', '#f4d03f', '#8e44ad', '#16a085', '#ecf0f1', '#d35400', '#7f8c8d', '#e84393'];
      const out = [];
      for (let i = 0; i < 12; i++) {
        const side = i % 2 ? 1 : -1;
        const seg = rng() < 0.55 ? [9, 47] : [80, 250];
        out.push({
          side, x: side * (9.0 + rng() * 1.2), seg, z: seg[0] + rng() * (seg[1] - seg[0]),
          dir: rng() < 0.5 ? 1 : -1, speed: 1.0 + rng() * 0.5, phase: rng() * 6,
          shirt: shirts[Math.floor(rng() * shirts.length)], saree: rng() < 0.35, active: i,
        });
      }
      return out;
    }

    // ---- sizing -----------------------------------------------------------
    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const cssW = Math.max(280, rect.width || 960), cssH = Math.max(200, rect.height || 540);
      let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (cssW * cssH * dpr * dpr > 2.4e6) dpr = Math.sqrt(2.4e6 / (cssW * cssH));
      this.W = Math.round(cssW * dpr);
      this.H = Math.round(cssH * dpr);
      this.canvas.width = this.W;
      this.canvas.height = this.H;
      this.cx = this.W / 2;
      this.hy = this.H * 0.43;
      this.f = ((this.H - this.hy) * 9.5) / this.camH;   // ground at z = 9.5 m touches the bottom edge
      this.staticFar = makeCanvas(this.W, this.H);
      this.staticNear = makeCanvas(this.W, this.H);
      this.lightsLayer = makeCanvas(this.W / 2, this.H / 2);
      this.lampLayer = makeCanvas(this.W / 2, this.H / 2);
      this.vignette = this.buildVignette();
      this.initRain();
      this.staticKey = '';
    }

    buildVignette() {
      const c = makeCanvas(this.W, this.H);
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(this.W / 2, this.H * 0.55, Math.min(this.W, this.H) * 0.35, this.W / 2, this.H * 0.55, Math.max(this.W, this.H) * 0.78);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, 'rgba(8,12,20,0.28)');
      g.fillStyle = grd; g.fillRect(0, 0, this.W, this.H);
      return c;
    }

    initRain() {
      const n = Math.round(520 * (this.W * this.H) / (1600 * 900));
      this.rain = [];
      for (let i = 0; i < n; i++) {
        this.rain.push({ x: Math.random() * this.W, y: Math.random() * this.H, len: 0.6 + Math.random() * 0.8, spd: 0.8 + Math.random() * 0.5 });
      }
    }

    // ---- projection & fog ------------------------------------------------------
    proj(x, y, z) {
      const s = this.f / z;
      return [this.cx + x * s, this.hy + (this.camH - y) * s];
    }
    get visibility() { return Math.exp(this.env.visLog); }
    /** Fraction of fog colour mixed in at distance z (Koschmieder's law: 5% contrast left at the visibility distance). */
    fogAt(z) { return 1 - Math.exp((-3.0 * z) / this.visibility); }

    // ---- weather & lighting targets -------------------------------------------
    targetEnv(c) {
      const w = WEATHER_LOOK[c.weather] || WEATHER_LOOK.sunny;
      const l = LIGHT_LOOK[c.lighting] || LIGHT_LOOK.day;
      const skyTop = mix(w.top, l.top, l.mix);
      let skyBot = mix(w.bot, l.bot, l.mix);
      if (c.weather === 'foggy' && l.mix > 0) skyBot = mix(skyBot, [150, 150, 158], 0.25 * (1 - l.night));
      const dark = 1 - (1 - l.dark) * (1 - w.overcast);
      return {
        skyTop, skyBot,
        darkCol: l.mix > 0 ? l.darkCol : [32, 38, 48],
        sun: w.sun * (l.dusk ? 0.6 : 1) * (1 - l.night),
        cloud: w.cloud, grey: w.grey, rain: w.rain,
        wet: Math.max(w.wet, c.surface === 'wet' ? 0.85 : 0),
        mist: w.mist, dark,
        lamps: l.lamps, headlights: Math.max(l.head, w.head),
        dusk: l.dusk, night: l.night,
        visLog: Math.log(clamp(c.visibility, 50, 2000)),
        wind: c.weather === 'rainy' ? 1 : c.weather === 'cloudy' ? 0.6 : 0.35,
      };
    }

    setConditions(c) {
      const prevSurface = this.conditions.surface;
      Object.assign(this.conditions, c);
      this.envTarget = this.targetEnv(this.conditions);
      if (this.reducedMotion) this.env = JSON.parse(JSON.stringify(this.envTarget));
      if (prevSurface !== this.conditions.surface) this.staticKey = '';
    }

    isTransitioning() {
      for (const k of ENV_KEYS) if (Math.abs(this.env[k] - this.envTarget[k]) > 0.004) return true;
      for (const k of ENV_COLORS) for (let i = 0; i < 3; i++) if (Math.abs(this.env[k][i] - this.envTarget[k][i]) > 0.6) return true;
      return false;
    }

    /** realDt drives weather transitions; simDt (0 when paused) drives clouds, rain, sway and walkers. */
    update(realDt, simDt) {
      const k = 1 - Math.exp(-realDt / 0.55);
      for (const key of ENV_KEYS) this.env[key] = lerp(this.env[key], this.envTarget[key], k);
      for (const key of ENV_COLORS) this.env[key] = this.env[key].map((v, i) => lerp(v, this.envTarget[key][i], k));
      if (!this.isTransitioning()) {
        for (const key of ENV_KEYS) this.env[key] = this.envTarget[key];
        for (const key of ENV_COLORS) this.env[key] = this.envTarget[key].slice();
      }
      if (simDt > 0) {
        this.decoTime += simDt;
        if (!this.reducedMotion) {
          for (const c of this.cloudList) { c.x += c.speed * simDt * (0.6 + this.env.wind); if (c.x > 1.25) c.x -= 1.5; }
          const fall = this.H * 1.6 * simDt;
          for (const d of this.rain) {
            d.y += fall * d.spd; d.x -= fall * d.spd * 0.12;
            if (d.y > this.H) { d.y -= this.H + 40; d.x = Math.random() * (this.W + 80); }
          }
        }
        for (const w of this.walkers) {
          w.z += w.dir * w.speed * simDt;
          w.phase += simDt * w.speed * 5.2;
          if (w.z > w.seg[1]) w.z = w.seg[0];
          if (w.z < w.seg[0]) w.z = w.seg[1];
        }
      }
      // Fog colour, compensated so that after the darkness overlay it matches the horizon sky.
      const a = this.env.dark;
      const sb = this.env.skyBot, dc = this.env.darkCol;
      this.fogCol = a < 0.999 ? [0, 1, 2].map(i => clamp((sb[i] - dc[i] * a) / (1 - a), 0, 255)) : sb;
      if (this.env.mist > 0.01) this.fogCol = mix(this.fogCol, mix([226, 229, 232], this.fogCol, Math.min(1, a * 1.2)), this.env.mist * 0.5);
    }

    staticKeyNow() {
      const e = this.env;
      return [Math.round(e.visLog * 60), Math.round(e.wet * 25), Math.round(e.sun * 20), Math.round(e.mist * 20),
        this.fogCol.map(v => Math.round(v / 3)).join('.'), this.conditions.surface, this.W, this.H].join('|');
    }

    // ======================================================================
    // Static layers
    // ======================================================================
    renderStatic() {
      const key = this.staticKeyNow();
      if (key === this.staticKey) return;
      this.staticKey = key;
      const far = this.staticFar.getContext('2d');
      const near = this.staticNear.getContext('2d');
      far.clearRect(0, 0, this.W, this.H);
      near.clearRect(0, 0, this.W, this.H);
      this.ctx = far;
      this.drawHills(far);
      this.drawGround(far);
      this.drawCrossStreet(far);
      this.drawRoad(far);
      this.drawShadows(far);
      this.drawBuildings(far, b => b.z0 >= 54, true);
      this.ctx = near;
      this.drawBuildings(near, b => b.z0 < 54, false);
      this.renderLightLayers();
      this.ctx = this.main;
    }

    // ---- hills and distant skyline ----
    drawHills(g) {
      const e = this.env;
      const hillA = clamp((this.visibility - 250) / 1500, 0, 1) * (1 - e.mist * 0.85);
      const layers = [
        { col: [96, 122, 146], haze: 0.5, amp: 0.15, base: 0.012, seed: 1.3, left: 1.0 },  // Western Ghats, distant blue ridges
        { col: [84, 108, 112], haze: 0.32, amp: 0.06, base: 0.006, seed: 4.1, left: 0.4 },
      ];
      for (const L of layers) {
        if (hillA <= 0.01) break;
        g.globalAlpha = hillA;
        g.fillStyle = rgb(mix(L.col, this.fogCol, L.haze));
        g.beginPath();
        g.moveTo(0, this.hy + 2);
        for (let x = 0; x <= this.W; x += 6) {
          const t = x / this.W;
          const westBias = 1 - t * L.left * 0.75;     // ridges rise towards the west (left)
          const n = Math.sin(t * 7.1 + L.seed) * 0.5 + Math.sin(t * 17.3 + L.seed * 2) * 0.28 + Math.sin(t * 41 + L.seed) * 0.1 + 0.6;
          g.lineTo(x, this.hy - this.H * (L.base + L.amp * n * westBias * 0.55));
        }
        g.lineTo(this.W, this.hy + 2);
        g.closePath(); g.fill();
      }
      g.globalAlpha = 1;
      // Distant tree line and rooftops at the end of the street.
      const zf = 520;
      const col = mix([70, 92, 64], this.fogCol, this.fogAt(zf));
      const bcol = mix([196, 186, 170], this.fogCol, this.fogAt(zf));
      const rng = T.mulberry32(99);
      for (let x = -260; x < 260; x += 4 + rng() * 9) {
        const tree = rng() < 0.6;
        const h = tree ? 7 + rng() * 9 : 5 + rng() * 12, w = tree ? 5 + rng() * 6 : 6 + rng() * 10;
        const p0 = this.proj(x, 0, zf), p1 = this.proj(x + w, h, zf);
        g.fillStyle = rgb(tree ? col : bcol);
        if (tree) { g.beginPath(); g.ellipse((p0[0] + p1[0]) / 2, p1[1] + (p0[1] - p1[1]) * 0.35, (p1[0] - p0[0]) / 2, (p0[1] - p1[1]) * 0.6, 0, 0, Math.PI * 2); g.fill(); }
        else g.fillRect(p0[0], p1[1], p1[0] - p0[0], p0[1] - p1[1]);
      }
    }

    /** Vertical gradient for anything lying flat on the ground, fogged by distance. */
    depthGradient(g, col) {
      const grd = g.createLinearGradient(0, this.hy, 0, this.H);
      for (const z of [G.Z_FAR, 300, 200, 130, 80, 50, 30, 18, 12, 9.5]) {
        const y = this.hy + (this.f * this.camH) / z;
        grd.addColorStop(clamp((y - this.hy) / (this.H - this.hy), 0, 1), rgb(mix(col, this.fogCol, this.fogAt(z))));
      }
      return grd;
    }

    groundQuad(g, x0, x1, z0, z1, style) {
      z0 = Math.max(z0, 5); z1 = Math.max(z1, 5);      // never project points behind the camera
      if (z1 <= z0) return;
      const a = this.proj(x0, 0, z0), b = this.proj(x1, 0, z0), c = this.proj(x1, 0, z1), d = this.proj(x0, 0, z1);
      g.fillStyle = style;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]); g.closePath(); g.fill();
    }

    drawGround(g) {
      const wet = this.env.wet;
      const earth = mix([156, 128, 98], [104, 88, 72], wet * 0.7);
      g.fillStyle = this.depthGradient(g, earth);
      g.fillRect(0, this.hy, this.W, this.H - this.hy);
    }

    drawCrossStreet(g) {
      const wet = this.env.wet;
      const asphalt = mix([96, 99, 104], [62, 66, 73], wet);
      const z0 = G.CROSS_Z[0], z1 = G.CROSS_Z[1];
      for (const s of [-1, 1]) {
        this.groundQuad(g, s * 8.3, s * 140, z0 - 2, z0, rgb(mix([178, 170, 158], this.fogCol, this.fogAt(z0))));
        this.groundQuad(g, s * 8.3, s * 140, z1, z1 + 2.4, rgb(mix([178, 170, 158], this.fogCol, this.fogAt(z1))));
      }
      this.groundQuad(g, -140, 140, z0, z1, rgb(mix(asphalt, this.fogCol, this.fogAt((z0 + z1) / 2))));
      // Centre line of the cross street (broken white).
      const zc = (z0 + z1) / 2;
      for (let x = -140; x < 140; x += 6) {
        if (Math.abs(x) < G.ROAD_EDGE + 1) continue;
        this.groundQuad(g, x, x + 3, zc - 0.08, zc + 0.08, rgb(mix([226, 226, 220], this.fogCol, this.fogAt(zc))));
      }
    }

    drawRoad(g) {
      const e = this.env;
      const Z0 = 6, Z1 = G.Z_FAR;
      const asphalt = mix([94, 97, 102], [58, 62, 70], e.wet);
      const footpath = mix([184, 176, 162], [140, 136, 130], e.wet * 0.6);
      const shoulder = mix([150, 138, 118], [108, 102, 94], e.wet * 0.6);
      for (const s of [-1, 1]) {
        this.groundQuad(g, s * G.FOOTPATH_OUT, s * G.BUILD_LINE, Z0, Z1, this.depthGradient(g, mix([138, 112, 84], [96, 82, 68], e.wet)));
        this.groundQuad(g, s * G.FOOTPATH_IN, s * G.FOOTPATH_OUT, Z0, Z1, this.depthGradient(g, footpath));
        this.groundQuad(g, s * G.ROAD_EDGE, s * G.FOOTPATH_IN, Z0, Z1, this.depthGradient(g, shoulder));
      }
      // Re-draw the cross street over the footpaths.
      this.drawCrossStreet(g);
      // Main carriageway.
      const roadPath = new Path2D();
      const a = this.proj(-G.ROAD_EDGE, 0, Z0), b = this.proj(G.ROAD_EDGE, 0, Z0), c = this.proj(G.ROAD_EDGE, 0, Z1), d = this.proj(-G.ROAD_EDGE, 0, Z1);
      roadPath.moveTo(a[0], a[1]); roadPath.lineTo(b[0], b[1]); roadPath.lineTo(c[0], c[1]); roadPath.lineTo(d[0], d[1]); roadPath.closePath();
      g.fillStyle = this.depthGradient(g, asphalt);
      g.fill(roadPath);
      g.save();
      g.clip(roadPath);
      // Asphalt grain.
      g.globalAlpha = 0.55 * (1 - e.wet * 0.4);
      g.fillStyle = g.createPattern(this.noise, 'repeat');
      g.fillRect(0, this.hy, this.W, this.H - this.hy);
      g.globalAlpha = 1;
      // Tyre-polished wheel tracks in every lane.
      for (const lx of [-5.85, -2.35, 2.35, 5.85]) {
        for (const o of [-0.78, 0.78]) {
          g.globalAlpha = 0.1;
          this.groundQuad(g, lx + o - 0.32, lx + o + 0.32, Z0, 300, 'rgb(40,42,46)');
        }
      }
      g.globalAlpha = 1;
      for (const p of this.layout.patches) {
        g.globalAlpha = 0.5;
        this.groundQuad(g, p.x - p.w / 2, p.x + p.w / 2, p.z, p.z + p.l, rgb(mix(shade(asphalt, 0.82), this.fogCol, this.fogAt(p.z))));
      }
      g.globalAlpha = 1;
      // Wet road: sky reflection sheen, strongest towards the horizon.
      if (e.wet > 0.02) {
        const sheen = g.createLinearGradient(0, this.hy, 0, this.H);
        sheen.addColorStop(0, rgb(this.fogCol, 0.55 * e.wet));
        sheen.addColorStop(0.35, rgb(this.fogCol, 0.18 * e.wet));
        sheen.addColorStop(1, rgb(this.fogCol, 0.04 * e.wet));
        g.fillStyle = sheen;
        g.fillRect(0, this.hy, this.W, this.H - this.hy);
      }
      g.restore();

      this.drawMarkings(g);
      if (this.conditions.surface === 'potholes') this.drawPotholes(g);
      this.drawMedian(g);
      this.drawKerbs(g);
      if (this.conditions.surface === 'construction') this.drawWorkZone(g);
      this.drawBusStopPeople(g);
    }

    paint(z) { return rgb(mix([232, 232, 226], this.fogCol, this.fogAt(z))); }

    drawMarkings(g) {
      const e = this.env;
      g.globalAlpha = 0.92 - e.wet * 0.15;
      // Solid edge lines.
      for (const s of [-1, 1]) {
        for (let z = 6; z < G.Z_FAR; z += 20) {
          if (z + 20 > G.ZEBRA_AWAY[0] && z < G.ZEBRA_ON[1]) continue;
          this.groundQuad(g, s * 7.3, s * 7.45, z, z + 20, this.paint(z));
        }
      }
      // Broken lane lines: 3 m dash, 4.5 m gap (urban practice).
      for (const lx of [-4.1, 4.1]) {
        for (let z = 6; z < G.Z_FAR; z += 7.5) {
          if (z > G.STOP_AWAY - 18 && z < G.STOP_ON + 1) continue;
          this.groundQuad(g, lx - 0.075, lx + 0.075, z, z + 3, this.paint(z));
        }
      }
      // Solid lines approaching the junction (no lane changing).
      this.groundQuad(g, -4.17, -4.03, G.STOP_AWAY - 18, G.STOP_AWAY, this.paint(G.STOP_AWAY - 9));
      this.groundQuad(g, 4.03, 4.17, G.STOP_ON, G.STOP_ON + 18, this.paint(G.STOP_ON + 9));
      // Stop lines.
      this.groundQuad(g, -G.ROAD_EDGE, -G.MEDIAN_HALF, G.STOP_AWAY - 0.3, G.STOP_AWAY, this.paint(G.STOP_AWAY));
      this.groundQuad(g, G.MEDIAN_HALF, G.ROAD_EDGE, G.STOP_ON, G.STOP_ON + 0.3, this.paint(G.STOP_ON));
      // Zebra crossings: bars run along the direction of traffic.
      for (const [z0, z1] of [G.ZEBRA_AWAY, G.ZEBRA_ON]) {
        for (let x = -G.ROAD_EDGE + 0.2; x < G.ROAD_EDGE - 0.3; x += 1.0) {
          this.groundQuad(g, x, x + 0.5, z0, z1, this.paint(z0));
        }
      }
      // Straight-ahead arrows before the junction (and for oncoming lanes beyond it).
      for (const lx of [-5.85, -2.35]) this.arrow(g, lx, 30, 1);
      for (const lx of [2.35, 5.85]) this.arrow(g, lx, 96, -1);
      g.globalAlpha = 1;
    }

    arrow(g, x, z, dir) {
      const pts = [[-0.15, 0], [0.15, 0], [0.15, 3.2], [0.45, 3.2], [0, 5], [-0.45, 3.2], [-0.15, 3.2]];
      g.fillStyle = this.paint(z);
      g.beginPath();
      pts.forEach(([px, pz], i) => {
        const p = this.proj(x + px, 0, z + dir * pz);
        if (i === 0) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]);
      });
      g.closePath(); g.fill();
    }

    drawPotholes(g) {
      const e = this.env;
      for (const p of this.layout.potholes) {
        const fz = this.fogAt(p.z);
        const ring = (scale, col) => {
          g.fillStyle = rgb(mix(col, this.fogCol, fz));
          g.beginPath();
          for (let i = 0; i <= 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            const wob = 1 + 0.18 * Math.sin(a * 3 + p.rot * 6);
            const q = this.proj(p.x + Math.cos(a) * p.rx * scale * wob, 0, p.z + Math.sin(a) * p.rz * scale * wob);
            if (i === 0) g.moveTo(q[0], q[1]); else g.lineTo(q[0], q[1]);
          }
          g.fill();
        };
        ring(1.15, [118, 112, 104]);                      // broken edge / gravel
        ring(1.0, [44, 42, 40]);                          // the hole
        if (e.wet > 0.3) ring(0.8, mix([44, 42, 40], this.fogCol, 0.55 * e.wet));   // water-filled
      }
    }

    drawMedian(g) {
      const p = this.painter;
      p.fz = 0;
      const segs = [[6, G.STOP_AWAY - 1.5], [G.STOP_ON + 1.5, G.Z_FAR]];
      for (const [z0, z1] of segs) {
        // Raised median: black/white painted kerb faces and planted top.
        for (let z = z0; z < z1; z += z < 80 ? 1 : 4) {
          const zz = Math.min(z1, z + (z < 80 ? 1 : 4));
          p.fz = this.fogAt(z);
          const stripe = z < 80 ? (Math.floor(z) % 2 === 0) : false;
          const kerb = stripe ? [30, 30, 30] : [228, 228, 222];
          p.poly(p.faceX(-G.MEDIAN_HALF, z, zz, 0, 0.22), p.col(kerb, 0.85));
          p.poly(p.faceX(G.MEDIAN_HALF, z, zz, 0, 0.22), p.col(kerb, 0.85));
          p.poly(p.faceY(0.22, -G.MEDIAN_HALF, G.MEDIAN_HALF, z, zz), p.col([96, 128, 70], 1));
        }
        p.fz = this.fogAt(z0);
        p.poly(p.faceZ(z0, -G.MEDIAN_HALF, G.MEDIAN_HALF, 0, 0.22), p.col([228, 228, 222], 0.95));
        // Low oleander / bougainvillea shrubs on the median.
        for (let z = z0 + 2; z < z1 - 1; z += 3.2) {
          const fz = this.fogAt(z);
          const spr = this.sprites.shrub[Math.floor(z) % 2];
          const q = this.proj(0, 0.2, z);
          const s = this.f / z;
          g.globalAlpha = 1 - fz;
          g.drawImage(spr.canvas, q[0] - (spr.worldW * 0.42 * s) / 2, q[1] - spr.worldH * 0.62 * s, spr.worldW * 0.42 * s, spr.worldH * 0.62 * s);
        }
        g.globalAlpha = 1;
      }
    }

    drawKerbs(g) {
      const p = this.painter;
      for (const s of [-1, 1]) {
        for (let z = 6; z < G.Z_FAR; z += z < 90 ? 1 : 5) {
          if (z > G.CROSS_Z[0] - 2 && z < G.CROSS_Z[1] + 2.4) continue;
          const zz = z + (z < 90 ? 1 : 5);
          p.fz = this.fogAt(z);
          const yellow = z < 90 && Math.floor(z) % 2 === 0;
          p.poly(p.faceX(s * G.FOOTPATH_IN, z, zz, 0, 0.18), p.col(yellow ? [222, 186, 40] : [36, 36, 36], 0.9));
        }
      }
    }

    drawWorkZone(g) {
      const p = this.painter;
      const wz = G.WORK_ZONE;
      p.fz = this.fogAt(wz.z0);
      // Excavated strip with gravel.
      p.poly(p.faceY(0.01, -7.2, -4.7, wz.z0 + 2, wz.z1 - 2), p.col([128, 102, 78]));
      p.poly(p.faceY(0.02, -6.8, -5.2, wz.z0 + 6, wz.z1 - 8), p.col([92, 74, 58]));
      for (const c of this.layout.cones) {
        p.fz = this.fogAt(c.z);
        p.box(c.x - 0.18, c.x + 0.18, 0, 0.06, c.z - 0.18, c.z + 0.18, [30, 30, 30]);
        p.box(c.x - 0.11, c.x + 0.11, 0.06, 0.72, c.z - 0.1, c.z + 0.1, [238, 108, 30], { top: 1 });
        p.poly(p.faceZ(c.z - 0.1, c.x - 0.1, c.x + 0.1, 0.36, 0.5), p.col([245, 245, 240]));
      }
      for (const b of this.layout.barricades) {
        p.fz = this.fogAt(b.z);
        p.box(b.x0, b.x0 + 0.1, 0, 1.1, b.z - 0.05, b.z + 0.05, [60, 60, 60]);
        p.box(b.x1 - 0.1, b.x1, 0, 1.1, b.z - 0.05, b.z + 0.05, [60, 60, 60]);
        const n = 7;
        for (let i = 0; i < n; i++) {
          const x0 = lerp(b.x0, b.x1, i / n), x1 = lerp(b.x0, b.x1, (i + 1) / n);
          p.poly(p.faceZ(b.z - 0.06, x0, x1, 0.65, 1.0), p.col(i % 2 ? [240, 240, 236] : [204, 40, 40]));
        }
      }
      // Two workers in high-visibility vests.
      this.person(g, -6.2, wz.z0 + 9, { shirt: '#ff7a1a', phase: 0, still: true, helmet: '#f2c230' });
      this.person(g, -5.6, wz.z0 + 16, { shirt: '#ff7a1a', phase: 1, still: true, helmet: '#f2c230' });
    }

    drawBusStopPeople(g) {
      const z = G.BUS_STOP_Z[0];
      this.person(g, -9.7, z + 4, { shirt: '#2e86c1', still: true, rain: this.env.rain > 0.4 });
      this.person(g, -9.9, z + 6.5, { shirt: '#c0392b', saree: true, still: true, rain: this.env.rain > 0.4 });
      this.person(g, -9.5, z + 8.4, { shirt: '#f4d03f', still: true });
    }

    /** Pedestrian figure standing on the ground at (x, z). */
    person(g, x, z, o) {
      const fz = this.fogAt(z);
      const s = this.f / z;
      const base = this.proj(x, 0, z);
      if (s < 1.2) return;
      const c = col => rgb(mix(hexToRgb(col), this.fogCol, fz));
      const swing = o.still ? 0 : Math.sin(o.phase) * 0.22;
      g.lineCap = 'round';
      if (o.saree) {
        g.fillStyle = c(o.shirt);
        g.beginPath();
        g.moveTo(base[0] - 0.24 * s, base[1]); g.lineTo(base[0] + 0.24 * s, base[1]);
        g.lineTo(base[0] + 0.19 * s, base[1] - 1.4 * s); g.lineTo(base[0] - 0.19 * s, base[1] - 1.4 * s);
        g.closePath(); g.fill();
      } else {
        g.strokeStyle = c('#2d3138');
        g.lineWidth = Math.max(1, 0.13 * s);
        g.beginPath();
        g.moveTo(base[0] - 0.07 * s, base[1] - 0.86 * s); g.lineTo(base[0] - 0.07 * s + swing * s, base[1]);
        g.moveTo(base[0] + 0.07 * s, base[1] - 0.86 * s); g.lineTo(base[0] + 0.07 * s - swing * s, base[1]);
        g.stroke();
        g.fillStyle = c(o.shirt);
        g.fillRect(base[0] - 0.2 * s, base[1] - 1.45 * s, 0.4 * s, 0.62 * s);
      }
      g.fillStyle = c(o.helmet || '#22180f');
      g.beginPath(); g.arc(base[0], base[1] - 1.56 * s, 0.12 * s, 0, Math.PI * 2); g.fill();
      if (o.rain) {
        g.fillStyle = c('#1b1d22');
        g.beginPath(); g.ellipse(base[0], base[1] - 1.92 * s, 0.55 * s, 0.22 * s, 0, Math.PI, 0); g.fill();
        g.strokeStyle = c('#1b1d22'); g.lineWidth = Math.max(1, 0.04 * s);
        g.beginPath(); g.moveTo(base[0], base[1] - 1.92 * s); g.lineTo(base[0], base[1] - 1.35 * s); g.stroke();
      }
    }

    drawShadows(g) {
      const e = this.env;
      if (e.sun < 0.05) return;
      // Right-hand buildings cast shadows across the footpath (sun from the front right).
      for (const b of this.layout.buildings) {
        if (b.side < 0 || b.kind === 'wall') continue;
        const len = Math.min(b.h * 0.42, 6);
        g.globalAlpha = 0.22 * e.sun;
        this.groundQuad(g, b.xIn - len, b.xIn, b.z0 - b.h * 0.3, b.z1 - b.h * 0.3, 'rgb(20,24,34)');
      }
      // Tree canopy shadows (soft ellipses).
      for (const t of this.layout.roadside) {
        if (t.type !== 'tree') continue;
        const spr = this.sprites[t.kind][t.v % this.sprites[t.kind].length];
        const h = spr.worldH * 0.7, r = spr.worldW * 0.32;
        const cx = t.x - h * 0.42, cz = t.z - h * 0.7;
        if (cz < 7) continue;
        g.globalAlpha = 0.2 * e.sun * (1 - this.fogAt(cz));
        g.fillStyle = 'rgb(20,26,30)';
        g.beginPath();
        for (let i = 0; i <= 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          const q = this.proj(cx + Math.cos(a) * r, 0.01, Math.max(6, cz + Math.sin(a) * r * 0.8));
          if (i === 0) g.moveTo(q[0], q[1]); else g.lineTo(q[0], q[1]);
        }
        g.fill();
      }
      g.globalAlpha = 1;
    }

    // ---- buildings ----
    /** Maps a facade texture onto the wall plane x = const with perspective-correct vertical strips. */
    wallX(g, tex, x, z0, z1, y0, y1, flip) {
      const zMin = (this.f * Math.abs(x)) / this.cx;       // nearest depth still on screen
      const za = Math.max(z0, zMin * 0.98, 0.8);
      if (za >= z1) return;
      const sx0 = this.cx + (this.f * x) / za, sx1 = this.cx + (this.f * x) / z1;
      const n = clamp(Math.ceil(Math.abs(sx1 - sx0) / 3), 1, 260);
      const tw = tex.width, th = tex.height;
      for (let i = 0; i < n; i++) {
        const xa = lerp(sx0, sx1, i / n), xb = lerp(sx0, sx1, (i + 1) / n);
        const zA = (this.f * x) / (xa - this.cx), zB = (this.f * x) / (xb - this.cx);
        let ua = (zA - z0) / (z1 - z0), ub = (zB - z0) / (z1 - z0);
        if (flip) { ua = 1 - ua; ub = 1 - ub; }
        const u0 = Math.min(ua, ub) * tw, uw = Math.max(1, Math.abs(ub - ua) * tw);
        const zm = (zA + zB) / 2;
        const yt = this.hy + (this.f * (this.camH - y1)) / zm, yb = this.hy + (this.f * (this.camH - y0)) / zm;
        g.drawImage(tex, clamp(u0, 0, tw - 1), 0, Math.min(uw, tw - u0), th, Math.min(xa, xb), yt, Math.abs(xb - xa) + 0.7, yb - yt);
      }
    }

    fogWallX(g, x, z0, z1, y0, y1) {
      const za = Math.max(z0, (this.f * Math.abs(x)) / this.cx * 0.98, 0.8);
      if (za >= z1) return;
      const a = this.proj(x, y0, za), b = this.proj(x, y0, z1), c = this.proj(x, y1, z1), d = this.proj(x, y1, za);
      const grd = g.createLinearGradient(a[0], 0, b[0], 0);
      grd.addColorStop(0, rgb(this.fogCol, this.fogAt(za)));
      grd.addColorStop(1, rgb(this.fogCol, this.fogAt(z1)));
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]); g.closePath(); g.fill();
    }

    /** Texture on a camera-facing plane z = const (a plain scaled rectangle). */
    wallZ(g, tex, z, x0, x1, y0, y1) {
      const a = this.proj(x0, y1, z), b = this.proj(x1, y0, z);
      g.drawImage(tex, a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.fillStyle = rgb(this.fogCol, this.fogAt(z));
      g.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }

    drawBuildings(g, filter, includeCross) {
      const p = this.painter;
      if (includeCross) {
        for (const b of [...this.layout.cross].sort((a, c) => c.x0 - a.x0)) {
          const x0 = b.side * b.x0, x1 = b.side * b.x1;
          const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
          p.fz = this.fogAt(b.z0);
          if (b.h < this.camH) p.poly(p.faceY(b.h, lo, hi, b.z0, b.z1), p.col([150, 146, 140]));
          this.wallZ(g, b.tex.day, b.z0, lo, hi, 0, b.h);
          if (b.tank) this.tank(lo + 1.5, b.h, b.z0 + 2);
        }
      }
      for (const side of [-1, 1]) {
        const list = this.layout.buildings.filter(b => b.side === side && filter(b)).sort((a, b) => b.z0 - a.z0);
        for (const b of list) {
          const xIn = side * b.xIn, xOut = side * (b.xIn + b.depth);
          const lo = Math.min(xIn, xOut), hi = Math.max(xIn, xOut);
          p.fz = this.fogAt(b.z0);
          if (b.h < this.camH) p.poly(p.faceY(b.h, lo, hi, b.z0, b.z1), p.col(b.kind === 'wall' ? b.color : [158, 152, 144], b.kind === 'wall' ? 0.9 : 1));
          if (b.texFront) this.wallZ(g, b.texFront.day, b.z0, lo, hi, 0, b.h);
          else p.poly(p.faceZ(b.z0, lo, hi, 0, b.h), p.col(b.color, 0.85));
          this.wallX(g, b.tex.day, xIn, b.z0, b.z1, 0, b.h, side > 0);
          this.fogWallX(g, xIn, b.z0, b.z1, 0, b.h);
          // Contact shadow along the base of the wall.
          g.globalAlpha = 0.25;
          this.groundQuad(g, xIn - side * 0.6, xIn, Math.max(6, b.z0), b.z1, 'rgb(20,20,24)');
          g.globalAlpha = 1;
          if (b.tank) this.tank(xIn + side * 1.6, b.h, b.z0 + 1.5);
        }
      }
    }

    /** Black rooftop water tank, a familiar sight on Tamil Nadu rooftops. */
    tank(x, y, z) {
      const p = this.painter;
      p.fz = this.fogAt(z);
      p.box(x - 0.6, x + 0.6, y, y + 1.5, z, z + 1.2, [36, 38, 42], { side: 0.7, top: 1.3 });
      p.poly(p.faceZ(z, x - 0.6, x + 0.6, y + 1.2, y + 1.3), p.col([60, 62, 66]));
    }

    // ---- emissive layers (half resolution) ----
    renderLightLayers() {
      const lw = this.lightsLayer.getContext('2d');
      const ll = this.lampLayer.getContext('2d');
      lw.clearRect(0, 0, this.lightsLayer.width, this.lightsLayer.height);
      ll.clearRect(0, 0, this.lampLayer.width, this.lampLayer.height);
      lw.save(); lw.scale(0.5, 0.5);
      // Same far-to-near order as the buildings themselves: each building first erases the
      // lights of anything it hides, then adds its own lit windows.
      const erase = pts => {
        lw.globalCompositeOperation = 'destination-out';
        lw.globalAlpha = 1;
        lw.beginPath(); pts.forEach((q, i) => (i ? lw.lineTo(q[0], q[1]) : lw.moveTo(q[0], q[1]))); lw.closePath(); lw.fill();
        lw.globalCompositeOperation = 'source-over';
      };
      for (const b of this.layout.cross) {
        const x0 = b.side * b.x0, x1 = b.side * b.x1;
        const a = this.proj(Math.min(x0, x1), b.h, b.z0), c = this.proj(Math.max(x0, x1), 0, b.z0);
        lw.globalAlpha = 1 - this.fogAt(b.z0);
        lw.drawImage(b.tex.night, a[0], a[1], c[0] - a[0], c[1] - a[1]);
      }
      for (const side of [-1, 1]) {
        const list = this.layout.buildings.filter(b => b.side === side).sort((a, b) => b.z0 - a.z0);
        for (const b of list) {
          const xIn = side * b.xIn, xOut = side * (b.xIn + b.depth);
          const za = Math.max(b.z0, (this.f * Math.abs(xIn)) / this.cx * 0.98, 0.8);
          if (za < b.z1) erase([this.proj(xIn, 0, za), this.proj(xIn, 0, b.z1), this.proj(xIn, b.h, b.z1), this.proj(xIn, b.h, za)]);
          erase([this.proj(xIn, 0, b.z0), this.proj(xOut, 0, b.z0), this.proj(xOut, b.h, b.z0), this.proj(xIn, b.h, b.z0)]);
          if (b.kind === 'wall' || !b.tex.night) continue;
          lw.globalAlpha = 1 - this.fogAt((b.z0 + b.z1) / 2);
          this.wallX(lw, b.tex.night, xIn, b.z0, b.z1, 0, b.h, side > 0);
        }
      }
      lw.globalAlpha = 1;
      lw.restore();
      // Street-lamp pools of light on the road and the lamp heads.
      ll.save(); ll.scale(0.5, 0.5);
      for (const m of this.layout.medianLamps) {
        const fz = this.fogAt(m.z);
        for (const s of [-1, 1]) {
          const cx = s * 3.4;
          const q = this.proj(cx, 0, m.z), r = (8.5 * this.f) / m.z;
          const grd = ll.createRadialGradient(q[0], q[1], 0, q[0], q[1], r);
          grd.addColorStop(0, `rgba(255,210,150,${0.42 * (1 - fz)})`);
          grd.addColorStop(1, 'rgba(255,210,150,0)');
          ll.fillStyle = grd;
          ll.save(); ll.translate(q[0], q[1]); ll.scale(1, 0.32); ll.translate(-q[0], -q[1]);
          ll.fillRect(q[0] - r, q[1] - r, r * 2, r * 2);
          ll.restore();
        }
      }
      ll.restore();
    }

    // ======================================================================
    // Per-frame drawing
    // ======================================================================
    render() {
      this.renderStatic();
      const g = this.main;
      this.ctx = g;
      const e = this.env;
      this.lights.length = 0; this.beams.length = 0; this.countdowns.length = 0;
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.clearRect(0, 0, this.W, this.H);
      g.drawImage(this.staticFar, 0, 0);

      // Split vehicles into the group beyond the junction and the group before it.
      const vehicles = this.sim.snapshot(this.vehicleList);
      const farGroup = [], nearGroup = [];
      for (const v of vehicles) {
        const ext = this.sim.extents(v);
        const item = { z: ext.z0, v, e: ext };
        if (v.lane.def.axis === 'x' || ext.z0 >= 56) farGroup.push(item); else nearGroup.push(item);
      }
      for (const m of this.layout.medianLamps) (m.z >= 56 ? farGroup : nearGroup).push({ z: m.z, lamp: m });

      this.drawRoadside(g, z => z >= 71);
      this.drawSorted(farGroup);
      g.drawImage(this.staticNear, 0, 0);
      this.drawRoadside(g, z => z < 71);
      this.drawSorted(nearGroup);
      this.drawWires(g);

      // Day/night lighting applies to everything drawn so far (not to the sky).
      if (e.dark > 0.003) {
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = rgb(e.darkCol, e.dark);
        g.fillRect(0, 0, this.W, this.H);
      }
      // Sky goes behind the world.
      g.globalCompositeOperation = 'destination-over';
      this.drawClouds(g);
      this.drawSunMoon(g);
      this.drawSky(g);

      // Emissive pass.
      g.globalCompositeOperation = 'lighter';
      this.drawEmissive(g);
      g.globalCompositeOperation = 'source-over';
      this.drawCountdowns(g);
      this.drawRain(g);
      this.drawFog(g);
      g.drawImage(this.vignette, 0, 0);
    }

    drawSorted(items) {
      items.sort((a, b) => b.z - a.z);
      for (const it of items) {
        if (it.lamp) this.medianLamp(it.lamp);
        else this.painter.draw(it.v, it.e);
      }
    }

    medianLamp(m) {
      const p = this.painter;
      p.fz = this.fogAt(m.z);
      if (p.fz > 0.98) return;
      const g = this.ctx;
      p.box(-0.13, 0.13, 0, 9.4, m.z - 0.13, m.z + 0.13, [150, 154, 158], { side: 0.75 });
      g.strokeStyle = p.col([130, 134, 140]);
      g.lineWidth = Math.max(1, (0.1 * this.f) / m.z);
      for (const s of [-1, 1]) {
        const a = this.proj(0, 9.2, m.z), b = this.proj(s * 1.6, 9.9, m.z), c = this.proj(s * 2.9, 9.95, m.z);
        g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo(b[0], b[1], c[0], c[1]); g.stroke();
        p.box(s * 2.9 - 0.35, s * 2.9 + 0.35, 9.75, 9.95, m.z - 0.18, m.z + 0.18, [70, 74, 80], { top: 1.3 });
        if (this.env.lamps > 0.02) {
          p.light(s * 2.9, 9.7, m.z, 0.45, 'lamp', this.env.lamps);
        }
      }
    }

    // ---- roadside (trees, poles, signals, bus stop, people) ----
    drawRoadside(g, filter) {
      const items = this.layout.roadside.filter(o => filter(o.z));
      for (const w of this.walkers) {
        if (w.active < 4 + Math.round(this.conditions.density / 12) && filter(w.z)) items.push({ type: 'walker', z: w.z, w });
      }
      items.sort((a, b) => b.z - a.z);
      for (const o of items) {
        if (o.z < 6.5) continue;
        switch (o.type) {
          case 'tree': this.tree(g, o); break;
          case 'pole': this.utilityPole(o); break;
          case 'busStop': this.busStop(g, o); break;
          case 'dirBoard': this.board(g, o, this.signs.dirBoard, 4.2, 2.2, 2.6); break;
          case 'workSign': if (this.conditions.surface === 'construction') this.board(g, o, this.signs.workSign, 1.6, 0.7, 1.4); break;
          case 'signalNear': this.signalNear(o); break;
          case 'signalFar': this.signalFar(o); break;
          case 'walker': this.person(g, o.w.x, o.w.z, { shirt: o.w.shirt, saree: o.w.saree, phase: o.w.phase, rain: this.env.rain > 0.4 }); break;
        }
      }
    }

    tree(g, t) {
      const spr = this.sprites[t.kind][t.v % this.sprites[t.kind].length];
      const fz = this.fogAt(t.z);
      if (fz > 0.97) return;
      const s = this.f / t.z;
      const base = this.proj(t.x, 0, t.z);
      const w = spr.worldW * s, h = spr.worldH * s;
      if (base[0] + w / 2 < 0 || base[0] - w / 2 > this.W) return;
      const sway = this.reducedMotion ? 0 : Math.sin(this.decoTime * (t.kind === 'palm' ? 0.9 : 0.6) + t.phase) * 0.011 * (0.4 + this.env.wind);
      g.save();
      g.globalAlpha = 1 - fz;
      g.translate(base[0], base[1]);
      g.rotate(sway);
      g.drawImage(spr.canvas, -w / 2, -h, w, h);
      g.restore();
    }

    utilityPole(o) {
      const p = this.painter;
      p.fz = this.fogAt(o.z);
      if (p.fz > 0.97) return;
      p.box(o.x - 0.12, o.x + 0.12, 0, 9.2, o.z - 0.12, o.z + 0.12, [170, 166, 158], { side: 0.72 });
      p.box(o.x - 1.1, o.x + 0.9, 8.55, 8.7, o.z - 0.07, o.z + 0.07, [110, 106, 100]);
      for (const dx of [-0.9, -0.2, 0.7]) p.box(o.x + dx - 0.04, o.x + dx + 0.04, 8.7, 8.95, o.z - 0.04, o.z + 0.04, [200, 196, 188]);
    }

    drawWires(g) {
      const poles = this.layout.poles;
      g.lineWidth = Math.max(1, this.W / 1400);
      for (let i = 0; i + 1 < poles.length; i++) {
        const a = poles[i], b = poles[i + 1];
        if (b.z - a.z > 45) continue;
        const fz = this.fogAt(a.z);
        g.strokeStyle = `rgba(28,30,34,${0.8 * (1 - fz)})`;
        g.beginPath();
        for (const dx of [-0.9, -0.2, 0.7]) {
          const p0 = this.proj(a.x + dx, 8.95, Math.max(a.z, 7)), p1 = this.proj(b.x + dx, 8.95, b.z);
          const pm = this.proj(a.x + dx, 8.2, (a.z + b.z) / 2);
          g.moveTo(p0[0], p0[1]);
          g.quadraticCurveTo(pm[0] * 2 - (p0[0] + p1[0]) / 2, pm[1] * 2 - (p0[1] + p1[1]) / 2, p1[0], p1[1]);
        }
        g.stroke();
      }
    }

    board(g, o, tex, w, h, y0) {
      const p = this.painter;
      p.fz = this.fogAt(o.z);
      if (p.fz > 0.97) return;
      p.box(o.x - w * 0.42, o.x - w * 0.42 + 0.08, 0, y0, o.z, o.z + 0.08, [120, 124, 128]);
      p.box(o.x + w * 0.42 - 0.08, o.x + w * 0.42, 0, y0, o.z, o.z + 0.08, [120, 124, 128]);
      this.wallZ(g, tex, o.z, o.x - w / 2, o.x + w / 2, y0, y0 + h);
    }

    busStop(g, o) {
      const p = this.painter;
      const z0 = o.z, z1 = o.z + 14;
      p.fz = this.fogAt(z0);
      // Back panel with a road-safety poster, roof and posts.
      this.wallX(g, this.signs.poster, -10.55, z0 + 4, z0 + 9, 0.6, 2.3, false);
      p.poly(p.faceX(-10.55, z0, z0 + 4, 0.3, 2.4), p.col([216, 222, 226]));
      p.poly(p.faceX(-10.55, z0 + 9, z1, 0.3, 2.4), p.col([216, 222, 226]));
      for (const zz of [z0 + 0.3, z1 - 0.3]) {
        p.box(-8.85, -8.72, 0, 2.6, zz, zz + 0.12, [80, 90, 100]);
        p.box(-10.5, -10.37, 0, 2.6, zz, zz + 0.12, [80, 90, 100]);
      }
      p.box(-10.2, -9.6, 0.42, 0.5, z0 + 2, z1 - 2, [120, 92, 60]);          // bench
      p.box(-10.7, -8.5, 2.6, 2.75, z0, z1, [40, 120, 128], { top: 1.15 });   // roof
      // Bus-stop sign on a post facing the traffic.
      p.box(-8.68, -8.6, 0, 2.9, z0 - 1.5, z0 - 1.42, [110, 114, 118]);
      this.wallZ(g, this.signs.busStop, z0 - 1.55, -9.5, -7.8, 2.6, 3.25);
    }

    signalHead(x, y, z, state, facing) {
      const p = this.painter;
      p.box(x - 0.2, x + 0.2, y, y + 1.15, z, z + 0.25, [24, 26, 28], { side: 0.8 });
      if (facing !== 'camera') return;
      const g = this.ctx;
      const lenses = [['red', y + 0.92], ['amber', y + 0.57], ['green', y + 0.22]];
      for (const [col, ly] of lenses) {
        const on = (col === 'red' && state === 'red') || (col === 'amber' && state === 'yellow') || (col === 'green' && state === 'green');
        const q = this.proj(x, ly, z - 0.01);
        const r = (0.12 * this.f) / z;
        const base = col === 'red' ? [255, 70, 50] : col === 'amber' ? [255, 176, 40] : [60, 230, 130];
        g.fillStyle = on ? rgb(mix(base, [255, 255, 255], 0.25)) : rgb(shade(base, 0.22));
        g.beginPath(); g.arc(q[0], q[1], Math.max(0.8, r), 0, Math.PI * 2); g.fill();
        if (on) this.lights.push({ x: q[0], y: q[1], r: r * 1.4, kind: col, a: 1, z, wx: x, signal: true });
      }
    }

    signalNear(o) {
      const p = this.painter;
      const sig = this.sim.signal;
      p.fz = this.fogAt(o.z);
      p.box(o.x - 0.11, o.x + 0.11, 0, 6.0, o.z - 0.11, o.z + 0.11, [70, 74, 80]);
      // Black-and-yellow base band (common on Indian signal poles).
      for (let i = 0; i < 4; i++) p.box(o.x - 0.12, o.x + 0.12, i * 0.3, i * 0.3 + 0.15, o.z - 0.12, o.z + 0.12, i % 2 ? [24, 24, 24] : [226, 186, 30]);
      p.box(o.x, -3.6, 5.62, 5.78, o.z - 0.07, o.z + 0.07, [70, 74, 80]);       // cantilever arm over the lanes
      this.signalHead(-4.7, 4.45, o.z - 0.25, sig.main, 'camera');
      this.signalHead(o.x + 0.45, 2.5, o.z - 0.2, sig.main, 'camera');
      // Countdown timer box (shows seconds until the light changes).
      p.box(o.x + 0.75, o.x + 1.45, 2.95, 3.5, o.z - 0.2, o.z + 0.05, [20, 20, 22]);
      const a = this.proj(o.x + 0.75, 3.5, o.z - 0.21), b = this.proj(o.x + 1.45, 2.95, o.z - 0.21);
      this.countdowns.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, h: b[1] - a[1], w: b[0] - a[0], text: String(Math.ceil(sig.mainRemain)).padStart(2, '0'), state: sig.main });
    }

    signalFar(o) {
      const p = this.painter;
      p.fz = this.fogAt(o.z);
      p.box(o.x - 0.11, o.x + 0.11, 0, 6.0, o.z - 0.11, o.z + 0.11, [70, 74, 80]);
      p.box(3.6, o.x, 5.62, 5.78, o.z - 0.07, o.z + 0.07, [70, 74, 80]);
      this.signalHead(4.7, 4.45, o.z, this.sim.signal.main, 'away');
      this.signalHead(o.x - 0.45, 2.5, o.z, this.sim.signal.main, 'away');
    }

    // ---- sky ----
    drawSky(g) {
      const e = this.env;
      const grd = g.createLinearGradient(0, 0, 0, this.hy + 4);
      grd.addColorStop(0, rgb(e.skyTop));
      grd.addColorStop(0.62, rgb(mix(e.skyTop, e.skyBot, 0.55)));
      grd.addColorStop(1, rgb(e.skyBot));
      g.fillStyle = grd;
      g.fillRect(0, 0, this.W, this.H);
    }

    drawSunMoon(g) {
      const e = this.env;
      const d = e.dusk;
      const sx = this.W * lerp(0.74, 0.84, d), sy = this.hy * lerp(0.26, 0.86, d);
      const vis = e.sun * (1 - e.cloud * 0.55) * (1 - e.mist * 0.6);
      if (vis > 0.01) {
        const col = mix([255, 246, 220], [255, 170, 90], d);
        const R = Math.min(this.W, this.H) * 0.42;
        const grd = g.createRadialGradient(sx, sy, 0, sx, sy, R);
        grd.addColorStop(0, rgb(col, 0.95 * vis));
        grd.addColorStop(0.04, rgb(col, 0.85 * vis));
        grd.addColorStop(0.1, rgb(col, 0.28 * vis));
        grd.addColorStop(1, rgb(col, 0));
        g.fillStyle = grd;
        g.fillRect(sx - R, sy - R, R * 2, R * 2);
      }
      const moon = e.night * (1 - e.cloud * 0.8) * (1 - e.mist * 0.7);
      if (moon > 0.01) {
        const mx = this.W * 0.2, my = this.hy * 0.24, r = this.H * 0.022;
        const grd = g.createRadialGradient(mx, my, 0, mx, my, r * 6);
        grd.addColorStop(0, `rgba(235,240,255,${0.9 * moon})`);
        grd.addColorStop(0.17, `rgba(220,228,250,${0.75 * moon})`);
        grd.addColorStop(0.2, `rgba(200,210,240,${0.12 * moon})`);
        grd.addColorStop(1, 'rgba(200,210,240,0)');
        g.fillStyle = grd;
        g.fillRect(mx - r * 6, my - r * 6, r * 12, r * 12);
      }
    }

    drawClouds(g) {
      const e = this.env;
      const n = this.cloudList.length;
      const nightK = clamp(e.dark / 0.8, 0, 1);
      for (let i = 0; i < n; i++) {
        const c = this.cloudList[i];
        const a = clamp(e.cloud * n * 1.1 - i, 0, 1) * (1 - e.mist * 0.5);
        if (a <= 0.01) continue;
        const w = 420 * c.s * (this.W / 1300) * (1 + e.cloud * 0.6), h = w * (240 / 420);
        const x = c.x * this.W, y = c.y * this.hy * (1 - e.cloud * 0.3);
        const tones = [['white', (1 - e.grey) * (1 - nightK)], ['grey', e.grey * (1 - nightK)], ['night', nightK]];
        for (const [tone, ta] of tones) {
          if (ta * a < 0.01) continue;
          g.globalAlpha = ta * a * 0.95;
          g.drawImage(this.cloudSprites[tone][c.shape], x - w / 2, y - h / 2, w, h);
        }
      }
      g.globalAlpha = 1;
    }

    // ---- lights ----
    drawEmissive(g) {
      const e = this.env;
      const darkK = clamp(e.dark / 0.75, 0, 1);
      // Lit windows, shop interiors and street-lamp pools.
      if (darkK > 0.02) {
        g.globalAlpha = darkK * 0.9;
        g.drawImage(this.lightsLayer, 0, 0, this.W, this.H);
      }
      if (e.lamps > 0.02) {
        g.globalAlpha = e.lamps * darkK;
        g.drawImage(this.lampLayer, 0, 0, this.W, this.H);
      }
      // Headlight beams on the road surface (only visible when it is dark or foggy).
      const beamK = Math.max(darkK, e.mist * 0.35);
      if (beamK > 0.03) {
        for (const b of this.beams) {
          if (b.dir > 0 || b.z > 110 || b.a < 0.02) continue;
          // Soft elliptical pool of light on the road in front of the vehicle.
          const zc = Math.max(6, b.z - 7), xm = (b.x0 + b.x1) / 2;
          const q = this.proj(xm, 0, zc);
          const rx = (2.2 * this.f) / zc;
          const ry = Math.max(2, (this.f * this.camH) / Math.max(5, zc - 7) - (this.f * this.camH) / (zc + 7)) / 2;
          const grd = g.createRadialGradient(q[0], q[1], 0, q[0], q[1], rx);
          grd.addColorStop(0, `rgba(255,236,200,${0.2 * b.a * beamK})`);
          grd.addColorStop(1, 'rgba(255,236,200,0)');
          g.globalAlpha = 1;
          g.fillStyle = grd;
          g.save(); g.translate(q[0], q[1]); g.scale(1, ry / rx); g.translate(-q[0], -q[1]);
          g.fillRect(q[0] - rx, q[1] - rx, rx * 2, rx * 2);
          g.restore();
        }
      }
      // Point lights with glow (and streaky reflections on a wet road).
      const glowK = 0.35 + 0.65 * darkK;
      for (const L of this.lights) {
        let k = L.kind === 'brake' ? Math.max(0.65, glowK) : L.signal ? Math.max(0.75, glowK) : glowK;
        if (L.kind === 'head' && darkK < 0.2) k *= 0.6;
        const size = Math.max(3, L.r * (L.kind === 'lamp' ? 3.4 : 3.2));
        g.globalAlpha = clamp(L.a * k, 0, 1);
        g.drawImage(this.glows[L.kind] || this.glows.head, L.x - size, L.y - size, size * 2, size * 2);
        if (e.wet > 0.1 && L.y > this.hy && !L.signal) {
          const rh = size * 5.5, rw = size * 0.9;
          g.globalAlpha = clamp(L.a * k * e.wet * 0.42, 0, 1);
          g.drawImage(this.glows[L.kind] || this.glows.head, L.x - rw, L.y + size * 0.2, rw * 2, rh);
        }
      }
      g.globalAlpha = 1;
    }

    drawCountdowns(g) {
      for (const c of this.countdowns) {
        if (c.h < 5) continue;
        g.fillStyle = c.state === 'green' ? '#59f08f' : c.state === 'yellow' ? '#ffbe3d' : '#ff5a4a';
        g.font = `700 ${Math.round(c.h * 0.78)}px "IBM Plex Mono", monospace`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(c.text, c.x, c.y + c.h * 0.04, c.w * 0.9);
      }
    }

    drawRain(g) {
      const e = this.env;
      if (e.rain < 0.02) return;
      const n = Math.floor(this.rain.length * e.rain);
      const len = this.H * 0.045;
      const night = clamp(e.dark / 0.8, 0, 1);
      g.strokeStyle = night > 0.5 ? `rgba(170,184,210,${0.28 * e.rain})` : `rgba(222,230,238,${0.34 * e.rain})`;
      g.lineWidth = Math.max(1, this.W / 1500);
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const d = this.rain[i];
        g.moveTo(d.x, d.y);
        g.lineTo(d.x + len * d.len * 0.12, d.y - len * d.len);
      }
      g.stroke();
      // Splashes on the road surface.
      if (!this.reducedMotion && this.running) {
        g.strokeStyle = `rgba(230,236,242,${0.35 * e.rain})`;
        g.beginPath();
        for (let i = 0; i < 70 * e.rain; i++) {
          const z = 9 + Math.random() * 70, x = (Math.random() - 0.5) * 15;
          const q = this.proj(x, 0, z), w = (0.22 * this.f) / z;
          g.moveTo(q[0] + w, q[1]);
          g.ellipse(q[0], q[1], w, w * 0.3, 0, 0, Math.PI, true);
        }
        g.stroke();
      }
      // Overall rain veil.
      g.fillStyle = rgb(this.env.skyBot, 0.08 * e.rain);
      g.fillRect(0, 0, this.W, this.H);
    }

    drawFog(g) {
      const e = this.env;
      // Low-visibility veil hugging the horizon (applies to any weather with poor visibility).
      const veil = clamp((500 - this.visibility) / 450, 0, 1) * 0.5 + e.mist * 0.18;
      const fc = mix(e.skyBot, [255, 255, 255], 0.05);
      if (veil > 0.01) {
        const grd = g.createLinearGradient(0, this.hy - this.H * 0.25, 0, this.H);
        grd.addColorStop(0, rgb(fc, 0));
        grd.addColorStop(0.28, rgb(fc, veil));
        grd.addColorStop(0.55, rgb(fc, veil * 0.45));
        grd.addColorStop(1, rgb(fc, veil * 0.12));
        g.fillStyle = grd;
        g.fillRect(0, 0, this.W, this.H);
      }
      if (e.mist < 0.02) return;
      // Drifting mist banks.
      const night = clamp(e.dark / 0.8, 0, 1);
      g.globalAlpha = e.mist * (night > 0.5 ? 0.35 : 0.75);
      const bands = [[0.0, 0.55, 6], [0.12, 0.8, 10], [0.3, 1.1, 15]];
      for (const [yOff, scale, speed] of bands) {
        const h = this.H * 0.32 * scale, w = this.W * 1.2 * scale;
        const y = this.hy - h * 0.45 + this.H * yOff;
        let x = -((this.decoTime * speed * (this.W / 1200)) % w);
        for (; x < this.W; x += w) g.drawImage(this.mistSprite, x, y, w + 1, h);
      }
      g.globalAlpha = 1;
    }
  }

  root.RoadScene = RoadScene;
})(window);
