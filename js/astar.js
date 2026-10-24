/* ==========================================================================
   A* search on a city grid (logic only — rendering lives in ai-lab.js)
   --------------------------------------------------------------------------
   The grid layout and hazard rules follow the Python project's A* tab.
   Entering a road cell costs 1 + hazard penalty, so every step costs at
   least 1. The Manhattan distance therefore never overestimates the
   remaining cost (admissible) and changes by at most 1 per step
   (consistent), which makes the first expansion of the goal optimal.
   ========================================================================== */
(function (root) {
  'use strict';

  const COLS = 18, ROWS = 9;
  const ROAD_ROWS = new Set([0, 4, 8]);
  const ROAD_COLS = new Set([0, 4, 9, 13, 17]);
  const EXTRA_ROADS = new Set([
    ...[0, 1, 2, 3, 4].map(c => `${c},2`),
    ...[4, 5, 6, 7, 8].map(r => `6,${r}`),
  ]);
  const DEFAULT_START = [0, 8];
  const DEFAULT_GOAL = [17, 0];

  // Hazard cells (column, row).
  const HAZARDS = {
    water:     [[4, 6], [5, 4], [6, 4], [9, 2], [10, 8], [11, 8], [6, 6]],
    pothole:   [[2, 8], [3, 8], [13, 6], [14, 4], [15, 0], [9, 7]],
    work:      [[9, 6], [13, 2]],
    traffic:   [[8, 4], [9, 4], [10, 4], [11, 4], [9, 3]],
    fog:       [5, 6, 7, 8, 9, 10, 11, 12].map(c => [c, 0]),
    blackspot: [[4, 1], [4, 2], [13, 5]],
  };
  /** Cells that cut every route between the left and right halves of the map. */
  const CUT_CELLS = [[7, 0], [7, 4], [7, 8]];

  const key = (c, r) => c + ',' + r;
  const isRoad = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS && (ROAD_ROWS.has(r) || ROAD_COLS.has(c) || EXTRA_ROADS.has(key(c, r)));

  /**
   * Builds the cost map from the current conditions.
   * Returns { cost: Map(key -> number | null), tags: Map(key -> hazard) }; null = impassable.
   */
  function buildCostGrid(inputs, riskScore, userBlocks) {
    const cost = new Map(), tags = new Map();
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (isRoad(c, r)) cost.set(key(c, r), 1);
    const add = (list, amount, tag) => {
      for (const [c, r] of list) {
        const k = key(c, r);
        if (!cost.has(k) || cost.get(k) === null) continue;
        cost.set(k, cost.get(k) + amount);
        tags.set(k, tag);
      }
    };
    if (inputs.weather === 'rainy') add(HAZARDS.water, 5, 'water');
    if (inputs.surface === 'potholes') add(HAZARDS.pothole, 4, 'pothole');
    if (inputs.density > 40) add(HAZARDS.traffic, inputs.density / 15, 'traffic');
    const fog = (inputs.weather === 'foggy' ? 3 : 0) + Math.max(0, (300 - inputs.visibility) / 50);
    if (fog > 0) add(HAZARDS.fog, fog, 'fog');
    if (riskScore > 50) add(HAZARDS.blackspot, riskScore / 20, 'blackspot');
    if (inputs.surface === 'construction') {
      for (const [c, r] of HAZARDS.work) { cost.set(key(c, r), null); tags.set(key(c, r), 'work'); }
    }
    for (const k of userBlocks || []) if (cost.has(k)) { cost.set(k, null); tags.set(k, 'blocked'); }
    return { cost, tags };
  }

  // Binary min-heap keyed by [f, h, insertion counter] for deterministic tie-breaking.
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    less(x, y) { return x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] < y[2]; }
    push(item) {
      const a = this.a; a.push(item);
      let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
    }
    pop() {
      const a = this.a; const top = a[0]; const last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && this.less(a[l], a[m])) m = l;
          if (r < a.length && this.less(a[r], a[m])) m = r;
          if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m;
        }
      }
      return top;
    }
  }

  /** Incremental A*: step() expands exactly one node so the UI can animate the real search. */
  class AStarSearch {
    constructor(cost, start, goal, useHeuristic) {
      this.cost = cost; this.start = start; this.goal = goal;
      this.useHeuristic = useHeuristic !== false;
      this.g = new Map([[key(...start), 0]]);
      this.came = new Map();
      this.closed = new Set();
      this.open = new Set([key(...start)]);
      this.expanded = [];
      this.counter = 0;
      this.heap = new Heap();
      this.heap.push([this.h(start), this.h(start), 0, start]);
      this.current = null;
      this.status = 'searching';            // searching | found | nopath
      this.path = []; this.pathCost = Infinity;
      if (cost.get(key(...start)) === null || cost.get(key(...goal)) === null) this.status = 'nopath';
    }
    h(n) { return this.useHeuristic ? Math.abs(n[0] - this.goal[0]) + Math.abs(n[1] - this.goal[1]) : 0; }
    get done() { return this.status !== 'searching'; }

    step() {
      if (this.done) return null;
      while (this.heap.size) {
        const [, , , node] = this.heap.pop();
        const k = key(...node);
        if (this.closed.has(k)) continue;           // stale entry superseded by a cheaper g
        this.closed.add(k);
        this.open.delete(k);
        this.expanded.push(node);
        this.current = node;
        if (node[0] === this.goal[0] && node[1] === this.goal[1]) {
          this.status = 'found';
          const path = [node];
          let n = k;
          while (this.came.has(n)) { n = this.came.get(n); path.push(n.split(',').map(Number)); }
          this.path = path.reverse();
          this.pathCost = this.g.get(k);
          return node;
        }
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = [node[0] + dc, node[1] + dr];
          const nk = key(...nb);
          const c = this.cost.get(nk);
          if (c === undefined || c === null || this.closed.has(nk)) continue;
          const ng = this.g.get(k) + c;
          if (ng < (this.g.has(nk) ? this.g.get(nk) : Infinity)) {
            this.g.set(nk, ng);
            this.came.set(nk, k);
            this.open.add(nk);
            this.heap.push([ng + this.h(nb), this.h(nb), ++this.counter, nb]);
          }
        }
        return node;
      }
      this.status = 'nopath';
      this.current = null;
      return null;
    }
    run() { while (!this.done) this.step(); return this; }
  }

  root.AStar = { COLS, ROWS, HAZARDS, CUT_CELLS, DEFAULT_START, DEFAULT_GOAL, key, isRoad, buildCostGrid, AStarSearch };
})(typeof window !== 'undefined' ? window : globalThis);
