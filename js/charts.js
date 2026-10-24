/* ==========================================================================
   Lightweight canvas charts (no libraries)
   --------------------------------------------------------------------------
   LineChart  — risk history / learning curve, with threshold bands,
                crosshair and tooltip.
   BarChart   — histogram for the Monte Carlo demo.
   Colours are read from CSS custom properties at draw time, so the charts
   follow the light/dark theme automatically.
   ========================================================================== */
(function (root) {
  'use strict';

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /** Sizes a canvas to its CSS box at device-pixel resolution and returns a scaled context. */
  function fit(canvas) {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---------------------------------------------------------------------
  class LineChart {
    /**
     * opts: { yMin, yMax, yTicks, bands: [{from,to,cssVar}], tooltip (element),
     *         format(point) -> html, emptyText, xLabel }
     */
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.o = Object.assign({ yMin: 0, yMax: 100, yTicks: [0, 50, 100], bands: [], emptyText: 'No data yet' }, opts);
      this.points = [];
      this.hover = -1;
      canvas.addEventListener('pointermove', e => this.onMove(e));
      canvas.addEventListener('pointerleave', () => { this.hover = -1; this.draw(); });
    }

    setData(points) { this.points = points; this.draw(); }

    layout(w, h) {
      return { l: 34, r: 14, t: 12, b: 22, w, h };
    }

    xAt(i, L) {
      const n = this.points.length;
      return n <= 1 ? L.l + (L.w - L.l - L.r) / 2 : L.l + (i / (n - 1)) * (L.w - L.l - L.r);
    }
    yAt(v, L) {
      const { yMin, yMax } = this.o;
      return L.t + (1 - (v - yMin) / (yMax - yMin)) * (L.h - L.t - L.b);
    }

    draw() {
      const { g, w, h } = fit(this.canvas);
      const L = this.layout(w, h);
      g.clearRect(0, 0, w, h);
      const ink3 = css('--ink-3'), grid = css('--chart-grid'), line = css('--chart-line'), surface = css('--surface');
      g.font = '11px ' + css('--font-mono');
      // Threshold bands.
      for (const b of this.o.bands) {
        const y0 = this.yAt(b.to, L), y1 = this.yAt(b.from, L);
        g.fillStyle = hexA(css(b.cssVar), 0.09);
        g.fillRect(L.l, y0, w - L.l - L.r, y1 - y0);
      }
      // Grid + y labels.
      g.strokeStyle = grid; g.lineWidth = 1;
      g.fillStyle = ink3; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (const t of this.o.yTicks) {
        const y = Math.round(this.yAt(t, L)) + 0.5;
        g.beginPath(); g.moveTo(L.l, y); g.lineTo(w - L.r, y); g.stroke();
        g.fillText(this.o.yFormat ? this.o.yFormat(t) : String(t), L.l - 6, y);
      }
      // Dashed reference lines (e.g. the best achievable value).
      for (const ref of this.o.refLines || []) {
        const y = Math.round(this.yAt(ref.y, L)) + 0.5;
        g.strokeStyle = css('--ink-2'); g.setLineDash([5, 4]);
        g.beginPath(); g.moveTo(L.l, y); g.lineTo(w - L.r, y); g.stroke(); g.setLineDash([]);
        g.fillStyle = css('--ink-2'); g.textAlign = 'left'; g.textBaseline = 'bottom';
        g.fillText(ref.label, L.l + 6, y - 3);
      }
      const pts = this.points;
      if (!pts.length) {
        g.fillStyle = ink3; g.textAlign = 'center';
        g.font = '13px ' + css('--font-ui');
        g.fillText(this.o.emptyText, (L.l + w - L.r) / 2, (L.t + h - L.b) / 2);
        return;
      }
      if (this.o.xLabel) {
        g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.fillStyle = ink3;
        g.fillText(this.o.xLabel, w - L.r, h - 4);
      }
      // Line.
      g.strokeStyle = line; g.lineWidth = 2; g.lineJoin = 'round';
      g.beginPath();
      pts.forEach((p, i) => { const x = this.xAt(i, L), y = this.yAt(p.y, L); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
      // Markers (only when there is room), with a surface ring.
      const showMarkers = pts.length <= 40;
      pts.forEach((p, i) => {
        if (!showMarkers && i !== pts.length - 1 && i !== this.hover) return;
        const x = this.xAt(i, L), y = this.yAt(p.y, L);
        g.fillStyle = surface; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
        g.fillStyle = p.color ? css(p.color) : line; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
      });
      // Direct label on the latest point.
      const last = pts[pts.length - 1];
      const lx = this.xAt(pts.length - 1, L), ly = this.yAt(last.y, L);
      g.fillStyle = css('--ink'); g.font = '600 12px ' + css('--font-mono');
      g.textAlign = lx > w - 60 ? 'right' : 'left'; g.textBaseline = 'bottom';
      g.fillText(this.o.labelFormat ? this.o.labelFormat(last) : last.y.toFixed(1), lx + (lx > w - 60 ? -8 : 8), ly - 6);
      // Crosshair.
      if (this.hover >= 0 && this.hover < pts.length) {
        const x = this.xAt(this.hover, L);
        g.strokeStyle = ink3; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(Math.round(x) + 0.5, L.t); g.lineTo(Math.round(x) + 0.5, h - L.b); g.stroke();
        g.setLineDash([]);
      }
      this.updateTip(L);
    }

    onMove(e) {
      if (!this.points.length) return;
      const r = this.canvas.getBoundingClientRect();
      const L = this.layout(r.width, r.height);
      const x = e.clientX - r.left;
      let best = -1, bd = Infinity;
      this.points.forEach((p, i) => { const d = Math.abs(this.xAt(i, L) - x); if (d < bd) { bd = d; best = i; } });
      if (best !== this.hover) { this.hover = best; this.draw(); }
    }

    updateTip(L) {
      const tip = this.o.tooltip;
      if (!tip) return;
      if (this.hover < 0 || !this.points[this.hover]) { tip.hidden = true; return; }
      const p = this.points[this.hover];
      tip.innerHTML = this.o.format ? this.o.format(p) : String(p.y);
      tip.hidden = false;
      const x = this.xAt(this.hover, L), y = this.yAt(p.y, L);
      tip.style.left = Math.min(Math.max(x, 80), L.w - 80) + 'px';
      tip.style.top = Math.max(y, 40) + 'px';
    }
  }

  // ---------------------------------------------------------------------
  class BarChart {
    /** opts: { tooltip, format(bar) -> html, xTicks: [values], xMin, xMax } */
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.o = opts || {};
      this.bars = [];
      this.hover = -1;
      canvas.addEventListener('pointermove', e => this.onMove(e));
      canvas.addEventListener('pointerleave', () => { this.hover = -1; this.draw(); });
    }
    setData(bars, markers) { this.bars = bars; this.markers = markers || []; this.draw(); }
    layout(w, h) { return { l: 36, r: 10, t: 14, b: 24, w, h }; }

    draw() {
      const { g, w, h } = fit(this.canvas);
      const L = this.layout(w, h);
      g.clearRect(0, 0, w, h);
      const n = this.bars.length;
      if (!n) return;
      const max = Math.max(1, ...this.bars.map(b => b.value));
      const pw = w - L.l - L.r, ph = h - L.t - L.b;
      const bw = pw / n;
      const grid = css('--chart-grid'), ink3 = css('--ink-3');
      g.font = '11px ' + css('--font-mono');
      g.strokeStyle = grid; g.fillStyle = ink3; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let k = 0; k <= 4; k++) {
        const v = (max * k) / 4, y = Math.round(L.t + ph - (v / max) * ph) + 0.5;
        g.beginPath(); g.moveTo(L.l, y); g.lineTo(w - L.r, y); g.stroke();
        g.fillText(this.o.yFormat ? this.o.yFormat(v) : Math.round(v), L.l - 6, y);
      }
      this.bars.forEach((b, i) => {
        const bh = (b.value / max) * ph;
        const x = L.l + i * bw + 1, y = L.t + ph - bh;
        const wBar = Math.max(1, bw - 2);
        g.fillStyle = css(b.cssVar || '--chart-line');
        g.globalAlpha = this.hover === -1 || this.hover === i ? 1 : 0.55;
        if (bh > 0) {
          const r = Math.min(4, wBar / 2, bh);
          g.beginPath();
          g.moveTo(x, L.t + ph); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
          g.lineTo(x + wBar - r, y); g.quadraticCurveTo(x + wBar, y, x + wBar, y + r); g.lineTo(x + wBar, L.t + ph);
          g.closePath(); g.fill();
        }
      });
      g.globalAlpha = 1;
      // x ticks
      g.fillStyle = ink3; g.textAlign = 'center'; g.textBaseline = 'top';
      const { xMin = 0, xMax = 100 } = this.o;
      for (const t of this.o.xTicks || []) {
        const x = L.l + ((t - xMin) / (xMax - xMin)) * pw;
        g.fillText(String(t), x, h - L.b + 6);
      }
      // Vertical markers (e.g. mean).
      let prevX = -Infinity, row = 0;
      for (const m of this.markers) {
        const x = Math.round(L.l + ((m.x - xMin) / (xMax - xMin)) * pw) + 0.5;
        row = x - prevX < 70 ? row + 1 : 0;           // stack labels that would overlap
        prevX = x;
        g.strokeStyle = css('--ink'); g.lineWidth = 2; g.setLineDash([4, 3]);
        g.beginPath(); g.moveTo(x, L.t); g.lineTo(x, L.t + ph); g.stroke(); g.setLineDash([]); g.lineWidth = 1;
        g.fillStyle = css('--ink'); g.textAlign = x > w - 70 ? 'right' : 'left'; g.textBaseline = 'top';
        g.font = '600 11px ' + css('--font-mono');
        g.fillText(m.label, x + (x > w - 70 ? -5 : 5), L.t + row * 14);
      }
      this.updateTip(L, bw, max, ph);
    }

    onMove(e) {
      if (!this.bars.length) return;
      const r = this.canvas.getBoundingClientRect();
      const L = this.layout(r.width, r.height);
      const bw = (r.width - L.l - L.r) / this.bars.length;
      const i = Math.floor((e.clientX - r.left - L.l) / bw);
      const next = i >= 0 && i < this.bars.length ? i : -1;
      if (next !== this.hover) { this.hover = next; this.draw(); }
    }

    updateTip(L, bw, max, ph) {
      const tip = this.o.tooltip;
      if (!tip) return;
      if (this.hover < 0) { tip.hidden = true; return; }
      const b = this.bars[this.hover];
      tip.innerHTML = this.o.format ? this.o.format(b) : String(b.value);
      tip.hidden = false;
      tip.style.left = Math.min(Math.max(L.l + (this.hover + 0.5) * bw, 80), L.w - 80) + 'px';
      tip.style.top = Math.max(L.t + ph - (b.value / max) * ph, 40) + 'px';
    }
  }

  root.Charts = { LineChart, BarChart, fit, css };
})(window);
