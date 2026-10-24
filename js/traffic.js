/* ==========================================================================
   Traffic simulation (logic only, no drawing)
   --------------------------------------------------------------------------
   World units are metres and seconds. The camera stands above the median at
   z = 0 looking along +z. Traffic keeps LEFT (Indian rules):
     lanes 0,1  (x < 0) travel away from the camera (+z)
     lanes 2,3  (x > 0) travel towards the camera   (-z)
     lanes 4,5  run along the cross street at the junction (x axis)

   Car-following uses the Intelligent Driver Model (IDM, Treiber et al.
   2000). It gives smooth acceleration, smooth braking and natural spacing,
   and keeps vehicles from overlapping. Red lights, the bus stop and the work
   zone are modelled as stationary "virtual leaders".
   ========================================================================== */
(function (root) {
  'use strict';

  // ---- Road geometry (metres) shared with the renderer --------------------
  const GEOM = {
    MEDIAN_HALF: 0.6,        // raised median from x = -0.6 .. 0.6
    LANE_W: 3.5,
    ROAD_EDGE: 7.6,          // carriageway edge |x|
    FOOTPATH_IN: 8.3,        // paved shoulder 7.6 .. 8.3, kerb at 8.3
    FOOTPATH_OUT: 10.6,      // footpath 8.3 .. 10.6
    BUILD_LINE: 11.4,        // compound walls / shop fronts start here
    CAMERA_H: 6.5,           // camera height above the road
    Z_FAR: 430,              // furthest drawn road distance

    STOP_AWAY: 49,           // stop line for traffic moving away (z)
    ZEBRA_AWAY: [49.6, 53.4],
    CROSS_Z: [54.5, 70.5],   // cross-street carriageway
    ZEBRA_ON: [71.6, 75.4],
    STOP_ON: 76,             // stop line for oncoming traffic (z)
    CROSS_STOP_X: 9.4,       // |x| of the stop line on each cross-street arm

    BUS_STOP_Z: [160, 174],  // bus bay on the left footpath
    WORK_ZONE: { lane: 0, z0: 98, z1: 136 },   // lane closure used when the surface is 'Under construction'
  };

  const U_AWAY0 = -16;        // z of progress u = 0 for away lanes (behind camera)
  const Z_ONCOMING0 = 445;    // z of progress u = 0 for oncoming lanes
  const CROSS_X0 = 95;        // cross lanes start at |x| = 95
  const MAIN_LEN = 461;       // lane length in progress units
  const CROSS_LEN = 190;

  const LANES = [
    { id: 0, axis: 'z', dir: 1, x: -5.85, approach: 'main', outer: true },
    { id: 1, axis: 'z', dir: 1, x: -2.35, approach: 'main', outer: false },
    { id: 2, axis: 'z', dir: -1, x: 2.35, approach: 'main', outer: false },
    { id: 3, axis: 'z', dir: -1, x: 5.85, approach: 'main', outer: true },
    { id: 4, axis: 'x', dir: 1, z: 66.5, approach: 'cross' },   // keep left => +x traffic uses the far half
    { id: 5, axis: 'x', dir: -1, z: 58.5, approach: 'cross' },  // -x traffic uses the near half
  ];
  const SIBLING = { 0: 1, 1: 0, 2: 3, 3: 2 };

  // ---- Vehicle types: size (m) and IDM parameters ---------------------------
  // a = max acceleration, b = comfortable deceleration (m/s^2),
  // T = desired time headway (s), s0 = minimum standstill gap (m).
  const TYPES = {
    car:     { L: 4.1,  W: 1.72, H: 1.48, a: 1.6, b: 2.6, T: 1.3, s0: 2.0, speedFactor: 1.0,  maxKmh: 140, lcDur: 2.6 },
    suv:     { L: 4.6,  W: 1.86, H: 1.78, a: 1.5, b: 2.5, T: 1.4, s0: 2.0, speedFactor: 0.98, maxKmh: 140, lcDur: 2.8 },
    auto:    { L: 2.75, W: 1.32, H: 1.72, a: 1.0, b: 2.2, T: 1.2, s0: 1.5, speedFactor: 0.9,  maxKmh: 50,  lcDur: 2.2 },
    bike:    { L: 1.95, W: 0.78, H: 1.62, a: 2.2, b: 3.0, T: 1.0, s0: 1.5, speedFactor: 1.0,  maxKmh: 120, lcDur: 1.7 },
    scooter: { L: 1.8,  W: 0.72, H: 1.6,  a: 1.8, b: 2.8, T: 1.0, s0: 1.5, speedFactor: 0.94, maxKmh: 75,  lcDur: 1.8 },
    bus:     { L: 11.0, W: 2.55, H: 3.2,  a: 0.9, b: 2.0, T: 1.6, s0: 2.5, speedFactor: 0.86, maxKmh: 75,  lcDur: 4.0 },
    truck:   { L: 8.2,  W: 2.45, H: 3.05, a: 0.8, b: 2.0, T: 1.7, s0: 2.5, speedFactor: 0.82, maxKmh: 65,  lcDur: 4.0 },
  };

  // Vehicle mix (Coimbatore traffic is dominated by two-wheelers).
  const MIX_OUTER = [['bike', 22], ['scooter', 16], ['car', 26], ['auto', 16], ['bus', 11], ['truck', 9]];
  const MIX_INNER = [['bike', 20], ['scooter', 14], ['car', 44], ['suv', 17], ['auto', 5]];
  const MIX_CROSS = [['bike', 26], ['scooter', 18], ['car', 32], ['auto', 16], ['suv', 8]];

  const CAR_COLORS = ['#f1f1ef', '#f4f4f2', '#c9ccd1', '#9aa0a8', '#3d4148', '#a3262b', '#6e1f2a', '#2f5d9e', '#e9e4da', '#7b6a58', '#1f2328'];
  const BIKE_COLORS = ['#1d1f24', '#b8232a', '#2c4f8f', '#e6e6e6', '#3a3a3a', '#7a1f2b'];
  const BUS_LIVERIES = [['#f3ead6', '#9b2c2c'], ['#eef1f4', '#2c5aa0'], ['#f2e6c4', '#2f7d4f'], ['#f5f0e6', '#c25b17']];
  const TRUCK_LIVERIES = [['#e3a21a', '#2f6aa3'], ['#d8572a', '#2d7f5e'], ['#e5c02b', '#9b2c2c']];
  const SHIRTS = ['#e8e4dc', '#3b6fb6', '#c0392b', '#2e8b57', '#f0c419', '#6c4f9e', '#d9822b', '#4a4a4a', '#9bc4e2'];
  const HELMETS = ['#1b1b1b', '#e9e9e9', '#c62828', '#1f4fa0', '#f2b705'];
  const RTO_CODES = ['37', '38', '66', '99', '37', '38', '41', '39'];   // Coimbatore RTOs dominate

  const SIGNAL_PHASES = [
    { name: 'MAIN_GREEN', dur: 20, main: 'green', cross: 'red' },
    { name: 'MAIN_YELLOW', dur: 3, main: 'yellow', cross: 'red' },
    { name: 'ALL_RED', dur: 2, main: 'red', cross: 'red' },
    { name: 'CROSS_GREEN', dur: 9, main: 'red', cross: 'green' },
    { name: 'CROSS_YELLOW', dur: 3, main: 'red', cross: 'yellow' },
    { name: 'ALL_RED', dur: 2, main: 'red', cross: 'red' },
  ];

  const MAX_STEP = 1 / 30;     // physics sub-step (s) keeps IDM stable at any frame rate
  const KMH = 1 / 3.6;

  // ---- Deterministic random numbers (so Reset gives the same scene) --------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickWeighted(rng, table) {
    const total = table.reduce((s, e) => s + e[1], 0);
    let r = rng() * total;
    for (const [k, w] of table) { r -= w; if (r <= 0) return k; }
    return table[table.length - 1][0];
  }
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  const smoothstep = t => t * t * (3 - 2 * t);

  // ======================================================================
  class Simulation {
    constructor(seed) {
      this.seed = seed || 20251014;
      this.conditions = { density: 40, speed: 50, weather: 'sunny', surface: 'dry' };
      this.reset();
    }

    reset() {
      this.rng = mulberry32(this.seed);
      this.time = 0;
      this.nextId = 1;
      this.lanes = LANES.map(l => ({ def: l, vehicles: [], nextSpawn: 0 }));
      this.signal = { phase: 0, t: 0 };
      this.stats = { spawned: 0, exited: 0 };
      this.updateSignalState();
      this.warmUp(45);
    }

    /** Runs the model for a while before showing it, so the road starts with natural traffic. */
    warmUp(seconds) {
      for (let t = 0; t < seconds; t += 0.1) this.step(0.1);
    }

    setConditions(c) {
      Object.assign(this.conditions, c);
      for (const lane of this.lanes) lane.nextSpawn = Math.min(lane.nextSpawn, this.time + this.interArrival(lane.def));
    }

    get workZoneActive() { return this.conditions.surface === 'construction'; }

    /** Driver behaviour adapts to conditions: longer headways in rain/fog, gentler braking on wet roads. */
    driverAdjust() {
      const w = this.conditions.weather;
      const wet = w === 'rainy' || this.conditions.surface === 'wet';
      return {
        T: w === 'foggy' ? 1.45 : w === 'rainy' ? 1.25 : 1.0,
        b: wet ? 0.8 : 1.0,
      };
    }

    // ---- Signals --------------------------------------------------------
    updateSignalState() {
      const ph = SIGNAL_PHASES[this.signal.phase];
      this.signal.main = ph.main;
      this.signal.cross = ph.cross;
      // Seconds until each approach's light changes colour (for the countdown timers).
      this.signal.mainRemain = this.timeUntilChange('main');
      this.signal.crossRemain = this.timeUntilChange('cross');
    }

    timeUntilChange(approach) {
      const cur = SIGNAL_PHASES[this.signal.phase][approach];
      let t = SIGNAL_PHASES[this.signal.phase].dur - this.signal.t;
      for (let i = 1; i < SIGNAL_PHASES.length; i++) {
        const ph = SIGNAL_PHASES[(this.signal.phase + i) % SIGNAL_PHASES.length];
        if (ph[approach] !== cur) break;
        t += ph.dur;
      }
      return t;
    }

    stepSignal(dt) {
      this.signal.t += dt;
      while (this.signal.t >= SIGNAL_PHASES[this.signal.phase].dur) {
        this.signal.t -= SIGNAL_PHASES[this.signal.phase].dur;
        this.signal.phase = (this.signal.phase + 1) % SIGNAL_PHASES.length;
      }
      this.updateSignalState();
    }

    // ---- Geometry helpers -----------------------------------------------
    /** World extents of a vehicle: {x0,x1,z0,z1} with x0<x1, z0<z1. */
    extents(v) {
      const d = v.lane.def;
      if (d.axis === 'z') {
        const zFront = d.dir > 0 ? U_AWAY0 + v.u : Z_ONCOMING0 - v.u;
        const z0 = d.dir > 0 ? zFront - v.type.L : zFront;
        return { x0: v.x - v.type.W / 2, x1: v.x + v.type.W / 2, z0, z1: z0 + v.type.L };
      }
      const xFront = d.dir > 0 ? -CROSS_X0 + v.u : CROSS_X0 - v.u;
      const x0 = d.dir > 0 ? xFront - v.type.L : xFront;
      return { x0, x1: x0 + v.type.L, z0: d.z - v.type.W / 2, z1: d.z + v.type.W / 2 };
    }

    /** Progress value u at which a lane's front bumper reaches world position (z or x). */
    uAt(def, pos) {
      if (def.axis === 'z') return def.dir > 0 ? pos - U_AWAY0 : Z_ONCOMING0 - pos;
      return def.dir > 0 ? pos + CROSS_X0 : CROSS_X0 - pos;
    }

    stopU(def) {
      if (def.axis === 'z') return this.uAt(def, def.dir > 0 ? GEOM.STOP_AWAY : GEOM.STOP_ON);
      return this.uAt(def, def.dir > 0 ? -GEOM.CROSS_STOP_X : GEOM.CROSS_STOP_X);
    }

    /** Is the junction box occupied by traffic on the given axis? */
    boxOccupied(axis) {
      for (const lane of this.lanes) {
        if (lane.def.axis !== axis) continue;
        for (const v of lane.vehicles) {
          const e = this.extents(v);
          if (axis === 'z' && e.z1 > GEOM.CROSS_Z[0] && e.z0 < GEOM.CROSS_Z[1]) return true;
          if (axis === 'x' && e.x1 > -GEOM.ROAD_EDGE && e.x0 < GEOM.ROAD_EDGE) return true;
        }
      }
      return false;
    }

    // ---- Spawning ---------------------------------------------------------
    interArrival(def) {
      const d = this.conditions.density / 100;
      let q = 0.03 + 0.36 * Math.pow(d, 1.3);   // vehicles per second per lane
      if (def.axis === 'x') q *= 0.45;
      else if (!def.outer) q *= 0.85;
      const r = Math.max(1e-6, this.rng());
      return Math.max(1.3, -Math.log(r) / q);
    }

    makeVehicle(lane) {
      const def = lane.def;
      const rng = this.rng;
      const mix = def.axis === 'x' ? MIX_CROSS : def.outer ? MIX_OUTER : MIX_INNER;
      const kind = pickWeighted(rng, mix);
      const type = TYPES[kind];
      const v = {
        id: this.nextId++, kind, type, lane,
        u: 0, v: 0, acc: 0,
        x: def.axis === 'z' ? def.x : 0,
        desire: 0.92 + rng() * 0.14,
        lcTimer: 1 + rng() * 2, lc: null,
        committed: false, braking: false,
        busStop: kind === 'bus' && def.id === 0 && rng() < 0.7, dwell: 0,
        seed: Math.floor(rng() * 1e9),
      };
      // Appearance (chosen once; reused every frame).
      const commercial = kind === 'bus' || kind === 'truck' || kind === 'auto';
      v.plate = 'TN ' + pick(rng, RTO_CODES) + ' ' + String.fromCharCode(65 + Math.floor(rng() * 26), 65 + Math.floor(rng() * 26)) + ' ' + String(1000 + Math.floor(rng() * 9000));
      v.plateYellow = commercial;
      if (kind === 'car' || kind === 'suv') v.color = pick(rng, CAR_COLORS);
      else if (kind === 'bike' || kind === 'scooter') {
        v.color = pick(rng, BIKE_COLORS);
        v.shirt = pick(rng, SHIRTS); v.helmet = pick(rng, HELMETS);
        v.pillion = rng() < 0.28 ? pick(rng, SHIRTS) : null;
      } else if (kind === 'auto') v.color = '#f2c230';
      else if (kind === 'bus') v.livery = pick(rng, BUS_LIVERIES);
      else if (kind === 'truck') v.livery = pick(rng, TRUCK_LIVERIES);
      return v;
    }

    desiredSpeed(v) {
      const base = this.conditions.speed * v.type.speedFactor * v.desire;
      let kmh = Math.min(base, v.type.maxKmh);
      if (v.lane.def.axis === 'x') kmh = Math.min(kmh, 40);  // side street is slower
      return kmh * KMH;
    }

    trySpawn(lane) {
      if (this.time < lane.nextSpawn) return;
      const last = lane.vehicles[lane.vehicles.length - 1];  // vehicles sorted front-most first
      const veh = this.makeVehicle(lane);
      const v0 = this.desiredSpeed(veh);
      if (last) {
        const gap = last.u - last.type.L;   // our front bumper starts at u = 0
        const need = Math.max(7, Math.min(v0, last.v) * 1.3) + 2;
        if (gap < need) { this.nextId--; return; }  // entry blocked: retry next frame
        veh.v = Math.min(v0, last.v + 1);
      } else {
        veh.v = v0;
      }
      lane.vehicles.push(veh);
      this.stats.spawned++;
      lane.nextSpawn = this.time + this.interArrival(lane.def);
    }

    // ---- IDM ----------------------------------------------------------
    idm(veh, v, gap, vLead, adj) {
      const p = veh.type;
      const v0 = Math.max(0.5, this.desiredSpeed(veh));
      const a = p.a, b = p.b * adj.b, T = p.T * adj.T;
      const dv = v - vLead;
      const sStar = p.s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
      const free = 1 - Math.pow(v / v0, 4);
      const g = Math.max(gap, 0.05);
      return a * (free - (sStar / g) * (sStar / g));
    }

    /** Smallest gap to any stationary virtual obstacle (signal, bus stop, work zone). */
    obstacleGap(veh) {
      const def = veh.lane.def;
      let gap = Infinity;
      const sigState = def.approach === 'main' ? this.signal.main : this.signal.cross;
      const stopU = this.stopU(def);
      const toLine = stopU - veh.u;

      if (toLine > -0.5) {
        if (sigState === 'green') {
          veh.committed = false;
          // Yield if the junction is still occupied by the other stream.
          const otherAxis = def.axis === 'z' ? 'x' : 'z';
          if (toLine < 12 && this.boxOccupied(otherAxis)) gap = Math.min(gap, toLine);
        } else if (sigState === 'yellow') {
          if (!veh.committed) {
            const canStop = toLine > 0 && (veh.v * veh.v) / (2 * toLine) < 3.4;
            if (canStop) gap = Math.min(gap, toLine); else veh.committed = true;
          }
        } else if (!veh.committed) {
          gap = Math.min(gap, toLine);
        }
      } else {
        veh.committed = false;
      }

      // Buses stop at the bus bay (front bumper at the end of the bay).
      if (veh.busStop) {
        const bayU = this.uAt(def, GEOM.BUS_STOP_Z[1]);
        const d = bayU - veh.u;
        if (d > -0.5) gap = Math.min(gap, Math.max(d, 0.01));
      }

      // Closed lane in the work zone.
      if (this.workZoneActive && def.id === GEOM.WORK_ZONE.lane && !(veh.lc && veh.lc.to !== def.id)) {
        const d = this.uAt(def, GEOM.WORK_ZONE.z0) - veh.u;
        if (d > -0.5) gap = Math.min(gap, Math.max(d, 0.01));
      }
      return gap;
    }

    /** Leader (vehicle ahead) of a would-be vehicle at progress u in a lane. */
    leaderAt(lane, u, exclude) {
      let best = null;
      for (const o of lane.vehicles) {
        if (o === exclude) continue;
        if (o.u > u && (!best || o.u < best.u)) best = o;
      }
      return best;
    }

    followerAt(lane, u, exclude) {
      let best = null;
      for (const o of lane.vehicles) {
        if (o === exclude) continue;
        if (o.u <= u && (!best || o.u > best.u)) best = o;
      }
      return best;
    }

    accelInLane(veh, lane, adj) {
      const lead = this.leaderAt(lane, veh.u, veh);
      let gap = Infinity, vLead = 0;
      if (lead) { gap = lead.u - lead.type.L - veh.u; vLead = lead.v; }
      const obstacle = this.obstacleGapFor(veh, lane);
      if (obstacle < gap) { gap = obstacle; vLead = 0; }
      return { acc: this.idm(veh, veh.v, gap, vLead, adj), gap };
    }

    /** obstacleGap evaluated as if the vehicle were in another lane (no side effects). */
    obstacleGapFor(veh, lane) {
      const saved = { lane: veh.lane, committed: veh.committed };
      veh.lane = lane;
      const g = this.obstacleGap(veh);
      veh.lane = saved.lane; veh.committed = saved.committed;
      return g;
    }

    /** Simplified MOBIL lane-change decision for the main road. */
    considerLaneChange(veh, adj) {
      const def = veh.lane.def;
      if (def.axis !== 'z' || veh.lc) return;
      const z = def.dir > 0 ? U_AWAY0 + veh.u : Z_ONCOMING0 - veh.u;
      const targetLane = this.lanes[SIBLING[def.id]];
      const heavy = veh.kind === 'bus' || veh.kind === 'truck' || veh.kind === 'auto';
      const mandatory = this.workZoneActive && def.id === GEOM.WORK_ZONE.lane &&
        this.uAt(def, GEOM.WORK_ZONE.z0) - veh.u < 130 && this.uAt(def, GEOM.WORK_ZONE.z1) > veh.u;
      // No lane changes inside the junction; discretionary ones also not on its approaches.
      if (z > GEOM.STOP_AWAY - 2 && z < GEOM.STOP_ON + 2) return;
      if (!mandatory && z > 30 && z < 92) return;
      if (z > 380) return;
      if (veh.busStop && !mandatory) return;            // buses heading for the bay keep left

      const cur = this.accelInLane(veh, veh.lane, adj);
      const tgt = this.accelInLane(veh, targetLane, adj);
      const lead = this.leaderAt(targetLane, veh.u, veh);
      const follow = this.followerAt(targetLane, veh.u, veh);
      const frontGap = lead ? lead.u - lead.type.L - veh.u : Infinity;
      const backGap = follow ? veh.u - veh.type.L - follow.u : Infinity;

      const intoClosed = this.workZoneActive && targetLane.def.id === GEOM.WORK_ZONE.lane &&
        this.uAt(targetLane.def, GEOM.WORK_ZONE.z1) + 10 > veh.u && this.uAt(targetLane.def, GEOM.WORK_ZONE.z0) - veh.u < 140;
      if (intoClosed) return;

      // Safety criterion: the new follower must not need to brake harder than bSafe.
      let followerAcc = 0;
      if (follow) followerAcc = this.idm(follow, follow.v, Math.max(0.1, backGap), veh.v, adj);
      const bSafe = mandatory ? -3.5 : -2.0;
      const safe = frontGap > 2.5 && backGap > 3 && followerAcc > bSafe;
      if (!safe) return;

      let incentive = tgt.acc - cur.acc;
      if (heavy && targetLane.def.outer) incentive += 0.35;      // slow vehicles keep left
      if (heavy && !targetLane.def.outer) incentive -= 0.5;
      if (mandatory) incentive += 3;
      if (incentive > 0.45 && (veh.v > 1.5 || mandatory)) {
        // Move bookkeeping to the target lane now; the lateral motion is animated.
        const oldLane = veh.lane;
        oldLane.vehicles.splice(oldLane.vehicles.indexOf(veh), 1);
        targetLane.vehicles.push(veh);
        targetLane.vehicles.sort((a, b) => b.u - a.u);
        veh.lc = { from: veh.x, to: targetLane.def.x, t: 0, dur: veh.type.lcDur };
        veh.lane = targetLane;
        if (!targetLane.def.outer) veh.busStop = false;   // a bus forced out of the left lane skips the bay
      }
    }

    // ---- Main update ----------------------------------------------------
    step(dt) {
      // Sub-steps keep the model stable at low frame rates or high playback speeds.
      let remaining = dt;
      while (remaining > 1e-6) {
        const h = Math.min(MAX_STEP, remaining);
        this.substep(h);
        remaining -= h;
      }
    }

    substep(dt) {
      this.time += dt;
      this.stepSignal(dt);
      const adj = this.driverAdjust();

      for (const lane of this.lanes) {
        this.trySpawn(lane);
        const list = lane.vehicles;
        list.sort((a, b) => b.u - a.u);
        // Compute accelerations first, then integrate (consistent update).
        for (let i = 0; i < list.length; i++) {
          const veh = list[i];
          const lead = i > 0 ? list[i - 1] : null;
          let gap = Infinity, vLead = 0;
          if (lead) { gap = lead.u - lead.type.L - veh.u; vLead = lead.v; }
          const og = this.obstacleGap(veh);
          if (og < gap) { gap = og; vLead = 0; }
          let acc = this.idm(veh, veh.v, gap, vLead, adj);
          acc = Math.max(-9, Math.min(acc, veh.type.a));
          veh.acc = acc;
        }
        for (const veh of list) {
          const prevV = veh.v;
          veh.v = Math.max(0, veh.v + veh.acc * dt);
          veh.u += Math.max(0, (prevV + veh.v) * 0.5 * dt);
          veh.braking = veh.acc < -0.6 || (veh.v < 0.3 && veh.u > 5);

          // Bus dwell at the stop.
          if (veh.busStop) {
            const bayU = this.uAt(lane.def, GEOM.BUS_STOP_Z[1]);
            if (bayU - veh.u < veh.type.s0 + 1.5 && veh.v < 0.3) {
              veh.dwell += dt;
              if (veh.dwell > 7) veh.busStop = false;
            }
          }
          // Lateral motion during a lane change.
          if (veh.lc) {
            veh.lc.t += dt;
            const k = Math.min(1, veh.lc.t / veh.lc.dur);
            veh.x = veh.lc.from + (veh.lc.to - veh.lc.from) * smoothstep(k);
            if (k >= 1) { veh.x = veh.lc.to; veh.lc = null; }
          }
          veh.lcTimer -= dt;
        }
        // Remove vehicles that have left the visible world.
        const len = lane.def.axis === 'z' ? MAIN_LEN : CROSS_LEN;
        for (let i = lane.vehicles.length - 1; i >= 0; i--) {
          const veh = lane.vehicles[i];
          if (veh.u - veh.type.L > len) { lane.vehicles.splice(i, 1); this.stats.exited++; }
        }
      }

      // Lane changes run in a separate pass because they move vehicles between lane lists.
      for (const lane of this.lanes) {
        if (lane.def.axis !== 'z') continue;
        for (const veh of lane.vehicles.slice()) {
          if (veh.lcTimer > 0) continue;
          veh.lcTimer = 1 + this.rng() * 2;
          this.considerLaneChange(veh, adj);
        }
      }
    }

    /** All vehicles with their world extents, for the renderer. */
    snapshot(out) {
      out.length = 0;
      for (const lane of this.lanes) {
        for (const v of lane.vehicles) out.push(v);
      }
      return out;
    }

    vehicleCount() {
      let n = 0;
      for (const lane of this.lanes) n += lane.vehicles.length;
      return n;
    }

    /** Number of vehicles currently within the visible stretch of the main road. */
    visibleCount() {
      let n = 0;
      for (const lane of this.lanes) {
        for (const v of lane.vehicles) {
          const e = this.extents(v);
          if (e.z1 > 8 && e.z0 < 330) n++;
        }
      }
      return n;
    }

    averageSpeedKmh() {
      let sum = 0, n = 0;
      for (const lane of this.lanes) {
        if (lane.def.axis !== 'z') continue;
        for (const v of lane.vehicles) {
          const e = this.extents(v);
          if (e.z1 > 8 && e.z0 < 330) { sum += v.v; n++; }
        }
      }
      return n ? (sum / n) * 3.6 : 0;
    }
  }

  root.Traffic = { Simulation, GEOM, TYPES, LANES, SIGNAL_PHASES, mulberry32 };
})(typeof window !== 'undefined' ? window : globalThis);
