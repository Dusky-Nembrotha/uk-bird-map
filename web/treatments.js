/* Alternative ways of drawing the records on the tile map.

   The clustered discs put a number on screen that belongs to the clustering
   algorithm rather than to the birds - pan the map and it changes - and the
   discs cover the distribution they exist to describe. These six treatments
   are the alternatives, as a Leaflet layer you can switch to from Map options.

   Everything is drawn in container pixels onto one canvas pinned to the
   overlay pane. During a drag the pane carries the canvas with it, so the
   marks stay on their ground; the pixels are only recomputed when the map
   settles, and on any zoom. */
'use strict';

const TR_SP = 0, TR_LAT = 1, TR_LON = 2, TR_FLAG = 8;

/* One hue, lightness strictly rising, generated in OKLCH rather than picked
   by eye. The dark end is meant to recede into a dark basemap. */
const TR_RAMP = ['#351e01', '#5a2d00', '#803d00', '#a35100', '#c36900',
                 '#de8700', '#f2a74e', '#ffc98d', '#ffeccb'];

/* The three dark-mode categorical slots that clear the all-pairs separation
   gates. Three is the cap for marks that can land beside any other mark. */
const TR_CAT = ['#3987e5', '#d95926', '#199e70'];
const TR_OTHER = '#6b6a65';

const TR_GROUPS = [
  { key: 'waders', label: 'Waders', genera: new Set([
    'charadrius','thinornis','eudromias','pluvialis','vanellus','calidris','tringa',
    'actitis','arenaria','numenius','limosa','gallinago','lymnocryptes','scolopax',
    'haematopus','recurvirostra','burhinus','himantopus','phalaropus']) },
  { key: 'wildfowl', label: 'Wildfowl', genera: new Set([
    'anas','mareca','spatula','aythya','netta','branta','anser','cygnus','tadorna',
    'aix','bucephala','mergus','mergellus','somateria','melanitta','clangula',
    'alopochen','histrionicus']) },
  { key: 'raptors', label: 'Birds of prey', genera: new Set([
    'accipiter','astur','buteo','milvus','circus','pernis','pandion','falco',
    'aquila','haliaeetus','hieraaetus','clanga','elanus']) },
];

const TREATMENTS = {
  hex:    { label: 'Hex density field', legend: 'ramp' },
  relief: { label: 'Density as relief', legend: 'ramp' },
  ridge:  { label: 'The swell (ridgelines)', legend: 'ramp' },
  dots:   { label: 'One mark per record', legend: 'groups' },
  cells:  { label: 'The recording network', legend: 'ramp' },
  rare:   { label: 'Rarities lit up', legend: 'rare' },
};

const trHexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function trQuantiles(values, n) {
  const v = Float64Array.from(values).sort();
  const out = [];
  for (let i = 1; i < n; i++) out.push(v[Math.floor((i / n) * (v.length - 1))]);
  return out;
}
function trBucket(x, th) {
  let i = 0;
  while (i < th.length && x > th[i]) i++;
  return i;
}

function trBlur(grid, gw, gh, radius, passes) {
  let src = grid, dst = new Float32Array(gw * gh);
  const cl = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < gh; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += src[y * gw + cl(x, gw - 1)];
      for (let x = 0; x < gw; x++) {
        dst[y * gw + x] = sum / (radius * 2 + 1);
        sum += src[y * gw + cl(x + radius + 1, gw - 1)] - src[y * gw + cl(x - radius, gw - 1)];
      }
    }
    [src, dst] = [dst, src];
    for (let x = 0; x < gw; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += src[cl(y, gh - 1) * gw + x];
      for (let y = 0; y < gh; y++) {
        dst[y * gw + x] = sum / (radius * 2 + 1);
        sum += src[cl(y + radius + 1, gh - 1) * gw + x] - src[cl(y - radius, gh - 1) * gw + x];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/* --------------------------------------------------------- the treatments */

function trHex(ctx, W, H, pts) {
  const r = 11, sq3 = Math.sqrt(3);
  const bins = new Map();
  for (let i = 0; i < pts.n; i++) {
    const x = pts.x[i], y = pts.y[i];
    const q = (sq3 / 3 * x - y / 3) / r, rr = (2 / 3 * y) / r;
    let cx = q, cz = rr, cy = -cx - cz;
    let [rx, ry, rz] = [Math.round(cx), Math.round(cy), Math.round(cz)];
    const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
    // A string key rather than a packed integer: axial coordinates go negative
    // either side of the origin, and unpacking that correctly is a bug waiting
    // to happen for no measurable gain.
    const key = rx + ',' + rz;
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  if (!bins.size) return {};
  const th = trQuantiles([...bins.values()], TR_RAMP.length);
  for (const [key, n] of bins) {
    const [q, rz] = key.split(',').map(Number);
    const cx = r * sq3 * (q + rz / 2), cy = r * 1.5 * rz;
    const rad = r - 1.5;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = TR_RAMP[trBucket(n, th)];
    ctx.globalAlpha = 0.88;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return { max: Math.max(...bins.values()) };
}

function trRelief(ctx, W, H, pts) {
  const cell = 4;
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < pts.n; i++) {
    const gx = (pts.x[i] / cell) | 0, gy = (pts.y[i] / cell) | 0;
    if (gx >= 0 && gx < gw && gy >= 0 && gy < gh) grid[gy * gw + gx] += 1;
  }
  const f = trBlur(grid, gw, gh, 2, 3);
  // A floor, not an epsilon: a Gaussian leaves a vanishing halo everywhere it
  // touches, and counting that as "live" drags every break down until the top
  // band swallows the map.
  const FLOOR = 0.035;
  const live = [];
  for (let i = 0; i < f.length; i++) if (f[i] > FLOOR) live.push(f[i]);
  if (!live.length) return {};
  const th = trQuantiles(live, TR_RAMP.length);
  const rgb = TR_RAMP.map(trHexRgb);

  const img = ctx.createImageData(gw, gh);
  for (let i = 0; i < f.length; i++) {
    if (f[i] <= FLOOR) continue;
    const b = trBucket(f[i], th), t = b / (TR_RAMP.length - 1);
    const [R, G, B] = rgb[b];
    img.data[i * 4] = R; img.data[i * 4 + 1] = G; img.data[i * 4 + 2] = B;
    img.data[i * 4 + 3] = Math.round(255 * (0.16 + 0.64 * t));
  }
  const tmp = document.createElement('canvas');
  tmp.width = gw; tmp.height = gh;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0, W, H);

  ctx.lineWidth = 0.7;
  ctx.strokeStyle = 'rgba(255, 236, 203, .30)';
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
  return {};
}

function trRidge(ctx, W, H, pts) {
  const ROWS = Math.max(24, Math.min(72, Math.round(H / 16)));
  const COLS = 220;
  const rows = Array.from({ length: ROWS }, () => new Float32Array(COLS));
  for (let i = 0; i < pts.n; i++) {
    const r = ((pts.y[i] / H) * ROWS) | 0, c = ((pts.x[i] / W) * COLS) | 0;
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) rows[r][c] += 1;
  }
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
  if (!max) return {};

  /* On the design study the ground was already dark, so a near-opaque ridge
     occluded the one behind it and the map stayed readable. Over satellite
     imagery the same fill read as a stack of black slabs. So the basemap is
     dimmed once, as a scrim, and the ridges go back to being solid: the
     geography stays visible underneath, recessive, which is where it belongs
     in this treatment. */
  ctx.fillStyle = 'rgba(8, 11, 14, .50)';
  ctx.fillRect(0, 0, W, H);

  const rowH = H / ROWS, amp = rowH * 4.4;
  for (let r = 0; r < ROWS; r++) {
    const base = (r + 1) * rowH, p = prof[r];
    let peak = 0;
    for (const v of p) if (v > peak) peak = v;
    if (peak <= 0) continue;

    /* Split on every empty bin and a ridge becomes a row of dashes, so the
       occupied bins are closed over short gaps first - dilate, then erode. */
    const EPS = max * 0.0012, BRIDGE = 8;
    let on = Array.from({ length: COLS }, (_, c) => p[c] > EPS);
    const grow = (src, k, want) => src.map((_, c) => {
      for (let j = -k; j <= k; j++) {
        const m = c + j;
        const v = m < 0 || m >= COLS ? !want : src[m];
        if (v === want) return want;
      }
      return !want;
    });
    on = grow(on, BRIDGE, true);
    on = grow(on, BRIDGE, false);

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
    const stroke = TR_RAMP[Math.min(TR_RAMP.length - 1, Math.round(t * (TR_RAMP.length - 1)))];
    const X = (c) => (c / (COLS - 1)) * W;
    const Y = (c) => base - Math.sqrt(p[c] / max) * amp;

    for (const [a, b] of runs) {
      ctx.beginPath();
      ctx.moveTo(X(a), base);
      for (let c = a; c <= b; c++) ctx.lineTo(X(c), Y(c));
      ctx.lineTo(X(b), base);
      ctx.closePath();
      // Opaque enough to occlude the ridge behind, sheer enough to keep the
      // basemap readable underneath - on a tile map the ground matters.
      /* Not a flat fill. A ridge needs to be opaque just under its own line,
         to hide the ridge behind it, but a solid body all the way down to the
         baseline reads as a black slab laid over the map - which is what it
         looked like over satellite imagery. So it is opaque at the crest and
         gone by the foot: the occlusion survives, the ground comes back. */
      const grad = ctx.createLinearGradient(0, base - amp, 0, base);
      grad.addColorStop(0, 'rgba(8, 11, 14, .92)');
      grad.addColorStop(0.55, 'rgba(8, 11, 14, .80)');
      grad.addColorStop(1, 'rgba(8, 11, 14, 0)');
      ctx.fillStyle = grad;
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
  return {};
}

function trDots(ctx, W, H, pts, data, cls) {
  const counts = [0, 0, 0];
  for (let i = 0; i < pts.n; i++) {
    const g = cls[data.recs[pts.i[i]][TR_SP]];
    if (g >= 0) counts[g]++;
  }
  /* Not drawn additively. Blue plus orange plus aqua sums to white, and on an
     estuary where waders and wildfowl pile up that is exactly where the map
     went blank. */
  ctx.fillStyle = 'rgba(230, 228, 220, .30)';
  for (let i = 0; i < pts.n; i++) {
    if (cls[data.recs[pts.i[i]][TR_SP]] >= 0) continue;
    ctx.fillRect(pts.x[i] - 0.6, pts.y[i] - 0.6, 1.2, 1.2);
  }
  const order = counts.map((n, gi) => ({ gi, n })).sort((a, b) => b.n - a.n);
  for (const { gi } of order) {          // commonest first, scarcest on top
    const [R, G, B] = trHexRgb(TR_CAT[gi]);
    ctx.fillStyle = `rgba(${R}, ${G}, ${B}, .85)`;
    for (let i = 0; i < pts.n; i++) {
      if (cls[data.recs[pts.i[i]][TR_SP]] !== gi) continue;
      ctx.beginPath(); ctx.arc(pts.x[i], pts.y[i], 2, 0, Math.PI * 2); ctx.fill();
    }
  }
  return { counts, other: pts.n - counts[0] - counts[1] - counts[2] };
}

function trCells(ctx, W, H, pts, data) {
  const agg = new Map();
  for (let i = 0; i < pts.n; i++) {
    const id = data.recs[pts.i[i]][6];
    let s = agg.get(id);
    if (!s) agg.set(id, (s = { n: 0, x: 0, y: 0 }));
    s.n++; s.x += pts.x[i]; s.y += pts.y[i];
  }
  const sites = [...agg.values()]
    .map((s) => ({ n: s.n, x: s.x / s.n, y: s.y / s.n }))
    .sort((a, b) => b.n - a.n).slice(0, 700);
  if (!sites.length) return {};
  const th = trQuantiles(sites.map((s) => s.n), TR_RAMP.length);
  const rgb = TR_RAMP.map(trHexRgb);

  const cell = 4;
  const REACH = 58;                    // container px a cell may claim
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const img = ctx.createImageData(gw, gh);
  const owner = new Int32Array(gw * gh).fill(-1);
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
      /* A hard reach as well as a fade. Nearest-site is defined all the way
         out into the Atlantic, and on the mockups that drew enormous wedges
         across the ocean; there is no coastline to clip to on a tile map, so
         the cell simply stops at the distance past which it means nothing. */
      const dist = Math.sqrt(bd);
      if (dist > REACH) { owner[gy * gw + gx] = -1; continue; }
      owner[gy * gw + gx] = best;
      const b = trBucket(sites[best].n, th);
      const [R, G, B] = rgb[b];
      const i4 = (gy * gw + gx) * 4;
      const fade = Math.max(0, 1 - (dist / REACH) ** 2);
      img.data[i4] = R; img.data[i4 + 1] = G; img.data[i4 + 2] = B;
      img.data[i4 + 3] = Math.round(225 * fade * (0.3 + 0.7 * (b / (TR_RAMP.length - 1))));
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = gw; tmp.height = gh;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0, W, H);

  ctx.strokeStyle = 'rgba(8, 10, 12, .5)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let gy = 0; gy < gh - 1; gy++) {
    for (let gx = 0; gx < gw - 1; gx++) {
      const o = owner[gy * gw + gx];
      if (o < 0) continue;             // nothing out here to draw a border for
      if (owner[gy * gw + gx + 1] >= 0 && owner[gy * gw + gx + 1] !== o) {
        ctx.moveTo((gx + 1) * cell, gy * cell); ctx.lineTo((gx + 1) * cell, (gy + 1) * cell);
      }
      if (owner[(gy + 1) * gw + gx] >= 0 && owner[(gy + 1) * gw + gx] !== o) {
        ctx.moveTo(gx * cell, (gy + 1) * cell); ctx.lineTo((gx + 1) * cell, (gy + 1) * cell);
      }
    }
  }
  ctx.stroke();
  return { sites: sites.length, total: agg.size };
}

function trRare(ctx, W, H, pts, data, accent) {
  const [R, G, B] = trHexRgb(accent);
  let n = 0;
  ctx.fillStyle = 'rgba(226, 224, 216, .26)';
  for (let i = 0; i < pts.n; i++) {
    if (data.recs[pts.i[i]][TR_FLAG] & 1) { n++; continue; }
    ctx.fillRect(pts.x[i] - 0.5, pts.y[i] - 0.5, 1, 1);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < pts.n; i++) {
    if (!(data.recs[pts.i[i]][TR_FLAG] & 1)) continue;
    const x = pts.x[i], y = pts.y[i];
    const g = ctx.createRadialGradient(x, y, 0, x, y, 15);
    g.addColorStop(0, `rgba(${R}, ${G}, ${B}, .22)`);
    g.addColorStop(1, `rgba(${R}, ${G}, ${B}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  for (let i = 0; i < pts.n; i++) {
    if (!(data.recs[pts.i[i]][TR_FLAG] & 1)) continue;
    ctx.beginPath(); ctx.arc(pts.x[i], pts.y[i], 3, 0, Math.PI * 2);
    ctx.fillStyle = accent; ctx.fill();
    ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(8, 11, 14, .8)'; ctx.stroke();
  }
  return { notable: n };
}

/* ------------------------------------------------------------- the layer */

/* One canvas pinned to the overlay pane. Leaflet translates that pane as you
   drag, which carries the drawing with it, so the pixels only have to be
   recomputed once the map settles - and on any zoom, where the scale changes
   under them. */
const TreatmentLayer = L.Layer.extend({
  initialize(opts) { L.setOptions(this, opts); },

  onAdd(map) {
    this._map = map;
    const c = this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide');
    c.style.position = 'absolute';
    c.style.pointerEvents = 'none';
    map.getPanes().overlayPane.appendChild(c);
    map.on('moveend zoomend resize', this._reset, this);
    this._reset();
  },

  onRemove(map) {
    map.off('moveend zoomend resize', this._reset, this);
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._canvas = null;
  },

  redraw() { this._reset(); },

  _reset() {
    if (!this._map || !this._canvas) return;
    const map = this._map, size = map.getSize();
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this._canvas.width !== Math.round(size.x * dpr)
        || this._canvas.height !== Math.round(size.y * dpr)) {
      this._canvas.width = Math.round(size.x * dpr);
      this._canvas.height = Math.round(size.y * dpr);
      this._canvas.style.width = size.x + 'px';
      this._canvas.style.height = size.y + 'px';
    }
    const ctx = this._canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    this.options.draw(ctx, size.x, size.y);
  },
});

/* Record positions in container pixels. Mercator is precomputed once per
   record at load, so a redraw is a multiply and a subtract rather than a
   projection call and an object allocation per point. */
function trProject(map, data, visible, nx, ny, W, H, margin) {
  const scale = 256 * Math.pow(2, map.getZoom());
  const o = map.getPixelOrigin(), tl = map.containerPointToLayerPoint([0, 0]);
  const offX = o.x + tl.x, offY = o.y + tl.y;
  const xs = new Float32Array(visible.length);
  const ys = new Float32Array(visible.length);
  const idx = new Int32Array(visible.length);
  let n = 0;
  for (let k = 0; k < visible.length; k++) {
    const i = visible[k];
    const x = nx[i] * scale - offX;
    if (x < -margin || x > W + margin) continue;
    const y = ny[i] * scale - offY;
    if (y < -margin || y > H + margin) continue;
    xs[n] = x; ys[n] = y; idx[n] = i; n++;
  }
  return { x: xs, y: ys, i: idx, n };
}

function trMercator(recs) {
  const nx = new Float64Array(recs.length);
  const ny = new Float64Array(recs.length);
  for (let i = 0; i < recs.length; i++) {
    const lat = recs[i][TR_LAT], lon = recs[i][TR_LON];
    nx[i] = (lon + 180) / 360;
    const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
    ny[i] = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  return { nx, ny };
}

/* Species index -> group slot, or -1. */
function trClassify(species) {
  const cls = new Int8Array(species.length).fill(-1);
  species.forEach((sp, i) => {
    const genus = (sp[1] || '').toLowerCase().split(' ')[0];
    TR_GROUPS.forEach((g, gi) => { if (g.genera.has(genus)) cls[i] = gi; });
  });
  return cls;
}
