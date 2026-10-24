/* ==========================================================================
   Educational accident-risk model
   --------------------------------------------------------------------------
   A transparent, deterministic points model. Every input condition earns
   "risk points"; the points are summed into a score between 0 and 100.

   This is NOT a validated real-world prediction system and it is NOT the
   scikit-learn Random Forest from the Python project. It is a hand-written
   teaching model whose structure mirrors the expert formula that the Python
   project uses to label its synthetic training data.

   Component (maximum points)        Formula
   ------------------------------------------------------------------------
   Vehicle speed      (32)  32 * s^1.3,  s = (speed - 20) / 100
   Speed x hazards    (16)  16 * s * h,  h = (weather + surface + visibility
                                               + lighting points) / 44
   Visibility         (14)  14 * ((2000 - vis) / 1950)^2
   Weather            (10)  table: sunny 0, cloudy 3, foggy 8, rainy 10
   Road surface       (10)  table: dry 0, wet 8, construction 9, potholes 10
   Lighting           (10)  table: day 0, dusk 4, night lit 6, night unlit 10
   Traffic density     (8)   8 * density / 100
   ------------------------------------------------------------------------
   Total maximum = 100.   LOW < 35 <= MEDIUM < 65 <= HIGH
   ========================================================================== */
(function (root) {
  'use strict';

  const WEATHER = {
    sunny:  { label: 'Sunny',  points: 0,  presetVisibility: 2000 },
    cloudy: { label: 'Cloudy', points: 3,  presetVisibility: 1500 },
    rainy:  { label: 'Rainy',  points: 10, presetVisibility: 600 },
    foggy:  { label: 'Foggy',  points: 8,  presetVisibility: 150 },
  };

  const SURFACE = {
    dry:          { label: 'Dry',                points: 0,  friction: 0.70 },
    wet:          { label: 'Wet',                points: 8,  friction: 0.40 },
    potholes:     { label: 'Potholes',           points: 10, friction: 0.50 },
    construction: { label: 'Under construction', points: 9,  friction: 0.55 },
  };

  const LIGHTING = {
    day:       { label: 'Daylight',           points: 0 },
    dusk:      { label: 'Dusk',               points: 4 },
    nightLit:  { label: 'Night (street-lit)', points: 6 },
    nightDark: { label: 'Night (unlit)',      points: 10 },
  };

  const MAX_POINTS = {
    weather: 10, surface: 10, lighting: 10, speed: 32,
    visibility: 14, density: 8, interaction: 16,
  };
  const HAZARD_MAX = MAX_POINTS.weather + MAX_POINTS.surface + MAX_POINTS.visibility + MAX_POINTS.lighting; // 44

  const RANGES = {
    speed:      { min: 20, max: 120,  step: 5 },   // km/h
    visibility: { min: 50, max: 2000, step: 50 },  // metres
    density:    { min: 0,  max: 100,  step: 5 },   // percent
  };

  const THRESHOLDS = { medium: 35, high: 65 };

  /** Documented default state used on first load and by Reset. */
  const DEFAULTS = Object.freeze({
    weather: 'sunny', lighting: 'day', surface: 'dry',
    visibility: 2000, density: 40, speed: 50,
  });

  const REACTION_TIME_S = 1.5;   // driver perception-reaction time used in stopping distance
  const GRAVITY = 9.81;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function snapToStep(value, range) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return clamp(Math.round((n - range.min) / range.step) * range.step + range.min, range.min, range.max);
  }

  /** Returns a clean copy of the inputs. Unknown or invalid values fall back to defaults. */
  function sanitize(input) {
    const src = input || {};
    const out = {};
    out.weather = WEATHER[src.weather] ? src.weather : DEFAULTS.weather;
    out.surface = SURFACE[src.surface] ? src.surface : DEFAULTS.surface;
    out.lighting = LIGHTING[src.lighting] ? src.lighting : DEFAULTS.lighting;
    for (const key of ['speed', 'visibility', 'density']) {
      const v = snapToStep(src[key], RANGES[key]);
      out[key] = v === null ? DEFAULTS[key] : v;
    }
    return out;
  }

  /** Normalised speed 0 (20 km/h) .. 1 (120 km/h). */
  function speedFraction(speed) {
    return clamp((speed - RANGES.speed.min) / (RANGES.speed.max - RANGES.speed.min), 0, 1);
  }

  /** Core calculation. Same inputs always produce the same output. */
  function evaluate(rawInput) {
    const c = sanitize(rawInput);
    const s = speedFraction(c.speed);
    const visLoss = clamp((RANGES.visibility.max - c.visibility) / (RANGES.visibility.max - RANGES.visibility.min), 0, 1);

    const weather = WEATHER[c.weather].points;
    const surface = SURFACE[c.surface].points;
    const lighting = LIGHTING[c.lighting].points;
    const speed = MAX_POINTS.speed * Math.pow(s, 1.3);
    const visibility = MAX_POINTS.visibility * visLoss * visLoss;
    const density = MAX_POINTS.density * c.density / 100;
    const hazard = (weather + surface + visibility + lighting) / HAZARD_MAX;
    const interaction = MAX_POINTS.interaction * s * hazard;

    const factors = [
      { key: 'speed', label: 'Vehicle speed', points: speed, max: MAX_POINTS.speed, detail: c.speed + ' km/h' },
      { key: 'visibility', label: 'Visibility', points: visibility, max: MAX_POINTS.visibility, detail: formatDistance(c.visibility) },
      { key: 'weather', label: 'Weather', points: weather, max: MAX_POINTS.weather, detail: WEATHER[c.weather].label },
      { key: 'surface', label: 'Road surface', points: surface, max: MAX_POINTS.surface, detail: SURFACE[c.surface].label },
      { key: 'lighting', label: 'Lighting', points: lighting, max: MAX_POINTS.lighting, detail: LIGHTING[c.lighting].label },
      { key: 'density', label: 'Traffic density', points: density, max: MAX_POINTS.density, detail: c.density + '%' },
      { key: 'interaction', label: 'Speed × hazards', points: interaction, max: MAX_POINTS.interaction, detail: 'speed amplifies hazards' },
    ];

    const raw = factors.reduce((sum, f) => sum + f.points, 0);
    const score = Math.round(clamp(raw, 0, 100) * 10) / 10;
    return { inputs: c, score, level: classify(score), factors, hazard };
  }

  function classify(score) {
    if (score >= THRESHOLDS.high) return 'HIGH';
    if (score >= THRESHOLDS.medium) return 'MEDIUM';
    return 'LOW';
  }

  function formatDistance(m) {
    return m >= 2000 ? '2 km+' : m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
  }

  /** Physics-based stopping distance (reaction distance + braking distance), metres. */
  function stoppingDistance(speedKmh, surfaceKey, weatherKey) {
    const v = speedKmh / 3.6;
    let mu = SURFACE[surfaceKey] ? SURFACE[surfaceKey].friction : SURFACE.dry.friction;
    if (weatherKey === 'rainy') mu = Math.min(mu, SURFACE.wet.friction);
    return v * REACTION_TIME_S + (v * v) / (2 * mu * GRAVITY);
  }

  /** Highest speed (multiple of 5 km/h) that keeps the score LOW and stops within the visible distance. */
  function saferSpeed(rawInput) {
    const c = sanitize(rawInput);
    for (let v = c.speed; v >= RANGES.speed.min; v -= RANGES.speed.step) {
      const r = evaluate(Object.assign({}, c, { speed: v }));
      if (r.score < THRESHOLDS.medium && stoppingDistance(v, c.surface, c.weather) <= c.visibility) return v;
    }
    return RANGES.speed.min;
  }

  /** Highest speed (multiple of 5) whose stopping distance fits inside the visibility. */
  function speedForVisibility(c) {
    for (let v = RANGES.speed.max; v >= RANGES.speed.min; v -= RANGES.speed.step) {
      if (stoppingDistance(v, c.surface, c.weather) <= c.visibility) return v;
    }
    return RANGES.speed.min;
  }

  /**
   * Rule-based safety recommendations. Each one names the condition that triggered it,
   * so the advice can always be traced back to an input.
   */
  function recommendations(rawInput) {
    const c = sanitize(rawInput);
    const result = evaluate(c);
    const list = [];
    const add = (priority, cause, text) => list.push({ priority, cause, text });

    const stop = stoppingDistance(c.speed, c.surface, c.weather);
    if (stop > c.visibility) {
      add(3, 'Speed vs visibility', `At ${c.speed} km/h the estimated stopping distance (~${Math.round(stop)} m) exceeds the visible distance (${formatDistance(c.visibility)}). Slow to ${speedForVisibility(c)} km/h or less.`);
    }
    if (c.visibility < 300) {
      add(3, 'Low visibility', 'Switch on low-beam headlights or fog lamps (not high beam), keep a 4-second following gap and avoid overtaking.');
    } else if (c.visibility < 1000) {
      add(2, 'Reduced visibility', 'Increase your following gap to at least 3 seconds and use dipped headlights so others can see you.');
    }
    if (c.weather === 'rainy' || c.surface === 'wet') {
      add(2, c.weather === 'rainy' ? 'Rain' : 'Wet road', 'Reduce speed by about 20%, avoid sudden braking or sharp steering, and watch for waterlogged patches.');
    }
    if (c.weather === 'rainy') add(1, 'Rain', 'Use wipers and the demister; keep the windscreen clear.');
    if (c.surface === 'potholes') add(2, 'Potholes', 'Slow down early, hold the steering firmly and do not swerve suddenly to avoid a pothole.');
    if (c.surface === 'construction') add(2, 'Work zone', 'Follow diversion signs, merge early before the cones and expect workers near the lane.');
    if (c.density > 65) {
      add(2, 'Dense traffic', 'Keep safe spacing, avoid lane cutting and check mirrors for two-wheelers in blind spots.');
    } else if (c.density > 40 && c.speed > 60) {
      add(1, 'Moderate traffic', 'Brake early and keep at least a 2-second gap to the vehicle ahead.');
    }
    if (c.lighting === 'nightDark') {
      add(3, 'Unlit road at night', 'Use headlights; switch to high beam only when there is no oncoming traffic. Watch for unlit cyclists and pedestrians.');
    } else if (c.lighting === 'nightLit') {
      add(1, 'Night', 'Keep headlights on and dip them for oncoming traffic; pedestrians are harder to see between street lamps.');
    } else if (c.lighting === 'dusk') {
      add(1, 'Dusk', 'Switch on headlights early; low sun and fading light reduce contrast.');
    }
    if (c.speed > 80) add(2, 'High speed', `${c.speed} km/h is above typical urban limits. Obey the posted speed limit.`);

    if (list.length === 0) {
      add(0, 'Favourable conditions', 'Conditions are favourable. Maintain lane discipline and a normal 2-second following gap.');
    }
    list.sort((a, b) => b.priority - a.priority);
    return { result, items: list };
  }

  /** Explains the change between two evaluations using the factor points. */
  function explainChange(prev, next) {
    if (!prev) return 'Initial assessment of the current conditions.';
    const delta = next.score - prev.score;
    if (Math.abs(delta) < 0.05) return 'The risk score did not change.';
    const changes = next.factors
      .map((f, i) => ({ label: f.label, d: f.points - prev.factors[i].points }))
      .filter(x => Math.abs(x.d) >= 0.05)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
      .slice(0, 2)
      .map(x => `${x.label} ${x.d > 0 ? '+' : '−'}${Math.abs(x.d).toFixed(1)}`);
    const dir = delta > 0 ? 'rose' : 'fell';
    return `Risk ${dir} by ${Math.abs(delta).toFixed(1)} points (${changes.join(', ')}).`;
  }

  /** Safer / current / riskier configurations for the comparison chart. */
  function comparison(rawInput) {
    const c = sanitize(rawInput);
    const safeV = saferSpeed(c);
    const riskyV = Math.min(RANGES.speed.max, c.speed + 20);
    return [
      { label: `Safer: ${safeV} km/h`, inputs: Object.assign({}, c, { speed: safeV }) },
      { label: `Current: ${c.speed} km/h`, inputs: c, current: true },
      { label: `Riskier: ${riskyV} km/h`, inputs: Object.assign({}, c, { speed: riskyV }) },
    ].map(o => Object.assign(o, { score: evaluate(o.inputs).score }));
  }

  root.RiskModel = {
    WEATHER, SURFACE, LIGHTING, MAX_POINTS, RANGES, THRESHOLDS, DEFAULTS,
    sanitize, evaluate, classify, recommendations, explainChange, comparison,
    stoppingDistance, saferSpeed, speedFraction, formatDistance, clamp,
  };
})(typeof window !== 'undefined' ? window : globalThis);
