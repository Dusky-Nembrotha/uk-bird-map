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
  clock: 0,          // seconds of playback, not of wall time
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
    queueLand();
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
      queueTiles(); queueLand();
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = toCanvas(e);
    zoomAt(x, y, e.shiftKey ? 1 / 1.8 : 1.8);
    updateZoomUi();
    queueTiles();
    queueLand();
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
               /* The animation view draws this imagery at 0.9 and it looks
                  like somewhere. At 0.42, with a heavy wash over the top, this
                  page had turned it to mud - the whole reason it stopped
                  resembling the rest of the app. */
               credit: 'Esri, Maxar, Earthstar Geographics', max: 17, dim: 0.9 },
  light: { url: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
           credit: 'Esri, HERE, Garmin, OpenStreetMap', max: 16, dim: 1, pale: true },
  dark: { url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
          credit: 'Esri, HERE, Garmin, OpenStreetMap', max: 16, dim: 0.9 },
  none: null,
};

// A pale backdrop needs the opposite treatment to a dark one: a white wash
// rather than a black one, and a coastline dark enough to read on it.
const pale = () => !!(BASEMAPS[state.basemap] || {}).pale;

const tiles = { canvas: null, view: null, credit: '', dim: 1, token: 0 };
let tileTimer = null;

/* The backdrop - tiles, wash and coastline - only changes when the view does,
   but it was rebuilt on every frame: the coastline alone is thousands of
   points traced three times, sixty times a second. It is now composed once
   into an offscreen canvas and blitted, exactly as the tiles already were,
   and rebuilt once the gesture settles. */
const land = { canvas: null, view: null, key: '' };
let landTimer = null;

function queueLand() {
  clearTimeout(landTimer);
  landTimer = setTimeout(() => { land.view = null; }, 160);
}

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
  const key = `${state.w}x${state.h}|${state.basemap}|${tiles.token}`;
  if (!land.canvas || land.key !== key || !land.view) buildLand(key);

  // Between rebuilds, shift and scale what we have so the ground moves with
  // the gesture instead of sticking and then jumping.
  const lv = land.view;
  ctx.save();
  if (lv && (lv.k !== view.k || lv.tx !== view.tx || lv.ty !== view.ty)) {
    const f = view.k / lv.k;
    ctx.translate(view.tx - lv.tx * f, view.ty - lv.ty * f);
    ctx.scale(f, f);
  }
  ctx.drawImage(land.canvas, 0, 0, state.w, state.h);
  ctx.restore();
}

function buildLand(key) {
  if (!land.canvas || land.canvas.width !== state.w || land.canvas.height !== state.h) {
    land.canvas = document.createElement('canvas');
    land.canvas.width = state.w; land.canvas.height = state.h;
  }
  const c = land.canvas.getContext('2d');
  c.clearRect(0, 0, state.w, state.h);
  paintLand(c);
  land.view = { k: view.k, tx: view.tx, ty: view.ty };
  land.key = key;
}

function paintLand(ctx) {
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

  ctx.fillStyle = pale() ? '#e9eef2' : '#05070c';
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
    // Just enough to seat the marks on the ground, not enough to drown it.
    ctx.fillStyle = pale() ? 'rgba(255, 255, 255, .30)' : 'rgba(5, 8, 14, .16)';
    ctx.fillRect(0, 0, state.w, state.h);
  } else {
    // Until the imagery lands - or with it turned off - the drawn world.
    ctx.fillStyle = pale() ? '#dfe6ea' : '#1b2026';
    for (const r of state.geo.land) if (near(r)) { ring(r); ctx.fill(); }
    ctx.fillStyle = pale() ? '#c9d6de' : '#0a0d11';
    for (const r of state.geo.lakes) if (near(r)) { ring(r); ctx.fill(); }
  }

  /* A coastline over the top either way. On imagery it is what keeps the
     country readable once the land has been dimmed far enough for white
     marks to carry. */
  ctx.strokeStyle = pale() ? 'rgba(60, 85, 105, .45)'
                  : tiles.canvas ? 'rgba(170, 200, 230, .30)'
                                 : 'rgba(190, 205, 220, .20)';
  ctx.lineWidth = 0.8; ctx.lineJoin = 'round';
  for (const r of state.geo.land) if (near(r)) { ring(r); ctx.stroke(); }
}

/* The reports, rendered once per week rather than once per frame.

   This was the crash. A busy week is some fourteen hundred reports, each one
   allocating a radial gradient and filling two paths, every frame - around
   seventy thousand gradient objects a second, which a phone will not survive
   however patient it is. Nothing in that layer moves within a week, so it is
   drawn into an offscreen canvas and blitted: two drawImage calls a frame in
   place of several thousand operations.

   The cache is keyed on the view as well as the week, because panning and
   zooming do move the dots; it holds three layers, which is the pair being
   cross-faded plus the one about to be needed. */

/* ----------------------------------------------------------- the flock

   One population, not two layers.

   Until now a sighting was a glowing blob and a movement was a comet, drawn
   by different code in different shapes, and it read as a particle effect
   laid over a dot map - which is what it was. A bird that is sitting still
   and a bird that is flying are the same bird. So there is now a single
   flock of individuals: each one is the same mark, and the only difference
   between them is whether it is moving and therefore trailing.

   They are inferred, and the frame says so. The reports tell us where the
   birds were each week; the weekly shift tells us how many went from where
   to where. Which particular bird made which journey is interpretation
   filling the gap between two sightings - the same liberty the reference
   takes, and worth stating rather than implying. */

const FLOCK_MAX = 900;
const TRAIL = 22;                 // positions kept
// How long the tail is allowed to look, in screen pixels. A bird crossing
// eight hundred kilometres in twenty frames leaves forty kilometres between
// one position and the next, and drawing all of them put white beams across
// the whole map. The tail is walked back from the head until this is spent.
const TAIL_PX = 42;
const WEEK_SECONDS = () => (YEAR_SECONDS / Math.max(1, state.weeks));

const flock = { birds: [], week: -1, placesByWeek: new Map() };

/* One entry per distinct square reported that week, with how often. Cached
   on the data rather than the view, so panning does not recompute it. */
function weekPlaces(w) {
  const hit = flock.placesByWeek.get(w);
  if (hit) return hit;
  const arr = (state.d.points[w] || []);
  const seen = new Map();
  for (let k = 0; k < arr.length; k += 2) {
    const key = arr[k] + ',' + arr[k + 1];
    const at_ = seen.get(key);
    if (at_) at_.n += 1;
    else seen.set(key, { lat: arr[k], lon: arr[k + 1], n: 1 });
  }
  const list = [...seen.values()];
  flock.placesByWeek.set(w, list);
  return list;
}

function pickPlace(list) {
  // Weighted by how often the place was reported, so birds sit where birds
  // were seen rather than spread evenly over the map.
  let total = 0;
  for (const p of list) total += p.n;
  let r = Math.random() * total;
  for (const p of list) { r -= p.n; if (r <= 0) return p; }
  return list[list.length - 1];
}

function newBird(place) {
  return { lat: place.lat, lon: place.lon, flying: false,
           fromLat: 0, fromLon: 0, toLat: 0, toLon: 0,
           t0: 0, t1: 1, trail: [], jitter: Math.random() };
}

function seedFlock(w) {
  flock.birds = [];
  const list = weekPlaces(w);
  if (!list.length) { flock.week = w; return; }
  const want = Math.min(FLOCK_MAX, Math.max(12, Math.round(list.length * 1.1)));
  for (let i = 0; i < want; i++) flock.birds.push(newBird(pickPlace(list)));
  flock.week = w;
  /* Launch this week's journeys already in progress. Scrubbing to the peak
     of the autumn should show birds in the air, not a frozen field waiting
     for the next week boundary to come round. */
  launch(w, true);
}

/* Send the birds this week's arcs call for. `midflight` spreads departures
   backwards as well as forwards, so a week entered by scrubbing is already
   under way rather than about to begin. */
function launch(w, midflight) {
  const arcs = state.d.arcs[w] || [];
  const perched = flock.birds.filter((b) => !b.flying);
  for (const a of arcs) {
    const n = Math.max(1, Math.round(a[4] * FLOCK_MAX));
    // The perched birds nearest this journey's start are the ones that make
    // it, so a departure comes out of the flock standing there.
    perched.sort((x, y) => (
      ((x.lat - a[0]) ** 2 + (x.lon - a[1]) ** 2)
      - ((y.lat - a[0]) ** 2 + (y.lon - a[1]) ** 2)));
    for (let i = 0; i < n && perched.length; i++) {
      const b = perched.shift();
      const km = a[5] || 400;
      const span = Math.min(0.9, 0.12 + km / 3000);
      b.flying = true;
      b.fromLat = b.lat; b.fromLon = b.lon;
      b.toLat = a[2]; b.toLon = a[3];
      // Staggered departures; far journeys take longer than near ones.
      b.t0 = w + (midflight ? -0.35 : 0.05) + b.jitter * 0.55;
      b.t1 = b.t0 + span;
      b.trail.length = 0;
    }
  }
}

/* At each week boundary: settle the arrivals, send the departures the arcs
   call for, and let the population follow the season - a bird leaving the
   window in spring has to be able to leave. */
function stepFlock(w) {
  const list = weekPlaces(w);

  for (const b of flock.birds) {
    if (b.flying && state.t >= b.t1) {
      b.flying = false;
      b.lat = b.toLat; b.lon = b.toLon;
      b.trail.length = 0;
    }
  }
  launch(w, false);

  // Track the season's population: birds arrive in autumn and are gone by
  // summer, which is the whole shape of the year for most of these species.
  const want = list.length
    ? Math.min(FLOCK_MAX, Math.max(0, Math.round(list.length * 1.1))) : 0;
  while (flock.birds.length > want) {
    const i = flock.birds.findIndex((b) => !b.flying);
    if (i < 0) break;
    flock.birds.splice(i, 1);
  }
  while (flock.birds.length < want && list.length) {
    flock.birds.push(newBird(pickPlace(list)));
  }
  flock.week = w;
}

function updateFlock() {
  const w = Math.max(0, Math.min(state.d.arcs.length - 1, Math.floor(state.t)));
  if (w !== flock.week) {
    if (Math.abs(w - flock.week) > 1 || flock.week < 0) seedFlock(w);
    else stepFlock(w);
  }
  for (const b of flock.birds) {
    if (!b.flying) continue;
    const u = Math.max(0, Math.min(1, (state.t - b.t0) / (b.t1 - b.t0)));
    // Eased, so a departure looks like a bird leaving rather than a slide.
    const e = u * u * (3 - 2 * u);
    b.lat = b.fromLat + (b.toLat - b.fromLat) * e;
    b.lon = b.fromLon + (b.toLon - b.fromLon) * e;
    if (state.playing) {
      b.trail.push(b.lat, b.lon);
      if (b.trail.length > TRAIL * 2) b.trail.splice(0, 2);
    }
  }
}

/* One sprite, drawn once and blitted per bird. Building a radial gradient
   per bird per frame is what crashed the page the first time. */
let birdSprite = null, birdSpriteKey = '';
function sprite() {
  const key = `${pale()}:${state.dpr}`;
  if (birdSprite && birdSpriteKey === key) return birdSprite;
  const R = 6;
  const c = document.createElement('canvas');
  c.width = c.height = R * 2 * state.dpr;
  const g = c.getContext('2d');
  g.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  const halo = pale() ? '20, 60, 110' : '214, 232, 252';
  const core = pale() ? '12, 48, 92' : '244, 250, 255';
  const rg = g.createRadialGradient(R, R, 0, R, R, R);
  // Enough bloom to seat a bird on the imagery, not enough that a roost of
  // forty merges into one lamp. Crisp cores are what let a crowd still read
  // as a crowd of individuals.
  rg.addColorStop(0, `rgba(${halo}, ${pale() ? 0.14 : 0.17})`);
  rg.addColorStop(1, `rgba(${halo}, 0)`);
  g.fillStyle = rg;
  g.beginPath(); g.arc(R, R, R, 0, Math.PI * 2); g.fill();
  g.fillStyle = `rgba(${core}, ${pale() ? 0.90 : 0.95})`;
  g.beginPath(); g.arc(R, R, 1.05, 0, Math.PI * 2); g.fill();
  birdSprite = c; birdSpriteKey = key;
  return c;
}

function drawFlock(ctx) {
  updateFlock();
  const img = sprite();
  const R = 6;
  ctx.save();
  ctx.globalCompositeOperation = pale() ? 'multiply' : 'lighter';

  // Tails first, so a bird sits on the head of its own trail.
  const rgb = pale() ? '20, 70, 125' : '226, 240, 255';
  const batches = new Map();
  for (const b of flock.birds) {
    if (!b.flying || b.trail.length < 4) continue;
    let spent = 0;
    let hx = px(b.trail[b.trail.length - 1]), hy = py(b.trail[b.trail.length - 2]);
    for (let i = b.trail.length - 4; i >= 0 && spent < TAIL_PX; i -= 2) {
      const nx = px(b.trail[i + 1]), ny = py(b.trail[i]);
      const d = Math.hypot(nx - hx, ny - hy) || 0.001;
      // Clip the final segment so the tail ends exactly where its length runs
      // out, rather than overshooting by however far the last frame carried.
      const room = TAIL_PX - spent;
      const cut = d > room ? room / d : 1;
      const ex = hx + (nx - hx) * cut, ey = hy + (ny - hy) * cut;
      const f = 1 - spent / TAIL_PX;
      const bucket = Math.max(1, Math.round(f * 5));
      let path = batches.get(bucket);
      if (!path) batches.set(bucket, (path = new Path2D()));
      path.moveTo(hx, hy);
      path.lineTo(ex, ey);
      spent += d;
      hx = nx; hy = ny;
    }
  }
  for (const [bucket, path] of batches) {
    ctx.strokeStyle = `rgba(${rgb}, ${0.05 + 0.09 * bucket})`;
    ctx.lineWidth = 0.4 + 0.2 * bucket;
    ctx.lineCap = 'round';
    ctx.stroke(path);
    if (perf.on) perf.strokes++;
  }

  // Every bird the same mark, flying or not.
  for (const b of flock.birds) {
    const x = px(b.lon), y = py(b.lat);
    if (x < -R || y < -R || x > state.w + R || y > state.h + R) continue;
    ctx.drawImage(img, x - R, y - R, R * 2, R * 2);
    if (perf.on) perf.dots++;
  }
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
  /* Subordinate to the records, deliberately. These labels never change all
     year, and at full strength they were the brightest thing left on a quiet
     week - in February, with five reports in the whole of Europe, every lit
     pixel on the map was furniture. Annotation should not be mistakable for
     a sighting. */
  const S = state.h / 1920;
  ctx.font = `500 ${Math.round(19 * S)}px system-ui, -apple-system, sans-serif`;
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
    ctx.arc(x, y, 2.4 * S, 0, Math.PI * 2);
    ctx.strokeStyle = pale() ? 'rgba(20, 60, 110, .42)' : 'rgba(255,255,255,.40)';
    ctx.lineWidth = 1.1 * S;
    ctx.stroke();
    if (!put) continue;
    placed.push(put);

    ctx.textAlign = 'left';
    ctx.shadowColor = pale() ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.85)';
    ctx.shadowBlur = 5 * S;
    ctx.fillStyle = pale() ? 'rgba(18, 38, 60, .72)' : 'rgba(244,242,238,.60)';
    ctx.fillText(sp.name, put.x0, put.y);
    ctx.shadowBlur = 0;
  }
}

/* ------------------------------------------------------------------ HUD */

/* The HUD's ink, by role rather than by hex.

   Every caption on the frame was written white, which was right while the
   ground was always dark and became invisible the moment a pale basemap
   arrived. Scattering pale() ternaries through the drawing code would have
   worked and would have had to be done again for the next backdrop, so the
   decision lives here instead and the HUD asks for "primary" or "muted".

   The shadow matters as much as the fill: a title has to cross coastlines and
   cities, and on either ground a hairline of the opposite tone behind it is
   what keeps it readable. */
function ink() {
  return pale()
    ? { primary: '#0f2236', secondary: 'rgba(15,34,54,.78)',
        muted: 'rgba(15,34,54,.60)', hair: 'rgba(15,34,54,.38)',
        warn: '#8a4b00', accent: '#4a7c12', shadow: 'rgba(255,255,255,.85)' }
    /* The same ink the animation view uses: its off-white, its warm amber for
       figures and its lime accent, so the two pages read as one piece of
       software rather than two. */
    : { primary: '#f4f2ee', secondary: 'rgba(244,242,238,.76)',
        muted: 'rgba(244,242,238,.58)', hair: 'rgba(244,242,238,.32)',
        warn: '#ffd9a0', accent: '#a9e34b', shadow: 'rgba(0,0,0,.72)' };
}

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

  const C = ink();
  ctx.save();
  ctx.shadowColor = C.shadow;
  ctx.shadowBlur = 6 * S;
  ctx.textAlign = 'center';
  ctx.fillStyle = C.primary;
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

  /* Only claim a year when there is one. A backfill that stopped in March
     still produces a playable file, and captioning it "one year" would be a
     straightforward lie about the half that is missing. */
  const span = d.span || { complete: true };
  const sub = span.complete ? 'ONE YEAR OF MIGRATION' : (() => {
    const f = new Date(span.from + 'T12:00:00'), t = new Date(span.to + 'T12:00:00');
    const m = (x) => x.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    return `${m(f)} – ${m(t)} · PART YEAR`.toUpperCase();
  })();
  ctx.fillStyle = span.complete ? C.secondary : C.warn;
  ctx.font = `600 ${Math.round(23 * S)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillText(sub, W - pad, 192 * S);

  ctx.fillStyle = C.warn;
  ctx.font = `800 ${Math.round(46 * S)}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(when.toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short' }).toUpperCase(), W - pad, 252 * S);

  // The month axis, with the playhead on it.
  const axW = Math.min(330 * S, W * 0.46), axX = W - pad - axW, axY = 288 * S;
  ctx.strokeStyle = C.hair;
  ctx.lineWidth = 1.2 * S;
  ctx.beginPath(); ctx.moveTo(axX, axY); ctx.lineTo(axX + axW, axY); ctx.stroke();
  ctx.font = `600 ${Math.round(14 * S)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const start = new Date(d.times[0] + 'T12:00:00').getMonth();
  for (let m = 0; m < 12; m++) {
    const x = axX + (m + 0.5) / 12 * axW;
    ctx.fillStyle = C.muted;
    ctx.fillText(MONTHS[(start + m) % 12], x, axY - 9 * S);
  }
  const hx = axX + (t / Math.max(1, d.times.length - 1)) * axW;
  ctx.fillStyle = C.accent;
  ctx.beginPath(); ctx.arc(hx, axY, 4.2 * S, 0, Math.PI * 2); ctx.fill();

  // The legend, and the sentence that keeps it honest.
  ctx.textAlign = 'left';
  ctx.fillStyle = C.primary;
  ctx.font = `650 ${Math.round(20 * S)}px system-ui, sans-serif`;
  /* The bar is a fixed number of real pixels tall, so the footer has to be
     too - scaling it with the frame tucked it under the controls on a phone. */
  const foot = Math.max(118, 150 * S);
  ctx.fillText('Each point is one bird', pad, state.h - foot);
  ctx.fillStyle = C.secondary;
  ctx.font = `500 ${Math.round(16 * S)}px system-ui, sans-serif`;
  ctx.fillText('Positions between sightings are inferred, not tracked',
               pad, state.h - foot + 26 * S);
  ctx.fillStyle = C.muted;
  ctx.font = `500 ${Math.round(13 * S)}px system-ui, sans-serif`;
  ctx.fillText(`${d.species.sci} · ${d.records.toLocaleString('en-GB')} reports · `
    + 'eBird/GBIF · Natural Earth'
    + (tiles.credit ? ' · ' + tiles.credit : ''), pad, state.h - foot + 52 * S);
  ctx.restore();
}

/* ----------------------------------------------------------------- loop */

/* ?fps=1 reports the real frame cost in the zoom slot. Kept in rather than
   used once and deleted: "the browser crashes" needs a number next to it, and
   the number has to be obtainable on the device that crashed. */
const perf = { on: false, n: 0, sum: 0, t0: 0, dots: 0, grads: 0, strokes: 0 };

let last = 0;
function frame(now) {
  const tStart = perf.on ? performance.now() : 0;
  const dt = Math.min(3, (now - last) / 16.67 || 1);
  last = now;
  const ctx = state.ctx;

  drawLand(ctx);
  drawFlock(ctx);
  drawHotspots(ctx);
  drawHud(ctx, state.t);

  if (state.playing) {
    /* The comets ran off the wall clock, so they kept flying while the clip
       was paused - a still frame that would not hold still. They now run off
       a clock that only advances while it is playing, which is what pause is
       supposed to mean. A paused frame still shows its trails, because the
       phase they are frozen at is spread across each journey. */
    state.clock += dt / 60;
    // A year in about forty seconds.
    state.t += dt * (state.weeks / (YEAR_SECONDS * 60));
    if (state.t >= state.weeks - 1) state.t = 0;
    $('scrub').value = state.t;
    $('when').textContent = state.d.times[Math.round(state.t)];
  }
  if (perf.on) {
    perf.sum += performance.now() - tStart;
    perf.n += 1;
    if (now - perf.t0 > 500) {
      const ms = perf.sum / Math.max(1, perf.n);
      const per = perf.dots / Math.max(1, perf.n);
      // Wall-clock on a real device; counts everywhere, including headless,
      // where virtual time pins performance.now() to zero.
      const segs = perf.grads / Math.max(1, perf.n);
      const calls = perf.strokes / Math.max(1, perf.n);
      const flying = flock.birds.filter((b) => b.flying).length;
      $('zoom').textContent =
        `w${flock.week} · ${flock.birds.length} birds, ${flying} flying · ${calls.toFixed(0)} strokes`;
      perf.sum = 0; perf.n = 0; perf.dots = 0; perf.grads = 0; perf.strokes = 0; perf.t0 = now;
    }
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
  queueTiles(); queueLand();
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
    o.textContent = `${it.common} — ${it.movingWeeks} weeks on the move`
      + (it.complete === false ? ' (part year)' : '');
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
  // ?week=N&play=1 holds a moment and keeps it running, which is the only way
  // to see a given week's migration without waiting for the clip to reach it.
  if (q.get('play') === '1') state.playing = true;

  resize();
  window.addEventListener('resize', resize);
  $('size').onchange = resize;
  // ?basemap=satellite|light|dark|none, so a framing can be shared whole.
  const wantMap = q.get('basemap');
  if (wantMap && wantMap in BASEMAPS) {
    state.basemap = wantMap;
    $('basemap').value = wantMap;
  }
  // So the nav, which sits on the map rather than on a panel, can follow the
  // ground along with everything else drawn there.
  document.body.classList.toggle('pale', pale());
  perf.on = q.get('fps') === '1';
  $('more').onclick = () => document.body.classList.toggle('more');
  $('basemap').onchange = (e) => {
    state.basemap = e.target.value;
    document.body.classList.toggle('pale', pale());
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
