/* ==========================================================================
   AI concept laboratory — seven interactive demonstrations
   --------------------------------------------------------------------------
   1 Intelligent agents        model-based reflex agent at a junction
   2 Probability & uncertainty Monte Carlo spread of the risk score
   3 Knowledge representation  facts + IF–THEN rules + forward chaining
   4 Learning agents           ε-greedy value learning of a speed policy
   5 Problem formulation       states, actions, goal test, constraints
   6 Utility-based agents      weighted multi-attribute utility
   7 A* informed search        animated search on a hazard-weighted grid

   Demos 2, 3, 5, 6 and 7 read the live conditions from the road
   simulation (window.App.getInputs) and update when they change.
   ========================================================================== */
(function () {
  'use strict';

  const RM = window.RiskModel;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const live = () => (window.App ? window.App.getInputs() : RM.sanitize(RM.DEFAULTS));
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const radioValue = name => { const r = $(`input[name="${name}"]:checked`); return r ? r.value : null; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const conditionText = c => `${RM.WEATHER[c.weather].label}, ${RM.SURFACE[c.surface].label.toLowerCase()} road, ${RM.LIGHTING[c.lighting].label.toLowerCase()}, visibility ${RM.formatDistance(c.visibility)}, traffic ${c.density}%, ${c.speed} km/h`;
  const levelChip = lvl => `<span class="mini-level" data-level="${lvl}">${lvl}</span>`;

  /** Sizes a canvas to its CSS box (device pixels) and returns { g, w, h } in CSS pixels. */
  function fitCanvas(canvas) { return window.Charts.fit(canvas); }

  // =====================================================================
  // Tabs (WAI-ARIA tabs pattern with arrow-key navigation)
  // =====================================================================
  const demos = {};
  function initTabs() {
    const tabs = $$('#lab-tabs [role="tab"]');
    const activate = (tab, focus) => {
      tabs.forEach(t => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        $('#' + t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) tab.focus();
      const id = tab.getAttribute('aria-controls');
      if (demos[id] && demos[id].show) demos[id].show();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => activate(t));
      t.addEventListener('keydown', e => {
        let j = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
        if (e.key === 'Home') j = 0;
        if (e.key === 'End') j = tabs.length - 1;
        if (j !== null) { e.preventDefault(); activate(tabs[j], true); }
      });
    });
  }
  function visiblePanel() {
    const p = $$('.lab-panel').find(x => !x.hidden);
    return p ? p.id : null;
  }

  // =====================================================================
  // 1. Intelligent agent
  // =====================================================================
  function AgentDemo() {
    const canvas = $('#agent-canvas');
    const ROAD_LEN = 150, STOP_X = 108, ZEBRA = [109.5, 113.5], STALLED_X = 72, PED_TRIGGER = 42, PED_CROSS_S = 7;
    const SENSOR = 60;               // perception range (m)
    const RULES = [
      { id: 'R1', ifText: 'gap to obstacle < stopping distance + 2 m', then: 'Emergency brake' },
      { id: 'R2', ifText: 'pedestrian on or entering the crossing ahead', then: 'Stop before the crossing' },
      { id: 'R3', ifText: 'stalled vehicle in my lane within 45 m and next lane clear', then: 'Slow down and change lane' },
      { id: 'R4', ifText: 'signal red and stop line ahead', then: 'Stop at the stop line' },
      { id: 'R5', ifText: 'signal amber and I can stop comfortably (≤ 3 m/s²)', then: 'Stop at the stop line' },
      { id: 'R6', ifText: 'signal amber and I cannot stop comfortably', then: 'Proceed with caution' },
      { id: 'R7', ifText: 'road is wet', then: 'Cruise at 80% of target speed' },
      { id: 'R8', ifText: 'otherwise', then: 'Cruise at target speed' },
    ];
    const tbody = $('#agent-rules tbody');
    tbody.innerHTML = RULES.map(r => `<tr data-rule="${r.id}"><td class="mono">${r.id}</td><td>${r.ifText}</td><td>${r.then}</td></tr>`).join('');

    let s, raf = 0, last = 0;
    function reset() {
      cancelAnimationFrame(raf); raf = 0;
      s = {
        x: 6, v: Number($('#agent-speed').value) / 3.6, moving: true, lane: 0, laneY: 0, t: 0, running: false, done: false,
        sig: { state: radioValue('agent-signal') === 'red' ? 'red' : 'green', t: 0 },
        hazard: radioValue('agent-hazard'), road: radioValue('agent-road'),
        ped: { active: false, y: -1, done: false }, perceiveT: 0, decision: null,
        memory: { amberFor: 0, sawPedestrian: false }, waited: 0, stops: 0, maxBrake: 0, fired: {}, lastRule: null,
      };
      $('#agent-percept').textContent = '—';
      $('#agent-rule').textContent = '—';
      $('#agent-action').textContent = '—';
      $$('tr', tbody).forEach(tr => tr.classList.remove('is-fired'));
      $('#agent-result').innerHTML = 'Press <strong>Run agent</strong> to start the perceive → decide → act loop.';
      draw();
    }

    const bMax = () => (s.road === 'wet' ? 5 : 7);
    const target = () => (Number($('#agent-speed').value) / 3.6) * (s.road === 'wet' ? 0.8 : 1);

    function signalStep(dt) {
      const mode = radioValue('agent-signal');
      if (mode !== 'cycle') { s.sig.state = mode; return; }
      s.sig.t += dt;
      const cycle = [['green', 5], ['yellow', 3], ['red', 6]];
      let t = s.sig.t % 14, acc = 0;
      for (const [st, d] of cycle) { if (t < acc + d) { s.sig.state = st; break; } acc += d; }
    }

    /** PERCEIVE: build the percept from the world (only what the sensor can see). */
    function perceive() {
      const toLine = STOP_X - s.x;
      const p = { speed: s.v, signal: s.sig.state, toLine, wet: s.road === 'wet', obstacle: null, pedestrian: false };
      if (s.hazard === 'stalled' && s.lane === 0 && STALLED_X - s.x > 0 && STALLED_X - s.x < SENSOR) p.obstacle = STALLED_X - 2 - s.x;
      if (s.ped.active && !s.ped.done && ZEBRA[0] - s.x < SENSOR && ZEBRA[0] - s.x > -1) p.pedestrian = true;
      return p;
    }

    /** DECIDE: condition–action rules in priority order, using the internal model (memory). */
    function decide(p) {
      const b = bMax();
      const stopDist = (p.speed * p.speed) / (2 * b);
      // Brake so the car stops at distance d; near the stop point it brakes fully and holds,
      // so it never creeps over the line.
      const brakeTo = d => (d < 3 && p.speed < 1.5) || d <= 0.3 ? -b : -Math.min(b, (p.speed * p.speed) / (2 * (d - 0.3)));
      if (p.obstacle !== null && p.obstacle < stopDist + 2) return { rule: 'R1', action: 'Emergency brake', acc: -b };
      if (p.pedestrian && ZEBRA[0] - 1.5 - s.x > -0.5) return { rule: 'R2', action: 'Stop before the crossing', acc: brakeTo(ZEBRA[0] - 1.5 - s.x) };
      if (p.obstacle !== null && p.obstacle < 45) return { rule: 'R3', action: 'Slow down and change lane', acc: clamp((25 / 3.6 - p.speed) * 0.9, -3, 1), changeLane: true };
      if (p.signal === 'red' && p.toLine > -0.5) return { rule: 'R4', action: 'Stop at the stop line', acc: brakeTo(p.toLine - 0.5) };
      if (p.signal === 'yellow' && p.toLine > 0) {
        const need = (p.speed * p.speed) / (2 * Math.max(p.toLine - 0.5, 0.3));
        if (need <= 3 || s.memory.decidedStop) { s.memory.decidedStop = true; return { rule: 'R5', action: 'Stop at the stop line', acc: brakeTo(p.toLine - 0.5) }; }
        return { rule: 'R6', action: 'Proceed with caution', acc: clamp((target() - p.speed) * 0.5, -1, 0.5) };
      }
      if (p.signal !== 'yellow') s.memory.decidedStop = false;
      if (p.wet) return { rule: 'R7', action: 'Cruise at 80% of target', acc: clamp((target() - p.speed) * 0.8, -3, 1.8) };
      return { rule: 'R8', action: 'Cruise at target speed', acc: clamp((target() - p.speed) * 0.8, -3, 1.8) };
    }

    function tick(dt) {
      s.t += dt;
      signalStep(dt);
      s.memory.amberFor = s.sig.state === 'yellow' ? s.memory.amberFor + dt : 0;
      // Pedestrian starts crossing when the car approaches and takes PED_CROSS_S seconds.
      if (s.hazard === 'pedestrian' && !s.ped.active && !s.ped.done && ZEBRA[0] - s.x < PED_TRIGGER) { s.ped.active = true; s.ped.y = -0.15; }
      if (s.ped.active) { s.ped.y += dt / PED_CROSS_S; if (s.ped.y > 1.15) { s.ped.active = false; s.ped.done = true; } }

      s.perceiveT -= dt;
      if (s.perceiveT <= 0) {           // agent cycle every 0.2 s
        s.perceiveT = 0.2;
        const p = perceive();
        s.decision = decide(p);
        s.fired[s.decision.rule] = (s.fired[s.decision.rule] || 0) + 1;
        $('#agent-percept').textContent = `${(p.speed * 3.6).toFixed(0)} km/h · signal ${p.signal === 'yellow' ? 'amber' : p.signal} · line ${p.toLine > 0 ? p.toLine.toFixed(0) + ' m' : 'passed'}${p.obstacle !== null ? ' · obstacle ' + p.obstacle.toFixed(0) + ' m' : ''}${p.pedestrian ? ' · pedestrian' : ''}${p.wet ? ' · wet' : ''}`;
        if (s.lastRule !== s.decision.rule) {
          $('#agent-rule').textContent = s.decision.rule + ': ' + RULES.find(r => r.id === s.decision.rule).ifText;
          $('#agent-action').textContent = s.decision.action;
          $$('tr', tbody).forEach(tr => tr.classList.toggle('is-fired', tr.dataset.rule === s.decision.rule));
          s.lastRule = s.decision.rule;
        }
        if (s.decision.changeLane && s.lane === 0) s.lane = 1;
      }
      // ACT: apply the chosen acceleration.
      const a = s.decision ? s.decision.acc : 0;
      if (s.v > 2) s.maxBrake = Math.max(s.maxBrake, -a);   // ignore the final hold at walking pace
      s.v = Math.max(0, s.v + a * dt);
      if (s.v <= 0.05) { if (s.moving) s.stops++; s.moving = false; s.waited += dt; }
      else if (s.v > 0.5) s.moving = true;
      s.x += s.v * dt;
      s.laneY += (s.lane - s.laneY) * Math.min(1, dt * 1.6);
      if (s.x > ROAD_LEN + 4 || s.t > 45 || (radioValue('agent-signal') === 'red' && s.waited > 6)) finish();
    }

    function finish() {
      s.running = false; s.done = true;
      const counts = Object.entries(s.fired).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ');
      const passed = s.x > ROAD_LEN;
      const msg = passed
        ? `Trip complete in ${s.t.toFixed(1)} s. The agent stopped ${s.stops} time${s.stops === 1 ? '' : 's'} and waited ${s.waited.toFixed(1)} s; hardest braking ${s.maxBrake.toFixed(1)} m/s². Rules used: ${counts}.`
        : `The agent is holding safely at the red stop line (${(STOP_X - s.x).toFixed(1)} m before it). Rules used: ${counts}.`;
      $('#agent-result').textContent = msg;
    }

    function loop(ts) {
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 60;
      last = ts;
      tick(dt);
      draw();
      if (s.running) raf = requestAnimationFrame(loop);
      else { raf = 0; last = 0; }
    }

    function draw() {
      const { g, w, h } = fitCanvas(canvas);
      const k = w / ROAD_LEN;
      const roadTop = h * 0.26, laneH = h * 0.22;
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#c9d6b4'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#d8d2c4'; g.fillRect(0, roadTop - h * 0.07, w, h * 0.07); g.fillRect(0, roadTop + laneH * 2, w, h * 0.07);
      g.fillStyle = s && s.road === 'wet' ? '#4c535c' : '#5f656c';
      g.fillRect(0, roadTop, w, laneH * 2);
      // Lane line and edge lines.
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2; g.setLineDash([3 * k, 4.5 * k]);
      g.beginPath(); g.moveTo(0, roadTop + laneH); g.lineTo(STOP_X * k - 16 * k, roadTop + laneH); g.stroke(); g.setLineDash([]);
      g.beginPath(); g.moveTo(STOP_X * k - 16 * k, roadTop + laneH); g.lineTo(STOP_X * k, roadTop + laneH); g.stroke();
      // Stop line and zebra.
      g.fillStyle = '#fff'; g.fillRect(STOP_X * k, roadTop, 0.5 * k, laneH * 2);
      for (let y = roadTop + 2; y < roadTop + laneH * 2 - 2; y += laneH * 0.3) g.fillRect(ZEBRA[0] * k, y, (ZEBRA[1] - ZEBRA[0]) * k, laneH * 0.16);
      // Signal head.
      const sx = (ZEBRA[1] + 2) * k, sy = roadTop - h * 0.2;
      g.fillStyle = '#1d2024'; g.fillRect(sx - 7, sy, 14, h * 0.17);
      const st = s ? s.sig.state : 'green';
      [['red', '#ff4b3e'], ['yellow', '#ffb21a'], ['green', '#2fd67a']].forEach(([n, c], i) => {
        g.fillStyle = st === n ? c : '#3b3f45';
        g.beginPath(); g.arc(sx, sy + h * 0.03 + i * h * 0.055, Math.min(5, h * 0.022), 0, Math.PI * 2); g.fill();
      });
      if (!s) return;
      // Stalled auto-rickshaw with hazard triangle.
      if (s.hazard === 'stalled') {
        const ax = STALLED_X * k, ay = roadTop + laneH * 0.5;
        g.fillStyle = '#f2c230'; g.fillRect(ax - 2.8 * k, ay - laneH * 0.28, 2.8 * k, laneH * 0.56);
        g.fillStyle = '#222'; g.fillRect(ax - 2.0 * k, ay - laneH * 0.26, 1.6 * k, laneH * 0.52);
        g.fillStyle = '#e74c3c'; g.beginPath(); g.moveTo(ax - 9 * k, ay + 6); g.lineTo(ax - 8 * k, ay - 6); g.lineTo(ax - 7 * k, ay + 6); g.closePath(); g.fill();
      }
      // Pedestrian on the crossing.
      if (s.ped.active) {
        const py = roadTop + laneH * 2 * s.ped.y;
        g.fillStyle = '#c0392b'; g.beginPath(); g.arc(((ZEBRA[0] + ZEBRA[1]) / 2) * k, py, Math.max(4, laneH * 0.16), 0, Math.PI * 2); g.fill();
      }
      // Agent car with sensor cone.
      const cy = roadTop + laneH * (0.5 + s.laneY), cx = s.x * k;
      const grd = g.createLinearGradient(cx, 0, cx + SENSOR * k, 0);
      grd.addColorStop(0, 'rgba(47,127,200,.32)'); grd.addColorStop(1, 'rgba(47,127,200,0)');
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + SENSOR * k, cy - laneH * 0.9); g.lineTo(cx + SENSOR * k, cy + laneH * 0.9); g.closePath(); g.fill();
      g.fillStyle = '#1f5fbf'; g.fillRect(cx - 4.3 * k, cy - laneH * 0.3, 4.3 * k, laneH * 0.6);
      g.fillStyle = '#9fc4ef'; g.fillRect(cx - 1.6 * k, cy - laneH * 0.24, 0.9 * k, laneH * 0.48);
      if (s.decision && s.decision.acc < -0.6) { g.fillStyle = '#ff3b30'; g.fillRect(cx - 4.5 * k, cy - laneH * 0.3, 0.4 * k, laneH * 0.6); }
      // HUD.
      g.fillStyle = 'rgba(12,20,28,.72)'; g.fillRect(8, h - 30, 210, 22);
      g.fillStyle = '#fff'; g.font = '600 12px ' + css('--font-mono'); g.textBaseline = 'middle';
      g.fillText(`${(s.v * 3.6).toFixed(0).padStart(3)} km/h   t ${s.t.toFixed(1)} s`, 16, h - 19);
    }

    $('#agent-run').addEventListener('click', () => {
      if (s.running) return;
      if (s.done || s.t > 0) reset();
      s.running = true;
      $('#agent-result').textContent = 'Running… watch the highlighted rule change as the percepts change.';
      raf = requestAnimationFrame(loop);
    });
    $('#agent-reset').addEventListener('click', reset);
    $('#agent-speed').addEventListener('input', () => { $('#agent-speed-out').textContent = $('#agent-speed').value + ' km/h'; });
    ['agent-hazard', 'agent-road'].forEach(n => $$(`input[name="${n}"]`).forEach(r => r.addEventListener('change', reset)));
    $$('input[name="agent-signal"]').forEach(r => r.addEventListener('change', () => { if (!s.running) reset(); }));
    reset();
    return { show: draw, redraw: draw };
  }

  // =====================================================================
  // 2. Probability & uncertainty (Monte Carlo)
  // =====================================================================
  function ProbabilityDemo() {
    let seed = 1;
    const chart = new window.Charts.BarChart($('#prob-chart'), {
      tooltip: $('#prob-tip'), xMin: 0, xMax: 100, xTicks: [0, 20, 35, 50, 65, 80, 100],
      format: b => `<b>${b.from}–${b.to}</b>: ${b.value} samples<br>${(b.share * 100).toFixed(1)}% · ${b.level}`,
    });
    const outs = { 'prob-vis': v => `±${v}%`, 'prob-den': v => `±${v} pts`, 'prob-spd': v => `±${v} km/h`, 'prob-rain': v => `${v}%` };

    function run() {
      const base = live();
      const u = { vis: Number($('#prob-vis').value) / 100, den: Number($('#prob-den').value), spd: Number($('#prob-spd').value), rain: Number($('#prob-rain').value) / 100 };
      const n = Number(radioValue('prob-n'));
      const rng = window.Traffic.mulberry32(1000 + seed);
      const U = () => rng() * 2 - 1;
      const scores = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const c = Object.assign({}, base);
        c.visibility = clamp(base.visibility * (1 + u.vis * U()), 50, 2000);
        c.density = clamp(base.density + u.den * U(), 0, 100);
        c.speed = clamp(base.speed + u.spd * U(), 20, 120);
        if (base.weather !== 'rainy' && rng() < u.rain) {
          c.weather = 'rainy';
          c.visibility = Math.min(c.visibility, 800);
          if (c.surface === 'dry') c.surface = 'wet';
        }
        scores[i] = RM.evaluate(c).score;
      }
      const sorted = Array.from(scores).sort((a, b) => a - b);
      const mean = sorted.reduce((s, v) => s + v, 0) / n;
      const pct = q => sorted[Math.min(n - 1, Math.floor(q * n))];
      const pLow = sorted.filter(v => v < RM.THRESHOLDS.medium).length / n;
      const pHigh = sorted.filter(v => v >= RM.THRESHOLDS.high).length / n;
      const point = RM.evaluate(base);
      const bins = [];
      for (let b = 0; b < 20; b++) {
        const from = b * 5, to = from + 5;
        const count = sorted.filter(v => v >= from && (b === 19 ? v <= to : v < to)).length;
        const level = RM.classify(from);
        bins.push({ from, to, value: count, share: count / n, level, cssVar: level === 'LOW' ? '--low' : level === 'MEDIUM' ? '--med' : '--high' });
      }
      chart.setData(bins, [{ x: point.score, label: `point ${point.score.toFixed(0)}` }, { x: mean, label: `mean ${mean.toFixed(0)}` }].sort((a, b) => a.x - b.x));
      $('#prob-stats').innerHTML = [
        ['Mean score', mean.toFixed(1)],
        ['90% interval', `${pct(0.05).toFixed(0)}–${pct(0.95).toFixed(0)}`],
        ['P(LOW)', (pLow * 100).toFixed(1) + '<small>%</small>'],
        ['P(HIGH)', (pHigh * 100).toFixed(1) + '<small>%</small>'],
      ].map(([k, v]) => `<div class="stat"><span class="stat__k">${k}</span><span class="stat__v">${v}</span></div>`).join('');
      $('#prob-live').innerHTML = `<b>Live conditions:</b> ${conditionText(base)}. Point estimate ${point.score.toFixed(1)} ${levelChip(point.level)} · sample set #${seed} (${n.toLocaleString()} samples).`;
      $('#prob-chart').setAttribute('aria-label', `Histogram of ${n} sampled risk scores. Mean ${mean.toFixed(1)}, 90 percent of samples between ${pct(0.05).toFixed(0)} and ${pct(0.95).toFixed(0)}. ${(pHigh * 100).toFixed(1)} percent in HIGH.`);
    }

    Object.keys(outs).forEach(id => $('#' + id).addEventListener('input', () => { $('#' + id + '-out').textContent = outs[id]($('#' + id).value); run(); }));
    $$('input[name="prob-n"]').forEach(r => r.addEventListener('change', run));
    $('#prob-resample').addEventListener('click', () => { seed++; run(); });
    return { show: run, onConditions: run, redraw: () => chart.draw() };
  }

  // =====================================================================
  // 3. Knowledge representation (forward chaining)
  // =====================================================================
  function KnowledgeDemo() {
    const BASE_FACTS = ['Rain', 'Fog', 'WetRoad', 'Potholes', 'Construction', 'LowVisibility', 'VeryLowVisibility', 'ModerateSpeed', 'HighSpeed', 'Overspeeding', 'HighDensity', 'Dusk', 'Night', 'Unlit'];
    const RULES = [
      ['R1', ['Rain'], 'WetRoad'],
      ['R2', ['WetRoad', 'HighSpeed'], 'SkidRisk'],
      ['R3', ['Fog'], 'LowVisibility'],
      ['R4', ['LowVisibility', 'HighSpeed'], 'LateBrakingRisk'],
      ['R5', ['HighDensity', 'HighSpeed'], 'RearEndRisk'],
      ['R6', ['Potholes', 'ModerateSpeed'], 'LossOfControlRisk'],
      ['R7', ['Construction'], 'LaneNarrowing'],
      ['R8', ['LaneNarrowing', 'HighDensity'], 'CongestionRisk'],
      ['R9', ['LowVisibility', 'HighDensity'], 'CollisionRisk'],
      ['R10', ['Unlit'], 'PoorLighting'],
      ['R11', ['PoorLighting', 'ModerateSpeed'], 'PedestrianRisk'],
      ['R12', ['VeryLowVisibility|Overspeeding'], 'SevereCondition'],
      ['R13', ['SevereCondition', 'SkidRisk|LateBrakingRisk|LossOfControlRisk|PedestrianRisk'], 'CriticalAlert'],
    ];
    const ADVICE = {
      CriticalAlert: 'CRITICAL: postpone the trip if possible, or drive very slowly with hazard lights ready.',
      SkidRisk: 'Wet surface at high speed: slow down 20–30% and avoid sudden braking or sharp turns.',
      LateBrakingRisk: 'Low visibility at speed: use low-beam or fog lamps and keep a 4-second gap.',
      CollisionRisk: 'Poor visibility in dense traffic: do not overtake; follow lane markings closely.',
      RearEndRisk: 'Dense traffic at high speed: increase following distance and brake early.',
      LossOfControlRisk: 'Potholes ahead: reduce speed and hold the steering firmly.',
      LaneNarrowing: 'Work zone: follow diversion signs and merge early near the cones.',
      CongestionRisk: 'Expect queues near the work zone; avoid lane cutting.',
      PoorLighting: 'Unlit road: use headlights and dip them for oncoming traffic.',
      PedestrianRisk: 'Dark road at moderate speed: slow down near bus stops and crossings; watch for pedestrians and unlit cycles.',
      SevereCondition: 'Severe condition detected: reduce speed well below the limit.',
      WetRoad: 'Wet road: allow double the normal braking distance.',
    };
    let base = new Set(), derived = [], fired = [], liveMode = true, timer = 0;

    function factsFromInputs(c) {
      const f = new Set();
      if (c.weather === 'rainy') f.add('Rain');
      if (c.weather === 'foggy') f.add('Fog');
      if (c.surface === 'wet') f.add('WetRoad');
      if (c.surface === 'potholes') f.add('Potholes');
      if (c.surface === 'construction') f.add('Construction');
      if (c.visibility < 300) f.add('LowVisibility');
      if (c.visibility < 150) f.add('VeryLowVisibility');
      if (c.speed > 50) f.add('ModerateSpeed');
      if (c.speed > 80) f.add('HighSpeed');
      if (c.speed > 100) f.add('Overspeeding');
      if (c.density > 65) f.add('HighDensity');
      if (c.lighting === 'dusk') f.add('Dusk');
      if (c.lighting === 'nightLit' || c.lighting === 'nightDark') f.add('Night');
      if (c.lighting === 'nightDark') f.add('Unlit');
      return f;
    }
    const known = () => new Set([...base, ...derived]);
    const satisfied = (item, facts) => item.split('|').some(p => facts.has(p));

    function nextRule() {
      const facts = known();
      return RULES.find(([id, prem, concl]) => !fired.includes(id) && !facts.has(concl) && prem.every(p => satisfied(p, facts)));
    }
    function fireOne() {
      const r = nextRule();
      if (!r) return false;
      fired.push(r[0]);
      derived.push(r[2]);
      render(r[0]);
      return true;
    }
    function resetInference() { clearTimeout(timer); derived = []; fired = []; render(); }
    function loadLive() { base = factsFromInputs(live()); liveMode = true; resetInference(); }

    function render(latest) {
      const facts = known();
      $('#kr-facts').innerHTML = BASE_FACTS.map(f => `<button type="button" class="fact" aria-pressed="${base.has(f)}" data-fact="${f}">${f}</button>`).join('');
      $('#kr-rules').innerHTML = RULES.map(([id, prem, concl]) => {
        const premText = prem.map(p => p.split('|').join(' ∨ ')).map(p => (p.includes('∨') ? `(${p})` : p)).join(' ∧ ');
        const cls = [fired.includes(id) ? 'is-fired' : '', id === latest ? 'is-latest' : ''].join(' ');
        return `<li class="${cls}"><span class="rid">${id}</span><span>IF <code>${premText}</code> THEN <code>${concl}</code></span></li>`;
      }).join('');
      $('#kr-derived').innerHTML = derived.length
        ? derived.map(d => `<span class="fact fact--derived ${d === derived[derived.length - 1] && latest ? 'fact--new' : ''}">${d}</span>`).join('')
        : '<span class="hint">No facts derived yet — fire the rules.</span>';
      const adviceKeys = Object.keys(ADVICE).filter(k => facts.has(k));
      $('#kr-advice').innerHTML = adviceKeys.length
        ? adviceKeys.map(k => `<li>${ADVICE[k]}</li>`).join('')
        : `<li>${nextRule() ? 'Advice appears as facts are derived.' : 'No hazards inferred: keep normal precautions.'}</li>`;
      $('#kr-trace').innerHTML = fired.map((id, i) => {
        const r = RULES.find(x => x[0] === id);
        return `<li>${i + 1}. ${id}: ${r[1].join(' ∧ ')} ⇒ ${r[2]}</li>`;
      }).join('') + (fired.length && !nextRule() ? '<li>Fixpoint reached: no rule can add a new fact.</li>' : '');
      $('#kr-step').disabled = !nextRule();
      $('#kr-run').disabled = !nextRule();
      $$('.fact[data-fact]').forEach(b => b.addEventListener('click', () => {
        const f = b.dataset.fact;
        if (base.has(f)) base.delete(f); else base.add(f);
        liveMode = false;
        resetInference();
      }));
    }

    $('#kr-step').addEventListener('click', fireOne);
    $('#kr-run').addEventListener('click', () => {
      clearTimeout(timer);
      if (reduced()) { while (fireOne()) { /* fire all */ } return; }
      const go = () => { if (fireOne()) timer = setTimeout(go, 380); };
      go();
    });
    $('#kr-reset').addEventListener('click', resetInference);
    $('#kr-live').addEventListener('click', loadLive);
    loadLive();
    return { onConditions: () => { if (liveMode) loadLive(); } };
  }

  // =====================================================================
  // 4. Learning agent (ε-greedy action-value learning)
  // =====================================================================
  function LearningDemo() {
    const CONTEXTS = [
      { name: 'Dry daylight', c: { weather: 'sunny', surface: 'dry', lighting: 'day', visibility: 2000, density: 40 } },
      { name: 'Unlit night', c: { weather: 'sunny', surface: 'dry', lighting: 'nightDark', visibility: 800, density: 40 } },
      { name: 'Dense fog', c: { weather: 'foggy', surface: 'dry', lighting: 'day', visibility: 150, density: 40 } },
      { name: 'Monsoon rain', c: { weather: 'rainy', surface: 'wet', lighting: 'day', visibility: 600, density: 40 } },
    ];
    const SPEEDS = [30, 45, 60, 75];
    // Reward model (documented in the README):
    //   progress = 10 · v / 75 · noise(±15%)
    //   hazard   = 1.5 · (score / 100)^2.5 · noise(±60%)       (score from the educational risk model)
    //   reward   = progress − 48 · hazard · (v / 75)^2         (harm grows with the square of speed)
    const HAZ_K = 1.5, HAZ_EXP = 2.5, HARM = 48, Q0 = 12;
    const scores = CONTEXTS.map(x => SPEEDS.map(v => RM.evaluate(Object.assign({}, x.c, { speed: v })).score));
    const expected = CONTEXTS.map((x, i) => SPEEDS.map((v, j) => 10 * v / 75 - HARM * HAZ_K * Math.pow(scores[i][j] / 100, HAZ_EXP) * (v / 75) ** 2));
    const optimal = expected.map(r => r.indexOf(Math.max(...r)));
    const bestAvg = expected.reduce((s, r) => s + Math.max(...r), 0) / CONTEXTS.length;
    let Q, N, rng, episodes, rewards, curve, training = 0;

    const chart = new window.Charts.LineChart($('#learn-chart'), {
      yMin: -2, yMax: 10, yTicks: [0, 2.5, 5, 7.5, 10], tooltip: $('#learn-tip'), emptyText: 'Train the agent to see its learning curve',
      refLines: [{ y: bestAvg, label: `best possible ≈ ${bestAvg.toFixed(2)}` }], xLabel: 'blocks of 50 trips',
      format: p => `Trips ${p.t - 49}–${p.t}<br>avg reward <b>${p.y.toFixed(2)}</b>`, labelFormat: p => p.y.toFixed(2),
    });

    function reset() {
      cancelAnimationFrame(training); training = 0;
      Q = CONTEXTS.map(() => SPEEDS.map(() => Q0));     // optimistic start encourages trying every speed
      N = CONTEXTS.map(() => SPEEDS.map(() => 0));
      rng = window.Traffic.mulberry32(77);
      episodes = 0; rewards = []; curve = [];
      render();
    }

    function episode() {
      const i = episodes % CONTEXTS.length;          // conditions cycle so each gets equal practice
      const eps = Number($('#learn-eps').value), alpha = Number($('#learn-alpha').value);
      let a;
      if (rng() < eps) a = Math.floor(rng() * SPEEDS.length);         // explore
      else { const m = Math.max(...Q[i]); a = Q[i].indexOf(m); }      // exploit
      const v = SPEEDS[a];
      const progress = (10 * v / 75) * (0.85 + 0.3 * rng());
      const hazard = HAZ_K * Math.pow(scores[i][a] / 100, HAZ_EXP) * (0.4 + 1.2 * rng());
      const reward = progress - HARM * hazard * (v / 75) ** 2;
      Q[i][a] += alpha * (reward - Q[i][a]);         // learning element
      N[i][a]++;
      episodes++;
      rewards.push(reward);
      if (rewards.length % 50 === 0) {
        const block = rewards.slice(-50);
        curve.push({ y: block.reduce((s, r) => s + r, 0) / 50, t: episodes });
        if (curve.length > 200) curve.shift();
      }
    }

    function train(n) {
      cancelAnimationFrame(training);
      if (reduced()) { for (let k = 0; k < n; k++) episode(); render(); return; }
      let left = n;
      const perFrame = Math.max(4, Math.ceil(n / 45));
      const step = () => {
        for (let k = 0; k < perFrame && left > 0; k++, left--) episode();
        render();
        if (left > 0) training = requestAnimationFrame(step); else training = 0;
      };
      training = requestAnimationFrame(step);
    }

    function render() {
      const truth = $('#learn-truth').checked;
      const greedy = Q.map(r => r.indexOf(Math.max(...r)));
      const rgb = css('--q-hi');
      let html = `<thead><tr><th scope="col">Condition</th>${SPEEDS.map(v => `<th scope="col">${v} km/h</th>`).join('')}</tr></thead><tbody>`;
      CONTEXTS.forEach((x, i) => {
        const vals = truth ? expected[i] : Q[i];
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const best = truth ? optimal[i] : greedy[i];
        html += `<tr><th scope="row">${x.name}</th>` + vals.map((q, j) => {
          const a = hi - lo > 1e-6 ? (q - lo) / (hi - lo) : 0.5;
          const label = truth ? `E=${q.toFixed(2)}` : N[i][j] ? q.toFixed(2) : '—';
          return `<td class="${j === best ? 'is-best' : ''}" style="background:rgba(${rgb},${(0.08 + a * 0.55).toFixed(2)})">${label}<small>${truth ? 'risk ' + scores[i][j].toFixed(0) : 'n=' + N[i][j]}</small></td>`;
        }).join('') + '</tr>';
      });
      $('#q-table').innerHTML = html + '</tbody>';
      const matches = greedy.filter((g, i) => g === optimal[i]).length;
      const recent = rewards.slice(-200);
      const avg = recent.length ? recent.reduce((s, r) => s + r, 0) / recent.length : 0;
      $('#learn-stats').innerHTML = [
        ['Trips trained', episodes.toLocaleString()],
        ['Policy = optimum', episodes ? `${matches}<small>/4</small>` : '—'],
        ['Avg reward (last 200)', recent.length ? avg.toFixed(2) : '—'],
        ['Best possible avg', bestAvg.toFixed(2)],
      ].map(([k, v]) => `<div class="stat"><span class="stat__k">${k}</span><span class="stat__v">${v}</span></div>`).join('');
      chart.setData(curve.slice());
    }

    $('#learn-100').addEventListener('click', () => train(100));
    $('#learn-1000').addEventListener('click', () => train(1000));
    $('#learn-reset').addEventListener('click', reset);
    $('#learn-truth').addEventListener('change', render);
    $('#learn-eps').addEventListener('input', () => { $('#learn-eps-out').textContent = Number($('#learn-eps').value).toFixed(2); });
    $('#learn-alpha').addEventListener('input', () => { $('#learn-alpha-out').textContent = Number($('#learn-alpha').value).toFixed(2); });
    reset();
    return { show: render, redraw: render, policy: () => Q.map(r => SPEEDS[r.indexOf(Math.max(...r))]), optimal: () => optimal.map(i => SPEEDS[i]), train: n => { for (let k = 0; k < n; k++) episode(); render(); } };
  }

  // =====================================================================
  // 5. Problem formulation
  // =====================================================================
  function ProblemDemo() {
    const SPEEDS = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const FLOW = 0.8;   // average speed ≈ 80% of cruising speed because of signals and junctions
    const LIMIT = 60;   // illustrative posted urban speed limit (km/h)
    let prev = {};

    function run() {
      const c = live();
      const D = Number($('#pf-dist').value), T = Number($('#pf-time').value);
      const tol = radioValue('pf-tol');
      const limit = tol === 'low' ? RM.THRESHOLDS.medium : RM.THRESHOLDS.high;
      const rows = SPEEDS.map(v => {
        const time = (D / (v * FLOW)) * 60;
        const ev = RM.evaluate(Object.assign({}, c, { speed: v }));
        return { v, time, score: ev.score, level: ev.level, onTime: time <= T + 1e-9, safe: ev.score < limit, legal: v <= LIMIT };
      });
      const feasible = rows.filter(r => r.onTime && r.safe && r.legal);
      const minV = (D * 60) / (T * FLOW);                     // slowest speed that meets the deadline
      const safeRows = rows.filter(r => r.safe && r.legal);
      const maxSafe = safeRows.length ? safeRows[safeRows.length - 1].v : null;

      const def = {
        'State': 'A tuple <code>(position km, speed km/h, elapsed min, conditions)</code>',
        'Initial state': `<code>(0 km, 0 km/h, 0 min)</code> under ${conditionText(Object.assign({}, c, { speed: 0 })).replace(', 0 km/h', '')}`,
        'Actions': '<code>accelerate +10</code>, <code>decelerate −10</code>, <code>hold speed</code>, <code>stop and wait</code>',
        'Transition model': `position += speed × ${FLOW} × Δt (signals and junctions); risk = RiskModel(conditions, speed)`,
        'Goal test': `<code>position ≥ ${D} km</code> and <code>elapsed ≤ ${T} min</code>`,
        'Constraints': `risk score stays <code>&lt; ${limit}</code> (${tol === 'low' ? 'LOW only' : 'LOW or MEDIUM'}) at every step; speed ≤ ${LIMIT} km/h posted limit; stop at red lights`,
        'Path cost': 'Elapsed time in minutes (lower is better)',
      };
      const dl = $('#pf-def');
      dl.innerHTML = Object.entries(def).map(([k, v]) => `<dt>${k}</dt><dd class="${prev[k] && prev[k] !== v ? 'is-changed' : ''}">${v}</dd>`).join('');
      prev = def;

      $('#pf-outcomes').innerHTML = `<caption>Possible outcomes for each cruising speed (${D} km, ${T} min available)</caption>
        <thead><tr><th scope="col">Speed</th><th scope="col">Time</th><th scope="col">Risk</th><th scope="col">On time</th><th scope="col">Risk OK</th><th scope="col">Legal</th></tr></thead><tbody>` +
        rows.map(r => `<tr class="${feasible.length && r === feasible[feasible.length - 1] ? 'is-best' : ''}"><td class="mono">${r.v}</td><td class="mono">${r.time.toFixed(1)} min</td><td class="mono">${r.score.toFixed(1)} ${levelChip(r.level)}</td>
          <td class="${r.onTime ? 'ok' : 'no'}">${r.onTime ? '✓ yes' : '✗ no'}</td><td class="${r.safe ? 'ok' : 'no'}">${r.safe ? '✓ yes' : '✗ no'}</td><td class="${r.legal ? 'ok' : 'no'}">${r.legal ? '✓' : '✗'}</td></tr>`).join('') + '</tbody>';

      // Speed window graphic (20–120 km/h).
      const pos = v => clamp((v - 20) / 100, 0, 1) * 100;
      const lo = Math.max(20, minV), hi = maxSafe === null ? 20 : maxSafe;
      const ok = hi >= lo;
      $('#pf-window').innerHTML = `<div class="speed-window__track"></div>
        ${ok ? `<div class="speed-window__ok" style="left:${pos(lo)}%;width:${pos(hi) - pos(lo)}%"></div>` : ''}
        <div class="speed-window__mark" style="left:${pos(Math.min(120, minV))}%"></div>
        <span class="speed-window__lbl speed-window__lbl--top" style="left:${clamp(pos(Math.min(120, minV)), 8, 92)}%">deadline needs ≥ ${minV > 120 ? '120+' : Math.ceil(minV)} km/h</span>
        ${maxSafe !== null ? `<div class="speed-window__mark" style="left:${pos(maxSafe)}%"></div><span class="speed-window__lbl speed-window__lbl--bot" style="left:${clamp(pos(maxSafe), 8, 92)}%">risk &amp; ${LIMIT} km/h limit allow ≤ ${maxSafe} km/h</span>` : '<span class="speed-window__lbl speed-window__lbl--bot" style="left:50%">no speed keeps the risk within the limit</span>'}`;

      const best = feasible[feasible.length - 1];
      let msg;
      if (best) {
        msg = `Goal reachable. Feasible cruising speeds: ${feasible[0].v}–${best.v} km/h. Lowest path cost: ${best.v} km/h, arriving in ${best.time.toFixed(1)} min with risk ${best.score.toFixed(1)}.`;
      } else if (maxSafe === null) {
        msg = `No solution: even 20 km/h exceeds the risk limit under these conditions. Accept MEDIUM risk, or wait for better conditions.`;
      } else {
        const needT = (D / (maxSafe * FLOW)) * 60;
        msg = `No solution: the deadline needs at least ${Math.ceil(minV)} km/h but the risk limit and the ${LIMIT} km/h speed limit allow at most ${maxSafe} km/h. Allow ${Math.ceil(needT)} min or more, shorten the trip, or relax the risk limit.`;
      }
      $('#pf-result').textContent = msg;
      $('#pf-live').innerHTML = `<b>Live conditions:</b> ${conditionText(c)}. The current simulation speed is ignored here: choosing the speed is the problem.`;
    }
    $('#pf-dist').addEventListener('input', () => { $('#pf-dist-out').textContent = $('#pf-dist').value + ' km'; run(); });
    $('#pf-time').addEventListener('input', () => { $('#pf-time-out').textContent = $('#pf-time').value + ' min'; run(); });
    $$('input[name="pf-tol"]').forEach(r => r.addEventListener('change', run));
    return { show: run, onConditions: run };
  }

  // =====================================================================
  // 6. Utility-based agent
  // =====================================================================
  function UtilityDemo() {
    const TRIP_KM = 10, FLOW = 0.8;
    function actions(c) {
      const snap = v => clamp(Math.round(v / 5) * 5, 20, 120);
      const poorWx = c.weather === 'rainy' || c.weather === 'foggy' || c.lighting === 'nightDark';
      return [
        { name: 'Maintain speed', inputs: Object.assign({}, c), comfort: 90, extraMin: 0, why: 'no manoeuvre' },
        { name: 'Slow down 20%', inputs: Object.assign({}, c, { speed: snap(c.speed * 0.8) }), comfort: 82, extraMin: 0, why: 'gentle braking' },
        { name: 'Overtake', inputs: Object.assign({}, c, { speed: snap(c.speed + 15), density: clamp(c.density + 10, 0, 100) }), comfort: poorWx ? 25 : 45, extraMin: 0, why: poorWx ? 'stressful in poor conditions' : 'lane changes and acceleration' },
        { name: 'Increase gap', inputs: Object.assign({}, c, { speed: snap(c.speed - 5), density: clamp(c.density - 15, 0, 100) }), comfort: 88, extraMin: 0, why: 'calmer following' },
        { name: 'Pull over 10 min', inputs: null, comfort: 60, extraMin: 10, why: 'waiting' },
      ];
    }
    function run() {
      const c = live();
      let ws = Number($('#util-ws').value), wt = Number($('#util-wt').value), wc = Number($('#util-wc').value);
      const sum = ws + wt + wc || 1;
      ws /= sum; wt /= sum; wc /= sum;
      const list = actions(c).map(a => {
        const speed = a.inputs ? a.inputs.speed : c.speed;
        const time = (TRIP_KM / (speed * FLOW)) * 60 + a.extraMin;
        const score = a.inputs ? RM.evaluate(a.inputs).score : 5;     // parked safely off the road
        return Object.assign(a, { speed, time, risk: score, safety: 100 - score });
      });
      const minTime = Math.min(...list.map(a => a.time));
      list.forEach(a => {
        a.timeScore = (100 * minTime) / a.time;
        a.parts = [ws * a.safety, wt * a.timeScore, wc * a.comfort];
        a.U = a.parts[0] + a.parts[1] + a.parts[2];
      });
      const best = list.reduce((b, a) => (a.U > b.U ? a : b), list[0]);
      const runner = list.filter(a => a !== best).reduce((b, a) => (a.U > b.U ? a : b));
      $('#util-bars').innerHTML = list.map(a => `<li class="${a === best ? 'is-best' : ''}">
          <span class="ub-name">${a.name}</span>
          <span class="ub-track" role="img" aria-label="${a.name}: utility ${a.U.toFixed(1)}; safety ${a.parts[0].toFixed(1)}, time ${a.parts[1].toFixed(1)}, comfort ${a.parts[2].toFixed(1)}">
            <i class="ub-s" style="width:${a.parts[0]}%"></i><i class="ub-t" style="width:${a.parts[1]}%"></i><i class="ub-c" style="width:${a.parts[2]}%"></i>
          </span>
          <span class="ub-val">${a.U.toFixed(1)}</span></li>`).join('');
      $('#util-table').innerHTML = `<caption>Attribute scores (0–100) for a ${TRIP_KM} km trip</caption><thead><tr><th scope="col">Action</th><th scope="col" class="mono">Safety</th><th scope="col" class="mono">Time</th><th scope="col" class="mono">Comfort</th></tr></thead><tbody>` +
        list.map(a => `<tr class="${a === best ? 'is-best' : ''}"><td>${a.name}<br><small class="hint">${a.speed} km/h · ${a.time.toFixed(1)} min · ${a.why}</small></td><td class="mono">${a.safety.toFixed(0)}</td><td class="mono">${a.timeScore.toFixed(0)}</td><td class="mono">${a.comfort}</td></tr>`).join('') + '</tbody>';
      const diffs = ['Safety', 'Time', 'Comfort'].map((n, k) => ({ n, d: best.parts[k] - runner.parts[k] })).sort((a, b) => b.d - a.d);
      $('#util-result').innerHTML = `<strong>Chosen: ${best.name}</strong> (U = ${best.U.toFixed(1)}). It beats “${runner.name}” (${runner.U.toFixed(1)}) mainly on ${diffs[0].n.toLowerCase()} (+${diffs[0].d.toFixed(1)} weighted points)${diffs[2].d < -0.05 ? `, while giving up ${Math.abs(diffs[2].d).toFixed(1)} on ${diffs[2].n.toLowerCase()}` : ''}. Weights used: safety ${ws.toFixed(2)}, time ${wt.toFixed(2)}, comfort ${wc.toFixed(2)}.`;
      $('#util-live').innerHTML = `<b>Live conditions:</b> ${conditionText(c)}.`;
    }
    ['util-ws', 'util-wt', 'util-wc'].forEach(id => $('#' + id).addEventListener('input', () => { $('#' + id + '-out').textContent = Number($('#' + id).value).toFixed(2); run(); }));
    return { show: run, onConditions: run };
  }

  // =====================================================================
  // 7. A* search
  // =====================================================================
  function AStarDemo() {
    const AS = window.AStar;
    const canvas = $('#astar-canvas');
    let start = AS.DEFAULT_START.slice(), goal = AS.DEFAULT_GOAL.slice();
    let blocks = new Set(), grid, search = null, ucsExpanded = null, raf = 0, last = 0, acc = 0, playing = false;
    let cursor = [0, 8], hover = null;

    function buildGrid() {
      const c = live();
      grid = AS.buildCostGrid(c, RM.evaluate(c).score, blocks);
    }
    function resetSearch(msg) {
      cancelAnimationFrame(raf); raf = 0; playing = false; last = 0;
      search = null; ucsExpanded = null;
      buildGrid();
      updateStats();
      $('#astar-result').textContent = msg || 'Press Run A* to watch the search, or Step to expand one node at a time.';
      draw();
    }
    function ensureSearch() {
      if (!search) {
        search = new AS.AStarSearch(grid.cost, start, goal, true);
        const ucs = new AS.AStarSearch(grid.cost, start, goal, false).run();
        ucsExpanded = ucs.expanded.length;
      }
    }
    function finishMessage() {
      if (search.status === 'found') {
        $('#astar-result').innerHTML = `<strong>Path found.</strong> Cost ${search.pathCost.toFixed(1)} over ${search.path.length - 1} moves. A* expanded ${search.expanded.length} nodes; uniform-cost search (h = 0) needs ${ucsExpanded} on the same map.`;
      } else if (search.status === 'nopath') {
        $('#astar-result').innerHTML = `<strong>No path found.</strong> Every route from start to destination is blocked. A* explored all ${search.expanded.length} reachable nodes and the frontier became empty. Remove a block or move the destination.`;
      }
    }
    function step() {
      ensureSearch();
      if (search.done) return false;
      search.step();
      if (search.done) { playing = false; finishMessage(); }
      updateStats();
      draw();
      return !search.done;
    }
    function play() {
      ensureSearch();
      if (search.done) { resetSearch(); ensureSearch(); }
      if (reduced()) { search.run(); finishMessage(); updateStats(); draw(); return; }
      playing = true;
      $('#astar-result').textContent = 'Searching… amber cells are on the frontier, blue cells have been expanded.';
      const loop = ts => {
        const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
        last = ts;
        acc += dt * Number($('#astar-speed').value);
        while (acc >= 1 && playing) { acc -= 1; if (!step()) break; }
        if (playing) raf = requestAnimationFrame(loop); else { raf = 0; last = 0; acc = 0; }
      };
      raf = requestAnimationFrame(loop);
    }

    function updateStats() {
      const s = search;
      $('#astar-stats').innerHTML = [
        ['Nodes expanded', s ? s.expanded.length : 0],
        ['Frontier size', s ? s.open.size : 1],
        ['Path cost', s && s.status === 'found' ? s.pathCost.toFixed(1) : '—'],
        ['Path length', s && s.status === 'found' ? `${s.path.length - 1}<small> moves</small>` : '—'],
      ].map(([k, v]) => `<div class="stat"><span class="stat__k">${k}</span><span class="stat__v">${v}</span></div>`).join('');
    }

    function geom() {
      const r = canvas.getBoundingClientRect();
      const cell = Math.min(r.width / AS.COLS, r.height / AS.ROWS);
      return { cell, ox: (r.width - cell * AS.COLS) / 2, oy: (r.height - cell * AS.ROWS) / 2 };
    }

    const TAG_STYLE = {
      water: ['rgba(47,127,200,.55)', 'W'], pothole: ['rgba(120,84,50,.55)', 'P'], traffic: ['rgba(208,59,59,.45)', 'T'],
      fog: ['rgba(220,226,232,.75)', 'F'], blackspot: ['rgba(20,20,20,.55)', 'B'],
    };

    function draw() {
      const { g, w, h } = fitCanvas(canvas);
      const { cell, ox, oy } = geom();
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      g.clearRect(0, 0, w, h);
      const ink = css('--ink');
      for (let c = 0; c < AS.COLS; c++) {
        for (let r = 0; r < AS.ROWS; r++) {
          const x = ox + c * cell, y = oy + r * cell, k = AS.key(c, r);
          if (!AS.isRoad(c, r)) {
            g.fillStyle = dark ? '#2a2f33' : '#ebe3d2'; g.fillRect(x, y, cell, cell);
            g.fillStyle = dark ? '#33393e' : '#dfd4bd'; g.fillRect(x + cell * 0.15, y + cell * 0.15, cell * 0.7, cell * 0.7);
            continue;
          }
          const cost = grid.cost.get(k);
          g.fillStyle = dark ? '#596169' : '#a9aeb5'; g.fillRect(x, y, cell, cell);
          const tag = grid.tags.get(k);
          if (search) {
            if (search.closed.has(k)) { g.fillStyle = 'rgba(169,200,236,.85)'; g.fillRect(x, y, cell, cell); }
            else if (search.open.has(k)) { g.fillStyle = 'rgba(244,193,91,.9)'; g.fillRect(x, y, cell, cell); }
          }
          if (cost === null) {
            g.fillStyle = tag === 'work' ? '#f08a24' : '#3a414b'; g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
            g.strokeStyle = tag === 'work' ? '#1d1d1d' : '#c9ced4'; g.lineWidth = 2;
            g.beginPath(); g.moveTo(x + cell * 0.25, y + cell * 0.25); g.lineTo(x + cell * 0.75, y + cell * 0.75);
            g.moveTo(x + cell * 0.75, y + cell * 0.25); g.lineTo(x + cell * 0.25, y + cell * 0.75); g.stroke();
          } else if (tag && TAG_STYLE[tag]) {
            g.fillStyle = TAG_STYLE[tag][0]; g.fillRect(x + 2, y + 2, cell - 4, cell - 4);
            if (cell > 22) { g.fillStyle = tag === 'fog' ? '#3a414b' : '#fff'; g.font = `700 ${Math.round(cell * 0.3)}px ${css('--font-mono')}`; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(TAG_STYLE[tag][1], x + 4, y + 3); }
          }
          if (cost !== null && cost > 1 && cell > 26) {
            g.fillStyle = '#10161c'; g.font = `600 ${Math.round(cell * 0.26)}px ${css('--font-mono')}`; g.textAlign = 'right'; g.textBaseline = 'bottom';
            g.fillText(cost.toFixed(cost % 1 ? 1 : 0), x + cell - 3, y + cell - 2);
          }
        }
      }
      // Grid lines.
      g.strokeStyle = dark ? 'rgba(0,0,0,.35)' : 'rgba(255,255,255,.6)'; g.lineWidth = 1;
      for (let c = 0; c <= AS.COLS; c++) { g.beginPath(); g.moveTo(ox + c * cell + 0.5, oy); g.lineTo(ox + c * cell + 0.5, oy + cell * AS.ROWS); g.stroke(); }
      for (let r = 0; r <= AS.ROWS; r++) { g.beginPath(); g.moveTo(ox, oy + r * cell + 0.5); g.lineTo(ox + cell * AS.COLS, oy + r * cell + 0.5); g.stroke(); }
      // Current node.
      if (search && search.current && !search.done) {
        const [c, r] = search.current;
        g.strokeStyle = '#8a4fd0'; g.lineWidth = 3; g.strokeRect(ox + c * cell + 2, oy + r * cell + 2, cell - 4, cell - 4);
      }
      // Final path.
      if (search && search.status === 'found') {
        g.strokeStyle = '#1f9e6b'; g.lineWidth = Math.max(3, cell * 0.22); g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath();
        search.path.forEach(([c, r], i) => { const x = ox + (c + 0.5) * cell, y = oy + (r + 0.5) * cell; i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.stroke();
      }
      // Start and destination.
      const pin = ([c, r], col, label) => {
        const x = ox + (c + 0.5) * cell, y = oy + (r + 0.5) * cell;
        g.fillStyle = col; g.beginPath(); g.arc(x, y, cell * 0.36, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
        g.fillStyle = '#fff'; g.font = `700 ${Math.round(cell * 0.36)}px ${css('--font-ui')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(label, x, y + 1);
      };
      pin(start, '#1f6f5c', 'S');
      pin(goal, '#d03b3b', 'D');
      // Keyboard cursor.
      if (document.activeElement === canvas) {
        g.strokeStyle = ink; g.lineWidth = 2; g.setLineDash([4, 3]);
        g.strokeRect(ox + cursor[0] * cell + 1, oy + cursor[1] * cell + 1, cell - 2, cell - 2);
        g.setLineDash([]);
      }
      describe(hover || (document.activeElement === canvas ? cursor : null));
    }

    function describe(cellPos) {
      if (!cellPos) return;
      const [c, r] = cellPos, k = AS.key(c, r);
      if (!AS.isRoad(c, r)) { $('#astar-cell').textContent = `(${c}, ${r}) building — not passable`; return; }
      const cost = grid.cost.get(k), tag = grid.tags.get(k);
      const hval = Math.abs(c - goal[0]) + Math.abs(r - goal[1]);
      let txt = `(${c}, ${r}) road · step cost ${cost === null ? 'blocked' : cost.toFixed(1)}${tag ? ' · ' + tag : ''} · h = ${hval}`;
      if (search && search.g.has(k)) txt += ` · g = ${search.g.get(k).toFixed(1)} · f = ${(search.g.get(k) + hval).toFixed(1)}`;
      $('#astar-cell').textContent = txt;
    }

    function cellAt(e) {
      const r = canvas.getBoundingClientRect();
      const { cell, ox, oy } = geom();
      const c = Math.floor((e.clientX - r.left - ox) / cell), row = Math.floor((e.clientY - r.top - oy) / cell);
      return c >= 0 && row >= 0 && c < AS.COLS && row < AS.ROWS ? [c, row] : null;
    }

    function apply(pos) {
      const [c, r] = pos, k = AS.key(c, r);
      const mode = radioValue('astar-mode');
      if (!AS.isRoad(c, r)) { $('#astar-result').textContent = 'That is a building. Choose a grey road cell.'; return; }
      const isStart = c === start[0] && r === start[1], isGoal = c === goal[0] && r === goal[1];
      if (mode === 'start') {
        if (isGoal) return;
        start = [c, r]; blocks.delete(k);
        resetSearch(`Start moved to (${c}, ${r}).`);
      } else if (mode === 'goal') {
        if (isStart) return;
        goal = [c, r]; blocks.delete(k);
        resetSearch(`Destination moved to (${c}, ${r}).`);
      } else {
        if (isStart || isGoal) { $('#astar-result').textContent = 'The start and destination cannot be blocked.'; return; }
        if (blocks.has(k)) blocks.delete(k); else blocks.add(k);
        resetSearch(blocks.has(k) ? `Road blocked at (${c}, ${r}).` : `Road reopened at (${c}, ${r}).`);
      }
    }

    canvas.addEventListener('click', e => { const p = cellAt(e); if (p) { cursor = p; apply(p); } });
    canvas.addEventListener('pointermove', e => { hover = cellAt(e); if (hover) describe(hover); });
    canvas.addEventListener('pointerleave', () => { hover = null; });
    canvas.addEventListener('focus', draw);
    canvas.addEventListener('blur', draw);
    canvas.addEventListener('keydown', e => {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (moves[e.key]) {
        e.preventDefault();
        cursor = [clamp(cursor[0] + moves[e.key][0], 0, AS.COLS - 1), clamp(cursor[1] + moves[e.key][1], 0, AS.ROWS - 1)];
        draw();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); apply(cursor);
      }
    });
    $('#astar-run').addEventListener('click', () => { if (playing) { playing = false; } else play(); });
    $('#astar-step').addEventListener('click', () => { playing = false; step(); if (search && !search.done) $('#astar-result').textContent = `Expanded (${search.current[0]}, ${search.current[1]}) with f = ${(search.g.get(AS.key(...search.current)) + search.h(search.current)).toFixed(1)}.`; });
    $('#astar-instant').addEventListener('click', () => { playing = false; ensureSearch(); search.run(); finishMessage(); updateStats(); draw(); });
    $('#astar-reset').addEventListener('click', () => resetSearch('Search reset. Start, destination and blocks are kept.'));
    $('#astar-clear').addEventListener('click', () => { blocks.clear(); resetSearch('All user blocks removed.'); });
    $('#astar-wall').addEventListener('click', () => {
      for (const [c, r] of AS.CUT_CELLS) blocks.add(AS.key(c, r));
      resetSearch('Column 7 is blocked on every road, cutting the map in two. Run A* to see how it reports that no path exists.');
    });
    $('#astar-speed').addEventListener('input', () => { $('#astar-speed-out').textContent = $('#astar-speed').value + ' nodes/s'; });
    resetSearch();
    return {
      show: draw, redraw: draw,
      onConditions: () => resetSearch('Conditions changed in the simulation, so the hazard costs were rebuilt and the search was reset.'),
      test: () => ({ start, goal, blocks: [...blocks], search }),
    };
  }

  // =====================================================================
  // Boot
  // =====================================================================
  function init() {
    initTabs();
    demos['panel-agent'] = AgentDemo();
    demos['panel-prob'] = ProbabilityDemo();
    demos['panel-kr'] = KnowledgeDemo();
    demos['panel-learn'] = LearningDemo();
    demos['panel-pf'] = ProblemDemo();
    demos['panel-util'] = UtilityDemo();
    demos['panel-astar'] = AStarDemo();
    // Pre-compute the live-data demos so they are ready when their tab opens.
    ['panel-prob', 'panel-pf', 'panel-util'].forEach(id => demos[id].show());

    document.addEventListener('conditionschange', () => {
      for (const d of Object.values(demos)) if (d.onConditions) d.onConditions();
    });
    document.addEventListener('themechange', () => {
      const id = visiblePanel();
      if (id && demos[id].redraw) demos[id].redraw();
    });
    let t = 0;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => { const id = visiblePanel(); if (id && demos[id].redraw) demos[id].redraw(); }, 120);
    });
    window.Lab = demos;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
