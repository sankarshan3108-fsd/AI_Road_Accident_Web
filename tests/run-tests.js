/* Logic tests for the browser simulation. Run with:  node tests/run-tests.js
   They load the same plain script files the web page uses (no build step). */
'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'js', 'risk-model.js'));
require(path.join(__dirname, '..', 'js', 'traffic.js'));
require(path.join(__dirname, '..', 'js', 'astar.js'));
const { RiskModel: RM, Traffic: T, AStar: AS } = globalThis;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('Risk model');
test('component maxima sum to 100', () => {
  assert(Object.values(RM.MAX_POINTS).reduce((a, b) => a + b, 0) === 100);
});
test('best case scores 0 and worst case scores 100', () => {
  assert(RM.evaluate({ weather: 'sunny', surface: 'dry', lighting: 'day', visibility: 2000, speed: 20, density: 0 }).score === 0);
  assert(RM.evaluate({ weather: 'rainy', surface: 'potholes', lighting: 'nightDark', visibility: 50, speed: 120, density: 100 }).score === 100);
});
test('deterministic: identical inputs give identical outputs', () => {
  const c = { weather: 'foggy', surface: 'wet', lighting: 'dusk', visibility: 350, speed: 75, density: 55 };
  assert(JSON.stringify(RM.evaluate(c)) === JSON.stringify(RM.evaluate(Object.assign({}, c))));
});
test('thresholds: LOW < 35 <= MEDIUM < 65 <= HIGH', () => {
  assert(RM.classify(34.9) === 'LOW' && RM.classify(35) === 'MEDIUM' && RM.classify(64.9) === 'MEDIUM' && RM.classify(65) === 'HIGH');
});
test('score is monotonic in speed, density and (falling) visibility', () => {
  const base = { weather: 'rainy', surface: 'wet', lighting: 'day', visibility: 600, speed: 50, density: 40 };
  for (const [k, vals] of [['speed', [20, 40, 60, 80, 100, 120]], ['density', [0, 25, 50, 75, 100]], ['visibility', [2000, 1000, 500, 200, 50]]]) {
    let prev = -1;
    for (const v of vals) { const s = RM.evaluate(Object.assign({}, base, { [k]: v })).score; assert(s >= prev, `${k}=${v} gave ${s} < ${prev}`); prev = s; }
  }
});
test('every weather/surface/lighting worsening raises the score', () => {
  const base = { weather: 'sunny', surface: 'dry', lighting: 'day', visibility: 1000, speed: 60, density: 40 };
  const s0 = RM.evaluate(base).score;
  for (const [k, v] of [['weather', 'rainy'], ['weather', 'foggy'], ['weather', 'cloudy'], ['surface', 'wet'], ['surface', 'potholes'], ['surface', 'construction'], ['lighting', 'dusk'], ['lighting', 'nightDark']]) {
    assert(RM.evaluate(Object.assign({}, base, { [k]: v })).score > s0, `${k}=${v}`);
  }
});
test('invalid inputs are sanitised', () => {
  const c = RM.sanitize({ weather: 'snow', speed: 'fast', visibility: -10, density: 250, lighting: null });
  assert(c.weather === 'sunny' && c.speed === 50 && c.visibility === 50 && c.density === 100 && c.lighting === 'day');
});
test('recommendations follow the inputs', () => {
  const causes = c => RM.recommendations(c).items.map(r => r.cause);
  assert(causes(Object.assign({}, RM.DEFAULTS)).includes('Favourable conditions'));
  assert(causes(Object.assign({}, RM.DEFAULTS, { visibility: 100 })).includes('Low visibility'));
  assert(causes(Object.assign({}, RM.DEFAULTS, { surface: 'wet' })).includes('Wet road'));
  assert(causes(Object.assign({}, RM.DEFAULTS, { density: 90 })).includes('Dense traffic'));
  assert(causes(Object.assign({}, RM.DEFAULTS, { lighting: 'nightDark' })).includes('Unlit road at night'));
});
test('safer speed is never riskier than the current speed', () => {
  for (const w of Object.keys(RM.WEATHER)) for (const sp of [30, 60, 90, 120]) {
    const rows = RM.comparison(Object.assign({}, RM.DEFAULTS, { weather: w, speed: sp, visibility: RM.WEATHER[w].presetVisibility }));
    assert(rows[0].score <= rows[1].score && rows[1].score <= rows[2].score);
  }
});

console.log('A* search');
test('finds a path on the default map and it is optimal (equals uniform-cost search)', () => {
  const g = AS.buildCostGrid(RM.DEFAULTS, 10, []);
  const a = new AS.AStarSearch(g.cost, AS.DEFAULT_START, AS.DEFAULT_GOAL, true).run();
  const u = new AS.AStarSearch(g.cost, AS.DEFAULT_START, AS.DEFAULT_GOAL, false).run();
  assert(a.status === 'found' && Math.abs(a.pathCost - u.pathCost) < 1e-9);
  assert(a.expanded.length <= u.expanded.length);
});
test('optimal on 300 random hazard maps with random blocks', () => {
  const rng = T.mulberry32(42);
  const roads = [];
  for (let c = 0; c < AS.COLS; c++) for (let r = 0; r < AS.ROWS; r++) if (AS.isRoad(c, r)) roads.push([c, r]);
  for (let i = 0; i < 300; i++) {
    const inputs = { weather: ['sunny', 'rainy', 'foggy'][i % 3], surface: ['dry', 'potholes', 'construction'][i % 3], visibility: 50 + Math.floor(rng() * 1950), density: Math.floor(rng() * 100), lighting: 'day', speed: 50 };
    const blocks = [];
    for (let k = 0; k < 6; k++) { const [c, r] = roads[Math.floor(rng() * roads.length)]; blocks.push(AS.key(c, r)); }
    const start = roads[Math.floor(rng() * roads.length)], goal = roads[Math.floor(rng() * roads.length)];
    const bl = blocks.filter(k => k !== AS.key(...start) && k !== AS.key(...goal));
    const g = AS.buildCostGrid(inputs, rng() * 100, bl);
    const a = new AS.AStarSearch(g.cost, start, goal, true).run();
    const u = new AS.AStarSearch(g.cost, start, goal, false).run();
    assert(a.status === u.status, `status differs on map ${i}`);
    if (a.status === 'found') {
      assert(Math.abs(a.pathCost - u.pathCost) < 1e-9, `cost ${a.pathCost} vs ${u.pathCost} on map ${i}`);
      // Path is connected, uses only passable cells, and its cost adds up.
      let cost = 0;
      for (let k = 1; k < a.path.length; k++) {
        const [c0, r0] = a.path[k - 1], [c1, r1] = a.path[k];
        assert(Math.abs(c0 - c1) + Math.abs(r0 - r1) === 1, 'non-adjacent step');
        const cc = g.cost.get(AS.key(c1, r1));
        assert(cc !== null && cc !== undefined, 'path through blocked cell');
        cost += cc;
      }
      assert(Math.abs(cost - a.pathCost) < 1e-9, 'path cost mismatch');
    }
  }
});
test('reports no path when every route is cut', () => {
  const g = AS.buildCostGrid(RM.DEFAULTS, 10, AS.CUT_CELLS.map(([c, r]) => AS.key(c, r)));
  const a = new AS.AStarSearch(g.cost, AS.DEFAULT_START, AS.DEFAULT_GOAL, true).run();
  assert(a.status === 'nopath' && a.path.length === 0);
});
test('works zones are impassable when the surface is under construction', () => {
  const g = AS.buildCostGrid(Object.assign({}, RM.DEFAULTS, { surface: 'construction' }), 10, []);
  for (const [c, r] of AS.HAZARDS.work) assert(g.cost.get(AS.key(c, r)) === null);
});

console.log('Traffic simulation');
test('no overlapping vehicles in any lane (3 scenarios × 5 simulated minutes)', () => {
  for (const cond of [{ density: 40, speed: 50, weather: 'sunny', surface: 'dry' }, { density: 100, speed: 100, weather: 'rainy', surface: 'construction' }, { density: 70, speed: 120, weather: 'foggy', surface: 'potholes' }]) {
    const s = new T.Simulation(); s.setConditions(cond); s.reset();
    for (let i = 0; i < 18000; i++) {
      s.step(1 / 60);
      if (i % 6) continue;
      for (const lane of s.lanes) {
        const l = lane.vehicles;
        for (let j = 1; j < l.length; j++) {
          if (l[j].lc || l[j - 1].lc) continue;
          assert(l[j - 1].u - l[j - 1].type.L - l[j].u > -0.01, `overlap in lane ${lane.def.id}`);
        }
      }
    }
    assert(s.stats.exited > 50, 'traffic must keep flowing');
  }
});
test('speeds stay within the requested limit (+ desire margin)', () => {
  const s = new T.Simulation(); s.setConditions({ density: 50, speed: 60, weather: 'sunny', surface: 'dry' }); s.reset();
  for (let i = 0; i < 6000; i++) { s.step(1 / 60); for (const l of s.lanes) for (const v of l.vehicles) assert(v.v * 3.6 <= 60 * 1.06 + 0.5, `${v.kind} at ${(v.v * 3.6).toFixed(1)} km/h`); }
});
test('higher density puts more vehicles on the road', () => {
  const count = d => { const s = new T.Simulation(); s.setConditions({ density: d, speed: 50 }); s.reset(); for (let i = 0; i < 6000; i++) s.step(1 / 60); return s.visibleCount(); };
  const lo = count(10), hi = count(90);
  assert(hi > lo * 2, `density 10 → ${lo}, density 90 → ${hi}`);
});
test('reset is reproducible (seeded)', () => {
  const run = () => { const s = new T.Simulation(); s.reset(); for (let i = 0; i < 600; i++) s.step(1 / 60); return s.snapshot([]).map(v => v.u.toFixed(4)).join(','); };
  assert(run() === run());
});
test('step size does not change the outcome much (frame-rate independence)', () => {
  const run = dt => { const s = new T.Simulation(); s.reset(); for (let t = 0; t < 20; t += dt) s.step(dt); return s.stats.exited; };
  const a = run(1 / 30), b = run(1 / 144);
  assert(Math.abs(a - b) <= 3, `${a} vs ${b}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
