/* ==========================================================================
   Procedural art assets for the road scene
   --------------------------------------------------------------------------
   Everything is drawn once into small off-screen canvases (sprites and
   textures) and then reused every frame, which keeps the animation cheap.
   No image files are needed, so the site works offline and on GitHub Pages.
   ========================================================================== */
(function (root) {
  'use strict';

  const UI_FONT = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
  const TAMIL_FONT = '"Noto Sans Tamil", "Nirmala UI", "Latha", sans-serif';

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb(c, a) {
    return a === undefined ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function shade(c, f) { return f >= 1 ? mix(c, [255, 255, 255], Math.min(1, f - 1)) : [c[0] * f, c[1] * f, c[2] * f]; }

  // ---------------------------------------------------------------------
  // Trees (coconut palm, neem, rain tree) and shrubs
  // ---------------------------------------------------------------------
  const TREE_PPM = 40; // sprite pixels per metre

  function drawPalm(rng) {
    const worldW = 8, worldH = 13.5;
    const c = makeCanvas(worldW * TREE_PPM, worldH * TREE_PPM);
    const g = c.getContext('2d');
    const baseX = c.width / 2, baseY = c.height;
    const lean = (rng() - 0.5) * 1.6 * TREE_PPM;
    const topX = baseX + lean, topY = c.height - (9.5 + rng() * 2.6) * TREE_PPM;
    const ctrlX = baseX + lean * 0.15 + (rng() - 0.5) * 0.8 * TREE_PPM, ctrlY = (baseY + topY) / 2;

    // Trunk: curved and tapering, with growth rings.
    const steps = 40;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const p0 = quad(baseX, baseY, ctrlX, ctrlY, topX, topY, t0);
      const p1 = quad(baseX, baseY, ctrlX, ctrlY, topX, topY, t1);
      const w = (0.42 - 0.17 * t0) * TREE_PPM;
      g.strokeStyle = rgb(mix([122, 106, 88], [150, 136, 116], t0 * 0.7));
      g.lineWidth = w;
      g.lineCap = 'butt';
      g.beginPath(); g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); g.stroke();
      if (i % 2 === 0) {
        g.strokeStyle = 'rgba(70,58,46,0.35)';
        g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(p0[0] - w / 2, p0[1]); g.lineTo(p0[0] + w / 2, p0[1] + 1.5); g.stroke();
      }
    }
    // Shaded side of the trunk (sun from the upper right).
    g.globalAlpha = 0.25;
    g.strokeStyle = '#3e3328';
    g.lineWidth = 0.12 * TREE_PPM;
    g.beginPath(); g.moveTo(baseX - 0.15 * TREE_PPM, baseY);
    g.quadraticCurveTo(ctrlX - 0.12 * TREE_PPM, ctrlY, topX - 0.07 * TREE_PPM, topY);
    g.stroke();
    g.globalAlpha = 1;

    // Coconuts.
    for (let i = 0; i < 7; i++) {
      g.fillStyle = rgb(i % 3 ? [92, 110, 40] : [120, 92, 40]);
      g.beginPath();
      g.arc(topX + (rng() - 0.5) * 0.7 * TREE_PPM, topY + (0.25 + rng() * 0.35) * TREE_PPM, 0.17 * TREE_PPM, 0, Math.PI * 2);
      g.fill();
    }

    // Fronds: drooping arcs with leaflets.
    const fronds = 15 + Math.floor(rng() * 5);
    for (let i = 0; i < fronds; i++) {
      const ang = -Math.PI / 2 + (i / fronds - 0.5) * Math.PI * 2.05 + (rng() - 0.5) * 0.25;
      const len = (2.6 + rng() * 1.3) * TREE_PPM;
      const droop = (0.9 + rng() * 0.8) * TREE_PPM * (Math.abs(Math.cos(ang)) + 0.3);
      const ex = topX + Math.cos(ang) * len, ey = topY + Math.sin(ang) * len * 0.55 + droop;
      const cx = topX + Math.cos(ang) * len * 0.55, cy = topY + Math.sin(ang) * len * 0.5 - 0.4 * TREE_PPM;
      const back = Math.sin(ang) < -0.3;
      const base = back ? [52, 84, 34] : [64, 104, 40];
      const tip = back ? [82, 118, 50] : [108, 146, 58];
      g.strokeStyle = rgb([96, 110, 50]);
      g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(topX, topY); g.quadraticCurveTo(cx, cy, ex, ey); g.stroke();
      for (let t = 0.08; t <= 1; t += 0.045) {
        const p = quad(topX, topY, cx, cy, ex, ey, t);
        const d = quadDeriv(topX, topY, cx, cy, ex, ey, t);
        const dl = Math.hypot(d[0], d[1]) || 1;
        const nx = -d[1] / dl, ny = d[0] / dl;
        const leaf = (1 - t * 0.55) * 0.95 * TREE_PPM;
        g.strokeStyle = rgb(mix(base, tip, t));
        g.lineWidth = 1.6;
        for (const s of [1, -1]) {
          g.beginPath();
          g.moveTo(p[0], p[1]);
          g.lineTo(p[0] + (nx * s * 0.75 + d[0] / dl * 0.35) * leaf, p[1] + (ny * s * 0.75 + d[1] / dl * 0.35) * leaf + leaf * 0.45);
          g.stroke();
        }
      }
    }
    return { canvas: c, worldW, worldH, kind: 'palm' };
  }

  function quad(x0, y0, x1, y1, x2, y2, t) {
    const u = 1 - t;
    return [u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2];
  }
  function quadDeriv(x0, y0, x1, y1, x2, y2, t) {
    return [2 * (1 - t) * (x1 - x0) + 2 * t * (x2 - x1), 2 * (1 - t) * (y1 - y0) + 2 * t * (y2 - y1)];
  }

  /** Broadleaf tree: neem (rounded crown) or rain tree (wide umbrella crown). */
  function drawBroadleaf(rng, kind) {
    const rainTree = kind === 'rain';
    const worldW = rainTree ? 13 : 9, worldH = rainTree ? 11 : 10;
    const c = makeCanvas(worldW * TREE_PPM, worldH * TREE_PPM);
    const g = c.getContext('2d');
    const bx = c.width / 2, by = c.height;
    const crownY = c.height - (rainTree ? 6.6 : 6.0) * TREE_PPM;
    const crownRX = (rainTree ? 5.6 : 3.6) * TREE_PPM, crownRY = (rainTree ? 2.6 : 3.1) * TREE_PPM;

    // Trunk and main branches.
    g.strokeStyle = '#5b4a3b';
    g.lineCap = 'round';
    g.lineWidth = (rainTree ? 0.62 : 0.48) * TREE_PPM;
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + (rng() - 0.5) * 0.4 * TREE_PPM, crownY + crownRY * 0.6); g.stroke();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.42;
      g.lineWidth = (0.22 - i * 0.012) * TREE_PPM;
      g.beginPath();
      g.moveTo(bx, crownY + crownRY * 0.75);
      g.lineTo(bx + Math.cos(a) * crownRX * 0.7, crownY + Math.sin(a) * crownRY * 0.6 + crownRY * 0.2);
      g.stroke();
    }
    // Trunk shading.
    g.fillStyle = 'rgba(30,22,16,0.25)';
    g.fillRect(bx - 0.25 * TREE_PPM, crownY + crownRY, 0.16 * TREE_PPM, by - crownY - crownRY);

    // Foliage clusters: darker underneath, lighter where the sun hits (upper right).
    const dark = rainTree ? [46, 82, 40] : [40, 74, 34];
    const mid = rainTree ? [74, 116, 52] : [62, 104, 44];
    const light = rainTree ? [128, 164, 78] : [112, 152, 66];
    // Layered leaf clusters: dark core first, then progressively lighter, smaller clusters on the sunlit side.
    const layers = [[dark, 0.95, 0.42, 160], [mid, 0.92, 0.3, 320], [light, 0.85, 0.2, 260]];
    for (let li = 0; li < layers.length; li++) {
      const [col, spread, size, count] = layers[li];
      for (let i = 0; i < (rainTree ? count * 1.2 : count); i++) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * spread;
        let x = bx + Math.cos(a) * r * crownRX;
        let y = crownY + Math.sin(a) * r * crownRY;
        if (li === 2) { x += crownRX * 0.12; y -= crownRY * 0.18; }      // highlights towards the sun
        const lit = Math.max(0, Math.min(1, 0.55 - (y - crownY) / (crownRY * 2.2)));
        g.fillStyle = rgb(shade(col, 0.82 + lit * 0.3), 0.92);
        const s = (size * 0.6 + rng() * size) * TREE_PPM;
        g.beginPath(); g.ellipse(x, y, s, s * 0.72, rng() * 3, 0, Math.PI * 2); g.fill();
      }
    }
    // Leaf speckle and small sky gaps break up the silhouette.
    for (let i = 0; i < 900; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 1.0;
      const x = bx + Math.cos(a) * r * crownRX, y = crownY + Math.sin(a) * r * crownRY;
      g.fillStyle = rng() < 0.55 ? 'rgba(18,36,14,0.4)' : 'rgba(176,206,120,0.35)';
      g.fillRect(x, y, 2 + rng() * 3, 1.5 + rng() * 2);
    }
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 12; i++) {
      const a = rng() * Math.PI * 2, r = 0.7 + rng() * 0.3;
      g.beginPath(); g.arc(bx + Math.cos(a) * r * crownRX, crownY + Math.sin(a) * r * crownRY, (0.08 + rng() * 0.12) * TREE_PPM, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    return { canvas: c, worldW, worldH, kind };
  }

  function drawShrub(rng, flowering) {
    const worldW = 2.6, worldH = 1.6;
    const c = makeCanvas(worldW * TREE_PPM, worldH * TREE_PPM);
    const g = c.getContext('2d');
    for (let i = 0; i < 90; i++) {
      const x = c.width * (0.12 + rng() * 0.76);
      const y = c.height * (0.3 + rng() * 0.7);
      const lit = 1 - y / c.height;
      g.fillStyle = rgb(mix([46, 86, 38], [104, 146, 64], lit));
      g.beginPath(); g.arc(x, y, (0.16 + rng() * 0.18) * TREE_PPM, 0, Math.PI * 2); g.fill();
    }
    if (flowering) {
      for (let i = 0; i < 70; i++) {
        g.fillStyle = rng() < 0.75 ? '#c8287a' : '#e85a9f';   // bougainvillea magenta
        g.beginPath(); g.arc(c.width * (0.15 + rng() * 0.7), c.height * (0.25 + rng() * 0.55), 2.6, 0, Math.PI * 2); g.fill();
      }
    }
    return { canvas: c, worldW, worldH, kind: 'shrub' };
  }

  function buildTreeSprites(rng) {
    return {
      palm: [drawPalm(rng), drawPalm(rng), drawPalm(rng)],
      neem: [drawBroadleaf(rng, 'neem'), drawBroadleaf(rng, 'neem')],
      rain: [drawBroadleaf(rng, 'rain')],
      shrub: [drawShrub(rng, false), drawShrub(rng, true)],
    };
  }

  // ---------------------------------------------------------------------
  // Clouds (three tones: fair-weather white, overcast grey, night)
  // ---------------------------------------------------------------------
  function buildCloudSprites(rng) {
    const tones = { white: [255, 255, 255], grey: [150, 160, 172], night: [52, 60, 80] };
    const shapes = [];
    for (let s = 0; s < 4; s++) {
      const puffs = [];
      const n = 7 + Math.floor(rng() * 5);
      for (let i = 0; i < n; i++) {
        puffs.push({ x: 0.2 + 0.6 * (i / (n - 1)) + (rng() - 0.5) * 0.06, y: 0.62 + (rng() - 0.5) * 0.1 - Math.sin((i / (n - 1)) * Math.PI) * 0.2, r: 0.09 + rng() * 0.07 });
      }
      shapes.push(puffs);
    }
    const out = {};
    for (const [name, col] of Object.entries(tones)) {
      out[name] = shapes.map(puffs => {
        const c = makeCanvas(420, 240);
        const g = c.getContext('2d');
        for (const p of puffs) {
          const r = p.r * c.width;
          const grd = g.createRadialGradient(p.x * c.width, p.y * c.height, r * 0.15, p.x * c.width, p.y * c.height, r);
          const top = name === 'white' ? col : shade(col, 1.12);
          grd.addColorStop(0, rgb(top, 0.85));
          grd.addColorStop(0.65, rgb(col, 0.55));
          grd.addColorStop(1, rgb(col, 0));
          g.fillStyle = grd;
          g.beginPath(); g.arc(p.x * c.width, p.y * c.height, r, 0, Math.PI * 2); g.fill();
        }
        // Flat, slightly darker base like real cumulus.
        const base = g.createLinearGradient(0, c.height * 0.55, 0, c.height);
        base.addColorStop(0, rgb(shade(col, 0.85), 0));
        base.addColorStop(1, rgb(shade(col, 0.82), 0.25));
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = base; g.fillRect(0, 0, c.width, c.height);
        return c;
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Building facade textures (day + night emissive)
  // ---------------------------------------------------------------------
  const FACADE_PPM = 22;

  // Generic shop categories only (no invented landmarks). Tamil text is standard Unicode.
  const SHOP_SIGNS = [
    { en: 'MEDICALS', ta: 'மருந்தகம்', bg: '#1f7a4d', fg: '#ffffff' },
    { en: 'TEA STALL', ta: 'தேநீர் கடை', bg: '#f4d03f', fg: '#5a1d12' },
    { en: 'WET GRINDERS & PUMPS', bg: '#1d4f91', fg: '#ffffff' },
    { en: 'TEXTILES', ta: 'ஜவுளி', bg: '#8e1f3a', fg: '#ffe9a8' },
    { en: 'BAKERY & SWEETS', bg: '#f8f1e3', fg: '#9b2c2c' },
    { en: 'MOBILE SERVICE', bg: '#d64527', fg: '#ffffff' },
    { en: 'HARDWARES', bg: '#25303b', fg: '#ffd166' },
    { en: 'TIFFIN CENTRE', ta: 'உணவகம்', bg: '#fff3d6', fg: '#1d5e3b' },
    { en: 'ELECTRICALS', bg: '#0f6c7a', fg: '#ffffff' },
    { en: 'STATIONERY', bg: '#f0e6d2', fg: '#24467a' },
  ];

  function fitText(g, text, maxW, sizePx, weight, family) {
    let s = sizePx;
    g.font = `${weight} ${s}px ${family}`;
    while (g.measureText(text).width > maxW && s > 6) { s -= 1; g.font = `${weight} ${s}px ${family}`; }
    return s;
  }

  /**
   * Paints one facade into day and night canvases.
   * spec: { widthM, heightM, floors, color, shop (sign or null), wall (compound wall only), rng }
   */
  function buildFacade(spec) {
    const { widthM, heightM, floors, color, shop, rng, isFront } = spec;
    const W = Math.max(8, widthM * FACADE_PPM), H = Math.max(8, heightM * FACADE_PPM);
    const day = makeCanvas(W, H), night = makeCanvas(W, H);
    const g = day.getContext('2d'), n = night.getContext('2d');
    const base = hexToRgb(color);

    // Plaster with gentle vertical gradient and monsoon water stains.
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, rgb(shade(base, 1.04)));
    grd.addColorStop(1, rgb(shade(base, 0.9)));
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    for (let i = 0; i < Math.ceil(widthM / 2); i++) {
      const x = rng() * W, w = (0.2 + rng() * 0.6) * FACADE_PPM;
      const st = g.createLinearGradient(0, 0, 0, H * (0.3 + rng() * 0.5));
      st.addColorStop(0, 'rgba(60,55,45,0.16)'); st.addColorStop(1, 'rgba(60,55,45,0)');
      g.fillStyle = st; g.fillRect(x, 0, w, H);
    }
    // Parapet line.
    g.fillStyle = rgb(shade(base, 0.78)); g.fillRect(0, 0, W, 0.25 * FACADE_PPM);
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(0, 0.25 * FACADE_PPM, W, 2);

    const floorH = heightM / floors;
    const groundShop = !!shop && !isFront;
    for (let f = 0; f < floors; f++) {
      const yTop = H - (f + 1) * floorH * FACADE_PPM;
      const isGround = f === 0;
      if (isGround && groundShop) {
        paintShopFront(g, n, shop, W, yTop, floorH * FACADE_PPM, rng);
        continue;
      }
      // Floor slab line.
      g.fillStyle = rgb(shade(base, 0.82)); g.fillRect(0, yTop + floorH * FACADE_PPM - 3, W, 3);
      const winW = 1.2 * FACADE_PPM, winH = 1.35 * FACADE_PPM;
      const count = Math.max(1, Math.floor(widthM / 3.2));
      const gap = W / count;
      for (let i = 0; i < count; i++) {
        const x = gap * i + (gap - winW) / 2;
        const y = yTop + floorH * FACADE_PPM * 0.32;
        // Sunshade (chajja) above the window with its shadow.
        g.fillStyle = rgb(shade(base, 0.7)); g.fillRect(x - 6, y - 9, winW + 12, 5);
        g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(x - 4, y - 4, winW + 8, 7);
        // Glass with sky reflection.
        const wg = g.createLinearGradient(0, y, 0, y + winH);
        wg.addColorStop(0, '#7f93a6'); wg.addColorStop(1, '#2f3b47');
        g.fillStyle = wg; g.fillRect(x, y, winW, winH);
        // Window grill.
        g.strokeStyle = 'rgba(40,40,40,0.55)'; g.lineWidth = 1;
        for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(x + (winW * k) / 4, y); g.lineTo(x + (winW * k) / 4, y + winH); g.stroke(); }
        g.strokeStyle = 'rgba(245,245,240,0.8)'; g.lineWidth = 2; g.strokeRect(x, y, winW, winH);
        // Night: some windows lit warmly.
        if (rng() < 0.55) {
          n.fillStyle = rng() < 0.7 ? 'rgba(255,196,120,0.85)' : 'rgba(210,230,255,0.75)';
          n.fillRect(x + 2, y + 2, winW - 4, winH - 4);
        }
      }
      // Occasional balcony parapet.
      if (!isGround && rng() < 0.35) {
        g.fillStyle = rgb(shade(base, 0.95));
        g.fillRect(gap * 0.1, yTop + floorH * FACADE_PPM * 0.68, W * 0.45, floorH * FACADE_PPM * 0.3);
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.fillRect(gap * 0.1, yTop + floorH * FACADE_PPM * 0.98 - 3, W * 0.45, 3);
      }
    }
    if (isFront && shop && shop.ta) {
      // Painted name panel on a visible end wall (bilingual, as is common in Tamil Nadu).
      const ph = Math.min(1.6, floorH * 0.5) * FACADE_PPM;
      const pw = W * 0.8, px = W * 0.1, py = H - floorH * FACADE_PPM * 0.95;
      g.fillStyle = shop.bg; g.fillRect(px, py, pw, ph);
      g.fillStyle = shop.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
      fitText(g, shop.ta, pw * 0.9, ph * 0.42, 700, TAMIL_FONT);
      g.fillText(shop.ta, px + pw / 2, py + ph * 0.33);
      fitText(g, shop.en, pw * 0.9, ph * 0.3, 700, UI_FONT);
      g.fillText(shop.en, px + pw / 2, py + ph * 0.75);
    }
    return { day, night };
  }

  function paintShopFront(g, n, shop, W, yTop, h, rng) {
    const boardH = Math.min(h * 0.28, 0.95 * FACADE_PPM);
    const shutterTop = yTop + boardH + 6;
    // Sign board.
    g.fillStyle = shop.bg; g.fillRect(4, yTop + 4, W - 8, boardH);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(4, yTop + 4 + boardH - 3, W - 8, 3);
    g.fillStyle = shop.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (shop.ta) {
      const half = (W - 16) / 2;
      fitText(g, shop.ta, half * 0.95, boardH * 0.6, 700, TAMIL_FONT);
      g.fillText(shop.ta, 8 + half / 2, yTop + 4 + boardH / 2);
      fitText(g, shop.en, half * 0.95, boardH * 0.55, 700, UI_FONT);
      g.fillText(shop.en, 8 + half * 1.5, yTop + 4 + boardH / 2);
    } else {
      fitText(g, shop.en, (W - 16) * 0.95, boardH * 0.58, 700, UI_FONT);
      g.fillText(shop.en, W / 2, yTop + 4 + boardH / 2);
    }
    // Night: back-lit sign.
    n.fillStyle = 'rgba(255,240,210,0.28)'; n.fillRect(4, yTop + 4, W - 8, boardH);

    // Rolling shutters, mostly open, showing a lit interior with goods on shelves.
    const bays = Math.max(1, Math.round(W / (3.2 * FACADE_PPM)));
    const bayW = W / bays;
    for (let b = 0; b < bays; b++) {
      const x = b * bayW + 4, w = bayW - 8, bottom = yTop + h;
      const open = rng() < 0.8;
      const shutterH = open ? (bottom - shutterTop) * (0.12 + rng() * 0.12) : bottom - shutterTop;
      // Interior.
      const ig = g.createLinearGradient(0, shutterTop, 0, bottom);
      ig.addColorStop(0, '#3a3530'); ig.addColorStop(1, '#1d1a17');
      g.fillStyle = ig; g.fillRect(x, shutterTop, w, bottom - shutterTop);
      if (open) {
        for (let s = 0; s < 3; s++) {
          const sy = shutterTop + shutterH + 6 + s * ((bottom - shutterTop - shutterH) / 3.4);
          for (let k = 0; k < 7; k++) {
            g.fillStyle = `hsl(${Math.floor(rng() * 360)},${12 + rng() * 22}%,${26 + rng() * 22}%)`;
            g.fillRect(x + 4 + (k * (w - 8)) / 7, sy + 3, (w - 8) / 7 - 3, 3 + rng() * 5);
          }
        }
        n.fillStyle = 'rgba(255,226,170,0.8)';
        n.fillRect(x, shutterTop + shutterH, w, bottom - shutterTop - shutterH);
      }
      // Shutter slats.
      g.fillStyle = '#9aa1a6'; g.fillRect(x, shutterTop, w, shutterH);
      g.strokeStyle = 'rgba(60,64,70,0.45)'; g.lineWidth = 1;
      for (let yy = shutterTop + 3; yy < shutterTop + shutterH; yy += 3) {
        g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke();
      }
      // Pillar between bays.
      g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(x + w, shutterTop, 8, bottom - shutterTop);
    }
  }

  /** Compound wall texture (painted plaster with coping and a gate). */
  function buildWall(widthM, heightM, color, rng) {
    const W = widthM * FACADE_PPM, H = heightM * FACADE_PPM;
    const day = makeCanvas(W, H), night = makeCanvas(4, 4);
    const g = day.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 0, W, 0.18 * FACADE_PPM);
    g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillRect(0, 0.18 * FACADE_PPM, W, 2);
    for (let x = 2.5 * FACADE_PPM; x < W; x += 2.5 * FACADE_PPM) {
      g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(x, 0, 0.25 * FACADE_PPM, H);
    }
    const sp = g.createLinearGradient(0, H * 0.6, 0, H);
    sp.addColorStop(0, 'rgba(120,80,50,0)'); sp.addColorStop(1, 'rgba(120,80,50,0.3)');
    g.fillStyle = sp; g.fillRect(0, 0, W, H);          // rain splash / dust near the ground
    if (widthM > 6 && rng() < 0.7) {
      const gx = W * (0.3 + rng() * 0.4), gw = 3 * FACADE_PPM;
      g.fillStyle = '#4a4e55'; g.fillRect(gx, H * 0.12, gw, H * 0.88);
      g.strokeStyle = '#2b2e33'; g.lineWidth = 2;
      for (let x = gx + 6; x < gx + gw; x += 7) { g.beginPath(); g.moveTo(x, H * 0.12); g.lineTo(x, H); g.stroke(); }
    }
    return { day, night };
  }

  /** Small rectangular sign texture (bus stop, direction board, safety poster). */
  function buildSign(lines, opts) {
    const W = opts.w, H = opts.h;
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = opts.bg; g.fillRect(0, 0, W, H);
    if (opts.border) { g.strokeStyle = opts.border; g.lineWidth = Math.max(2, W * 0.015); g.strokeRect(g.lineWidth, g.lineWidth, W - 2 * g.lineWidth, H - 2 * g.lineWidth); }
    g.fillStyle = opts.fg; g.textBaseline = 'middle';
    const rowH = H / lines.length;
    lines.forEach((ln, i) => {
      g.textAlign = ln.align || 'center';
      const family = ln.tamil ? TAMIL_FONT : UI_FONT;
      fitText(g, ln.text, W * 0.9, rowH * (ln.scale || 0.55), ln.weight || 700, family);
      const x = ln.align === 'left' ? W * 0.06 : ln.align === 'right' ? W * 0.94 : W / 2;
      g.fillText(ln.text, x, rowH * (i + 0.5));
    });
    return c;
  }

  /** Fine asphalt grain, used as a repeating pattern. */
  function buildNoise(rng, size) {
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rng();
      const k = v < 0.5 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = k;
      img.data[i + 3] = Math.floor(Math.abs(v - 0.5) * 2 * 40);
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  root.SceneAssets = {
    UI_FONT, TAMIL_FONT, SHOP_SIGNS, FACADE_PPM,
    makeCanvas, hexToRgb, rgb, mix, shade,
    buildTreeSprites, buildCloudSprites, buildFacade, buildWall, buildSign, buildNoise,
  };
})(window);
