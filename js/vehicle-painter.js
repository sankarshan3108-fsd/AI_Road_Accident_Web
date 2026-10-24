/* ==========================================================================
   Vehicle painter
   --------------------------------------------------------------------------
   Draws every vehicle as a set of shaded boxes in true perspective, then adds
   details (lamps, number plates, windows, riders) on the visible faces.
   Vehicles moving away show their rear, oncoming vehicles show their front,
   and cross-street vehicles show their side.

   Colours are mixed towards the fog colour by distance (atmospheric
   perspective). Light sources are collected in scene.lights and drawn later
   in the emissive pass, after the day/night lighting has been applied.
   ========================================================================== */
(function (root) {
  'use strict';
  const A = root.SceneAssets;
  const { hexToRgb, mix, shade } = A;

  const GLASS = [34, 44, 56];
  const TYRE = [24, 24, 26];
  const TRIM = [40, 42, 46];
  const SKIN = [150, 104, 74];
  const KHAKI = [176, 152, 104];
  const BUS_DESTINATIONS = ['GANDHIPURAM', 'UKKADAM', 'SINGANALLUR', 'TOWN HALL'];

  const colorCache = new Map();
  function toRgb(c) {
    if (Array.isArray(c)) return c;
    let v = colorCache.get(c);
    if (!v) { v = hexToRgb(c); colorCache.set(c, v); }
    return v;
  }

  class VehiclePainter {
    constructor(scene) {
      this.s = scene;
      this.fz = 0;
    }

    // ---- low-level helpers ---------------------------------------------
    col(c, f, a) {
      let v = toRgb(c);
      if (f !== undefined && f !== 1) v = shade(v, f);
      v = mix(v, this.s.fogCol, this.fz);
      return a === undefined ? `rgb(${v[0] | 0},${v[1] | 0},${v[2] | 0})` : `rgba(${v[0] | 0},${v[1] | 0},${v[2] | 0},${a})`;
    }
    poly(pts, style) {
      const g = this.s.ctx;
      g.fillStyle = style;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fill();
    }
    P(x, y, z) { return this.s.proj(x, y, z); }
    faceZ(z, x0, x1, y0, y1) { return [this.P(x0, y0, z), this.P(x1, y0, z), this.P(x1, y1, z), this.P(x0, y1, z)]; }
    faceX(x, z0, z1, y0, y1) { return [this.P(x, y0, z0), this.P(x, y0, z1), this.P(x, y1, z1), this.P(x, y1, z0)]; }
    faceY(y, x0, x1, z0, z1) { return [this.P(x0, y, z0), this.P(x1, y, z0), this.P(x1, y, z1), this.P(x0, y, z1)]; }

    /** Shaded box. Only faces that the camera can actually see are drawn. */
    box(x0, x1, y0, y1, z0, z1, color, opt) {
      const camH = this.s.camH;
      if (z1 <= 0.6) return;
      z0 = Math.max(z0, 0.6);
      const side = opt && opt.side !== undefined ? opt.side : 0.78;
      const top = opt && opt.top !== undefined ? opt.top : 1.1;
      const near = opt && opt.near !== undefined ? opt.near : 0.94;
      if (x1 < 0) this.poly(this.faceX(x1, z0, z1, y0, y1), this.col(color, side));
      else if (x0 > 0) this.poly(this.faceX(x0, z0, z1, y0, y1), this.col(color, side));
      if (y1 < camH) this.poly(this.faceY(y1, x0, x1, z0, z1), this.col(color, top));
      if (!(opt && opt.noNear)) this.poly(this.faceZ(z0, x0, x1, y0, y1), this.col(color, near));
    }

    /** A point light for the emissive pass. */
    light(x, y, z, radiusM, kind, intensity) {
      if (z < 0.8) return;
      const p = this.P(x, y, z);
      const r = radiusM * this.s.f / z;
      this.s.lights.push({ x: p[0], y: p[1], r, kind, a: intensity * (1 - this.fz * 0.85), z, wx: x });
    }

    plate(x0, x1, y0, y1, z, v) {
      const pts = this.faceZ(z, x0, x1, y0, y1);
      this.poly(pts, this.col(v.plateYellow ? '#f4cf2c' : '#f4f4ef'));
      const w = pts[1][0] - pts[0][0];
      if (w > 26 && this.fz < 0.5) {
        const g = this.s.ctx;
        g.fillStyle = this.col('#111111');
        g.font = `700 ${Math.max(5, (pts[0][1] - pts[3][1]) * 0.72)}px "IBM Plex Mono", monospace`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(v.plate, (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[3][1]) / 2 + 0.5, w * 0.92);
      }
    }

    /** Ground shadow: soft contact shadow plus a sun-cast shadow towards the camera. */
    shadow(e, h) {
      const env = this.s.env;
      const g = this.s.ctx;
      const a = (0.32 + 0.12 * env.sun) * (1 - this.fz);
      this.poly(this.faceY(0.02, e.x0 - 0.12, e.x1 + 0.12, Math.max(0.7, e.z0 - 0.15), e.z1 + 0.1), `rgba(10,12,16,${a * 0.75})`);
      if (env.sun > 0.05) {
        const dx = -0.42 * h, dz = -0.7 * h;
        const pts = [this.P(e.x0 + dx, 0.02, Math.max(0.7, e.z0 + dz)), this.P(e.x1 + dx, 0.02, Math.max(0.7, e.z0 + dz)),
          this.P(e.x1, 0.02, e.z1), this.P(e.x0, 0.02, e.z1)];
        g.globalAlpha = 0.24 * env.sun * (1 - this.fz);
        this.poly(pts, 'rgb(14,18,26)');
        g.globalAlpha = 1;
      }
    }

    // ---- entry point -------------------------------------------------------
    draw(v, e) {
      const s = this.s;
      if (e.z1 < 1.2) return;
      // Clip at a near plane 1 m in front of the camera: a vehicle entering from behind the
      // camera is drawn truncated instead of being projected through z <= 0.
      if (e.z0 < 1) e = { x0: e.x0, x1: e.x1, z0: 1, z1: e.z1 };
      this.fz = s.fogAt(Math.max(e.z0, 1));
      if (this.fz > 0.985) return;           // lost in fog
      const def = v.lane.def;
      const view = def.axis === 'x' ? 'side' : def.dir > 0 ? 'rear' : 'front';
      const ppm = s.f / Math.max(e.z0, 1);  // screen pixels per metre at this depth
      this.lod = ppm > 9 ? 2 : ppm > 3.5 ? 1 : 0;
      this.shadow(e, v.type.H);
      if (s.env.wet > 0.05 && view !== 'side' && e.z0 < 170) this.reflection(v, e);
      switch (v.kind) {
        case 'car': case 'suv': this.car(v, e, view); break;
        case 'auto': this.auto(v, e, view); break;
        case 'bike': case 'scooter': this.twoWheeler(v, e, view); break;
        case 'bus': this.bus(v, e, view); break;
        case 'truck': this.truck(v, e, view); break;
      }
    }

    /** Mirror image in the wet road (near face only, low opacity). */
    reflection(v, e) {
      const g = this.s.ctx;
      g.globalAlpha = 0.2 * this.s.env.wet * (1 - this.fz);
      const body = v.kind === 'bus' ? v.livery[0] : v.kind === 'truck' ? v.livery[0] : v.color || '#555555';
      const h = v.type.H;
      const xw = (v.kind === 'bike' || v.kind === 'scooter') ? 0.3 : 0;
      this.poly(this.faceZ(Math.max(0.7, e.z0), e.x0 + xw, e.x1 - xw, -h * 0.95, -0.05), this.col(body, 0.7));
      g.globalAlpha = 1;
    }

    wheels(e, axles, inset, radius, width) {
      for (const az of axles) {
        this.box(e.x0 + inset, e.x0 + inset + width, 0, radius * 2, az - radius, az + radius, TYRE, { side: 0.9, top: 0.9 });
        this.box(e.x1 - inset - width, e.x1 - inset, 0, radius * 2, az - radius, az + radius, TYRE, { side: 0.9, top: 0.9 });
      }
    }

    // ---- cars and SUVs -------------------------------------------------------
    car(v, e, view) {
      if (view === 'side') return this.carSide(v, e);
      const suv = v.kind === 'suv';
      const H = v.type.H, body = toRgb(v.color);
      const beltY = suv ? 1.05 : 0.92;
      const rear = view === 'rear';
      const z0 = e.z0, z1 = e.z1, L = z1 - z0;
      // Cabin position: long bonnet at the front, short boot at the back.
      const cz0 = rear ? z0 + (suv ? 0.35 : 0.75) : z0 + (suv ? 1.05 : 1.25);
      const cz1 = rear ? z1 - (suv ? 1.05 : 1.25) : z1 - (suv ? 0.35 : 0.7);
      if (this.lod > 0) this.wheels(e, [z0 + 0.8, z1 - 0.85], 0.02, 0.31, 0.22);
      this.box(e.x0, e.x1, 0.26, beltY, z0, z1, body);
      this.box(e.x0 + 0.1, e.x1 - 0.1, beltY, H, cz0, cz1, body, { near: 0.9, top: 1.16 });
      const g = this.s.ctx;
      // Glass on the visible cabin side.
      if (this.lod > 0 && (e.x1 < 0 || e.x0 > 0)) {
        const sx = e.x1 < 0 ? e.x1 - 0.1 : e.x0 + 0.1;
        this.poly(this.faceX(sx, cz0 + 0.18, cz1 - 0.18, beltY + 0.05, H - 0.08), this.col(GLASS, 1.05));
        g.strokeStyle = this.col(body, 0.7); g.lineWidth = Math.max(1, this.s.f / z0 * 0.06);
        const m0 = this.P(sx, beltY + 0.05, (cz0 + cz1) / 2), m1 = this.P(sx, H - 0.08, (cz0 + cz1) / 2);
        g.beginPath(); g.moveTo(m0[0], m0[1]); g.lineTo(m1[0], m1[1]); g.stroke();
      }
      // Windscreen / rear window on the cabin's near face.
      const cx0 = e.x0 + 0.1, cx1 = e.x1 - 0.1;
      this.poly(this.faceZ(cz0, cx0 + 0.07, cx1 - 0.07, beltY + 0.06, H - 0.07), this.col(GLASS, 1.1));
      if (this.lod > 1) {
        // Sky reflection on the glass.
        g.globalAlpha = 0.25 * (1 - this.fz);
        this.poly(this.faceZ(cz0, cx0 + 0.15, cx0 + 0.6, H - 0.2, H - 0.09), 'rgb(220,230,240)');
        g.globalAlpha = 1;
      }
      const W = e.x1 - e.x0, xm = (e.x0 + e.x1) / 2;
      // Bumper.
      this.poly(this.faceZ(z0, e.x0, e.x1, 0.26, 0.38), this.col(body, 0.62));
      if (this.lod === 0) {
        this.lamps(e, view, 0.7, v);
        return;
      }
      if (rear) {
        this.poly(this.faceZ(z0, e.x0 + 0.05, e.x0 + 0.38, 0.66, 0.84), this.col('#9e1218'));
        this.poly(this.faceZ(z0, e.x1 - 0.38, e.x1 - 0.05, 0.66, 0.84), this.col('#9e1218'));
        this.plate(xm - 0.26, xm + 0.26, 0.42, 0.54, z0, v);
      } else {
        this.poly(this.faceZ(z0, xm - 0.36, xm + 0.36, 0.48, 0.66), this.col(TRIM));
        this.poly(this.faceZ(z0, e.x0 + 0.06, e.x0 + 0.42, 0.62, 0.76), this.col('#dfe6ea'));
        this.poly(this.faceZ(z0, e.x1 - 0.42, e.x1 - 0.06, 0.62, 0.76), this.col('#dfe6ea'));
        this.plate(xm - 0.26, xm + 0.26, 0.3, 0.42, z0, v);
      }
      this.lamps(e, view, 0.72, v, W);
    }

    /** Head/tail/brake lamps as emissive lights. */
    lamps(e, view, y, v, W) {
      const env = this.s.env;
      const z = Math.max(0.8, e.z0 - 0.02);
      const inset = Math.min(0.24, ((W || (e.x1 - e.x0)) / 2) * 0.4);
      if (view === 'rear') {
        const brake = v.braking ? 1 : 0;
        const a = Math.max(env.headlights * 0.75, brake * 0.95);
        if (a > 0.02) {
          this.light(e.x0 + inset, y, z, 0.32, brake ? 'brake' : 'tail', a);
          this.light(e.x1 - inset, y, z, 0.32, brake ? 'brake' : 'tail', a);
        }
      } else if (view === 'front' && env.headlights > 0.02) {
        this.light(e.x0 + inset, y, z, 0.42, 'head', env.headlights);
        this.light(e.x1 - inset, y, z, 0.42, 'head', env.headlights);
        this.s.beams.push({ x0: e.x0, x1: e.x1, z: e.z0, dir: -1, a: env.headlights * (1 - this.fz) });
      }
      if (view === 'rear' && env.headlights > 0.3) {
        this.s.beams.push({ x0: e.x0, x1: e.x1, z: e.z1, dir: 1, a: env.headlights * 0.8 * (1 - this.fz) });
      }
    }

    carSide(v, e) {
      const suv = v.kind === 'suv';
      const body = toRgb(v.color), H = v.type.H, belt = suv ? 1.05 : 0.92;
      const fwd = v.lane.def.dir > 0;           // travelling +x
      const front = fwd ? e.x1 : e.x0, back = fwd ? e.x0 : e.x1;
      const sgn = fwd ? 1 : -1;
      const c0 = Math.min(back + sgn * 0.8, front - sgn * 1.3), c1 = Math.max(back + sgn * 0.8, front - sgn * 1.3);
      this.box(e.x0, e.x1, 0.26, belt, e.z0, e.z1, body);
      this.box(c0, c1, belt, H, e.z0 + 0.1, e.z1 - 0.1, body);
      this.poly(this.faceZ(e.z0 + 0.1, c0 + 0.15, c1 - 0.15, belt + 0.05, H - 0.07), this.col(GLASS, 1.05));
      this.sideWheels(e, [back + sgn * 0.8, front - sgn * 0.85], 0.31);
      if (this.s.env.headlights > 0.02) this.light(front, 0.7, e.z0, 0.35, 'head', this.s.env.headlights);
    }

    sideWheels(e, xs, r) {
      const g = this.s.ctx;
      for (const x of xs) {
        const p = this.P(x, r, e.z0 - 0.01);
        const pr = r * this.s.f / e.z0;
        g.fillStyle = this.col(TYRE);
        g.beginPath(); g.arc(p[0], p[1], pr, 0, Math.PI * 2); g.fill();
        g.fillStyle = this.col('#8a8f96');
        g.beginPath(); g.arc(p[0], p[1], pr * 0.5, 0, Math.PI * 2); g.fill();
      }
    }

    // ---- auto-rickshaw -----------------------------------------------------
    auto(v, e, view) {
      const yellow = toRgb(v.color), black = [30, 31, 34];
      const rear = view === 'rear';
      const xm = (e.x0 + e.x1) / 2;
      if (view === 'side') {
        const fwd = v.lane.def.dir > 0, sgn = fwd ? 1 : -1;
        const front = fwd ? e.x1 : e.x0, back = fwd ? e.x0 : e.x1;
        this.box(e.x0, e.x1, 0.25, 0.95, e.z0, e.z1, yellow);
        this.box(Math.min(back, front - sgn * 0.3), Math.max(back, front - sgn * 0.3), 0.95, 1.72, e.z0 + 0.03, e.z1 - 0.03, black);
        this.poly(this.faceZ(e.z0 + 0.03, Math.min(back + sgn * 0.3, front - sgn * 0.9), Math.max(back + sgn * 0.3, front - sgn * 0.9), 1.0, 1.55), this.col('#14161a'));
        this.sideWheels(e, [back + sgn * 0.45, front - sgn * 0.35], 0.24);
        if (this.s.env.headlights > 0.02) this.light(front, 0.9, e.z0, 0.3, 'head', this.s.env.headlights);
        return;
      }
      const z0 = e.z0, z1 = e.z1;
      if (this.lod > 0) {
        if (rear) this.wheels(e, [z0 + 0.4], 0.04, 0.24, 0.16);
        else this.box(xm - 0.08, xm + 0.08, 0, 0.48, z0 + 0.1, z0 + 0.58, TYRE);
      }
      if (rear) {
        this.box(e.x0, e.x1, 0.25, 1.0, z0, z1 - 0.8, yellow);
        this.box(xm - 0.5, xm + 0.5, 0.25, 1.05, z1 - 0.85, z1, yellow, { noNear: true });
        this.box(e.x0 + 0.03, e.x1 - 0.03, 1.0, 1.72, z0 + 0.08, z1 - 0.3, black, { top: 1.25 });
        if (this.lod > 0) {
          this.poly(this.faceZ(z0 + 0.08, xm - 0.32, xm + 0.32, 1.25, 1.5), this.col('#2c3a46'));
          this.poly(this.faceZ(z0, e.x0 + 0.05, e.x0 + 0.25, 0.62, 0.78), this.col('#9e1218'));
          this.poly(this.faceZ(z0, e.x1 - 0.25, e.x1 - 0.05, 0.62, 0.78), this.col('#9e1218'));
          this.plate(xm - 0.2, xm + 0.2, 0.38, 0.5, z0, v);
        }
        this.lamps(e, view, 0.7, v);
      } else {
        // Front: narrow cowl with a single headlamp, windscreen and a khaki-clad driver.
        this.box(e.x0, e.x1, 0.25, 1.0, z0 + 0.8, z1, yellow);
        this.box(e.x0 + 0.03, e.x1 - 0.03, 1.0, 1.72, z0 + 0.3, z1 - 0.08, black, { top: 1.25, noNear: true });
        this.poly(this.faceZ(z0 + 0.3, e.x0 + 0.03, e.x1 - 0.03, 1.62, 1.72), this.col(black));
        this.poly(this.faceZ(z0 + 0.3, e.x0 + 0.08, e.x1 - 0.08, 1.04, 1.62), this.col(GLASS, 1.2, 0.85));
        if (this.lod > 1) {
          this.poly(this.faceZ(z0 + 0.45, xm - 0.2, xm + 0.2, 1.0, 1.3), this.col(KHAKI));
          const hp = this.P(xm, 1.42, z0 + 0.45);
          const g = this.s.ctx;
          g.fillStyle = this.col('#2a1d16');
          g.beginPath(); g.arc(hp[0], hp[1], 0.12 * this.s.f / (z0 + 0.45), 0, Math.PI * 2); g.fill();
        }
        this.box(xm - 0.5, xm + 0.5, 0.25, 1.05, z0, z0 + 0.8, yellow);
        if (this.lod > 0) this.plate(xm - 0.17, xm + 0.17, 0.32, 0.42, z0, v);
        if (this.s.env.headlights > 0.02) {
          this.light(xm, 0.88, z0 - 0.02, 0.36, 'head', this.s.env.headlights);
          this.s.beams.push({ x0: e.x0, x1: e.x1, z: z0, dir: -1, a: this.s.env.headlights * 0.7 * (1 - this.fz) });
        }
      }
    }

    // ---- motorcycles and scooters -------------------------------------------
    twoWheeler(v, e, view) {
      const g = this.s.ctx;
      const xm = (e.x0 + e.x1) / 2;
      const scooter = v.kind === 'scooter';
      const f = this.s.f;
      if (view === 'side') {
        const fwd = v.lane.def.dir > 0, sgn = fwd ? 1 : -1;
        const front = fwd ? e.x1 : e.x0, back = fwd ? e.x0 : e.x1;
        const zr = (e.z0 + e.z1) / 2;
        this.sideWheels({ z0: zr }, [back + sgn * 0.3, front - sgn * 0.3], 0.3);
        this.box(Math.min(back + sgn * 0.35, front - sgn * 0.35), Math.max(back + sgn * 0.35, front - sgn * 0.35), 0.35, 0.8, zr - 0.15, zr + 0.15, v.color);
        this.rider(xm - sgn * 0.1, zr, v, 'side');
        if (this.s.env.headlights > 0.02) this.light(front - sgn * 0.1, 0.95, zr, 0.25, 'head', this.s.env.headlights);
        return;
      }
      const rear = view === 'rear';
      const z0 = e.z0, z1 = e.z1;
      const zMid = (z0 + z1) / 2;
      // Body / engine / scooter panels, then the nearer tyre seen end-on.
      if (scooter) this.box(xm - 0.22, xm + 0.22, 0.2, 0.82, z0 + 0.2, z1 - 0.3, v.color, { top: 1.15 });
      else this.box(xm - 0.17, xm + 0.17, 0.32, 0.86, z0 + 0.3, z1 - 0.3, v.color, { top: 1.2 });
      this.box(xm - 0.06, xm + 0.06, 0, 0.6, z0 + 0.05, z0 + 0.6, TYRE);

      if (rear) {
        // Rider first (further), pillion behind them is nearer the camera.
        this.rider(xm, zMid + 0.15, v, 'rear');
        if (v.pillion && this.lod > 0) this.rider(xm, zMid - 0.4, v, 'rear', true);
        if (this.lod > 0) {
          this.poly(this.faceZ(z0, xm - 0.1, xm + 0.1, 0.48, 0.6), this.col('#f4f4ef'));
          this.poly(this.faceZ(z0, xm - 0.07, xm + 0.07, 0.68, 0.76), this.col('#9e1218'));
        }
        const brake = v.braking ? 1 : 0;
        const a = Math.max(this.s.env.headlights * 0.7, brake * 0.9);
        if (a > 0.02) this.light(xm, 0.72, z0 - 0.02, 0.22, brake ? 'brake' : 'tail', a);
      } else {
        if (v.pillion && this.lod > 0) this.rider(xm, zMid + 0.3, v, 'front', true);
        this.rider(xm, zMid - 0.15, v, 'front');
        // Handlebar and mirrors.
        if (this.lod > 0) {
          g.strokeStyle = this.col(TRIM);
          g.lineWidth = Math.max(1, 0.05 * f / z0);
          const a0 = this.P(xm - 0.38, 1.05, z0 + 0.35), a1 = this.P(xm + 0.38, 1.05, z0 + 0.35);
          g.beginPath(); g.moveTo(a0[0], a0[1]); g.lineTo(a1[0], a1[1]); g.stroke();
          this.poly(this.faceZ(z0 + 0.1, xm - 0.15, xm + 0.15, 0.75, 1.0), this.col(v.color, 0.9));
        }
        if (this.s.env.headlights > 0.02) {
          this.light(xm, 0.92, z0 - 0.02, 0.3, 'head', this.s.env.headlights);
          this.s.beams.push({ x0: xm - 0.5, x1: xm + 0.5, z: z0, dir: -1, a: this.s.env.headlights * 0.5 * (1 - this.fz) });
        }
      }
    }

    /** Rider: legs, torso (shirt colour), arms and helmet. Pillions often ride without one. */
    rider(xm, zc, v, view, pillion) {
      const g = this.s.ctx;
      const shirt = pillion ? v.pillion : v.shirt;
      const dz = 0.18;
      const lift = pillion ? 0.08 : 0;
      this.box(xm - 0.27, xm - 0.12, 0.42, 0.88, zc - dz, zc + dz, '#2d3138');
      this.box(xm + 0.12, xm + 0.27, 0.42, 0.88, zc - dz, zc + dz, '#2d3138');
      this.box(xm - 0.24, xm + 0.24, 0.86 + lift, 1.4 + lift, zc - 0.13, zc + 0.13, shirt, { top: 1.05 });
      if (view === 'front' && !pillion && this.lod > 0) {
        this.box(xm - 0.36, xm - 0.24, 1.0, 1.32, zc - 0.35, zc + 0.05, shirt, { near: 0.8 });
        this.box(xm + 0.24, xm + 0.36, 1.0, 1.32, zc - 0.35, zc + 0.05, shirt, { near: 0.8 });
      }
      if (zc < 0.8) return;
      const p = this.P(xm, 1.56 + lift, zc);
      const r = 0.15 * this.s.f / zc;
      const helmet = !pillion || v.seed % 3 === 0;
      g.fillStyle = helmet ? this.col(v.helmet) : this.col('#1d1612');
      g.beginPath(); g.arc(p[0], p[1], r, 0, Math.PI * 2); g.fill();
      if (helmet && this.lod > 1 && view === 'front') {
        g.fillStyle = this.col('#1a2028', 1, 0.85);
        g.beginPath(); g.ellipse(p[0], p[1] + r * 0.2, r * 0.7, r * 0.42, 0, 0, Math.PI * 2); g.fill();
      } else if (!helmet && this.lod > 1 && view === 'front') {
        g.fillStyle = this.col(SKIN);
        g.beginPath(); g.ellipse(p[0], p[1] + r * 0.25, r * 0.72, r * 0.62, 0, 0, Math.PI * 2); g.fill();
      }
    }

    // ---- buses ---------------------------------------------------------------
    bus(v, e, view) {
      const [base, stripe] = v.livery.map(toRgb);
      const g = this.s.ctx;
      if (view === 'side') {
        this.box(e.x0, e.x1, 0.35, 3.2, e.z0, e.z1, base);
        this.poly(this.faceZ(e.z0, e.x0, e.x1, 0.85, 1.25), this.col(stripe));
        this.poly(this.faceZ(e.z0, e.x0 + 0.5, e.x1 - 0.5, 1.5, 2.55), this.col(GLASS, 1.1));
        this.sideWheels(e, [e.x0 + 2.1, e.x1 - 2.4], 0.48);
        return;
      }
      const rear = view === 'rear';
      const z0 = e.z0, z1 = e.z1, xm = (e.x0 + e.x1) / 2;
      if (this.lod > 0) this.wheels(e, [z0 + 2.4, z1 - 2.2], 0.05, 0.48, 0.3);
      this.box(e.x0, e.x1, 0.35, 3.2, z0, z1, base, { top: 1.05 });
      // Side windows and livery stripe on the visible side.
      if (e.x1 < 0 || e.x0 > 0) {
        const sx = e.x1 < 0 ? e.x1 : e.x0;
        this.poly(this.faceX(sx, z0 + 0.3, z1 - 0.3, 0.85, 1.25), this.col(stripe, 0.82));
        if (this.lod > 0) {
          this.poly(this.faceX(sx, z0 + 0.6, z1 - 0.8, 1.5, 2.6), this.col(GLASS, 1.0));
          g.strokeStyle = this.col(base, 0.78);
          g.lineWidth = Math.max(1, 0.12 * this.s.f / (z0 + 4));
          for (let zz = z0 + 1.6; zz < z1 - 0.9; zz += 1.15) {
            const a = this.P(sx, 1.5, zz), b = this.P(sx, 2.6, zz);
            g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
          }
        }
      }
      this.poly(this.faceZ(z0, e.x0, e.x1, 0.85, 1.25), this.col(stripe));
      this.poly(this.faceZ(z0, e.x0, e.x1, 0.35, 0.55), this.col(TRIM));
      if (rear) {
        this.poly(this.faceZ(z0, e.x0 + 0.25, e.x1 - 0.25, 2.0, 2.95), this.col(GLASS, 1.05));
        if (this.lod > 0) {
          this.poly(this.faceZ(z0, e.x0 + 0.08, e.x0 + 0.3, 0.6, 1.5), this.col('#9e1218'));
          this.poly(this.faceZ(z0, e.x1 - 0.3, e.x1 - 0.08, 0.6, 1.5), this.col('#9e1218'));
          this.plate(xm - 0.27, xm + 0.27, 0.6, 0.74, z0, v);
        }
        this.lamps(e, view, 1.0, v);
      } else {
        this.poly(this.faceZ(z0, e.x0 + 0.12, e.x1 - 0.12, 1.45, 2.72), this.col(GLASS, 1.15));
        // Destination board (amber LED style).
        const db = this.faceZ(z0, e.x0 + 0.2, e.x1 - 0.2, 2.8, 3.1);
        this.poly(db, this.col('#121212'));
        const w = db[1][0] - db[0][0];
        if (w > 40 && this.fz < 0.5) {
          g.fillStyle = this.col('#ffb21a');
          g.font = `700 ${Math.max(6, (db[0][1] - db[3][1]) * 0.7)}px "IBM Plex Mono", monospace`;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(BUS_DESTINATIONS[v.seed % BUS_DESTINATIONS.length], (db[0][0] + db[1][0]) / 2, (db[0][1] + db[3][1]) / 2, w * 0.9);
        }
        if (this.lod > 0) this.plate(xm - 0.27, xm + 0.27, 0.58, 0.72, z0, v);
        this.lamps(e, view, 0.75, v);
      }
    }

    // ---- lorries ------------------------------------------------------------
    truck(v, e, view) {
      const [cab, cargo] = v.livery.map(toRgb);
      const g = this.s.ctx;
      if (view === 'side') {
        const fwd = v.lane.def.dir > 0;
        const cx0 = fwd ? e.x1 - 1.9 : e.x0, cx1 = fwd ? e.x1 : e.x0 + 1.9;
        const bx0 = fwd ? e.x0 : e.x0 + 2.1, bx1 = fwd ? e.x1 - 2.1 : e.x1;
        this.box(bx0, bx1, 0.95, 3.05, e.z0, e.z1, cargo);
        this.box(cx0, cx1, 0.55, 2.65, e.z0, e.z1, cab);
        this.sideWheels(e, [e.x0 + 1.3, e.x1 - 1.3], 0.5);
        return;
      }
      const rear = view === 'rear';
      const z0 = e.z0, z1 = e.z1, xm = (e.x0 + e.x1) / 2;
      if (this.lod > 0) this.wheels(e, [z0 + 1.3, z1 - 1.4], 0.05, 0.5, 0.32);
      if (rear) {
        this.box(e.x0 + 0.05, e.x1 - 0.05, 0.55, 2.65, z1 - 1.9, z1, cab, { noNear: true });
        this.box(e.x0, e.x1, 0.95, 3.05, z0, z1 - 2.1, cargo, { top: 1.0 });
        this.poly(this.faceZ(z0, e.x0, e.x1, 0.95, 1.9), this.col('#2b2b2b'));
        const tb = this.faceZ(z0, e.x0 + 0.1, e.x1 - 0.1, 1.05, 1.8);
        this.poly(tb, this.col('#f1c232'));
        const w = tb[1][0] - tb[0][0];
        if (w > 34 && this.fz < 0.55) {
          g.fillStyle = this.col('#7a1414');
          g.font = `800 ${Math.max(5, (tb[0][1] - tb[3][1]) * 0.36)}px "IBM Plex Sans", sans-serif`;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          const hh = tb[0][1] - tb[3][1];
          g.fillText('HORN OK', (tb[0][0] + tb[1][0]) / 2, tb[3][1] + hh * 0.3, w * 0.9);
          g.fillText('PLEASE', (tb[0][0] + tb[1][0]) / 2, tb[3][1] + hh * 0.72, w * 0.9);
        }
        if (this.lod > 0) {
          this.poly(this.faceZ(z0, e.x0 + 0.06, e.x0 + 0.3, 0.6, 0.85), this.col('#9e1218'));
          this.poly(this.faceZ(z0, e.x1 - 0.3, e.x1 - 0.06, 0.6, 0.85), this.col('#9e1218'));
          this.plate(xm - 0.27, xm + 0.27, 0.6, 0.74, z0 - 0.01, v);
        }
        this.lamps(e, view, 0.72, v);
      } else {
        this.box(e.x0, e.x1, 0.95, 3.05, z0 + 2.1, z1, cargo, { top: 1.0 });
        this.box(e.x0 + 0.05, e.x1 - 0.05, 0.55, 2.65, z0, z0 + 1.9, cab);
        this.poly(this.faceZ(z0, e.x0 + 0.15, e.x1 - 0.15, 1.65, 2.35), this.col(GLASS, 1.15));
        this.poly(this.faceZ(z0, e.x0 + 0.05, e.x1 - 0.05, 2.38, 2.65), this.col(cargo, 1.1));
        this.poly(this.faceZ(z0, e.x0 + 0.05, e.x1 - 0.05, 0.55, 0.78), this.col(TRIM));
        if (this.lod > 0) this.plate(xm - 0.27, xm + 0.27, 0.82, 0.96, z0, v);
        this.lamps(e, view, 1.0, v);
      }
    }
  }

  root.VehiclePainter = VehiclePainter;
})(window);
