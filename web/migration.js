/* One year of a species, as a field you can watch.

   Two layers, kept honestly apart, which is the whole discipline of the
   thing: the bright dots are reports somebody actually filed that week, and
   the streaks are a model - the direction the population's centre of mass
   must have shifted for one week's distribution to become the next. No bird
   was tracked. The caption on the frame says so, because a picture this
   persuasive has to.

   Built from web/data/migration.json (see src/migration.py). */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  d: null, geo: null,
  t: 0,                 // week, fractional
  playing: true,
  weeks: 0,
  w: 0, h: 0, dpr: 1,
  basemap: 'satellite',
};

/* The view. Britain, Iceland and the Norwegian Sea - the triangle this
   species actually uses - rather than the whole European export. */
/* Wide enough for both flyways. Pink-footed Geese are two populations, not
   one: Iceland and Greenland birds winter in Britain, while Svalbard birds
   winter in Denmark and the Netherlands and go north up the Norwegian coast.
   A frame cut at 5E showed the second lot piling up against the edge like
   moths on a window - 98% of the spring journeys ended east of 4E, and the
   map was hiding the clearest signal in the data. */
const VIEW = { west: -25, east: 22, south: 49, north: 70 };

/* How long a year takes on screen. Everything else derives from it: the week
   the clip is on, and - crucially - how far a particle moves per frame. The
   first version had those two as separate constants, so the streaks flew at
   fourteen times the speed the dates were advancing and came out as straight
   lines ruled across the whole frame. */
const YEAR_SECONDS = 40;
const daysPerFrame = () => (state.weeks * 7) / (YEAR_SECONDS * 60);

const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
let MY0, MY1, px, py, lonAt, latAt;

/* The map is vector all the way down - coastlines, reports, journeys and
   labels are all drawn from coordinates every frame - so zooming is a change
   of projection rather than a magnified bitmap. Nothing gets softer as you go
   in, and the labels and the title stay the size they were. */
const view = { k: 1, tx: 0, ty: 0 };

function setProjection(w, h) {
  MY0 = merc(VIEW.south); MY1 = merc(VIEW.north);
  const sx = w / (VIEW.east - VIEW.west);
  const sy = h / (MY1 - MY0) * (Math.PI / 180);
  /* Contain, not cover. Covering filled the frame handsomely and cut Iceland
     in half - and for this species the Iceland-to-Britain axis is the entire
     story. The bbox is shaped close to 4:5 instead, so in that frame there is
     little to letterbox, and the space a taller frame leaves is where the
     title and the legend already live. */
  const s = Math.min(sx, sy);
  const cw = s * (VIEW.east - VIEW.west);
  const ch = s * (MY1 - MY0) / (Math.PI / 180);
  const ox = (w - cw) / 2, oy = (h - ch) / 2;

  const bx = (lon) => ox + ((lon - VIEW.west) / (VIEW.east - VIEW.west)) * cw;
  const by = (lat) => oy + ch - ((merc(lat) - MY0) / (MY1 - MY0)) * ch;

  px = (lon) => bx(lon) * view.k + view.tx;
  py = (lat) => by(lat) * view.k + view.ty;
  lonAt = (x) => VIEW.west
    + ((((x - view.tx) / view.k) - ox) / cw) * (VIEW.east - VIEW.west);
  latAt = (y) => {
    const m = MY0 + ((oy + ch - (y - view.ty) / view.k) / ch) * (MY1 - MY0);
    return (Math.atan(Math.exp(m)) - Math.PI / 4) * 360 / Math.PI;
  };
}

/* Zoom about the pointer, so the thing under the cursor stays under it. */
function zoomAt(cx, cy, factor) {
  const k = Math.max(1, Math.min(40, view.k * factor));
  const f = k / view.k;
  view.tx = cx - (cx - view.tx) * f;
  view.ty = cy - (cy - view.ty) * f;
  view.k = k;
  clampPan();
}

/* At k = 1 the map is exactly framed, so there is nothing to pan to; further
   in, panning stops at the edge rather than letting the map drift off. */
function clampPan() {
  const over = (view.k - 1);
  const maxX = state.w * over, maxY = state.h * over;
  view.tx = Math.min(0, Math.max(-maxX, view.tx));
  view.ty = Math.min(0, Math.max(-maxY, view.ty));
  if (view.k === 1) { view.tx = 0; view.ty = 0; }
}

function wireZoom(canvas) {
  // Canvas pixels, not CSS pixels: the frame is drawn at its export size and
  // scaled down to fit the window, and a wheel event knows nothing about that.
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * state.w,
            (e.clientY - r.top) / r.height * state.h];
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = toCanvas(e);
    zoomAt(x, y, Math.exp(-e.deltaY * 0.0015));
    updateZoomUi();
    queueTiles();
  }, { passive: false });

  /* Pointer events cover mouse and touch together, so one finger pans and two
     pinch. The canvas carries touch-action: none, without which the browser
     takes the gesture for scrolling and the map never sees it - which is why
     this would not move on a phone. */
  const live = new Map();
  let drag = null, pinch = null;

  const centre = () => {
    const pts = [...live.values()];
    return [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
  };
  const spread = () => {
    const pts = [...live.values()];
    return Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1;
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    live.set(e.pointerId, toCanvas(e));
    if (live.size === 2) {
      drag = null;
      pinch = { d: spread(), k: view.k, c: centre(), tx: view.tx, ty: view.ty };
    } else if (live.size === 1) {
      const [x, y] = toCanvas(e);
      drag = { x, y, tx: view.tx, ty: view.ty };
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!live.has(e.pointerId)) return;
    live.set(e.pointerId, toCanvas(e));
    if (pinch && live.size === 2) {
      const f = spread() / pinch.d;
      view.k = Math.max(1, Math.min(40, pinch.k * f));
      const g = view.k / pinch.k;
      const [cx, cy] = pinch.c;
      view.tx = cx - (cx - pinch.tx) * g;
      view.ty = cy - (cy - pinch.ty) * g;
      clampPan();
      updateZoomUi();
    } else if (drag) {
      const [x, y] = toCanvas(e);
      view.tx = drag.tx + (x - drag.x);
      view.ty = drag.ty + (y - drag.y);
      clampPan();
    }
  });

  const end = (e) => {
    live.delete(e.pointerId);
    if (live.size < 2) pinch = null;
    if (live.size === 0) {
      drag = null;
      canvas.style.cursor = view.k > 1 ? 'grab' : 'default';
      queueTiles();
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = toCanvas(e);
    zoomAt(x, y, e.shiftKey ? 1 / 1.8 : 1.8);
    updateZoomUi();
    queueTiles();
  });
}

function updateZoomUi() {
  const z = $('zoom');
  if (z) z.textContent = view.k > 1.02 ? `${view.k.toFixed(1)}x` : '';
  const r = $('reset');
  if (r) r.hidden = view.k <= 1.02;
  $('c').style.cursor = view.k > 1 ? 'grab' : 'default';
}

/* ------------------------------------------------------------ the ground

   Real imagery, the same Esri satellite layer the animation view uses, drawn
   into an offscreen canvas for the current projection. Tiles arrive over the
   network, so while they are in flight the pixels we already have are shifted
   and scaled to the view we are now looking at - the ground tracks the
   gesture, slightly soft, and the sharp ones drop into the same place. */

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const BASEMAPS = {
  satellite: { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
               credit: 'Esri, Maxar, Earthstar Geographics', max: 17, dim: 0.42 },
  dark: { url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
          credit: 'Esri, HERE, Garmin, OpenStreetMap', max: 16, dim: 0.9 },
  none: null,
};

const tiles = { canvas: null, view: null, credit: '', dim: 1, token: 0 };
let tileTimer = null;

function queueTiles() {
  clearTimeout(tileTimer);
  // Only once the map has settled: a tile request per frame of a drag would
  // be rude to Esri and useless to us.
  tileTimer = setTimeout(loadTiles, 180);
}

async function loadTiles() {
  const spec = BASEMAPS[state.basemap];
  if (!spec) { tiles.canvas = null; return; }
  const mine = ++tiles.token;
  const W = state.w, H = state.h;

  // The zoom whose native pixel scale is closest to what we are drawing at.
  const degPerPx = (lonAt(W) - lonAt(0)) / W;
  const worldPx = 360 / degPerPx;
  const z = Math.max(2, Math.min(spec.max, Math.round(Math.log2(worldPx / 256))));
  const n = Math.pow(2, z);

  const lonOf = (x) => (x / n) * 360 - 180;
  const latOf = (y) => {
    const t = Math.PI - (2 * Math.PI * y) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  };
  const xOf = (lon) => ((lon + 180) / 360) * n;
  const yOf = (lat) => {
    const r = lat * Math.PI / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  };

  const west = lonAt(0), east = lonAt(W), north = latAt(0), south = latAt(H);
  const x0 = Math.max(0, Math.floor(xOf(west)) - 1);
  const x1 = Math.min(n - 1, Math.ceil(xOf(east)));
  const y0 = Math.max(0, Math.floor(yOf(north)) - 1);
  const y1 = Math.min(n - 1, Math.ceil(yOf(south)));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return;   // never hammer the server

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const left = px(lonOf(x)), right = px(lonOf(x + 1));
          const top = py(latOf(y)), bottom = py(latOf(y + 1));
          // +1px or hairline seams show between neighbouring tiles.
          g.drawImage(img, left, top, right - left + 1, bottom - top + 1);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = spec.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      }));
    }
  }
  await Promise.all(jobs);
  if (mine !== tiles.token) return;        // a later view already asked
  tiles.canvas = c;
  tiles.credit = spec.credit;
  tiles.dim = spec.dim;
  tiles.view = { k: view.k, tx: view.tx, ty: view.ty, w: W, h: H };
}

/* ------------------------------------------------------------ the field */

function sample(which, lat, lon, t) {
  const d = state.d, g = d.grid;
  const fr = (lat - g.lat0) / g.dlat, fc = (lon - g.lon0) / g.dlon;
  if (fr < 0 || fc < 0 || fr > g.rows - 1 || fc > g.cols - 1) return 0;
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(g.rows - 1, r0 + 1), c1 = Math.min(g.cols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;
  const i = Math.max(0, Math.min(d.times.length - 1, Math.floor(t)));
  const j = Math.min(d.times.length - 1, i + 1);
  const f = t - i;
  const at = (arr, r, c) => arr[r * g.cols + c];
  const mix = (a) => (at(a, r0, c0) * (1 - tc) + at(a, r0, c1) * tc) * (1 - tr)
                   + (at(a, r1, c0) * (1 - tc) + at(a, r1, c1) * tc) * tr;
  // Interpolated through the week, so a 53-frame year plays as motion rather
  // than as a slideshow of Mondays.
  return mix(d[which][i]) * (1 - f) + mix(d[which][j]) * f;
}

/* --------------------------------------------------------------- drawing */

function drawLand(ctx) {
  const near = (r) => r.some(([lon, lat]) =>
    lon > VIEW.west - 6 && lon < VIEW.east + 6
    && lat > VIEW.south - 6 && lat < VIEW.north + 6);
  const ring = (r) => {
    ctx.beginPath();
    r.forEach(([lon, lat], i) => {
      const x = px(lon), y = py(lat);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
  };

  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, state.w, state.h);

  if (tiles.canvas) {
    ctx.save();
    ctx.globalAlpha = tiles.dim;
    const tv = tiles.view;
    if (tv && (tv.k !== view.k || tv.tx !== view.tx || tv.ty !== view.ty)) {
      // Shift and scale what we have onto where we are now looking, so the
      // ground moves with the gesture instead of sticking and then jumping.
      const f = view.k / tv.k;
      ctx.translate(view.tx - tv.tx * f, view.ty - tv.ty * f);
      ctx.scale(f, f);
    }
    ctx.drawImage(tiles.canvas, 0, 0, state.w, state.h);
    ctx.restore();
    // Dimming the tiles alone leaves a pale sea with plenty of contrast of
    // its own; the wash pushes the whole ground back so the birds are the
    // brightest thing on the frame, which is the entire point of it.
    ctx.fillStyle = 'rgba(5, 8, 14, .34)';
    ctx.fillRect(0, 0, state.w, state.h);
  } else {
    // Until the imagery lands - or with it turned off - the drawn world.
    ctx.fillStyle = '#1b2026';
    for (const r of state.geo.land) if (near(r)) { ring(r); ctx.fill(); }
    ctx.fillStyle = '#0a0d11';
    for (const r of state.geo.lakes) if (near(r)) { ring(r); ctx.fill(); }
  }

  /* A coastline over the top either way. On imagery it is what keeps the
     country readable once the land has been dimmed far enough for white
     marks to carry. */
  ctx.strokeStyle = tiles.canvas ? 'rgba(170, 200, 230, .30)'
                                 : 'rgba(190, 205, 220, .20)';
  ctx.lineWidth = 0.8; ctx.lineJoin = 'round';
  for (const r of state.geo.land) if (near(r)) { ring(r); ctx.stroke(); }
}

function drawReports(ctx, t) {
  /* The observations. Two consecutive weeks are cross-faded so a report does
     not blink out on a week boundary - the data is weekly, the eye is not. */
  const d = state.d;
  const i = Math.max(0, Math.min(d.points.length - 1, Math.floor(t)));
  const j = Math.min(d.points.length - 1, i + 1);
  const f = t - i;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const paint = (arr, alpha) => {
    if (alpha <= 0.01) return;
    for (let k = 0; k < arr.length; k += 2) {
      const x = px(arr[k + 1]), y = py(arr[k]);
      if (x < -20 || y < -20 || x > state.w + 20 || y > state.h + 20) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
      g.addColorStop(0, `rgba(235, 244, 255, ${0.30 * alpha})`);
      g.addColorStop(1, 'rgba(235, 244, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(245, 250, 255, ${0.85 * alpha})`;
      ctx.beginPath(); ctx.arc(x, y, 1.15, 0, Math.PI * 2); ctx.fill();
    }
  };
  paint(d.points[i], 1 - f);
  paint(d.points[j], f);
  ctx.restore();
}

const TRAIL = 14;          // positions kept per particle

/* The journeys.

   This replaces a dense velocity field, which was the wrong instrument and
   looked it: particles released into a smooth field drift about like weather,
   wander out over open ocean, and keep moving in midwinter when the birds are
   standing in a Norfolk field. A goose does not diffuse. It sits still for
   months and then flies a long way to somewhere specific.

   So nothing moves except along an inferred journey - from a place that lost
   birds to a place that gained them - and in the thirty-four weeks of the year
   where no movement clears the noise, nothing moves at all. */

const COMET = 0.085;        // trail length, as a fraction of the journey
const SPEED = 0.26;         // journeys per second

function arcPath(a) {
  const x0 = px(a[1]), y0 = py(a[0]), x1 = px(a[3]), y1 = py(a[2]);
  // Bowed a little, so two journeys between the same pair of places do not
  // land on top of each other and the line reads as a flight rather than a
  // ruled connector.
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx - dy / len * len * 0.11;
  const cy = my + dx / len * len * 0.11;
  return { x0, y0, x1, y1, cx, cy, len };
}

const at = (q, t) => {
  const m = 1 - t;
  return [m * m * q.x0 + 2 * m * t * q.cx + t * t * q.x1,
          m * m * q.y0 + 2 * m * t * q.cy + t * t * q.y1];
};

function drawJourneys(ctx, now) {
  const d = state.d;
  const i = Math.max(0, Math.min(d.arcs.length - 1, Math.floor(state.t)));
  const j = Math.min(d.arcs.length - 1, i + 1);
  const f = state.t - i;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  const fly = (list, fade) => {
    if (fade <= 0.02) return;
    const biggest = list.reduce((m, a) => Math.max(m, a[4]), 1e-9);
    list.forEach((a, k) => {
      const q = arcPath(a);
      if (q.len < 2) return;
      /* The trail is a fraction of the journey, which at six times zoom makes
         a journey six times longer on screen and the comets into rain. Bound
         it in pixels as well, so a bird stays a bird however far in you go. */
      const comet = Math.min(COMET, 70 / q.len);
      const weight = a[4] / biggest;
      // More of the population moving means more birds in the air, not a
      // brighter smear: the count carries the quantity.
      const n = 1 + Math.round(weight * 5);
      for (let b = 0; b < n; b++) {
        const phase = (now * SPEED + k * 0.37 + b / n) % 1;
        const head = at(q, phase);
        const alpha = fade * (0.25 + 0.6 * weight)
          * Math.min(1, phase / 0.08) * Math.min(1, (1 - phase) / 0.12);
        for (let seg = 0; seg < 5; seg++) {
          const t1 = phase - (seg / 5) * comet;
          const t2 = phase - ((seg + 1) / 5) * comet;
          if (t2 < 0) break;
          const p1 = seg === 0 ? head : at(q, t1), p2 = at(q, t2);
          ctx.strokeStyle = `rgba(226, 240, 255, ${alpha * (1 - seg / 5)})`;
          ctx.lineWidth = 1.6 - seg * 0.22;
          ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
        }
      }
    });
  };

  fly(d.arcs[i], 1 - f);
  fly(d.arcs[j], f);
  ctx.restore();
}

/* The places themselves.

   A migration map that names nowhere is a pattern; the names are what make it
   somewhere. Ranked by birds rather than by reports - reports measure
   birdwatchers, and on this species they put Titchwell above Montrose Basin,
   which holds forty thousand geese. */

function drawHotspots(ctx) {
  const spots = state.d.hotspots || [];
  if (!spots.length) return;
  const S = state.h / 1920;
  ctx.font = `600 ${Math.round(21 * S)}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'middle';
  const placed = [];
  // The biggest first, so when two labels fight it is the lesser that loses.
  for (const sp of spots) {
    const x = px(sp.lon), y = py(sp.lat);
    if (x < 10 || y < 10 || x > state.w - 10 || y > state.h - 10) continue;

    const w = ctx.measureText(sp.name).width;
    const gap = 11 * S;
    const options = [
      [x + gap, y, 'left'], [x - gap, y, 'right'],
      [x, y - gap * 1.5, 'centre'], [x, y + gap * 1.5, 'centre'],
    ];
    let put = null;
    for (const [lx, ly, align] of options) {
      const x0 = align === 'left' ? lx : align === 'right' ? lx - w : lx - w / 2;
      if (x0 < 6 || x0 + w > state.w - 6) continue;
      const clash = placed.some((q) =>
        lx < q.x1 + 8 * S && x0 < q.x1 + 8 * S && x0 + w > q.x0 - 8 * S
        && Math.abs(ly - q.y) < 22 * S);
      if (!clash) { put = { x0, y: ly, align, x1: x0 + w }; break; }
    }
    // A ring marks the place whether or not its name would fit.
    ctx.beginPath();
    ctx.arc(x, y, 3.1 * S, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.78)';
    ctx.lineWidth = 1.3 * S;
    ctx.stroke();
    if (!put) continue;
    placed.push(put);

    ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0,0,0,.85)';
    ctx.shadowBlur = 5 * S;
    ctx.fillStyle = 'rgba(255,255,255,.90)';
    ctx.fillText(sp.name, put.x0, put.y);
    ctx.shadowBlur = 0;
  }
}

/* ------------------------------------------------------------------ HUD */

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function drawHud(ctx, t) {
  const d = state.d, W = state.w;
  const i = Math.max(0, Math.min(d.times.length - 1, Math.round(t)));
  const when = new Date(d.times[i] + 'T12:00:00');
  /* Scaled off whichever dimension is smaller. Taking it from the height
     alone was fine for a 4:5 export and threw the title clean off both edges
     of a phone held upright. */
  const S = Math.min(state.h / 1920, W / 1080);
  const pad = 54 * S;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  // And then made to fit outright, because "YELLOW-BROWED WARBLER" is twice
  // the length of "BRENT GOOSE" and no single scale suits both.
  const title = d.species.common.toUpperCase();
  let size = 86 * S;
  ctx.letterSpacing = `${2 * S}px`;
  do {
    ctx.font = `800 ${Math.round(size)}px system-ui, -apple-system, sans-serif`;
    if (ctx.measureText(title).width <= W - pad * 2) break;
    size -= 2;
  } while (size > 12);
  ctx.fillText(title, W / 2, 150 * S);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.font = `600 ${Math.round(23 * S)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillText('ONE YEAR OF MIGRATION', W - pad, 192 * S);

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${Math.round(46 * S)}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(when.toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short' }).toUpperCase(), W - pad, 252 * S);

  // The month axis, with the playhead on it.
  const axW = Math.min(330 * S, W * 0.46), axX = W - pad - axW, axY = 288 * S;
  ctx.strokeStyle = 'rgba(255,255,255,.34)';
  ctx.lineWidth = 1.2 * S;
  ctx.beginPath(); ctx.moveTo(axX, axY); ctx.lineTo(axX + axW, axY); ctx.stroke();
  ctx.font = `600 ${Math.round(14 * S)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const start = new Date(d.times[0] + 'T12:00:00').getMonth();
  for (let m = 0; m < 12; m++) {
    const x = axX + (m + 0.5) / 12 * axW;
    ctx.fillStyle = 'rgba(255,255,255,.62)';
    ctx.fillText(MONTHS[(start + m) % 12], x, axY - 9 * S);
  }
  const hx = axX + (t / Math.max(1, d.times.length - 1)) * axW;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(hx, axY, 4.2 * S, 0, Math.PI * 2); ctx.fill();

  // The legend, and the sentence that keeps it honest.
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = `650 ${Math.round(20 * S)}px system-ui, sans-serif`;
  /* The bar is a fixed number of real pixels tall, so the footer has to be
     too - scaling it with the frame tucked it under the controls on a phone. */
  const foot = Math.max(118, 150 * S);
  ctx.fillText('Bright: birds reported', pad, state.h - foot);
  ctx.fillStyle = 'rgba(255,255,255,.62)';
  ctx.font = `500 ${Math.round(16 * S)}px system-ui, sans-serif`;
  ctx.fillText('Lines: modelled movement, not tracked birds', pad, state.h - foot + 26 * S);
  ctx.fillStyle = 'rgba(255,255,255,.34)';
  ctx.font = `500 ${Math.round(13 * S)}px system-ui, sans-serif`;
  ctx.fillText(`${d.species.sci} · ${d.records.toLocaleString('en-GB')} reports · `
    + 'eBird/GBIF · Natural Earth'
    + (tiles.credit ? ' · ' + tiles.credit : ''), pad, state.h - foot + 52 * S);
}

/* ----------------------------------------------------------------- loop */

let last = 0;
function frame(now) {
  const dt = Math.min(3, (now - last) / 16.67 || 1);
  last = now;
  const ctx = state.ctx;

  drawLand(ctx);
  drawReports(ctx, state.t);
  drawJourneys(ctx, now / 1000);
  drawHotspots(ctx);
  drawHud(ctx, state.t);

  if (state.playing) {
    // A year in about forty seconds.
    state.t += dt * (state.weeks / (YEAR_SECONDS * 60));
    if (state.t >= state.weeks - 1) state.t = 0;
    $('scrub').value = state.t;
    $('when').textContent = state.d.times[Math.round(state.t)];
  }
  requestAnimationFrame(frame);
}

function resize() {
  const pick = $('size').value;
  let w, h;
  if (pick === 'fit') {
    // The viewer's normal state: the map is the page. A fixed export shape is
    // for when you are making a clip, not for looking at one on a phone.
    w = Math.round(window.innerWidth);
    h = Math.round(window.innerHeight);
  } else {
    [w, h] = pick.split('x').map(Number);
  }
  document.body.classList.toggle('fit', pick === 'fit');

  const scale = pick === 'fit' ? 1
    : Math.min((window.innerHeight - 96) / h, (window.innerWidth - 40) / w, 1);
  const c = $('c');
  state.dpr = Math.min(2, window.devicePixelRatio || 1);
  state.w = w; state.h = h;
  c.width = Math.round(w * state.dpr);
  c.height = Math.round(h * state.dpr);
  c.style.width = Math.round(w * scale) + 'px';
  c.style.height = Math.round(h * scale) + 'px';
  state.ctx = c.getContext('2d');
  state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  setProjection(w, h);
  clampPan();
  queueTiles();
}

async function loadSpecies(slug) {
  const d = await fetch(`data/migration/${slug}.json`).then((r) => r.json());
  state.d = d;
  state.weeks = d.times.length;
  state.t = Math.min(state.t, state.weeks - 1);
  $('scrub').max = state.weeks - 1;
  $('scrub').value = state.t;
  $('when').textContent = d.times[Math.round(state.t)];
  const url = new URL(location);
  url.searchParams.set('species', slug);
  history.replaceState(null, '', url);
}

async function boot() {
  let index, geo;
  try {
    [index, geo] = await Promise.all([
      fetch('data/migration/index.json').then((r) => r.json()),
      fetch('data/geo.json').then((r) => r.json()),
    ]);
  } catch (e) {
    $('loading').textContent = 'No migration fields yet. Run: python3 -m '
      + 'src.backfill --species "Anser brachyrhynchus" --from 2024-09-01 '
      + '--to 2025-08-31, then python3 -m src.migration --from 2024-09-01 '
      + '--to 2025-08-31';
    return;
  }
  state.geo = geo;

  const q = new URLSearchParams(location.search);
  const sel = $('species');
  for (const it of index) {
    const o = document.createElement('option');
    o.value = it.slug;
    // The count of weeks that actually move is the honest headline for a
    // species here: a bird with two is a bird this method cannot see.
    o.textContent = `${it.common} — ${it.movingWeeks} weeks on the move`;
    sel.appendChild(o);
  }
  const want = q.get('species');
  sel.value = index.some((i) => i.slug === want) ? want : index[0].slug;
  await loadSpecies(sel.value);

  $('loading').hidden = true;
  $('bar').hidden = false;
  if (q.has('week')) {
    state.t = Math.max(0, Math.min(state.weeks - 1, Number(q.get('week'))));
    state.playing = false;
  }
  if (q.get('play') === '0') state.playing = false;

  resize();
  window.addEventListener('resize', resize);
  $('size').onchange = resize;
  $('more').onclick = () => document.body.classList.toggle('more');
  $('basemap').onchange = (e) => {
    state.basemap = e.target.value;
    tiles.canvas = null;
    tiles.credit = '';
    loadTiles();
  };
  wireZoom($('c'));
  /* ?zoom=4&at=57.5,-3 frames a corner of the map, which is how you share
     "look at the Moray Firth" rather than describing it. */
  if (q.has('zoom')) {
    view.k = Math.max(1, Math.min(40, Number(q.get('zoom')) || 1));
    const at = (q.get('at') || '').split(',').map(Number);
    const lat = at.length === 2 && isFinite(at[0]) ? at[0]
      : (VIEW.south + VIEW.north) / 2;
    const lon = at.length === 2 && isFinite(at[1]) ? at[1]
      : (VIEW.west + VIEW.east) / 2;
    view.tx = 0; view.ty = 0;
    setProjection(state.w, state.h);
    view.tx = state.w / 2 - px(lon);
    view.ty = state.h / 2 - py(lat);
    clampPan();
  }
  $('reset').onclick = () => {
    view.k = 1; view.tx = 0; view.ty = 0;
    updateZoomUi();
  };
  updateZoomUi();
  sel.onchange = () => loadSpecies(sel.value);
  $('play').textContent = state.playing ? 'Pause' : 'Play';
  $('when').textContent = state.d.times[Math.round(state.t)];
  $('scrub').value = state.t;
  $('play').onclick = () => {
    state.playing = !state.playing;
    $('play').textContent = state.playing ? 'Pause' : 'Play';
  };
  $('scrub').oninput = (e) => {
    state.playing = false; $('play').textContent = 'Play';
    state.t = Number(e.target.value);
    $('when').textContent = state.d.times[Math.round(state.t)];
  };
  requestAnimationFrame(frame);
}

boot();
