/* Design study: six ways of drawing the sightings that are not clustered discs.
   Every treatment reads the real export, so what is on screen is the actual
   distribution rather than a sketch of one. */
'use strict';

const SP = 0, LAT = 1, LON = 2, DATE = 3, SRC = 4, CNT = 5, SITE = 6,
      OBS = 7, FLAG = 8;
const F_NOTABLE = 1;

/* Britain and Ireland. The export covers Europe; the current map opens here,
   and a design study wants one coastline you can read at a glance. */
const VIEW = { west: -11.4, east: 2.6, south: 49.5, north: 61.2 };
const W = 920;                       // logical px; the backing store is 2x

const css = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
const RAMP = () => ['--d0','--d1','--d2','--d3','--d4','--d5','--d6','--d7','--d8'].map(css);

/* ----------------------------------------------------------- projection */

const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const MY0 = merc(VIEW.south), MY1 = merc(VIEW.north);
const H = Math.round(W * (MY1 - MY0) / ((VIEW.east - VIEW.west) * Math.PI / 180));
const px = (lon) => ((lon - VIEW.west) / (VIEW.east - VIEW.west)) * W;
const py = (lat) => H - ((merc(lat) - MY0) / (MY1 - MY0)) * H;
const inView = (lat, lon) => lon >= VIEW.west && lon <= VIEW.east
  && lat >= VIEW.south && lat <= VIEW.north;

/* --------------------------------------------------------------- canvas */

function makeCanvas(host) {
  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  c.style.aspectRatio = `${W} / ${H}`;
  host.appendChild(c);
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  return ctx;
}

/* The export spans Europe; most of its rings are nowhere near this canvas. */
const nearView = (r) => r.some(([lon, lat]) =>
  lon > VIEW.west - 4 && lon < VIEW.east + 4
  && lat > VIEW.south - 4 && lat < VIEW.north + 4);

function landPath(geo) {
  const path = new Path2D();
  for (const r of geo.land) {
    if (!nearView(r)) continue;
    r.forEach(([lon, lat], i) => {
      const x = px(lon), y = py(lat);
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    });
    path.closePath();
  }
  return path;
}

function drawBase(ctx, geo, opts = {}) {
  const landFill = opts.land || css('--land');
  const coast = opts.coast || css('--coast');
  ctx.fillStyle = opts.sea || css('--sea');
  ctx.fillRect(0, 0, W, H);

  const ring = (r) => {
    ctx.beginPath();
    for (let i = 0; i < r.length; i++) {
      const [lon, lat] = r[i];
      const x = px(lon), y = py(lat);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  ctx.fillStyle = landFill;
  for (const r of geo.land) if (nearView(r)) { ring(r); ctx.fill(); }
  ctx.fillStyle = opts.sea || css('--sea');
  for (const r of geo.lakes) if (nearView(r)) { ring(r); ctx.fill(); }

  if (opts.coastline !== false) {
    ctx.strokeStyle = coast; ctx.lineWidth = opts.coastWidth || 0.7;
    ctx.lineJoin = 'round';
    for (const r of geo.land) if (nearView(r)) { ring(r); ctx.stroke(); }
  }
}

/* ------------------------------------------------------------- helpers */

/* Quantile thresholds, so the ramp spends its steps where the data is rather
   than on the one hotspot that would flatten everything else to the floor. */
function quantiles(values, n) {
  const v = values.slice().sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < n; i++) out.push(v[Math.floor((i / n) * (v.length - 1))]);
  return out;
}
const bucket = (x, thresholds) => {
  let i = 0;
  while (i < thresholds.length && x > thresholds[i]) i++;
  return i;
};

/* Separable box blur, run three times - a close enough Gaussian and fast
   enough to stay interactive on a grid this size. */
function blur(grid, gw, gh, radius, passes = 3) {
  let src = grid, dst = new Float32Array(gw * gh);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < gh; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += src[y * gw + Math.min(gw - 1, Math.max(0, x))];
      for (let x = 0; x < gw; x++) {
        dst[y * gw + x] = sum / (radius * 2 + 1);
        const out = Math.min(gw - 1, Math.max(0, x - radius));
        const inn = Math.min(gw - 1, Math.max(0, x + radius + 1));
        sum += src[y * gw + inn] - src[y * gw + out];
      }
    }
    [src, dst] = [dst, src];
    for (let x = 0; x < gw; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += src[Math.min(gh - 1, Math.max(0, y)) * gw + x];
      for (let y = 0; y < gh; y++) {
        dst[y * gw + x] = sum / (radius * 2 + 1);
        const out = Math.min(gh - 1, Math.max(0, y - radius));
        const inn = Math.min(gh - 1, Math.max(0, y + radius + 1));
        sum += src[inn * gw + x] - src[out * gw + x];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/* ===================================================== 1. hex density field */

function hexField(ctx, geo, recs) {
  drawBase(ctx, geo, { coastWidth: 0.6 });

  const r = 9.2;                       // hex circumradius, logical px
  const sq3 = Math.sqrt(3);
  const bins = new Map();
  for (const rec of recs) {
    const x = px(rec[LON]), y = py(rec[LAT]);
    // pixel -> axial, then cube-round to the nearest hex centre
    const q = (sq3 / 3 * x - y / 3) / r, rr = (2 / 3 * y) / r;
    let cx = q, cz = rr, cy = -cx - cz;
    let [rx, ry, rz] = [Math.round(cx), Math.round(cy), Math.round(cz)];
    const [dx, dy, dz] = [Math.abs(rx - cx), Math.abs(ry - cy), Math.abs(rz - cz)];
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
    const key = rx + ',' + rz;
    bins.set(key, (bins.get(key) || 0) + 1);
  }

  const ramp = RAMP();
  const th = quantiles([...bins.values()], ramp.length);

  for (const [key, n] of bins) {
    const [q, rr] = key.split(',').map(Number);
    const cx = r * sq3 * (q + rr / 2), cy = r * 1.5 * rr;
    // A 1.5px gap between neighbours: the spacer that keeps adjacent fills
    // from reading as one blob.
    const rad = r - 1.5;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = ramp[bucket(n, th)];
    ctx.fill();
  }
  return { bins: bins.size, max: Math.max(...bins.values()) };
}

/* ================================================= 2. contour relief (KDE) */

function contourRelief(ctx, geo, recs) {
  const cell = 3;
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const grid = new Float32Array(gw * gh);
  for (const rec of recs) {
    const gx = Math.floor(px(rec[LON]) / cell), gy = Math.floor(py(rec[LAT]) / cell);
    if (gx >= 0 && gx < gw && gy >= 0 && gy < gh) grid[gy * gw + gx] += 1;
  }
  const f = blur(grid, gw, gh, 2, 3);

  const ramp = RAMP();
  // A floor, not an epsilon: a Gaussian leaves a vanishing halo everywhere it
  // touches, and counting that halo as "live" drags every quantile break down
  // until the top band swallows the whole of England.
  const FLOOR = 0.035;
  const live = [];
  for (let i = 0; i < f.length; i++) if (f[i] > FLOOR) live.push(f[i]);
  const th = quantiles(live, ramp.length);

  // Sea, land, then a light coastline the bands will sit over at less than
  // full opacity - so the shape of the country survives underneath them.
  drawBase(ctx, geo, { coastline: false });
  ctx.strokeStyle = 'rgba(240, 239, 236, .30)';
  ctx.lineWidth = 0.8;
  drawCoastOnly(ctx, geo);

  // Quantised bands rather than a smooth wash: crisp edges are what make it
  // read as relief instead of a blur.
  const img = ctx.createImageData(gw, gh);
  const rgb = ramp.map(hexToRgb);
  for (let i = 0; i < f.length; i++) {
    const b = f[i] <= FLOOR ? -1 : bucket(f[i], th);
    if (b < 0) continue;
    const [R, G, B] = rgb[b];
    const t = b / (ramp.length - 1);
    img.data[i * 4] = R; img.data[i * 4 + 1] = G; img.data[i * 4 + 2] = B;
    // Capped below opaque, so the coastline drawn underneath still reads
    // through even the brightest band.
    img.data[i * 4 + 3] = Math.round(255 * (0.18 + 0.72 * t));
  }
  const tmp = document.createElement('canvas');
  tmp.width = gw; tmp.height = gh;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, W, H);
  ctx.restore();

  // Hairline isolines by marching squares - segments, not stitched paths,
  // which is enough at this line weight.
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = 'rgba(255, 236, 203, .34)';
  ctx.beginPath();
  for (const t of th) {
    for (let y = 0; y < gh - 1; y++) {
      for (let x = 0; x < gw - 1; x++) {
        const a = f[y * gw + x], b = f[y * gw + x + 1];
        const c = f[(y + 1) * gw + x + 1], d = f[(y + 1) * gw + x];
        const idx = (a > t ? 8 : 0) | (b > t ? 4 : 0) | (c > t ? 2 : 0) | (d > t ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const X = x * cell, Y = y * cell;
        const top = [X + cell * ((t - a) / (b - a || 1)), Y];
        const right = [X + cell, Y + cell * ((t - b) / (c - b || 1))];
        const bot = [X + cell * ((t - d) / (c - d || 1)), Y + cell];
        const left = [X, Y + cell * ((t - a) / (d - a || 1))];
        const seg = {
          1: [left, bot], 2: [bot, right], 3: [left, right], 4: [top, right],
          5: [top, left], 6: [top, bot], 7: [top, left], 8: [top, left],
          9: [top, bot], 10: [top, right], 11: [top, right], 12: [left, right],
          13: [bot, right], 14: [left, bot],
        }[idx];
        if (!seg) continue;
        ctx.moveTo(seg[0][0], seg[0][1]); ctx.lineTo(seg[1][0], seg[1][1]);
      }
    }
  }
  ctx.stroke();

  // And again on top in a dark warm line, which is what reads where the band
  // beneath it is near-white. Light under, dark over: between them the coast
  // is legible at both ends of the ramp.
  ctx.strokeStyle = 'rgba(42, 23, 1, .50)';
  ctx.lineWidth = 0.8;
  drawCoastOnly(ctx, geo);
}

function drawCoastOnly(ctx, geo) {
  ctx.lineJoin = 'round';
  for (const r of geo.land) {
    if (!nearView(r)) continue;
    ctx.beginPath();
    r.forEach(([lon, lat], i) => {
      const x = px(lon), y = py(lat);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath(); ctx.stroke();
  }
}

/* ================================================= 3. ridgeline ("the swell") */

function ridgeline(ctx, geo, recs) {
  ctx.fillStyle = css('--sea');
  ctx.fillRect(0, 0, W, H);
  // The coastline stays, dimmed, underneath: without it the ridges are a
  // handsome abstraction of nowhere in particular.
  ctx.strokeStyle = 'rgba(240, 239, 236, .13)';
  ctx.lineWidth = 0.7;
  drawCoastOnly(ctx, geo);

  const ROWS = 64, COLS = 260;
  const rows = Array.from({ length: ROWS }, () => new Float32Array(COLS));
  for (const rec of recs) {
    const x = px(rec[LON]), y = py(rec[LAT]);
    const r = Math.floor((y / H) * ROWS), c = Math.floor((x / W) * COLS);
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) rows[r][c] += 1;
  }
  // Smooth along each ridge so it reads as a profile, not a comb.
  const smooth = (a, k) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) {
      let s = 0, n = 0;
      for (let j = -k; j <= k; j++) { const m = i + j; if (m >= 0 && m < a.length) { s += a[m]; n++; } }
      out[i] = s / n;
    }
    return out;
  };
  const prof = rows.map((r) => smooth(r, 4));
  let max = 0;
  for (const p of prof) for (const v of p) if (v > max) max = v;

  const rowH = H / ROWS;
  const amp = rowH * 5.2;              // ridges overlap, but not into a thicket
  const ramp = RAMP();

  // Back to front, so a near ridge occludes the one behind it.
  for (let r = 0; r < ROWS; r++) {
    const base = (r + 1) * rowH;
    const p = prof[r];
    let peak = 0;
    for (const v of p) if (v > peak) peak = v;
    if (peak <= 0) continue;

    /* Only the stretches that actually hold records. Running the baseline the
       full width drew a flat rule from the Atlantic to the North Sea on every
       band, and seventy of those read as a grid rather than as terrain. */
    /* Split on every empty bin and a ridge becomes a row of dashes - the
       Pennines alone put a dozen holes in a band. So the occupied bins are
       closed over short gaps first (dilate, then erode: a gap narrower than
       the brush disappears, a real one survives), and dashes too short to be
       a coastline are dropped. */
    const EPS = max * 0.0012;
    const BRIDGE = 9;
    let on = Array.from({ length: COLS }, (_, c) => p[c] > EPS);
    const grow = (src, k, want) => src.map((_, c) => {
      for (let j = -k; j <= k; j++) {
        const m = c + j;
        const v = m < 0 || m >= COLS ? !want : src[m];
        if (v === want) return want;
      }
      return !want;
    });
    on = grow(on, BRIDGE, true);        // dilate: close the gaps
    on = grow(on, BRIDGE, false);       // erode: give back the edges

    const runs = [];
    let start = -1;
    for (let c = 0; c < COLS; c++) {
      if (on[c] && start < 0) start = c;
      if ((!on[c] || c === COLS - 1) && start >= 0) {
        const end = on[c] ? c : c - 1;
        if (end - start >= 4) runs.push([start, end]);
        start = -1;
      }
    }
    const t = Math.sqrt(peak / max);
    const stroke = ramp[Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1)))];
    const X = (c) => (c / (COLS - 1)) * W;
    const Y = (c) => base - Math.sqrt(p[c] / max) * amp;

    for (const [a, b] of runs) {
      ctx.beginPath();
      ctx.moveTo(X(a), base);
      for (let c = a; c <= b; c++) ctx.lineTo(X(c), Y(c));
      ctx.lineTo(X(b), base);
      ctx.closePath();
      // Opaque fill is what does the occluding; it is the surface, not a colour.
      ctx.fillStyle = 'rgba(15, 19, 23, .94)';
      ctx.fill();

      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      for (let c = a; c <= b; c++) {
        if (c === a) ctx.moveTo(X(c), Y(c)); else ctx.lineTo(X(c), Y(c));
      }
      ctx.stroke();
    }
  }
}

/* ============================================ 4. dot field by bird group */

const GROUPS = [
  { key: 'waders', label: 'Waders', slot: '--cat-1', genera: new Set([
    'charadrius','thinornis','eudromias','pluvialis','vanellus','calidris','tringa',
    'actitis','arenaria','numenius','limosa','gallinago','lymnocryptes','scolopax',
    'haematopus','recurvirostra','burhinus','himantopus','phalaropus']) },
  { key: 'wildfowl', label: 'Wildfowl', slot: '--cat-2', genera: new Set([
    'anas','mareca','spatula','aythya','netta','branta','anser','cygnus','tadorna',
    'aix','bucephala','mergus','mergellus','somateria','melanitta','clangula',
    'alopochen','histrionicus']) },
  { key: 'raptors', label: 'Birds of prey', slot: '--cat-3', genera: new Set([
    'accipiter','astur','buteo','milvus','circus','pernis','pandion','falco',
    'aquila','haliaeetus','hieraaetus','clanga','elanus']) },
];

function classify(data) {
  const cls = new Int8Array(data.species.length).fill(-1);
  data.species.forEach((s, i) => {
    const genus = (s[1] || '').toLowerCase().split(' ')[0];
    GROUPS.forEach((g, gi) => { if (g.genera.has(genus)) cls[i] = gi; });
  });
  return cls;
}

function dotField(ctx, geo, recs, cls) {
  drawBase(ctx, geo, { sea: '#0b0e11', land: '#161a18', coastWidth: 0.6 });

  /* Everything else first and faint: the backdrop the three groups are read
     against, not a fourth series competing with them. Deliberately NOT drawn
     additively - 230,000 grey marks summed go white, and the white then
     outshouts the three hues the picture is actually about. */
  ctx.fillStyle = 'rgba(126, 124, 118, .22)';
  for (const rec of recs) {
    if (cls[rec[SP]] !== -1) continue;
    ctx.fillRect(px(rec[LON]) - 0.5, py(rec[LAT]) - 0.5, 1, 1);
  }

  /* The groups are not blended additively either. Blue plus orange plus aqua
     sums to white, and on an estuary where waders and wildfowl pile up that is
     exactly what happened - the busiest, most interesting ground went blank.
     Painted normally, overlap keeps a hue; concentration still reads, because
     the marks are denser, not brighter.
     Commonest first, so the scarcest group is never buried. */
  const counts = GROUPS.map((g, gi) => recs.filter((r) => cls[r[SP]] === gi).length);
  const order = counts.map((n, gi) => ({ gi, n })).sort((a, b) => b.n - a.n);
  for (const { gi } of order) {
    const [R, G, B] = hexToRgb(css(GROUPS[gi].slot));
    ctx.fillStyle = `rgba(${R}, ${G}, ${B}, .78)`;
    for (const rec of recs) {
      if (cls[rec[SP]] !== gi) continue;
      const x = px(rec[LON]), y = py(rec[LAT]);
      ctx.beginPath(); ctx.arc(x, y, 1.7, 0, Math.PI * 2); ctx.fill();
    }
  }
  return { counts, other: recs.length - counts.reduce((a, b) => a + b, 0) };
}

/* ========================================== 5. the recording network (cells) */

function siteCells(ctx, geo, recs, data) {
  // Sites have no coordinates in the export, so each one is placed at the
  // centroid of its own records.
  const agg = new Map();
  for (const rec of recs) {
    const id = rec[SITE];
    let s = agg.get(id);
    if (!s) agg.set(id, (s = { n: 0, lat: 0, lon: 0 }));
    s.n++; s.lat += rec[LAT]; s.lon += rec[LON];
  }
  const sites = [...agg.entries()]
    .map(([id, s]) => ({ id, n: s.n, x: px(s.lon / s.n), y: py(s.lat / s.n) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 900);                   // the long tail is one-record places

  const ramp = RAMP();
  const th = quantiles(sites.map((s) => s.n), ramp.length);
  const rgb = ramp.map(hexToRgb);

  drawBase(ctx, geo, { land: '#141816', coastline: false });

  // A rasterised nearest-site map: a Voronoi without the library, and at this
  // cell size the stepping is invisible once it is drawn.
  const cell = 3;
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const img = ctx.createImageData(gw, gh);
  const owner = new Int32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y = gy * cell + cell / 2;
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * cell + cell / 2;
      let best = -1, bd = Infinity;
      for (let i = 0; i < sites.length; i++) {
        const dx = sites[i].x - x, dy = sites[i].y - y;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      owner[gy * gw + gx] = best;
      const b = bucket(sites[best].n, th);
      const [R, G, B] = rgb[b];
      const i4 = (gy * gw + gx) * 4;
      // Distant cells fade out: a cell 200px from its site is an artefact of
      // the tessellation, not a place anyone birds.
      const fade = Math.max(0, 1 - Math.sqrt(bd) / 72);
      img.data[i4] = R; img.data[i4 + 1] = G; img.data[i4 + 2] = B;
      img.data[i4 + 3] = Math.round(235 * fade * (0.33 + 0.67 * (b / (ramp.length - 1))));
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = gw; tmp.height = gh;
  tmp.getContext('2d').putImageData(img, 0, 0);

  /* Clipped to land. Unclipped, the cells belonging to coastal sites ran out
     into the Atlantic as enormous wedges - nearest-site is defined out there,
     but nobody birds it, and the wedges buried the country they were supposed
     to describe. */
  ctx.save();
  ctx.clip(landPath(geo));
  ctx.drawImage(tmp, 0, 0, W, H);

  // Cell edges: wherever two neighbouring cells have different owners.
  ctx.strokeStyle = 'rgba(10, 12, 14, .5)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let gy = 0; gy < gh - 1; gy++) {
    for (let gx = 0; gx < gw - 1; gx++) {
      const o = owner[gy * gw + gx];
      if (owner[gy * gw + gx + 1] !== o) {
        ctx.moveTo((gx + 1) * cell, gy * cell); ctx.lineTo((gx + 1) * cell, (gy + 1) * cell);
      }
      if (owner[(gy + 1) * gw + gx] !== o) {
        ctx.moveTo(gx * cell, (gy + 1) * cell); ctx.lineTo((gx + 1) * cell, (gy + 1) * cell);
      }
    }
  }
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = 'rgba(240, 239, 236, .34)';
  ctx.lineWidth = 0.8;
  drawCoastOnly(ctx, geo);
  return { sites: sites.length, total: agg.size };
}

/* ================================================ 6. the rarities, lit up */

function rarities(ctx, geo, recs, data) {
  drawBase(ctx, geo, { sea: '#0b0e11', land: '#151917', coastWidth: 0.6 });

  // The ordinary 260,000 become the texture the rare ones are read against -
  // present, deliberately recessive, no hue of their own.
  ctx.fillStyle = 'rgba(137, 135, 129, .26)';
  for (const rec of recs) {
    if (rec[FLAG] & F_NOTABLE) continue;
    ctx.fillRect(px(rec[LON]) - 0.5, py(rec[LAT]) - 0.5, 1, 1);
  }

  const notable = recs.filter((r) => r[FLAG] & F_NOTABLE);
  const accent = css('--accent');
  const [R, G, B] = hexToRgb(accent);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const rec of notable) {
    const x = px(rec[LON]), y = py(rec[LAT]);
    const g = ctx.createRadialGradient(x, y, 0, x, y, 13);
    g.addColorStop(0, `rgba(${R}, ${G}, ${B}, .22)`);
    g.addColorStop(1, `rgba(${R}, ${G}, ${B}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  for (const rec of notable) {
    const x = px(rec[LON]), y = py(rec[LAT]);
    ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = accent; ctx.fill();
    // The 2px surface ring that keeps overlapping marks countable.
    ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(11, 14, 17, .85)'; ctx.stroke();
  }

  // Direct labels for the scarcest species on screen: a legend cannot name
  // 400 species, and naming the rarest is the whole point of the layer.
  const bySp = new Map();
  for (const rec of notable) {
    const k = rec[SP];
    if (!bySp.has(k)) bySp.set(k, []);
    bySp.get(k).push(rec);
  }
  const picks = [...bySp.entries()]
    .filter(([, rs]) => rs.length <= 3)
    .sort((a, b) => a[1].length - b[1].length)
    .slice(0, 14)
    .map(([sp, rs]) => ({ name: data.species[sp][0], rec: rs[0] }));

  ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  const placed = [];
  for (const p of picks) {
    const x = px(p.rec[LON]), y = py(p.rec[LAT]);
    if (x < 0 || x > W || y < 0 || y > H) continue;
    const w = ctx.measureText(p.name).width;
    let lx = x + 9, ly = y;
    const hits = (bx, by) => placed.some((q) =>
      Math.abs(q.x - bx) < (q.w + w) / 2 + 10 && Math.abs(q.y - by) < 18);
    if (lx + w > W - 8 || hits(lx + w / 2, ly)) { lx = x - 9 - w; }
    if (hits(lx + w / 2, ly)) { ly = y - 16; lx = x + 9; }
    if (lx < 4 || lx + w > W - 5 || hits(lx + w / 2, ly)) continue;
    placed.push({ x: lx + w / 2, y: ly, w });

    ctx.strokeStyle = 'rgba(169, 227, 75, .45)';
    ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx < x ? lx + w + 3 : lx - 3, ly); ctx.stroke();
    ctx.fillStyle = 'rgba(11, 14, 17, .78)';
    ctx.fillRect(lx - 4, ly - 9, w + 8, 18);
    ctx.fillStyle = css('--text-primary');
    ctx.fillText(p.name, lx, ly);
  }
  return { notable: notable.length, species: bySp.size };
}

/* ------------------------------------------------------------- the gallery */

const rampLegend = (lo, hi, note) => `
  <div class="legend">
    <div class="legend-title">Records per cell</div>
    <div class="ramp">${RAMP().map((c) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="ramp-ends"><span>${lo}</span><span>${hi}</span></div>
  </div>
  ${note ? `<p class="note">${note}</p>` : ''}`;

const keyLegend = (items, title, note) => `
  <div class="legend">
    <div class="legend-title">${title}</div>
    <div class="keys">${items.map((i) => `
      <span class="key"><span class="sw ${i.round ? 'ring' : ''}" style="background:${i.color}"></span>${i.label}</span>`).join('')}
    </div>
  </div>
  ${note ? `<p class="note">${note}</p>` : ''}`;

const MOCKS = [
  {
    key: 'hex',
    title: 'Equal-area hex field',
    blurb: `Every hexagon is the same size on the ground, so colour alone carries
      the count — and the count no longer changes when you pan. Shade is stepped
      by quantile, so the ramp spends its range on the gradient from quiet to
      busy rather than on the single hotspot that would flatten everything else.`,
    render: (ctx, g, r) => hexField(ctx, g, r),
    legend: (s) => rampLegend('1', s.max.toLocaleString('en-GB'),
      `${s.bins.toLocaleString('en-GB')} occupied cells. Quantile steps, 1.5px gap
       between neighbours so adjacent cells stay countable.`),
  },
  {
    key: 'relief',
    title: 'Density as relief',
    blurb: `The same magnitude read as terrain: a kernel density surface cut into
      bands at the same quantile breaks, with a hairline isoline on each break.
      Contours are the oldest way of drawing a continuous field onto a map, and
      the eye reads the steep edge — where birding effort drops off a cliff —
      far faster than it reads a stack of discs.`,
    render: (ctx, g, r) => contourRelief(ctx, g, r),
    legend: () => rampLegend('sparse', 'dense',
      `Gaussian kernel, sigma about 7px. Isolines sit on the band edges, so the
       spacing between them is the gradient.`),
  },
  {
    key: 'ridge',
    title: 'The swell',
    blurb: `Britain sliced into 64 bands of latitude; each ridge is the number of
      records running west to east along that band, and near ridges occlude far
      ones. It is the least conventional of the six and the most immediately
      legible: the Wash, the Severn and the Moray Firth announce themselves as
      peaks, and the empty middle of the country is a flat line you cannot miss.`,
    render: (ctx, g, r) => ridgeline(ctx, g, r),
    legend: () => rampLegend('quiet band', 'busy band',
      `Ridge height is √(count) so the long tail stays visible; the stroke takes
       its step from the band's own peak. Coastline dimmed underneath.`),
  },
  {
    key: 'dots',
    title: 'One mark per bird',
    blurb: `No aggregation at all — every one of the records is drawn, so the
      texture of the thing is the data rather than a summary of it. Three groups
      of birds carry a hue each and the other 400-odd species recede to grey.
      That is what makes it worth reading: the blue of the waders picks out the
      coast and the estuaries while the inland scatter is somebody else's.`,
    render: (ctx, g, r, cls) => dotField(ctx, g, r, cls),
    legend: (s) => keyLegend([
      ...GROUPS.map((g, i) => ({
        label: `${g.label} (${(s.counts[i] || 0).toLocaleString('en-GB')})`,
        color: css(g.slot), round: true })),
      { label: `All other species (${(s.other || 0).toLocaleString('en-GB')})`,
        color: css('--cat-other'), round: true },
    ], 'Bird group', `Three hues is the cap for marks that can land next to any
       other mark; a fourth would fail the colour-separation floor. Scarcest group
       drawn last so it is never buried — which is why the counts are here, in
       case the topmost hue looks commoner than it is.`),
  },
  {
    key: 'cells',
    title: 'The recording network',
    blurb: `This one is honest about what the data actually measures. Each cell is
      the ground nearest a named recording site, shaded by how much that site
      reports — so it maps the observers, not the birds. Put it beside any of the
      others and the sampling bias stops being a footnote: the map is bright
      where people go.`,
    render: (ctx, g, r, cls, data) => siteCells(ctx, g, r, data),
    legend: (s) => rampLegend('few records', 'many',
      `Top ${s.sites.toLocaleString('en-GB')} sites of ${s.total.toLocaleString('en-GB')};
       cells fade with distance from their site, because far ground is an artefact
       of the tessellation rather than a place anyone birds.`),
  },
  {
    key: 'rare',
    title: 'The rarities, lit up',
    blurb: `Emphasis instead of encoding. The ordinary ninety-eight thousand
      become a grey texture — still there, deliberately recessive — and only the
      records flagged notable are lit, with a few named on the map itself. This is
      the view that answers the question people actually open the map with:
      what is about, and is it near me?`,
    render: (ctx, g, r, cls, data) => rarities(ctx, g, r, data),
    legend: (s) => keyLegend([
      { label: `Notable record (${s.notable.toLocaleString('en-GB')})`, color: css('--accent'), round: true },
      { label: 'Everything else', color: css('--cat-other'), round: true },
    ], 'Emphasis', `${s.species} notable species on screen. The 14 named are the
       ones with the fewest notable records here — not the rarest birds in
       Britain, but the least-reported of what is currently flagged.`),
  },
];

async function boot() {
  const gallery = document.getElementById('gallery');
  gallery.innerHTML = '<p class="loading">Reading the export…</p>';

  const [data, geo] = await Promise.all([
    fetch('../data/sightings.json').then((r) => r.json()),
    fetch('../data/geo.json').then((r) => r.json()),
  ]);

  const recs = data.recs.filter((r) => inView(r[LAT], r[LON]));
  const cls = classify(data);
  const nEl = document.getElementById('n-recs');
  if (nEl) nEl.textContent = recs.length.toLocaleString('en-GB');

  const only = new URLSearchParams(location.search).get('m');
  const list = only ? MOCKS.filter((m) => m.key === only) : MOCKS;
  if (only) document.body.classList.add('solo');

  gallery.innerHTML = '';
  list.forEach((m, i) => {
    const n = MOCKS.indexOf(m) + 1;
    const sec = document.createElement('section');
    sec.className = 'mock';
    sec.id = m.key;
    sec.innerHTML = `
      <div class="mock-head">
        <div class="no">Mockup ${n} of ${MOCKS.length}</div>
        <h2>${m.title}</h2>
        <p>${m.blurb}</p>
      </div>
      <div class="mock-figure"></div>
      <div class="mock-foot"></div>`;
    gallery.appendChild(sec);

    const ctx = makeCanvas(sec.querySelector('.mock-figure'));
    const stats = m.render(ctx, geo, recs, cls, data) || {};
    sec.querySelector('.mock-foot').innerHTML = m.legend(stats);
  });

  document.body.dataset.ready = '1';
}

boot();
