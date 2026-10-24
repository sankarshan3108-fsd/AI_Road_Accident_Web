/* ==========================================================================
   Road Risk Simulator — application controller
   --------------------------------------------------------------------------
   Responsibilities
     • UI state (inputs, run status, playback speed)
     • one animation loop (requestAnimationFrame, delta-time based)
     • wiring the controls to the traffic simulation, the scene and the
       risk dashboard
     • risk history, event log (both bounded), theme, navigation, tooltips

   The loop only runs while it has something to animate: the simulation is
   running, a weather/lighting transition is in progress, or a redraw was
   requested. It stops when the tab is hidden or the road is scrolled out of
   view, and resumes without a time jump (delta time is clamped).
   ========================================================================== */
(function () {
  'use strict';

  const RM = window.RiskModel;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  const HISTORY_MAX = 40;        // points kept in the risk-history chart
  const LOG_MAX = 60;            // entries kept in the event log
  const OVERLAY_INTERVAL = 0.25; // seconds between overlay text refreshes
  const PLAYBACK_SPEEDS = [0.5, 1, 2, 4];

  const LEVEL_ICON = { LOW: '#i-check', MEDIUM: '#i-alert', HIGH: '#i-octagon' };
  const LEVEL_VAR = { LOW: '--low', MEDIUM: '--med', HIGH: '--high' };

  // ---- State ---------------------------------------------------------------
  const state = {
    inputs: RM.sanitize(RM.DEFAULTS),
    status: 'ready',              // ready | running | paused
    playback: 1,
    simClock: 0,                  // simulated seconds since start/reset
    history: [],
    log: [],
    displayScore: 0,              // animated gauge value (always converges to the real score)
    committed: null,              // evaluation at the last committed change
    committedRecs: [],
  };

  // ---- DOM -------------------------------------------------------------------
  const el = {
    stage: $('#stage'), canvas: $('#road-canvas'), startOverlay: $('#stage-start'),
    runBtn: $('#run-btn'), runLabel: $('#run-label'), runIcon: $('#run-icon'), resetBtn: $('#reset-btn'),
    statusPill: $('#status-pill'), statusText: $('#status-text'), toast: $('#toast'),
    ovConditions: $('#ov-conditions'), ovLighting: $('#ov-lighting'), ovSignal: $('#ov-signal'), ovSignalText: $('#ov-signal-text'),
    ovClock: $('#ov-clock'), ovTraffic: $('#ov-traffic'), densityBars: $$('#density-bars i'), sceneDesc: $('#scene-description'),
    score: $('#risk-score'), level: $('#risk-level'), levelText: $('#risk-level-text'), levelIcon: $('#risk-level-icon'),
    explain: $('#risk-explain'), announcer: $('#risk-announcer'), factors: $('#factors'), recs: $('#recs'),
    compare: $('#compare'), log: $('#event-log'), historyCount: $('#history-count'),
    gaugeFill: $('#gauge-fill'), gaugeNeedle: $('#gauge-needle'),
    visibility: $('#visibility'), density: $('#density'), speed: $('#speed'),
    visibilityOut: $('#visibility-out'), densityOut: $('#density-out'), speedOut: $('#speed-out'),
    fullscreenBtn: $('#fullscreen-btn'), themeToggle: $('#theme-toggle'), navToggle: $('#nav-toggle'), nav: $('#site-nav'),
    tooltip: $('#tooltip'), ovRisk: $('#ov-risk'),
  };

  // ---- Simulation + scene ------------------------------------------------------
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sim = new window.Traffic.Simulation();
  sim.setConditions(simConditions(state.inputs));
  sim.reset();
  const scene = new window.RoadScene(el.canvas, sim, { reducedMotion: reducedMotionQuery.matches });
  scene.setConditions(state.inputs);
  scene.env = JSON.parse(JSON.stringify(scene.envTarget));   // no transition on first paint

  function simConditions(i) {
    return { density: i.density, speed: i.speed, weather: i.weather, surface: i.surface };
  }

  // ---- Animation loop (a single guarded requestAnimationFrame chain) ----------
  const loop = { raf: 0, last: 0, dirty: true, pageVisible: !document.hidden, onScreen: true, overlayT: 0 };

  function wantsFrames() {
    return loop.pageVisible && loop.onScreen && (state.status === 'running' || loop.dirty || scene.isTransitioning());
  }
  function requestFrame() {
    if (!loop.raf && loop.pageVisible && loop.onScreen) loop.raf = requestAnimationFrame(frame);
  }
  function invalidate() { loop.dirty = true; requestFrame(); }

  function frame(ts) {
    loop.raf = 0;
    // Delta time in seconds, clamped so a long pause never produces a jump.
    const dt = loop.last ? Math.min(0.1, Math.max(0, (ts - loop.last) / 1000)) : 1 / 60;
    loop.last = ts;
    const simDt = state.status === 'running' ? dt * state.playback : 0;
    if (simDt > 0) {
      sim.step(simDt);
      state.simClock += simDt;
    }
    scene.running = state.status === 'running';
    scene.update(dt, simDt);
    scene.render();
    loop.dirty = false;
    loop.overlayT -= dt;
    if (loop.overlayT <= 0) { updateOverlay(); loop.overlayT = OVERLAY_INTERVAL; }
    if (wantsFrames()) requestFrame();
    else loop.last = 0;
  }

  document.addEventListener('visibilitychange', () => {
    loop.pageVisible = !document.hidden;
    loop.last = 0;
    if (loop.pageVisible) invalidate();
    else if (loop.raf) { cancelAnimationFrame(loop.raf); loop.raf = 0; }
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      loop.onScreen = entries[0].isIntersecting;
      loop.last = 0;
      if (loop.onScreen) invalidate();
    }, { threshold: 0.02 }).observe(el.stage);
  }

  let resizeQueued = false;
  const onResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; scene.resize(); invalidate(); historyChart.draw(); });
  };
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(el.stage);
  else window.addEventListener('resize', onResize);

  // ---- Run controls ------------------------------------------------------------
  function setStatus(status) {
    state.status = status;
    const labels = { ready: 'Start simulation', running: 'Pause', paused: 'Resume' };
    el.runLabel.textContent = labels[status];
    el.runIcon.setAttribute('href', status === 'running' ? '#i-pause' : '#i-play');
    el.runBtn.setAttribute('aria-pressed', status === 'running' ? 'true' : 'false');
    el.statusPill.dataset.state = status;
    el.statusText.textContent = status === 'running' ? `Running · ${state.playback}×` : status === 'paused' ? 'Paused' : 'Ready';
    el.startOverlay.classList.toggle('is-hidden', status !== 'ready');
    loop.last = 0;
    invalidate();
  }

  function toggleRun() {
    if (state.status === 'running') {
      setStatus('paused');
      toast('Simulation paused');
      addLog('Simulation paused', 'control');
    } else {
      const wasReady = state.status === 'ready';
      setStatus('running');
      toast(wasReady ? 'Simulation started' : 'Simulation resumed');
      addLog(wasReady ? 'Simulation started' : 'Simulation resumed', 'control');
      if (wasReady) recordHistory('Simulation started');
    }
  }

  function resetAll() {
    state.inputs = RM.sanitize(RM.DEFAULTS);
    state.playback = 1;
    state.simClock = 0;
    $$('input[name="playback"]').forEach(r => { r.checked = Number(r.value) === 1; });
    syncControls();
    sim.setConditions(simConditions(state.inputs));
    sim.reset();
    scene.setConditions(state.inputs);
    setStatus('ready');
    updateDashboard();
    commit('Simulation reset to default conditions', 'control');
    toast('Reset to default conditions');
  }

  el.runBtn.addEventListener('click', toggleRun);
  $('#stage-start-btn').addEventListener('click', toggleRun);
  el.resetBtn.addEventListener('click', resetAll);

  $$('input[name="playback"]').forEach(r => r.addEventListener('change', () => {
    const v = Number(r.value);
    state.playback = PLAYBACK_SPEEDS.includes(v) ? v : 1;
    setStatus(state.status);
    addLog(`Playback speed set to ${state.playback}×`, 'control');
  }));

  // Space toggles the simulation when focus is not on a form control.
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat) return;
    const t = e.target;
    if (t.closest && t.closest('input, button, select, textarea, [contenteditable], canvas, [role="tab"]')) return;
    e.preventDefault();
    toggleRun();
  });

  // ---- Condition controls ----------------------------------------------------------
  function setRangeFill(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--pct', pct + '%');
  }

  function syncControls() {
    const i = state.inputs;
    for (const name of ['weather', 'lighting', 'surface']) {
      $$(`input[name="${name}"]`).forEach(r => { r.checked = r.value === i[name]; });
    }
    el.visibility.value = i.visibility;
    el.density.value = i.density;
    el.speed.value = i.speed;
    [el.visibility, el.density, el.speed].forEach(setRangeFill);
    el.visibilityOut.textContent = RM.formatDistance(i.visibility);
    el.densityOut.textContent = i.density + '%';
    el.speedOut.textContent = i.speed + ' km/h';
  }

  /** Applies the current inputs everywhere (scene, traffic, dashboard) without logging. */
  function applyInputs() {
    state.inputs = RM.sanitize(state.inputs);
    sim.setConditions(simConditions(state.inputs));
    scene.setConditions(state.inputs);
    updateDashboard();
    updateOverlay();
    invalidate();
    document.dispatchEvent(new CustomEvent('conditionschange', { detail: Object.assign({}, state.inputs) }));
  }

  for (const name of ['weather', 'lighting', 'surface']) {
    $$(`input[name="${name}"]`).forEach(r => r.addEventListener('change', () => {
      if (!r.checked) return;
      state.inputs[name] = r.value;
      let text;
      if (name === 'weather') {
        // Each weather sets a typical visibility; the slider can fine-tune it afterwards.
        state.inputs.visibility = RM.WEATHER[r.value].presetVisibility;
        text = `Weather changed to ${RM.WEATHER[r.value].label} (visibility set to ${RM.formatDistance(state.inputs.visibility)})`;
      } else if (name === 'lighting') {
        text = `Lighting changed to ${RM.LIGHTING[r.value].label}`;
      } else {
        text = `Road surface changed to ${RM.SURFACE[r.value].label}`;
      }
      syncControls();
      applyInputs();
      commit(text, 'condition');
    }));
  }

  const sliderMeta = {
    visibility: { label: 'Visibility', fmt: v => RM.formatDistance(v) },
    density: { label: 'Traffic density', fmt: v => v + '%' },
    speed: { label: 'Vehicle speed', fmt: v => v + ' km/h' },
  };
  for (const key of Object.keys(sliderMeta)) {
    const input = el[key];
    let startValue = state.inputs[key];
    input.addEventListener('pointerdown', () => { startValue = state.inputs[key]; });
    input.addEventListener('focus', () => { startValue = state.inputs[key]; });
    input.addEventListener('input', () => {
      state.inputs[key] = Number(input.value);
      syncControls();
      applyInputs();             // live preview while dragging
    });
    input.addEventListener('change', () => {
      const v = state.inputs[key];
      if (v === startValue) return;
      const dir = v > startValue ? 'increased' : 'decreased';
      commit(`${sliderMeta[key].label} ${dir} to ${sliderMeta[key].fmt(v)}`, 'condition');
      startValue = v;
    });
  }

  // ---- Risk dashboard ------------------------------------------------------------------
  const GAUGE = { cx: 110, cy: 118, r: 92, rBand: 106 };
  function arcPath(r, from, to) {
    const a0 = Math.PI * (1 - from / 100), a1 = Math.PI * (1 - to / 100);
    const x0 = GAUGE.cx + r * Math.cos(a0), y0 = GAUGE.cy - r * Math.sin(a0);
    const x1 = GAUGE.cx + r * Math.cos(a1), y1 = GAUGE.cy - r * Math.sin(a1);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  $('#gauge-track').setAttribute('d', arcPath(GAUGE.r, 0, 100));
  $('#band-low').setAttribute('d', arcPath(GAUGE.rBand, 0, RM.THRESHOLDS.medium - 0.6));
  $('#band-med').setAttribute('d', arcPath(GAUGE.rBand, RM.THRESHOLDS.medium + 0.6, RM.THRESHOLDS.high - 0.6));
  $('#band-high').setAttribute('d', arcPath(GAUGE.rBand, RM.THRESHOLDS.high + 0.6, 100));

  function drawGauge(score) {
    const s = Math.max(0, Math.min(100, score));
    el.gaugeFill.setAttribute('d', s > 0.2 ? arcPath(GAUGE.r, 0, s) : '');
    el.gaugeFill.style.stroke = `var(${LEVEL_VAR[RM.classify(s)]})`;
    el.gaugeNeedle.setAttribute('transform', `rotate(${(-90 + s * 1.8).toFixed(2)} ${GAUGE.cx} ${GAUGE.cy})`);
    el.score.textContent = s.toFixed(1);
  }

  let gaugeAnim = 0;
  function animateGaugeTo(target) {
    cancelAnimationFrame(gaugeAnim);
    const from = state.displayScore;
    if (reducedMotionQuery.matches || Math.abs(target - from) < 0.05) {
      state.displayScore = target; drawGauge(target); return;
    }
    const t0 = performance.now(), dur = 550;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      state.displayScore = from + (target - from) * e;
      drawGauge(k < 1 ? state.displayScore : target);   // the final frame shows the exact calculated value
      if (k < 1) gaugeAnim = requestAnimationFrame(step); else state.displayScore = target;
    };
    gaugeAnim = requestAnimationFrame(step);
  }

  let lastEval = null;
  let renderedLevel = null;
  function updateDashboard() {
    const ev = RM.evaluate(state.inputs);
    animateGaugeTo(ev.score);
    if (renderedLevel !== ev.level) {
      el.level.dataset.level = ev.level;
      el.levelText.textContent = ev.level;
      el.levelIcon.setAttribute('href', LEVEL_ICON[ev.level]);
      if (renderedLevel) {
        el.level.classList.remove('is-bumped'); void el.level.offsetWidth; el.level.classList.add('is-bumped');
        el.announcer.textContent = `Risk level changed to ${ev.level}`;
      }
      renderedLevel = ev.level;
    }
    el.explain.textContent = RM.explainChange(lastEval, ev);
    el.ovRisk.textContent = `Risk ${ev.score.toFixed(1)} · ${ev.level}`;
    el.ovRisk.dataset.level = ev.level;
    lastEval = ev;
    renderFactors(ev);
    renderRecommendations();
    renderComparison();
    return ev;
  }

  function renderFactors(ev) {
    const ranked = ev.factors.filter(f => f.points >= 1).sort((a, b) => b.points - a.points).slice(0, 2).map(f => f.key);
    if (!el.factors.children.length) {
      el.factors.innerHTML = ev.factors.map(f => `
        <li class="factor" data-key="${f.key}">
          <span class="factor__name">${f.label}<small></small></span>
          <span class="factor__pts"></span>
          <span class="factor__bar" aria-hidden="true"><i></i></span>
        </li>`).join('');
    }
    for (const f of ev.factors) {
      const li = el.factors.querySelector(`[data-key="${f.key}"]`);
      li.querySelector('small').textContent = '· ' + f.detail;
      li.querySelector('.factor__pts').textContent = `${f.points.toFixed(1)} / ${f.max}`;
      li.querySelector('.factor__bar i').style.width = (f.points / f.max) * 100 + '%';
      li.classList.toggle('is-major', ranked.includes(f.key));
      li.setAttribute('aria-label', `${f.label}: ${f.points.toFixed(1)} of ${f.max} points${ranked.includes(f.key) ? ', major factor' : ''}`);
    }
  }

  let renderedRecKey = '';
  function renderRecommendations() {
    const { items } = RM.recommendations(state.inputs);
    const key = items.map(r => r.text).join('|');
    if (key === renderedRecKey) return;
    renderedRecKey = key;
    const icon = p => (p >= 3 ? '#i-octagon' : p === 2 ? '#i-alert' : '#i-check');
    el.recs.innerHTML = items.slice(0, 6).map(r => `
      <li class="rec" data-p="${r.priority}">
        <span class="rec__icon"><svg class="icon" aria-hidden="true"><use href="${icon(r.priority)}"/></svg></span>
        <span><strong>${r.cause}</strong>${r.text}</span>
      </li>`).join('');
  }

  function renderComparison() {
    const rows = RM.comparison(state.inputs);
    el.compare.innerHTML = rows.map(r => {
      const level = RM.classify(r.score);
      return `<li class="${r.current ? 'is-current' : ''}">
        <span class="compare__label">${r.label}</span>
        <span class="compare__score">${r.score.toFixed(1)} <span class="mini-level" data-level="${level}">${level}</span></span>
        <span class="compare__bar" aria-hidden="true"><i style="width:${r.score}%;background:var(${LEVEL_VAR[level]})"></i></span>
      </li>`;
    }).join('');
  }

  // ---- History, log, commit -------------------------------------------------------------
  const historyChart = new window.Charts.LineChart($('#history-chart'), {
    yMin: 0, yMax: 100, yTicks: [0, 35, 65, 100],
    bands: [{ from: 0, to: 35, cssVar: '--low' }, { from: 35, to: 65, cssVar: '--med' }, { from: 65, to: 100, cssVar: '--high' }],
    tooltip: $('#history-tip'), emptyText: 'Change a condition to record the first point',
    format: p => `<b>${p.y.toFixed(1)}</b> · ${p.level}<br>${escapeHtml(p.label)}<br><span style="opacity:.75">t ${fmtClock(p.t)}</span>`,
    labelFormat: p => `${p.y.toFixed(1)} ${p.level}`,
  });

  function recordHistory(label) {
    const ev = RM.evaluate(state.inputs);
    state.history.push({ y: ev.score, level: ev.level, label, t: state.simClock, color: LEVEL_VAR[ev.level] });
    if (state.history.length > HISTORY_MAX) state.history.shift();
    historyChart.setData(state.history.slice());
    el.historyCount.textContent = `${state.history.length} recorded change${state.history.length === 1 ? '' : 's'}`;
  }

  /** A deliberate change: record history, log it, log level/recommendation changes. */
  function commit(text, kind) {
    const ev = RM.evaluate(state.inputs);
    addLog(text, kind);
    if (state.committed && state.committed.level !== ev.level) {
      addLog(`Risk classification changed: <b>${state.committed.level} → ${ev.level}</b> (${ev.score.toFixed(1)})`, 'risk', true);
    }
    const causes = [...new Set(RM.recommendations(state.inputs).items.map(r => r.cause))];
    const added = causes.filter(c => !state.committedRecs.includes(c));
    if (state.committed && added.length) addLog(`Safety recommendation updated: ${added.join(', ')}`, 'rec');
    state.committed = ev;
    state.committedRecs = causes;
    recordHistory(text);
    updateSceneDescription();
  }

  function addLog(text, kind, isHtml) {
    state.log.unshift({ t: state.simClock, text, kind, isHtml: !!isHtml });
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
    el.log.innerHTML = state.log.map(e => `<li data-kind="${e.kind}"><time>${fmtClock(e.t)}</time><span>${e.isHtml ? e.text : escapeHtml(e.text)}</span></li>`).join('');
  }

  function fmtClock(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- Stage overlay -------------------------------------------------------------------
  function updateOverlay() {
    const i = state.inputs;
    el.ovConditions.textContent = `${RM.WEATHER[i.weather].label} · ${RM.formatDistance(i.visibility)} visibility`;
    el.ovLighting.textContent = RM.LIGHTING[i.lighting].label + (i.surface !== 'dry' ? ` · ${RM.SURFACE[i.surface].label}` : '');
    const sig = sim.signal;
    el.ovSignal.dataset.state = sig.main;
    el.ovSignalText.textContent = `Main road ${sig.main === 'yellow' ? 'AMBER' : sig.main.toUpperCase()} · ${Math.ceil(sig.mainRemain)} s`;
    el.ovClock.textContent = 't ' + fmtClock(state.simClock);
    const visible = sim.visibleCount();
    el.ovTraffic.textContent = `${visible} vehicles · ${Math.round(sim.averageSpeedKmh())} km/h avg`;
    const on = Math.max(visible > 0 ? 1 : 0, Math.min(10, Math.round(visible / 10)));
    el.densityBars.forEach((b, k) => b.classList.toggle('on', k < on));
  }
  el.densityBars.forEach((b, k) => b.style.setProperty('--h', String(k * 1.2)));

  function updateSceneDescription() {
    const i = state.inputs;
    el.sceneDesc.textContent = `${RM.WEATHER[i.weather].label} weather, ${RM.LIGHTING[i.lighting].label.toLowerCase()}, ${RM.SURFACE[i.surface].label.toLowerCase()} road, visibility ${RM.formatDistance(i.visibility)}. ${sim.visibleCount()} vehicles visible.`;
  }

  let toastTimer = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 1600);
  }

  // ---- Full screen -----------------------------------------------------------------------
  if (!document.fullscreenEnabled || !el.stage.requestFullscreen) {
    el.fullscreenBtn.hidden = true;
  } else {
    el.fullscreenBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.stage.requestFullscreen().catch(() => toast('Full screen is not available here'));
    });
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement === el.stage;
      el.fullscreenBtn.setAttribute('aria-label', fs ? 'Exit full screen' : 'Show road in full screen');
      onResize();
    });
  }

  // ---- Theme -------------------------------------------------------------------------------
  function storedTheme() { try { return localStorage.getItem('rrs-theme'); } catch (e) { return null; } }
  function applyTheme(theme, save) {
    document.documentElement.setAttribute('data-theme', theme);
    el.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    if (save) { try { localStorage.setItem('rrs-theme', theme); } catch (e) { /* storage unavailable: theme still applies */ } }
    historyChart.draw();
    document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }
  el.themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
  });
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  darkQuery.addEventListener && darkQuery.addEventListener('change', e => { if (!storedTheme()) applyTheme(e.matches ? 'dark' : 'light', false); });
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light', false);

  reducedMotionQuery.addEventListener && reducedMotionQuery.addEventListener('change', e => { scene.reducedMotion = e.matches; invalidate(); });

  // ---- Navigation --------------------------------------------------------------------------
  el.navToggle.addEventListener('click', () => {
    const open = !el.nav.classList.contains('is-open');
    el.nav.classList.toggle('is-open', open);
    el.navToggle.setAttribute('aria-expanded', String(open));
    el.navToggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
  });
  $$('a', el.nav).forEach(a => a.addEventListener('click', () => {
    el.nav.classList.remove('is-open');
    el.navToggle.setAttribute('aria-expanded', 'false');
  }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.nav.classList.contains('is-open')) { el.nav.classList.remove('is-open'); el.navToggle.setAttribute('aria-expanded', 'false'); el.navToggle.focus(); }
  });
  if ('IntersectionObserver' in window) {
    const links = $$('a[data-nav]', el.nav);
    const io = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        links.forEach(a => {
          const on = a.dataset.nav === en.target.id;
          a.classList.toggle('is-active', on);
          if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
        });
      }
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['simulation', 'analytics', 'lab', 'model'].forEach(id => io.observe(document.getElementById(id)));
  }

  // ---- Tooltips (hover, keyboard focus and tap) ----------------------------------------------
  let tipOwner = null;
  function showTip(btn) {
    tipOwner = btn;
    el.tooltip.textContent = btn.dataset.tip;
    el.tooltip.hidden = false;
    const r = btn.getBoundingClientRect();
    const tw = el.tooltip.offsetWidth, th = el.tooltip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    let y = r.top - th - 8;
    if (y < 8) y = r.bottom + 8;
    el.tooltip.style.left = x + 'px';
    el.tooltip.style.top = y + 'px';
    btn.setAttribute('aria-describedby', 'tooltip');
  }
  function hideTip() {
    if (tipOwner) tipOwner.removeAttribute('aria-describedby');
    tipOwner = null;
    el.tooltip.hidden = true;
  }
  $$('.tip').forEach(btn => {
    btn.addEventListener('mouseenter', () => showTip(btn));
    btn.addEventListener('mouseleave', hideTip);
    btn.addEventListener('focus', () => showTip(btn));
    btn.addEventListener('blur', hideTip);
    btn.addEventListener('click', e => { e.preventDefault(); tipOwner === btn ? hideTip() : showTip(btn); });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', hideTip, { passive: true });

  // Keep every range input's filled track in sync (lab sliders too).
  $$('input[type="range"]').forEach(r => { setRangeFill(r); r.addEventListener('input', () => setRangeFill(r)); });

  // ---- Start-up --------------------------------------------------------------------------------
  syncControls();
  updateDashboard();
  updateOverlay();
  state.committed = RM.evaluate(state.inputs);
  state.committedRecs = [...new Set(RM.recommendations(state.inputs).items.map(r => r.cause))];
  addLog('Page loaded with the default conditions', 'control');
  recordHistory('Initial conditions');
  updateSceneDescription();
  invalidate();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { scene.buildTextures(); invalidate(); historyChart.draw(); });
  }

  // Small public surface used by the AI lab (and handy for testing in the console).
  window.App = {
    getInputs: () => Object.assign({}, state.inputs),
    state, sim, scene,
    toggleRun, resetAll,
    focusSimulation: () => document.getElementById('simulation').scrollIntoView({ behavior: reducedMotionQuery.matches ? 'auto' : 'smooth' }),
  };
})();
