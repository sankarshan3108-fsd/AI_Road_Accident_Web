# Road Risk Simulator — AI-Based Road Accident Risk Simulation (Web)


## 🌐 Live Demo

**Try the Road Accident Risk Simulator here:**

🔗 [AI Road Accident Prediction Simulation](https://ai-road-accident-simulation.sankarshan3108.workers.dev)

Explore realistic road scenarios, change weather and driving conditions, simulate traffic, and observe accident-risk assessments.

## 🚀 Project Overview

An interactive, browser-based road accident risk simulation designed to demonstrate how environmental conditions, traffic density, and driving factors can influence road safety.

A browser version of the **AI_Road_Accident_Simulation** university micro-project (Python/Pygame).
It shows an animated, perspective view of an **illustrative Coimbatore arterial road** with left-hand
traffic, live weather and lighting effects, a transparent **educational accident-risk model**, and an
**AI concept laboratory** with seven interactive demonstrations.

> **Educational simulation only.** The risk score comes from a hand-written teaching model, not from
> real accident data. It has not been validated and must not be used for real-world road-safety
> decisions. No live traffic, weather or accident data is used anywhere.

This folder is completely separate from the original Python project. It does not import, modify or
depend on any file in `AI_Road_Accident_Simulation`.

---

## Main features

**Road simulation**
- Perspective "traffic camera" view of a four-lane divided road: raised median with black-and-white
  kerbs, black-and-yellow footpath kerbs, zebra crossings, stop lines, lane arrows, a signalised
  junction with countdown timers, a bus stop and median lamp posts.
- Left-hand traffic (Indian rules): cars, SUVs, motorcycles and scooters (with riders and pillions),
  auto-rickshaws, town buses and lorries. Tamil Nadu number plates (white for private vehicles,
  yellow for commercial vehicles).
- Roadside: coconut palms, neem and rain trees, shops with bilingual signboards (correct Tamil
  Unicode, e.g. மருந்தகம், தேநீர் கடை), houses behind compound walls, black rooftop water tanks,
  utility poles with overhead wires, pedestrians, and the Western Ghats on the horizon.
- Vehicle behaviour: the Intelligent Driver Model (smooth acceleration and braking, safe spacing,
  no overlaps), traffic-signal compliance with amber decision logic, smooth lane changes, buses
  stopping at the bus bay, and mandatory merging before a work zone.
- Weather (sunny, cloudy, rainy, foggy) and lighting (day, dusk, street-lit night, unlit night) change
  the sky, clouds, rain, wet-road reflections, fog banks, haze, headlights, street lamps and lit
  windows, all with smooth transitions.

**Risk dashboard**
- Animated gauge, score, LOW / MEDIUM / HIGH classification (colour + icon + text).
- Contributing-factor bars showing exactly the points the model assigns.
- A one-line explanation of why the score changed.
- Safety recommendations, each linked to the condition that triggered it.
- Safer-vs-riskier comparison, risk-history chart (real recorded values) and an event log.

**AI concept laboratory**: seven demonstrations (see below).

**Other**: light/dark theme, full-screen road view, playback speed, keyboard support,
reduced-motion support, responsive layout from phones to wide desktops.

## Technology

- HTML5, CSS3 and vanilla JavaScript; HTML Canvas for the road scene and charts.
- No frameworks, no build step, no server, no paid API.
- Fonts: IBM Plex Sans / Mono and Noto Sans Tamil from Google Fonts (system fonts are used as a
  fallback if they cannot load).
- Scripts are plain `<script>` files (not ES modules), so the site works both on GitHub Pages and when
  `index.html` is opened directly from disk.

## Folder structure

```
AI_Road_Accident_Web/
├── index.html            page structure and all controls
├── style.css             design system, light/dark themes, responsive layout
├── script.js             app controller: state, animation loop, controls, dashboard, log, theme
├── js/
│   ├── risk-model.js     educational risk model, recommendations, stopping distance
│   ├── traffic.js        traffic simulation (IDM car-following, signals, lane changes)
│   ├── scene-assets.js   procedural sprites/textures: trees, clouds, facades, signs
│   ├── vehicle-painter.js  draws vehicles in perspective (rear/front/side views)
│   ├── scene.js          road scene renderer: projection, layers, weather, lighting
│   ├── charts.js         small canvas line chart and histogram
│   ├── astar.js          A* search logic and the hazard-weighted city grid
│   └── ai-lab.js         the seven AI demonstrations
├── assets/favicon.svg
├── tests/run-tests.js    Node.js logic tests (risk model, A*, traffic)
└── README.md
```

## How to run locally

**Option 1 — open the file.** Double-click `index.html`. Everything works offline except the web fonts.

**Option 2 — local web server (closest to GitHub Pages).** From the folder that contains
`AI_Road_Accident_Web`:

```bash
python -m http.server 8000
```

then open <http://localhost:8000/AI_Road_Accident_Web/>.

**Logic tests** (requires Node.js 18+):

```bash
node tests/run-tests.js
```

### Controls

| Control | Effect |
|---|---|
| Start / Pause / Resume (button or <kbd>Space</kbd>) | Runs or freezes simulated time |
| Reset | Restores the documented defaults (below), resets traffic and the clock; history and log are kept and the reset is recorded |
| Playback 0.5× – 4× | Speed of simulated time |
| Weather | Visuals + risk; also sets a typical visibility (sunny 2 km+, cloudy 1.5 km, rainy 600 m, foggy 150 m) which you can then fine-tune |
| Lighting | Darkness, headlights, street lamps, lit windows + risk |
| Visibility 50 m – 2 km | Haze/fog density + risk |
| Traffic density 0–100 % | Vehicle arrival rate (number of vehicles and queues) + risk |
| Vehicle speed 20–120 km/h | Drivers' target speed (buses, lorries, autos capped lower) + risk |
| Road surface | Dry, wet (dark reflective asphalt), potholes (visible in lanes), works (left lane closed with cones; traffic merges) + risk |

**Default state:** sunny, daylight, dry, visibility 2 km+, density 40 %, speed 50 km/h, playback 1×,
simulation ready (not running).

## The educational risk model

`js/risk-model.js`. Deterministic: identical inputs always give the identical score.

| Component | Max points | Rule |
|---|---:|---|
| Vehicle speed | 32 | 32 · s^1.3, with s = (speed − 20) / 100 |
| Speed × hazards | 16 | 16 · s · h, with h = (weather + surface + visibility + lighting points) / 44 |
| Visibility | 14 | 14 · ((2000 − visibility) / 1950)² |
| Weather | 10 | sunny 0, cloudy 3, foggy 8, rainy 10 |
| Road surface | 10 | dry 0, wet 8, works 9, potholes 10 |
| Lighting | 10 | day 0, dusk 4, night (street-lit) 6, night (unlit) 10 |
| Traffic density | 8 | 8 · density / 100 |
| **Total** | **100** | |

**Classification:** LOW < 35 ≤ MEDIUM < 65 ≤ HIGH.

Examples: the defaults score 9.9 (LOW); 120 km/h on a clear day scores 35.2 (MEDIUM); rain on a wet
road at 80 km/h at dusk with 600 m visibility scores 55.3 (MEDIUM); the worst combination scores 100.

**Recommendations** are rules over the inputs (low visibility, wet road, potholes, work zone, dense
traffic, dusk/night, high speed). One rule uses physics: stopping distance = reaction distance
(1.5 s) + braking distance v² / (2 μ g), with μ = 0.7 dry, 0.4 wet, 0.5 potholes, 0.55 works. If the
stopping distance exceeds the visibility, the advice gives the highest speed that fits.
The "safer" comparison speed is the highest speed that keeps the score LOW *and* stops within the
visible distance.

**Assumptions and limitations**
- The point values are illustrative judgements chosen so that speed matters most and hazards
  compound with speed. They are not fitted to accident statistics.
- The score ranks conditions from safer to riskier. It is **not** a probability of an accident.
- The browser does **not** run the scikit-learn Random Forest from the Python project, and its scores
  are not expected to match that model. The structure is inspired by the expert formula the Python
  project uses to label its synthetic data, with weights rebalanced for this page.
- Traffic behaviour is a simplified model for visualisation. Vehicles never collide in the scene, and
  no crash is ever simulated or predicted.
- The street is a composite inspired by Coimbatore (locality names on the direction board are real
  places; no specific junction is depicted).

## The seven AI concepts

1. **Intelligent agents.** A model-based reflex agent car approaches a junction. Every 0.2 s it
   perceives (signal, distance to the stop line, obstacles, pedestrian, speed, wet road), picks the
   first matching rule from a priority-ordered condition–action table (emergency brake, stop for a
   pedestrian, change lane around a stalled auto-rickshaw, stop on red/amber, proceed on late amber,
   cruise) and acts. Its internal state remembers whether it has committed to stopping on amber.
2. **Probability and uncertainty.** A Monte Carlo simulation (fixed seed, so it is reproducible)
   perturbs the live conditions by the chosen uncertainties, with an optional chance that rain sets
   in. It shows a histogram of resulting scores, the mean, a 90 % interval, P(LOW) and P(HIGH), and
   explains that a score is not a calibrated real-world probability.
3. **Knowledge representation.** Conditions become propositional facts. Thirteen IF–THEN rules are
   applied by forward chaining, one firing at a time or to a fixpoint. Derived facts select the
   advice. Facts can be toggled or loaded from the live simulation.
4. **Learning agents.** An ε-greedy action-value learner chooses a cruising speed (30/45/60/75 km/h)
   for four conditions. Reward = progress (10·v/75 ± 15 %) − 48 · hazard · (v/75)², where
   hazard = 1.5 · (score/100)^2.5 ± 60 % and the score comes from the risk model. Values start
   optimistic (Q₀ = 12) so every speed gets tried. The page shows Q-values, visit counts, a learning
   curve and, optionally, the true expected rewards. It learns a policy for *this simulator* only.
   No real data is involved.
5. **Problem formulation.** A trip is stated as a search problem (state, initial state, actions,
   transition model, goal test, constraints, path cost) using the live conditions. Distance, time
   available and acceptable risk change the formulation, the outcome table (time, risk, on time,
   risk OK, legal under an illustrative 60 km/h limit) and the feasible speed window. Infeasible
   problems are explained.
6. **Utility-based agents.** Five actions (maintain, slow down 20 %, overtake, increase gap, pull over
   10 min) are scored by U = wₛ·Safety + wₜ·Time + w꜀·Comfort. Safety = 100 − risk score under the
   action's effect on speed and spacing; Time is relative to the fastest action on a 10 km trip;
   Comfort is a documented constant per action (lower for overtaking in poor conditions).
7. **A\* informed search.** An 18 × 9 city grid (same layout as the Python project). Step cost =
   1 + hazard penalty from the live conditions (waterlogging in rain, fog banks at low visibility,
   congestion at high density, potholes, blackspots at high risk; works cells are blocked). The
   heuristic is the Manhattan distance, which is admissible and consistent because every step costs
   at least 1. You can set the start and destination, toggle blocks (mouse or keyboard), animate,
   step, solve instantly, and block every route to see "No path found". It also shows a comparison
   with uniform-cost search.

## Performance and accessibility notes

- One `requestAnimationFrame` loop with delta-time and fixed physics sub-steps (1/30 s). It stops when
  nothing is animating, when the tab is hidden, or when the road is scrolled off-screen, and resumes
  without a time jump.
- Static scenery is drawn once into cached layers and only redrawn when weather, visibility or
  lighting changes. A normal frame measured about 3–4 ms in headless Edge at 1280 × 680.
- `prefers-reduced-motion`: weather changes apply instantly, and clouds, rain and foliage don't
  animate. Vehicles move only after you press Start. Gauge and chart animations are disabled.
- Every control is a native input (radio groups, ranges, buttons) with a label and a visible value.
  Tabs follow the WAI-ARIA tabs pattern (arrow keys, Home/End). The A\* grid has a keyboard cursor.
  Risk level changes are announced to screen readers. Status is never shown by colour alone.
- **Theme:** the first visit follows the operating-system light/dark preference. Pressing the toggle
  saves your choice in `localStorage` (if storage is unavailable, the toggle still works for the
  session). The road scene itself is not themed: its lighting is a simulation input.

## Testing performed

All tests below were actually run (Windows 11, Microsoft Edge in headless mode driven over the
Chrome DevTools Protocol, Node.js 24):

- `node tests/run-tests.js`: 18 logic tests passed. They cover score bounds and determinism,
  thresholds, monotonicity, sanitising, recommendations, A\* optimality against uniform-cost search on
  300 random maps, path validity, the no-path case, work-zone blocking, absence of vehicle overlaps
  over 15 simulated minutes, speed limits, the density response, seeded reset and frame-rate
  independence.
- Browser functional run: start, pause, resume, 4× playback (4.07 s of simulated time per real
  second), weather/lighting/surface/slider changes updating the scene, model and recommendations,
  invalid slider value clamped, reset to defaults, theme toggle, all seven tabs, the agent in four
  scenarios (cycling signal, stalled auto, pedestrian on a wet road, fixed red — the agent holds at
  the line), Monte Carlo resampling, forward chaining to fixpoint, learning (policy matched the
  optimum 4/4 after 2,000 trips), problem formulation (feasible and infeasible), utility weights,
  A\* animated, instant, and no-path. No JavaScript errors were logged.
- Hidden tab: simulated time froze while `document.hidden` was true and resumed without a jump.
- Render stress test: 3,600 frames across 40 random weather/lighting/surface/visibility/density/speed
  combinations, with no exceptions (about 10 ms per frame on average in software-rendered headless
  Edge, including static-layer rebuilds after every change). Over 56,000 headlight beams were checked
  for near-plane violations and none were found.
- Served over HTTP under the `/AI_Road_Accident_Web/` sub-path (as on GitHub Pages) and opened
  directly from disk (`file://`): both worked.
- Layout: no horizontal overflow at 1440, 820 (tablet) and 390 px (phone).

**Manual checks still worth doing on real devices:** touch dragging of sliders on a phone, real
full-screen mode, a screen reader pass, and frame rate on a low-end laptop.

## Publishing with GitHub Pages

The site uses only relative paths, so it works from a repository sub-path such as
`https://<user>.github.io/AI_Road_Accident_Web/`.

1. Create a **new, empty** repository on GitHub, e.g. `AI_Road_Accident_Web` (keep it separate from
   the Python project's repository).
2. In a terminal, inside this folder:
   ```bash
   git init
   git add .
   git commit -m "Road Risk Simulator web version"
   git branch -M main
   git remote add origin https://github.com/<your-username>/AI_Road_Accident_Web.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, Branch:
   `main`, folder: `/ (root)`, then **Save**.
4. After a minute or two the site is available at
   `https://<your-username>.github.io/AI_Road_Accident_Web/`.

The original Python project cannot run on GitHub Pages (it needs Python and Pygame). This folder is
the web counterpart.
