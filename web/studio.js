/* UK Bird Sightings — Animation Studio.

   Draws its own world on a plain canvas rather than using map tiles, so that
   every frame is deterministic: nothing loads mid-render, nothing is rate
   limited, and the output carries no tile attribution. The scene is composed
   bottom-up each frame — sea, land, the night side with a real solar
   terminator, city lights coming on at dusk, optional weather, then the bird
   records themselves — and the frame is pushed to the server, which hands the
   sequence to ffmpeg at exactly the requested frame rate.

   Everything stateful (wind particles, the lasting-trace layer, the random
   stream) is reset before a render starts, so a clip rendered twice from the
   same settings is identical. */

'use strict';

const SP = 0, LAT = 1, LON = 2, DT = 3, SRC = 4, CNT = 5, SITE = 6,
      OBS = 7, FLAG = 8, REF = 9, TIME = 10;
const F_NOTABLE = 1, F_AGGREGATE = 8;

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// The area the clip is framed on. A preset, a view handed over from the map,
// or whatever the preview has been dragged and zoomed to.
const AREAS = {
  uk:        { label: 'Britain & Ireland', south: 49.7, west: -11.0, north: 61.1, east: 2.4 },
  britain:   { label: 'Britain',           south: 49.8, west: -6.6,  north: 59.5, east: 2.0 },
  scotland:  { label: 'Scotland',          south: 54.5, west: -8.2,  north: 61.0, east: -0.5 },
  north:     { label: 'Northern England',  south: 52.9, west: -3.8,  north: 55.9, east: 0.3 },
  wales:     { label: 'Wales',             south: 51.3, west: -5.5,  north: 53.5, east: -2.5 },
  midlands:  { label: 'The Midlands',      south: 51.8, west: -3.3,  north: 53.6, east: 0.4 },
  southwest: { label: 'South West',        south: 49.8, west: -6.6,  north: 51.9, east: -1.9 },
  southeast: { label: 'South East & London', south: 50.5, west: -1.7, north: 52.3, east: 1.7 },
  anglia:    { label: 'East Anglia',       south: 51.7, west: -0.4,  north: 53.3, east: 1.9 },
  nireland:  { label: 'Northern Ireland',  south: 53.9, west: -8.4,  north: 55.4, east: -5.2 },
  europe:    { label: 'Europe',            south: 35.0, west: -12.0, north: 68.0, east: 32.0 },
  nweurope:  { label: 'North-west Europe', south: 47.0, west: -11.0, north: 61.5, east: 16.0 },
  iberia:    { label: 'Iberia',            south: 35.8, west: -10.0, north: 44.0, east: 4.0 },
  nordics:   { label: 'Scandinavia',       south: 54.0, west: 3.0,   north: 71.5, east: 32.0 },
  alps:      { label: 'The Alps & Italy',  south: 36.0, west: 5.0,   north: 48.5, east: 19.0 },
  lowcountry:{ label: 'Low Countries',     south: 49.0, west: 2.0,   north: 54.0, east: 9.0 },
};

const DEFAULT_FOCUS = { ...AREAS.uk };
let FOCUS = { ...DEFAULT_FOCUS };

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

// Real map tiles, pre-loaded into an offscreen canvas before a render starts
// so that frames stay deterministic: nothing is still arriving mid-clip.
const TILE_BASEMAPS = {
  'tile-dark': { url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
                 labels: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
                 credit: 'Esri, HERE, Garmin, OpenStreetMap', max: 16, dim: 1 },
  'tile-light': { url: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
                  labels: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
                  credit: 'Esri, HERE, Garmin, OpenStreetMap', max: 16, dim: 1 },
  'tile-satellite': { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
                      credit: 'Esri, Maxar, Earthstar Geographics', max: 17, dim: 0.9 },
  'tile-terrain': { url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
                    credit: 'OpenTopoMap, OpenStreetMap', max: 15, dim: 0.85 },
  'tile-ocean': { url: `${ESRI}/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}`,
                  credit: 'Esri, GEBCO, NOAA', max: 13, dim: 1 },
};

const PALETTES = {
  space: { sea0: '#060a12', sea1: '#0b1526', land: '#1b222b', coast: '#39485a',
           lake: '#0c1726' },
  ink:   { sea0: '#05060a', sea1: '#0a0d14', land: '#171a20', coast: '#333a46',
           lake: '#0a0d14' },
  teal:  { sea0: '#04110f', sea1: '#07201d', land: '#152421', coast: '#2f5049',
           lake: '#07201d' },
  slate: { sea0: '#0a0c0f', sea1: '#141921', land: '#232a33', coast: '#44505f',
           lake: '#141921' },
};

const state = {
  data: null, geo: null, cities: null, weather: null,
  caps: { ffmpeg: false, formats: [] },
  backend: false,    // false on a static host: no render API, no photo proxy
  records: [],        // prepared, time-sorted
  t0: 0, t1: 0,       // clip span, ms
  playing: false,
  rendering: false,
  previewT: 0,
  job: null,
};

/* ----------------------------------------------------------- deterministic
   A small seeded PRNG, so "spread across daylight" and the wind field are the
   same every time a clip is rendered. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(n) {
  n = Math.imul(n ^ (n >>> 16), 2246822507);
  n = Math.imul(n ^ (n >>> 13), 3266489909);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/* -------------------------------------------------------------- solar math
   NOAA's low-precision algorithm: good to a hundredth of a degree, which is
   far more than a terminator drawn at screen resolution needs. */
const RAD = Math.PI / 180;

function solarPosition(ms) {
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  let gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  if (gmst < 0) gmst += 24;
  return { dec, ra, gmstDeg: gmst * 15 };
}

function elevationFrom(sun, lat, lon) {
  const H = (sun.gmstDeg + lon) * RAD - sun.ra;
  const phi = lat * RAD;
  const s = Math.sin(phi) * Math.sin(sun.dec)
          + Math.cos(phi) * Math.cos(sun.dec) * Math.cos(H);
  return Math.asin(clamp(s, -1, 1)) / RAD;
}

/** Local sunrise / sunset in ms for a day, or null inside polar day/night. */
function daylightWindow(dayMs, lat, lon) {
  const sun = solarPosition(dayMs + 43200000);
  const phi = lat * RAD;
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(sun.dec))
             / (Math.cos(phi) * Math.cos(sun.dec));
  if (cosH > 1) return null;                 // sun never rises
  if (cosH < -1) return [dayMs, dayMs + 86400000];
  const H = Math.acos(cosH) / RAD;           // degrees
  const noonUTC = 12 - lon / 15;             // hours, ignoring equation of time
  const rise = (noonUTC - H / 15) * 3600000;
  const set = (noonUTC + H / 15) * 3600000;
  return [dayMs + rise, dayMs + set];
}

/* ------------------------------------------------------------- projection */

/* Two independent drawing contexts: one behind the live preview, one for a
   render in progress. A render therefore owns its own canvas, its own
   particles and a frozen copy of the records, so the settings can be changed
   - or another preview played - while a clip is still being drawn.

   `view` and `scene` are rebound to whichever context is drawing. Every frame
   is drawn synchronously, so the two can never interleave mid-frame. */
function newView() {
  return { w: 1080, h: 1080, scale: 1, cx: 0, cy: 0,
           west: 0, east: 0, north: 0, south: 0 };
}

// Web Mercator. Both axes must be in the same angular units or the world
// comes out squashed, so x is longitude in radians, not degrees.
const mercX = (lon) => lon * RAD;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
const invMercX = (x) => x / RAD;
const invMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;

function setupView(w, h) {
  view.w = w; view.h = h;
  const pad = 0.06;
  const fx = mercX(FOCUS.east) - mercX(FOCUS.west);
  const fy = mercY(FOCUS.north) - mercY(FOCUS.south);
  // Fit the focus box inside the frame, then let the rest of the world fill.
  view.scale = Math.min((w * (1 - pad * 2)) / fx, (h * (1 - pad * 2)) / fy);
  view.cx = (mercX(FOCUS.east) + mercX(FOCUS.west)) / 2;
  view.cy = (mercY(FOCUS.north) + mercY(FOCUS.south)) / 2;
  view.west = invMercX(view.cx - (w / 2) / view.scale);
  view.east = invMercX(view.cx + (w / 2) / view.scale);
  view.north = invMercY(view.cy + (h / 2) / view.scale);
  view.south = invMercY(view.cy - (h / 2) / view.scale);
}

const px = (lon) => (mercX(lon) - view.cx) * view.scale + view.w / 2;
const py = (lat) => view.h / 2 - (mercY(lat) - view.cy) * view.scale;
const lonAt = (x) => invMercX((x - view.w / 2) / view.scale + view.cx);
const latAt = (y) => invMercY((view.h / 2 - y) / view.scale + view.cy);

/* --------------------------------------------------------- weather fields */

function weatherIndex(ms) {
  const w = state.weather;
  if (!w || !w.times.length) return null;
  // times are "YYYY-MM-DDTHH:00" in GMT
  const first = Date.parse(w.times[0] + 'Z');
  const h = (ms - first) / 3600000;
  if (h < 0) return { i: 0, j: 0, f: 0 };
  const i = Math.min(w.times.length - 1, Math.floor(h));
  const j = Math.min(w.times.length - 1, i + 1);
  return { i, j, f: clamp(h - i, 0, 1) };
}

/** How far inside the weather grid a point is, 0 at the edge and 1 well in.
    Without this the grid's bounding box draws itself as a hard rectangle. */
function gridFalloff(lat, lon) {
  const w = state.weather;
  if (!w) return 0;
  const g = w.grid;
  const latMax = g.lat0 + (g.rows - 1) * g.dlat;
  const lonMax = g.lon0 + (g.cols - 1) * g.dlon;
  const margin = 2.2;
  const d = Math.min(lat - g.lat0, latMax - lat,
                     (lon - g.lon0) * 0.7, (lonMax - lon) * 0.7);
  const t = clamp(d / margin, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Bilinear in space, linear in time, over the coarse Open-Meteo grid. */
function sampleField(field, lat, lon, ti) {
  const w = state.weather;
  if (!w || !ti) return 0;
  const g = w.grid;
  const fr = (lat - g.lat0) / g.dlat;
  const fc = (lon - g.lon0) / g.dlon;
  if (fr < 0 || fc < 0 || fr > g.rows - 1 || fc > g.cols - 1) return 0;
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(g.rows - 1, r0 + 1), c1 = Math.min(g.cols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;
  const at = (arr, r, c) => arr[r * g.cols + c];
  const a = w[field][ti.i], b = w[field][ti.j];
  const mix = (arr) => lerp(lerp(at(arr, r0, c0), at(arr, r0, c1), tc),
                            lerp(at(arr, r1, c0), at(arr, r1, c1), tc), tr);
  return lerp(mix(a), mix(b), ti.f);
}

/* ------------------------------------------------------------ scene state */

function newScene() {
  return {
    main: null, mctx: null,
    wind: null, wctx: null,
    heat: null, hctx: null,
    lightSprite: null, dotSprite: null,
    nightImg: null, dayImg: null, nightW: 0, nightH: 0,
    cloudImg: null,
    particles: [],
    rand: mulberry32(1),
    landPath: null, lakePath: null,
    stars: [],
    tileCanvas: null, tileCredit: '', tileDim: 1, tileView: null,
    records: [], t0: 0, t1: 0, timeline: null,
  };
}

const previewCtx = { view: newView(), scene: newScene() };
const renderCtx = { view: newView(), scene: newScene() };

let view = previewCtx.view;
let scene = previewCtx.scene;

function useContext(cx) { view = cx.view; scene = cx.scene; }

function makeSprite(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0,
                                      size / 2, size / 2, size / 2);
  for (const [at, colour] of stops) grad.addColorStop(at, colour);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

function buildScene(w, h, canvas) {
  setupView(w, h);

  scene.main = canvas || $('view');
  scene.main.width = w; scene.main.height = h;
  scene.mctx = scene.main.getContext('2d', { alpha: false });

  scene.wind = document.createElement('canvas');
  scene.wind.width = w; scene.wind.height = h;
  scene.wctx = scene.wind.getContext('2d');

  scene.heat = document.createElement('canvas');
  scene.heat.width = w; scene.heat.height = h;
  scene.hctx = scene.heat.getContext('2d');

  /* Towns have to read as towns, not as a second kind of bird. The old sprite
     had a solid core and a pale gold cast - the same two things that make a
     bird mark a bird mark - so at night the country filled with thousands of
     little suns and the birds were lost in them. This one has no core at all,
     just sodium haze: a different colour, a different shape, and no hard
     centre for the eye to lock onto. */
  scene.lightSprite = makeSprite(64, [
    [0, 'rgba(255,164,74,0.46)'], [0.22, 'rgba(252,142,58,0.30)'],
    [0.55, 'rgba(240,120,48,0.10)'], [1, 'rgba(230,110,44,0)']]);
  scene.dotSprite = makeSprite(64, [
    [0, 'rgba(255,255,255,1)'], [0.22, 'rgba(255,255,255,0.65)'],
    [0.55, 'rgba(255,255,255,0.16)'], [1, 'rgba(255,255,255,0)']]);

  // Land and lakes as Path2D, built once in projected pixels.
  scene.landPath = new Path2D();
  for (const ring of state.geo.land) {
    scene.landPath.moveTo(px(ring[0][0]), py(ring[0][1]));
    for (let i = 1; i < ring.length; i++) {
      scene.landPath.lineTo(px(ring[i][0]), py(ring[i][1]));
    }
    scene.landPath.closePath();
  }
  scene.lakePath = new Path2D();
  for (const ring of (state.geo.lakes || [])) {
    scene.lakePath.moveTo(px(ring[0][0]), py(ring[0][1]));
    for (let i = 1; i < ring.length; i++) {
      scene.lakePath.lineTo(px(ring[i][0]), py(ring[i][1]));
    }
    scene.lakePath.closePath();
  }

  // Night-side stars, fixed to the frame.
  const sr = mulberry32(7);
  scene.stars = [];
  for (let i = 0; i < Math.round(w * h / 14000); i++) {
    scene.stars.push([sr() * w, sr() * h, sr() * 0.9 + 0.25, sr()]);
  }

  // Night/cloud fields are drawn at low resolution and smoothed up.
  scene.nightW = 120;
  scene.nightH = Math.max(40, Math.round(120 * h / w));
  scene.nightImg = scene.mctx.createImageData(scene.nightW, scene.nightH);
  scene.dayImg = scene.mctx.createImageData(scene.nightW, scene.nightH);
  scene.cloudImg = scene.mctx.createImageData(scene.nightW, scene.nightH);

  resetDynamic();
}

/* Start the clip again from the top. Changing the dates, the hours shown or
   the selection makes everything currently on screen wrong, and the
   lasting-trace layer would otherwise keep the old marks painted over the new
   ones for the rest of the clip. */
function restart() {
  resetDynamic();
  state.previewT = 0;
  lastPreviewTs = 0;
  renderPreviewAt(0, opts(), 1);
}

function resetDynamic() {
  scene.rand = mulberry32(20261024);
  scene.hctx.clearRect(0, 0, view.w, view.h);
  scene.wctx.clearRect(0, 0, view.w, view.h);
  seedParticles(Number($('o-wind-count').value));
}

function seedParticles(n) {
  scene.particles = [];
  for (let i = 0; i < n; i++) {
    scene.particles.push({
      x: scene.rand() * view.w,
      y: scene.rand() * view.h,
      age: scene.rand() * 90,
      life: 60 + scene.rand() * 90,
    });
  }
}

/* ------------------------------------------------------------ scene draw */

/* The preview fills whatever room the stage has. Aspect ratio is a property
   of the exported clip, not of looking at the map, so it is only asked for
   when a render is actually requested. */
function previewSize() {
  const stage = $('stage');
  // Full-bleed layouts run the map to the edges; the sidebar keeps a margin.
  const lay = document.body.dataset.layout || 'theatre';
  const pad = (lay === 'theatre' || lay === 'search') ? 0 : 28;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  /* Measure what sits under the canvas rather than assuming it. The old
     hardcoded 46 was right for the scrubber alone; with the mini control bar
     showing it is not, and a wrong guess here is what leaves the map either
     short of its box or overflowing it. */
  let furniture = 0;
  for (const sel of ['#scrub-wrap']) {
    const el = document.querySelector(sel);
    if (!el || el.hidden) continue;
    // Floated over the map rather than stacked under it? Then it costs the
    // canvas no height. On a phone the scrubber is fixed; on a desktop it is
    // a row in the column and has to be subtracted.
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'absolute') continue;
    furniture += el.getBoundingClientRect().height + 6;
  }
  const w = Math.max(360, (stage.clientWidth || 900) - pad);
  const h = Math.max(220, (stage.clientHeight || 700) - pad - furniture);
  return [Math.round(w * dpr), Math.round(h * dpr)];
}

function opts(forExport) {
  const [ew, eh] = $('o-size').value.split('x').map(Number);
  const [pw, ph] = previewSize();
  const [w, h] = forExport ? [ew, eh] : [pw, ph];
  return {
    w, h, exportW: ew, exportH: eh,
    duration: clamp(Number($('o-duration').value) || 30, 3, 180),
    fps: Number($('o-fps').value) || 30,
    format: $('o-format').value,
    night: $('o-night').checked,
    lights: $('o-lights').checked,
    wind: $('o-wind').checked,
    clouds: $('o-clouds').checked,
    rain: $('o-rain').checked,
    stars: $('o-stars').checked,
    windCount: Number($('o-wind-count').value),
    windSpeed: Number($('o-wind-speed').value),
    windFade: Number($('o-wind-fade').value),
    windWeight: Number($('o-wind-weight').value),
    windAlpha: Number($('o-wind-alpha').value),
    cloudAlpha: Number($('o-cloud-alpha').value),
    rainAlpha: Number($('o-rain-alpha').value),
    lightGlow: Number($('o-light-glow').value),
    nightDepth: Number($('o-night-depth').value),
    basemap: $('o-basemap').value,
    palette: PALETTES[$('o-basemap').value] || PALETTES.space,
    birdColour: $('o-bird-colour').value,
    trailHours: Number($('o-trail').value) || 9,
    dotSize: Number($('o-dot-size').value),
    dotGlow: Number($('o-dot-glow').value),
    sizeByCount: $('o-size-by-count').checked,
    ripple: $('o-ripple').checked,
    heat: $('o-heat').checked,
    showClock: $('o-show-clock').checked,
    showCounter: $('o-show-counter').checked,
    showProgress: $('o-show-progress').checked,
    showCredit: $('o-show-credit').checked,
    title: $('o-title').value.trim(),
    subtitle: $('o-subtitle').value.trim(),
    hudLayout: $('o-hud-layout').value,
    markStyle: $('o-mark-style').value,
  };
}

const lat2merc = (lat) => mercY(lat);

/** Pre-render a tile basemap for the current view into an offscreen canvas. */
async function loadBasemap(key) {
  // Tiles arrive asynchronously, so the context that asked for them has to be
  // captured here - a preview frame drawn while they are in flight would
  // otherwise rebind `view` and land the tiles in the wrong place.
  const vw = view;
  const sc = scene;
  const PX = (lon) => (mercX(lon) - vw.cx) * vw.scale + vw.w / 2;
  const PY = (lat) => vw.h / 2 - (mercY(lat) - vw.cy) * vw.scale;

  sc.tileCanvas = null;
  sc.tileCredit = '';
  sc.tileView = null;
  const spec = TILE_BASEMAPS[key];
  if (!spec) return;

  // Pick the zoom whose native pixel scale is closest to the output's.
  const worldPx = 2 * Math.PI * vw.scale;
  let z = Math.round(Math.log2(worldPx / 256));
  z = clamp(z, 2, spec.max);

  const n = Math.pow(2, z);
  const tileLon = (x) => (x / n) * 360 - 180;
  const tileLat = (y) => {
    const t = Math.PI - (2 * Math.PI * y) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  };

  const x0 = Math.max(0, Math.floor(((vw.west + 180) / 360) * n) - 1);
  const x1 = Math.min(n - 1, Math.ceil(((vw.east + 180) / 360) * n));
  const yOf = (lat) => {
    const r = lat * RAD;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  };
  const y0 = Math.max(0, Math.floor(yOf(vw.north)) - 1);
  const y1 = Math.min(n - 1, Math.ceil(yOf(vw.south)));

  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count > 400) return;          // refuse to hammer a tile server

  const c = document.createElement('canvas');
  c.width = vw.w; c.height = vw.h;
  const g = c.getContext('2d');

  const layers = [spec.url].concat(spec.labels ? [spec.labels] : []);
  for (const template of layers) {
    const jobs = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        jobs.push(new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const left = PX(tileLon(x)), right = PX(tileLon(x + 1));
            const top = PY(tileLat(y)), bottom = PY(tileLat(y + 1));
            // +1px stops hairline seams between neighbouring tiles.
            g.drawImage(img, left, top,
                        right - left + 1, bottom - top + 1);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        }));
      }
    }
    await Promise.all(jobs);
  }

  sc.tileCanvas = c;
  sc.tileCredit = spec.credit;
  sc.tileDim = spec.dim;
  // The geometry these pixels were drawn for. Panning changes `view` long
  // before replacement tiles can arrive, and the gap is what has to be
  // covered - see drawSeaAndLand.
  sc.tileView = { cx: vw.cx, cy: vw.cy, scale: vw.scale, w: vw.w, h: vw.h };
}

function drawSeaAndLand(ctx, o) {
  if (scene.tileCanvas && TILE_BASEMAPS[o.basemap]) {
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.save();
    ctx.globalAlpha = scene.tileDim == null ? 1 : scene.tileDim;
    /* Tiles are fetched over the network, so during a drag the canvas holds
       pixels for wherever the map used to be. Blitting them at 0,0 pinned the
       ground while the birds moved over it, and dropped it into place in one
       jump when the new tiles arrived. Instead, shift and scale the pixels we
       have to the view we are now looking at: the basemap tracks the gesture,
       slightly soft, and the real tiles replace it in the same position. */
    const tv = scene.tileView;
    if (tv && (tv.cx !== view.cx || tv.cy !== view.cy
               || tv.scale !== view.scale)) {
      const k = view.scale / tv.scale;
      ctx.translate(view.w / 2 - k * tv.w / 2 + (tv.cx - view.cx) * view.scale,
                    view.h / 2 - k * tv.h / 2 - (tv.cy - view.cy) * view.scale);
      ctx.scale(k, k);
    }
    ctx.drawImage(scene.tileCanvas, 0, 0);
    ctx.restore();
    return;
  }
  const p = o.palette;
  const g = ctx.createLinearGradient(0, 0, 0, view.h);
  g.addColorStop(0, p.sea0);
  g.addColorStop(1, p.sea1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.w, view.h);

  ctx.save();
  ctx.fillStyle = p.land;
  ctx.fill(scene.landPath, 'evenodd');
  ctx.lineWidth = Math.max(0.6, view.w / 1400);
  ctx.strokeStyle = p.coast;
  ctx.stroke(scene.landPath);
  ctx.fillStyle = p.lake;
  ctx.fill(scene.lakePath, 'evenodd');
  ctx.restore();
}

function drawNight(ctx, o, ms) {
  const sun = solarPosition(ms);
  const night = scene.nightImg, day = scene.dayImg;
  const dn = night.data, dd = day.data;
  const W = scene.nightW, H = scene.nightH;
  for (let yy = 0; yy < H; yy++) {
    const lat = latAt((yy + 0.5) * view.h / H);
    for (let xx = 0; xx < W; xx++) {
      const lon = lonAt((xx + 0.5) * view.w / W);
      const el = elevationFrom(sun, lat, lon);
      const i = (yy * W + xx) * 4;

      // Twilight ramp: full night below -18 deg, clear day above +2. The
      // ceiling matters - at full strength the night side goes so black that
      // the coastline and the records on it disappear.
      let a = clamp((2 - el) / 20, 0, 1);
      a = a * a * (3 - 2 * a);                  // smoothstep
      a *= 0.88;
      // Warm band right at the terminator, cooling into deep blue.
      const warm = clamp(1 - Math.abs(el + 1.5) / 7, 0, 1);
      dn[i] = Math.round(lerp(6, 72, warm));
      dn[i + 1] = Math.round(lerp(9, 34, warm));
      dn[i + 2] = Math.round(lerp(26, 20, warm));
      dn[i + 3] = Math.round(255 * a * o.nightDepth);

      // Lift the sunlit side as well as darkening the shadowed one. Without
      // this the terminator only ever subtracts, and the day half of the
      // world looks no different from the night half.
      const lift = clamp(el / 26, 0, 1);
      dd[i] = 150; dd[i + 1] = 176; dd[i + 2] = 205;
      dd[i + 3] = Math.round(255 * lift * 0.30);
    }
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalCompositeOperation = 'screen';
  putScaled(ctx, day, W, H);
  ctx.globalCompositeOperation = 'source-over';
  putScaled(ctx, night, W, H);
  ctx.restore();
}

let _scratch = null;
function putScaled(ctx, img, W, H) {
  if (!_scratch) _scratch = document.createElement('canvas');
  _scratch.width = W; _scratch.height = H;
  _scratch.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(_scratch, 0, 0, W, H, 0, 0, view.w, view.h);
}

function drawStars(ctx, o, ms) {
  const sun = solarPosition(ms);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y, r, tw] of scene.stars) {
    const el = elevationFrom(sun, latAt(y), lonAt(x));
    const a = clamp((-6 - el) / 10, 0, 1) * (0.35 + 0.65 * tw);
    if (a <= 0.01) continue;
    const flicker = 0.85 + 0.15 * Math.sin(ms / 900 + tw * 40);
    ctx.globalAlpha = a * flicker * 0.9;
    ctx.fillStyle = '#dfe9ff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCityLights(ctx, o, ms) {
  const sun = solarPosition(ms);
  const sprite = scene.lightSprite;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [lon, lat, pop] of state.cities.cities) {
    const el = elevationFrom(sun, lat, lon);
    // Lights fade up through dusk and are full once the sun is well down.
    const on = clamp((-1 - el) / 7, 0, 1);
    if (on <= 0.02) continue;
    const x = px(lon), y = py(lat);
    if (x < -40 || y < -40 || x > view.w + 40 || y > view.h + 40) continue;
    const mag = Math.log10(Math.max(pop, 500)) - 2.4;       // ~0.3 .. 4
    // Wider and much fainter than before: a spread of glow where a settlement
    // is, rather than a point marking it.
    const size = clamp(mag * 11, 5, 72) * (view.w / 1080) * (0.7 + o.lightGlow * 0.6);
    ctx.globalAlpha = clamp(on * (0.09 + mag * 0.06) * o.lightGlow, 0, 1);
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  }
  ctx.restore();
}

function drawClouds(ctx, o, ms) {
  const ti = weatherIndex(ms);
  if (!ti) return;
  const sun = solarPosition(ms);
  const img = scene.cloudImg;
  const d = img.data;
  const W = scene.nightW, H = scene.nightH;
  for (let yy = 0; yy < H; yy++) {
    const lat = latAt((yy + 0.5) * view.h / H);
    for (let xx = 0; xx < W; xx++) {
      const lon = lonAt((xx + 0.5) * view.w / W);
      const i = (yy * W + xx) * 4;
      const edge = gridFalloff(lat, lon);
      if (edge <= 0.01) { d[i + 3] = 0; continue; }
      const cover = o.clouds ? sampleField('cloud', lat, lon, ti) / 100 : 0;
      const rain = o.rain ? clamp(sampleField('precip', lat, lon, ti) / 1.6, 0, 1) : 0;
      if (cover <= 0.03 && rain <= 0.02) { d[i + 3] = 0; continue; }
      const el = elevationFrom(sun, lat, lon);
      // Cloud tops catch the sun; on the night side they only dim the ground.
      const lit = clamp((el + 10) / 20, 0.18, 1);
      // Cloud is a neutral grey veil, rain a saturated blue. Shading rain as
      // a slightly bluer cloud made the two impossible to tell apart, so rain
      // now takes over the colour entirely wherever it is falling.
      const r0 = lerp(214, 56, rain), g0 = lerp(224, 126, rain),
            b0 = lerp(236, 240, rain);
      d[i] = Math.round(r0 * lit);
      d[i + 1] = Math.round(g0 * lit);
      d[i + 2] = Math.round(b0 * Math.max(lit, 0.55));
      // Thin cloud should veil, not erase; rain should be unmistakable.
      const body = Math.pow(cover, 1.6) * o.cloudAlpha * 0.55
                 + Math.pow(rain, 0.7) * o.rainAlpha;
      d[i + 3] = Math.round(255 * clamp(body * edge, 0, 0.82));
    }
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  putScaled(ctx, img, W, H);
  ctx.restore();
}

function stepWind(o, ms, dtFrames) {
  const ti = weatherIndex(ms);
  if (!ti) return;
  const wctx = scene.wctx;

  // Fade the existing trails rather than clearing them.
  wctx.save();
  wctx.globalCompositeOperation = 'destination-out';
  wctx.fillStyle = `rgba(0,0,0,${o.windFade})`;
  wctx.fillRect(0, 0, view.w, view.h);
  wctx.restore();

  wctx.save();
  wctx.lineCap = 'round';
  wctx.lineWidth = Math.max(0.8, (view.w / 1500) * o.windWeight);
  /* Particles advance per clip-frame, so this constant sets how fast the
     field reads. At the old value of 1.9 a 10 m/s wind crossed the whole
     frame in about a second, which looked like static rather than weather.
     At 0.12 the same wind takes roughly a quarter of a minute, and the
     slider still reaches a gale if that is what is wanted.

     Scaling by dtFrames keeps the live preview and the exported clip moving
     at the same rate whatever frame rate the screen happens to run at. */
  const step = clamp(dtFrames == null ? 1 : dtFrames, 0.25, 3);
  const k = o.windSpeed * (view.w / 1080) * 0.42 * step;

  for (const p of scene.particles) {
    const lat = latAt(p.y), lon = lonAt(p.x);
    const u = sampleField('u', lat, lon, ti);
    const v = sampleField('v', lat, lon, ti);
    const sp = Math.hypot(u, v);
    const x0 = p.x, y0 = p.y;
    p.x += u * k;
    p.y -= v * k;                       // screen y grows downward
    p.age += dtFrames;

    const out = p.x < -10 || p.y < -10 || p.x > view.w + 10 || p.y > view.h + 10;
    if (out || p.age > p.life || (sp < 0.05 && scene.rand() < 0.02)) {
      p.x = scene.rand() * view.w;
      p.y = scene.rand() * view.h;
      p.age = 0;
      p.life = 60 + scene.rand() * 90;
      continue;
    }
    // Cool for light airs, warm for a gale.
    const t = clamp(sp / 22, 0, 1);
    const r = Math.round(lerp(120, 255, t * t));
    const g = Math.round(lerp(198, 228, t));
    const b = Math.round(lerp(255, 180, t));
    const fade = 1 - clamp(p.age / p.life, 0, 1);
    const edge = gridFalloff(lat, lon);
    // Enough to read as weather, not so much that the land vanishes
    // underneath it; the sliders go a long way further if wanted.
    const alpha = clamp((0.09 + 0.5 * t) * fade * edge
                        * (0.6 + o.windWeight * 0.4) * (o.windAlpha * 1.8),
                        0, 1);
    wctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    wctx.beginPath();
    wctx.moveTo(x0, y0);
    wctx.lineTo(p.x, p.y);
    wctx.stroke();
  }
  wctx.restore();
}

function speciesColour(spIdx) {
  // Decorative identity only: the title names the species when one is chosen,
  // so these hues carry no load the viewer has to decode.
  const h = (spIdx * 137.508) % 360;
  return `hsl(${h.toFixed(0)}, 78%, 66%)`;
}

const SOURCE_COLOURS = ['#6da7ec', '#eb8a4a', '#35c295', '#d7a0ff', '#f2e06b'];

function birdColour(o, rec) {
  if (o.birdColour === 'white') return '#ffffff';
  if (o.birdColour === 'species') return speciesColour(rec[SP]);
  if (o.birdColour === 'source') return SOURCE_COLOURS[rec[SRC] % SOURCE_COLOURS.length];
  return '#ffd9a0';
}

/* The most marks alive at once anywhere in the clip. A two-pointer sweep of
   the time-sorted records, cached per (record set, window) because it is the
   same answer for every frame of a clip. */
let _peakCache = null;

function peakAlive(recs, windowMs) {
  if (_peakCache && _peakCache.recs === recs && _peakCache.windowMs === windowMs) {
    return _peakCache.value;
  }
  let lo = 0;
  let best = 1;
  for (let hi = 0; hi < recs.length; hi++) {
    while (recs[lo].tp < recs[hi].tp - windowMs) lo++;
    if (hi - lo + 1 > best) best = hi - lo + 1;
  }
  _peakCache = { recs, windowMs, value: best };
  return best;
}

function drawBirds(ctx, o, ms, lite) {
  const recs = scene.records || [];
  const scale = view.w / 1080;
  const nowPos = timelinePos(ms);

  /* Moderate the symbology by how many marks are alive at once, not by the
     raw record count: that is what actually decides whether the map reads or
     turns into a white sheet. Six Storm Petrel records need enlarging; a
     quarter of a million records need damping in three ways at once -
     smaller, dimmer, and lingering for less time, since a long trail is what
     piles them up in the first place. */
  const span = (scene.timeline && scene.timeline.total)
    || Math.max(1, scene.t1 - scene.t0);
  const askedWindow = o.trailHours * 3600000;
  const concurrent = recs.length * clamp(askedWindow / span, 0, 1);
  /* The neutral point is what a normal single-species or single-group
     selection looks like - a few dozen marks on screen at once. Anchoring it
     at a couple of thousand meant that anything smaller than "every species
     in Britain" got boosted, so a group like the seabirds came out glaring.
     The exponents are gentle so the curve corrects rather than dominates. */
  const load = clamp(concurrent / 60, 0.005, 400);
  const sizeK = clamp(Math.pow(load, -0.18), 0.36, 1.9);
  const glowK = clamp(Math.pow(load, -0.25), 0.13, 1.4);
  const windowK = clamp(Math.pow(load, -0.12), 0.5, 1);
  const windowMs = askedWindow * windowK;
  const scarcity = sizeK;

  // Records are time-sorted, and shown-time is monotonic in real time, so the
  // slice inside the trail window can still be found by bisection.
  let lo = 0, hi = recs.length - 1, start = recs.length;
  const fromPos = nowPos - windowMs;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (recs[mid].tp >= fromPos) { start = mid; hi = mid - 1; } else lo = mid + 1;
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  let shown = 0;
  /* Drawing eighteen thousand glowing sprites cannot be done sixty times a
     second on any machine, so the scatter is thinned to a budget and the
     survivors are brightened to compensate. The counter above is unaffected -
     it is computed from the records, not from what was drawn.

     The thinning must be keyed to the record's own index, not to its position
     relative to the moving window: sampling "every nth from the start" picks a
     different subset every frame as the window advances, which is precisely
     what made the map flicker. Keyed this way a record is either always drawn
     or never drawn at a given density, so the scatter holds still. */
  const budget = lite ? 2500 : 6000;
  // Where the trail window ends, so the loop stops at the playhead.
  let elo = start, ehi = recs.length - 1, end = recs.length;
  while (elo <= ehi) {
    const mid = (elo + ehi) >> 1;
    if (recs[mid].tp > nowPos) { end = mid; ehi = mid - 1; } else elo = mid + 1;
  }
  /* Keep a fixed fraction, chosen per record by a hash of its own index.
     `i % stride` looked stable because the key was absolute, but stride is an
     integer: when it stepped from 3 to 2, two thirds of the scatter was
     swapped for a different two thirds in a single frame - the points
     "shifting places" rather than fading. A per-record score makes the kept
     set *nested*: as the fraction eases up and down, marks join and leave one
     at a time and everything else stays exactly where it was.

     The fraction is pinned to the clip's BUSIEST moment, not to this frame.
     Sizing it frame by frame meant a busy evening drew a smaller share of its
     marks and brightened each one to compensate, which quietly cancelled out
     the very thing the clip is for: measured over a fortnight of Redwing
     arriving, the scatter grew 2.66x where the all-species view managed only
     1.59x. Fixed to the peak, what is drawn stays strictly proportional to
     how many birds are actually out there. */
  const mark = o.markStyle || 'glow';
  /* Styles that point somewhere read the same wind field the particles do, so
     a streaking record and the air around it agree. Sampled per mark; the
     grid lookup is a couple of multiplies, and it is only done for the styles
     that ask for it. */
  const wantsWind = mark === 'streak' || mark === 'glyph';
  const windTi = wantsWind ? weatherIndex(ms) : null;
  const keep = clamp(budget / peakAlive(recs, windowMs), 0, 1);
  const thinBoost = keep < 1 ? Math.min(1.7, Math.sqrt(1 / keep)) : 1;
  const sizeComp = keep < 1 ? Math.min(1.35, Math.pow(1 / keep, 0.18)) : 1;
  const pad = 40 * scale;
  for (let i = start; i < end; i++) {
    const r = recs[i];
    if (r.tp > nowPos) break;
    if (keep < 1 && r.u >= keep) continue;
    const x = px(r.lon), y = py(r.lat);
    // Once the clip is framed on one region, records outside it are neither
    // drawn nor counted - a counter reporting the whole country would be
    // describing something the viewer cannot see.
    if (x < -pad || y < -pad || x > view.w + pad || y > view.h + pad) continue;
    shown++;
    const age = (nowPos - r.tp) / windowMs;   // 0 fresh .. 1 gone
    /* Settled between the two extremes this has been through. The original
       1.7 on a 0.30 floor held a mark at over a third of full brightness for
       four fifths of its life, so even a short window read as a long smear;
       2.6 on 0.16 then snuffed them out too fast. A mark still never goes out
       while it is being shown - fading to nothing early left the lasting-trace
       layer looking dead - it just spends more of its life dim than bright. */
    const fade = Math.pow(1 - age, 2.05);
    const live = 0.19 + 0.81 * fade;
    const pulse = 1 + 0.85 * Math.pow(1 - age, 3);
    const base = (o.sizeByCount ? r.r : 4) * o.dotSize * scale * scarcity * pulse
               * sizeComp;

    /* How a record is drawn. Every style is fed the same `base`, `live` and
       `fade`, so the density calibration and the fade curve apply to all of
       them equally - only the shape changes. */
    const coreAlpha = clamp(live * clamp(glowK * thinBoost, 0.5, 1.3), 0, 1);
    const haloAlpha = clamp(0.30 * live * o.dotGlow * glowK * thinBoost, 0, 1);

    // The glow halo, under everything.
    const flatMark = mark === 'outline' || mark === 'diamond'
      || mark === 'spire' || mark === 'glyph';
    if (o.dotGlow > 0 && !flatMark) {
      const spread = mark === 'soft' ? 1.4 : 1;
      const halo = base * (5.5 + 5 * o.dotGlow) * (0.6 + 0.4 * fade) * spread;
      ctx.globalAlpha = clamp(haloAlpha * (mark === 'soft' ? 1.3 : 1), 0, 1);
      ctx.fillStyle = r.colour;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(halo / 64, halo / 64);
      ctx.drawImage(tintedDot(r.colour), -32, -32, 64, 64);
      ctx.restore();
    }

    ctx.globalAlpha = coreAlpha;
    ctx.fillStyle = r.colour;
    ctx.strokeStyle = r.colour;

    if (mark === 'soft') {
      // Haze only - no hard centre at all. Reads as cloud rather than pins.
    } else if (mark === 'ring' || mark === 'outline') {
      /* A hollow contact. `ring` opens outwards as it ages, like a sonar
         return; `outline` holds its size and carries no glow, which is the
         most legible of the lot when thousands overlap. */
      const rr = mark === 'ring' ? base * (1.5 + 2.2 * (1 - fade)) : base * 1.7;
      ctx.lineWidth = Math.max(1, (mark === 'ring' ? 1.7 : 1.5) * scale);
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.stroke();
    } else if (mark === 'streak') {
      /* A record as a motion trail rather than a position: the head is where
         the bird is, the tail is where the air is coming from. On a migration
         map this is the only style that says anything about direction. */
      let a = hash32(i * 7919) * Math.PI * 2;
      let mag = 1;
      if (windTi) {
        const u = sampleField('u', r.lat, r.lon, windTi);
        const v = sampleField('v', r.lat, r.lon, windTi);
        if (u || v) { a = Math.atan2(-v, -u); mag = clamp(Math.hypot(u, v) / 9, 0.45, 1.8); }
      }
      const len = base * (5.5 + 5 * fade) * mag;
      const g = ctx.createLinearGradient(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.addColorStop(0, r.colour);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.strokeStyle = g;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, base * 0.85);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
      ctx.fillStyle = r.colour;
      ctx.beginPath();
      ctx.arc(x, y, base * 0.85, 0, Math.PI * 2);
      ctx.fill();
    } else if (mark === 'flock') {
      /* One record drawn as the several birds it usually is - a tight scatter
         of specks whose spread grows with the count. Dense areas become
         texture instead of a single blown-out disc. */
      const n = clamp(2 + Math.round(Math.sqrt(r.count || 1) * 1.1), 3, 9);
      const spread = base * 2.6;
      for (let k = 0; k < n; k++) {
        const h1 = hash32(i * 2654 + k * 7717);
        const h2 = hash32(i * 9151 + k * 3313);
        const ang = h1 * Math.PI * 2;
        const rad = Math.sqrt(h2) * spread;
        ctx.beginPath();
        ctx.arc(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad,
                Math.max(0.6, base * 0.42), 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (mark === 'spire') {
      /* A skyline: every record stands up off the map, as tall as its count
         is big. Reads as a bar chart laid over a country. */
      const h = base * (3 + Math.sqrt(r.count || 1) * 2.2);
      const g = ctx.createLinearGradient(x, y, x, y - h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, r.colour);
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(1, base * 0.7);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - h);
      ctx.stroke();
      ctx.fillStyle = r.colour;
      ctx.beginPath();
      ctx.arc(x, y - h, base * 0.75, 0, Math.PI * 2);
      ctx.fill();
    } else if (mark === 'glyph') {
      /* An actual bird, banking into the wind. Only legible when there is
         room for it, so it is the style for one scarce species, not for all
         of Britain at once. */
      let a = 0;
      if (windTi) {
        const u = sampleField('u', r.lat, r.lon, windTi);
        const v = sampleField('v', r.lat, r.lon, windTi);
        if (u || v) a = Math.atan2(v, u);
      }
      const z = base * 2.1;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.beginPath();
      // A shallow gull: two swept wings meeting at the body.
      ctx.moveTo(-z, -z * 0.42);
      ctx.quadraticCurveTo(-z * 0.4, z * 0.3, 0, -z * 0.06);
      ctx.quadraticCurveTo(z * 0.4, z * 0.3, z, -z * 0.42);
      ctx.quadraticCurveTo(z * 0.42, z * 0.72, 0, z * 0.3);
      ctx.quadraticCurveTo(-z * 0.42, z * 0.72, -z, -z * 0.42);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else if (mark === 'diamond') {
      // A cartographic mark rather than an astronomical one.
      const d = base * 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - d); ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d); ctx.lineTo(x - d, y);
      ctx.closePath();
      ctx.fill();
    } else {
      // glow and spark share a solid core.
      ctx.beginPath();
      ctx.arc(x, y, base, 0, Math.PI * 2);
      ctx.fill();
      if (mark === 'spark') {
        // Diffraction spikes, the way a bright point reads through a lens.
        const len = base * (3.4 + 2.2 * fade);
        ctx.globalAlpha = clamp(coreAlpha * 0.55, 0, 1);
        ctx.lineWidth = Math.max(0.75, 1.1 * scale);
        ctx.beginPath();
        ctx.moveTo(x - len, y); ctx.lineTo(x + len, y);
        ctx.moveTo(x, y - len); ctx.lineTo(x, y + len);
        ctx.stroke();
      }
    }

    // A ripple as it lands, and a brighter ring for a rarity.
    if (o.ripple) {
      const rippleAge = (nowPos - r.tp) / (windowMs * 0.14);
      if (rippleAge < 1) {
        const rr = base * (1 + rippleAge * 11);
        ctx.globalAlpha = (1 - rippleAge) * 0.5;
        ctx.strokeStyle = r.notable ? '#ff7d7d' : r.colour;
        ctx.lineWidth = Math.max(1, 2.2 * scale) * (1 - rippleAge);
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (r.notable) {
      ctx.globalAlpha = clamp(0.5 * fade, 0, 1);
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = Math.max(1, 1.6 * scale);
      ctx.beginPath();
      ctx.arc(x, y, base * 2.1, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (o.heat && !lite && age < 0.04) {
      // Scale the deposit to how much is being plotted: the same alpha that
      // paints a single scarce species beautifully turns 40,000 records into
      // a white sheet within seconds.
      scene.hctx.globalCompositeOperation = 'lighter';
      scene.hctx.globalAlpha = clamp(0.12 * glowK * glowK, 0.004, 0.12);
      const hs = base * 6;
      scene.hctx.drawImage(tintedDot(r.colour), x - hs / 2, y - hs / 2, hs, hs);
    }
  }
  ctx.restore();
  // `shown` here is what is drawn; the HUD reports the running totals.
  return { shown, ...cumulativeAt(nowPos) };
}

const _tintCache = new Map();
function tintedDot(colour) {
  let c = _tintCache.get(colour);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.drawImage(scene.dotSprite, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = colour;
  g.fillRect(0, 0, 64, 64);
  _tintCache.set(colour, c);
  return c;
}

/* --------------------------------------------------------------- the HUD */

/* A bird in flight, drawn as two wing strokes meeting at the body. Vector
   rather than an image file so it scales cleanly to any output size and is
   never a missing asset in a rendered frame. */
const ACCENT = '#a9e34b';


function hudFont(size, weight) {
  return `${weight} ${Math.round(size)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
}

function drawHud(ctx, o, ms, result, progress) {
  const shown = typeof result === 'number' ? result : result.shown;
  const tally = (result && result.tally) || new Map();

  /* The HUD is laid out for a 1080-wide frame. On a phone the live canvas is
     only ~390 CSS pixels across, so that scale puts the counter at about five
     pixels - unreadable. Boost it back up for the on-screen view; an exported
     frame keeps the true scale so the clip is laid out as designed. */
  const exporting = scene === renderCtx.scene;
  const displayW = exporting ? view.w
    : (parseFloat(scene.main && scene.main.style.width) || view.w);
  // 1.45 still left the furniture small on a 390-pixel phone; 1.9 brings it
  // back to roughly the apparent size it has on a desktop.
  const boost = exporting ? 1 : clamp(1080 / Math.max(displayW, 1), 1, 1.9);
  const s = (view.w / 1080) * boost;
  // On a phone the frame cannot carry the full furniture, so the on-screen
  // HUD drops to a compact arrangement. Exports are never compact.
  const compact = !exporting && displayW < 620;
  const pad = (compact ? 26 : 42) * s;
  /* The theatre layout floats a toolbar across the top of the map on screen.
     Start the overlay below it there - and only there: an exported frame has
     no toolbar, so it keeps the true margin. */
  const topInset = (!exporting && !compact
                    && document.body.dataset.layout === 'theatre') ? 50 * s : 0;
  ctx.save();
  ctx.textBaseline = 'top';

  // A soft vignette keeps the eye in the middle of the frame.
  const vg = ctx.createRadialGradient(view.w / 2, view.h / 2, view.h * 0.35,
                                      view.w / 2, view.h / 2, view.h * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, view.w, view.h);

  const title = o.title || defaultTitle();
  const subtitle = o.subtitle || defaultSubtitle();
  /* Two arrangements of the same content. "split" keeps the middle of the
     frame clear - title top left, clock top right, numbers at the foot - so
     nothing is ever drawn over the birds. "column" stacks it all down the
     left, which is tighter but reaches into the middle on a square crop. */
  const split = o.hudLayout !== 'column' && !compact;

  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 14 * s;

  /* When a species is chosen, its photograph takes the logo's place beside
     the title - the bird's name and the bird itself together. */
  const badge = (compact ? 58 : 104) * s;
  const photo = speciesPhotos.find((im) => im.complete && im.naturalWidth);
  /* The running total sits on the photograph rather than below it: the bird
     and its number are one thing, and it buys back a whole line of the
     column. Drawn here, so the column skips it (see `countOnBadge`). */
  const countOnBadge = !!photo && o.showCounter;
  if (photo) {
    const cx = pad + badge / 2;
    const cy = pad + topInset + badge / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, badge / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(photo, pad, pad + topInset, badge, badge);
    if (countOnBadge) {
      /* A soft pool of shade behind the digits only, rather than a wash over
         the whole photograph - the bird stays lit at the edges and the number
         still reads. The heavy bottom-weighted scrim this replaces made the
         picture too dark to make out. */
      const scrim = ctx.createRadialGradient(cx, cy, 0, cx, cy, badge * 0.54);
      scrim.addColorStop(0, 'rgba(6,8,12,0.52)');
      scrim.addColorStop(0.55, 'rgba(6,8,12,0.30)');
      scrim.addColorStop(1, 'rgba(6,8,12,0)');
      ctx.fillStyle = scrim;
      ctx.fillRect(pad, pad + topInset, badge, badge);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, badge / 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2 * s;
    ctx.stroke();

    if (countOnBadge) {
      const label = shown.toLocaleString('en-GB');
      // Shrink to fit: six digits need more room than two.
      let fs = badge * 0.34;
      ctx.font = hudFont(fs, 700);
      const room = badge * 0.84;
      const w = ctx.measureText(label).width;
      if (w > room) {
        fs *= room / w;
        ctx.font = hudFont(fs, 700);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';          // dead centre of the photograph
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.95)';
      ctx.shadowBlur = 10 * s;
      ctx.fillStyle = 'rgba(255,233,195,0.99)';
      ctx.fillText(label, cx, cy);
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }
  }
  // No mark: the wordmark carries the name on its own. When a species is
  // chosen its photograph still sits beside it, and the text indents for that.
  const textX = photo ? pad + badge + 13 * s : pad;

  // The default title is set in two tones, the way the app's own wordmark is.
  /* Everything the viewer has to read is stacked in this one column. Spread
     across three corners - the time top right, the running count bottom left,
     the species somewhere else again - it made the eye hunt around the frame
     for a story that should arrive all at once. `flowY` walks down the
     column, and each block moves it on by its own height, rather than every
     block guessing at a fixed offset from the top. */
  let flowY = pad + topInset;
  const titleSize = (compact ? 24 : 42) * s;
  const named = title !== 'UK Bird Map';

  const wordmark = (size, weight, alpha) => {
    ctx.font = hudFont(size, weight);
    ctx.fillStyle = `rgba(244,242,238,${alpha})`;
    ctx.fillText('UK Bird ', textX, flowY);
    const w = ctx.measureText('UK Bird ').width;
    ctx.font = hudFont(size, weight === 300 ? 650 : weight);
    ctx.fillStyle = ACCENT;
    ctx.fillText('Map', textX + w, flowY);
  };

  if (named) {
    /* A clip about Redwing should say Redwing in the big type - but the app's
       name should not vanish with it, so it sits above as a small eyebrow and
       the bird gets the headline. */
    const eyebrow = (compact ? 12.5 : 17) * s;
    wordmark(eyebrow, 600, 0.74);
    flowY += eyebrow * 1.45;
    ctx.font = hudFont(titleSize, 600);
    ctx.fillStyle = '#f4f2ee';
    ctx.fillText(title, textX, flowY);
  } else {
    wordmark(titleSize, 300, 1);
  }
  flowY += titleSize * 1.14;

  if (!compact) {
    ctx.fillStyle = 'rgba(232,230,224,0.72)';
    ctx.font = hudFont(19 * s, 400);
    ctx.fillText(subtitle, textX, flowY);
    flowY += 27 * s;
  }
  flowY += (compact ? 6 : 10) * s;
  /* The photograph is taller than the two lines of text beside it, so the
     column has to start below it or the clock lands on the bird. */
  if (photo) flowY = Math.max(flowY, pad + topInset + badge + (compact ? 9 : 13) * s);
  /* One left edge for the whole column, so it reads as a single block with
     the mark hanging off to its left. On a phone the indent would eat too
     much of a narrow frame, so there the column goes flush instead. */
  const colX = compact ? pad : textX;

  // The birds the clip is about, pictured beside their names.
  // The first bird is already beside the title, so only show a row here when
  // more than one species is selected.
  const ready = (compact || speciesPhotos.length < 2) ? []
    : speciesPhotos.filter((im) => im.complete && im.naturalWidth).slice(1);
  if (ready.length) {
    const size = 64 * s;
    const gap = 10 * s;
    let x = colX;
    const y = flowY;
    flowY += size + 12 * s;
    ctx.save();
    for (const im of ready) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(im, x, y, size, size);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2 * s;
      ctx.stroke();
      x += size + gap;
    }
    ctx.restore();
  }

  if (o.showClock) {
    const d = new Date(ms);
    // One line: the time first, the date beside it. No weekday - it says
    // nothing about a migration - and a short month so it stays on the line.
    const day = d.toLocaleDateString('en-GB',
      { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const time = d.toLocaleTimeString('en-GB',
      { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    /* The date is the thing the clip is actually about, so it is set nearly
       as large as the clock and it announces itself when the day turns.

       The pulse is measured in SHOWN time, not wall time: `timelinePos`
       already excludes any hours being skipped, so "how long since midnight"
       still works when midnight itself is never drawn - and because it is
       derived from `ms` alone it is identical in the preview and the export,
       frame for frame. */
    const dayStart = Math.floor(ms / 86400000) * 86400000;
    const pulseSpan = Math.max(1, (scene.timeline && scene.timeline.total)
      || (scene.t1 - scene.t0)) * (0.55 / Math.max(1, o.duration));
    const sinceDay = timelinePos(ms) - timelinePos(Math.max(dayStart, scene.t0));
    const pulse = clamp(1 - sinceDay / pulseSpan, 0, 1);
    const pop = pulse * pulse;            // eased, so it snaps then settles

    const timeSize = (compact ? 25 : 38) * s;
    const dateBase = (compact ? 19 : 27) * s;
    const dateSize = dateBase * (1 + 0.34 * pop);
    const gap = (compact ? 9 : 13) * s;
    // The date sits on the time's own baseline rather than the top of its box.
    const dateDrop = timeSize * (compact ? 0.30 : 0.32);
    /* Lay out for the biggest the date ever gets, not its size this frame.
       In the split layout the clock is right-aligned off `dayW`, so measuring
       the pulsing size would shove the whole block sideways on every day
       change - and at the frame's edge it would overflow. */
    ctx.font = hudFont(dateBase * 1.34, 600);
    const dayW = ctx.measureText(day).width;
    ctx.font = hudFont(timeSize, 300);
    const timeW = ctx.measureText(time).width;
    // Split layout hangs the clock off the opposite corner; the column keeps
    // it in line under the title. Either way the time leads and the date
    // follows it on the same line.
    const clockX = split ? view.w - pad - timeW - gap - dayW : colX;
    const clockY = split ? pad + topInset : flowY;
    ctx.fillStyle = '#f4f2ee';
    ctx.fillText(time, clockX, clockY);
    // Brightens to white at the turn of the day, then settles back.
    ctx.fillStyle = `rgba(${Math.round(232 + 23 * pop)},`
      + `${Math.round(230 + 25 * pop)},${Math.round(224 + 31 * pop)},`
      + `${(0.72 + 0.28 * pop).toFixed(3)})`;
    ctx.font = hudFont(dateSize, pop > 0.5 ? 600 : 500);
    ctx.fillText(day, clockX + timeW + gap, clockY + dateDrop);
    if (!split) flowY += (compact ? 34 : 50) * s;
  }

  if (o.showCounter) {
    // The running total, then the species carrying it.
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, compact ? 6 : 10);
    const totalH = (compact ? 34 : 42) * s;
    const rowH0 = (compact ? 19 : 21) * s;

    /* In the split layout this block hangs off the bottom of the frame, so
       its height has to be known before anything is drawn - hence measuring
       it rather than just flowing downwards. The credit shares that baseline,
       so lift clear of it when it is showing. */
    if (split) {
      const rowsH = top.length > 1 ? top.length * rowH0 : 0;
      const creditH = (o.showCredit && !compact) ? 24 * s : 0;
      flowY = view.h - pad - creditH - (countOnBadge ? 0 : totalH) - rowsH;
    }

    if (!countOnBadge) {
      ctx.fillStyle = 'rgba(255,217,160,0.92)';
      ctx.font = hudFont((compact ? 26 : 32) * s, 600);
      ctx.fillText(shown.toLocaleString('en-GB'), colX, flowY);
      flowY += totalH;
    }

    if (top.length > 1) {
      // A ranked bar list, best first. The order shifts as the clip runs, so
      // the species carrying the moment is always at the top.
      const nameW = (compact ? 100 : 132) * s;
      const barW = (compact ? 52 : 86) * s;
      const rowH = rowH0;
      const max = (scene.cumulative && scene.cumulative.finalMax)
                  || top[0][1] || 1;
      const fs = (compact ? 12.5 : 13) * s;
      ctx.font = hudFont(fs, 400);
      /* The count leads the row. Sized to the widest number in the list and
         right-aligned, so the digits stack into a column that can be read
         straight down without the species names getting in the way. */
      let cntW = 0;
      for (const [, n] of top) {
        cntW = Math.max(cntW, ctx.measureText(n.toLocaleString('en-GB')).width);
      }
      const cntEnd = colX + cntW;
      const dotX = cntEnd + (compact ? 13 : 15) * s;
      const rowX = cntEnd + (compact ? 22 : 26) * s;
      for (let i = 0; i < top.length; i++) {
        const [sp, n] = top[i];
        const y = flowY + i * rowH;
        let name = (state.data.species[sp] || [''])[0];
        if (ctx.measureText(name).width > nameW - 8 * s) {
          while (ctx.measureText(name + '\u2026').width > nameW - 8 * s
                 && name.length > 4) {
            name = name.slice(0, -1);
          }
          name += '\u2026';
        }
        const swatch = (o.birdColour === 'species')
          ? speciesColour(sp) : 'rgba(255,205,135,0.9)';

        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(240,238,232,0.92)';
        ctx.fillText(n.toLocaleString('en-GB'), cntEnd, y);
        ctx.textAlign = 'left';

        ctx.fillStyle = swatch;
        ctx.beginPath();
        ctx.arc(dotX, y + fs * 0.55, (compact ? 3.4 : 4) * s, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(232,230,224,0.78)';
        ctx.fillText(name, rowX, y);

        const bx = rowX + nameW;
        const bh = 4.5 * s;
        const by = y + fs * 0.55 - bh / 2;
        const track = ctx.createLinearGradient(bx, 0, bx + barW, 0);
        track.addColorStop(0, 'rgba(255,255,255,0.055)');
        track.addColorStop(1, 'rgba(255,255,255,0.20)');
        ctx.fillStyle = track;
        ctx.fillRect(bx, by, barW, bh);

        const w = clamp(barW * (n / max), 2 * s, barW);
        ctx.fillStyle = swatch;
        ctx.fillRect(bx, by, w, bh);
        // A highlight toward the leading edge, so a growing bar reads as
        // advancing rather than simply getting longer.
        const sheen = ctx.createLinearGradient(bx, 0, bx + w, 0);
        sheen.addColorStop(0, 'rgba(255,255,255,0)');
        sheen.addColorStop(1, 'rgba(255,255,255,0.3)');
        ctx.fillStyle = sheen;
        ctx.fillRect(bx, by, w, bh);

      }
      flowY += top.length * rowH;
    }
  }

  if (o.showCredit && !compact) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(232,230,224,0.45)';
    ctx.font = hudFont(13 * s, 400);
    const credit = 'eBird · iNaturalist · BirdWeather · GBIF · county blogs'
      + (scene.tileCredit ? ' · ' + scene.tileCredit : '');
    ctx.fillText(credit, view.w - pad, view.h - pad - 6 * s);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  ctx.shadowBlur = 0;
  if (o.showProgress) {
    const y = view.h - 10 * s;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(0, y, view.w, 3.5 * s);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(0, y, view.w * progress, 3.5 * s);
  }
  ctx.restore();
}

function selectedSpecies() {
  return ($('o-species').value || '').split('|').filter(Boolean);
}

function defaultTitle() {
  const sp = selectedSpecies();
  const grp = activeGroup();
  if (!sp.length) return grp ? grp.label : 'UK Bird Map';
  if (sp.length <= 2) return sp.join(' & ');
  return `${sp.slice(0, 2).join(', ')} +${sp.length - 2}`;
}

/* Photos are proxied through our own server: one of iNaturalist's two image
   hosts sends no CORS header, and drawing such an image into the canvas
   taints it, which makes the frame export throw. */
function proxiedPhoto(url) {
  if (!url) return '';
  // No proxy on a static host. crossOrigin stays set, so a photo from the
  // host that does send CORS headers loads and the canvas stays exportable;
  // one from the host that doesn't simply fails to load, which is a better
  // trade than tainting the canvas and breaking the export outright.
  if (!state.backend) return url;
  return '/api/photo?u=' + encodeURIComponent(url);
}

const speciesPhotos = [];
function loadSpeciesPhotos(urls) {
  speciesPhotos.length = 0;
  for (const u of (urls || []).filter(Boolean).slice(0, 4)) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = proxiedPhoto(u);
    speciesPhotos.push(img);
  }
}
function defaultSubtitle() {
  const a = $('o-from').value, b = $('o-to').value;
  const fmtD = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return a && b ? `${fmtD(a)} – ${fmtD(b)}` : 'Recent records';
}

/* ----------------------------------------------------------- frame compose */

function drawFrame(ms, progress, o, dtFrames) {
  const ctx = scene.mctx;
  // While the map is being moved, skip everything that is not the shape of
  // the country and a thinned scatter of records.
  const lite = !!state.interacting && scene === previewCtx.scene;
  drawSeaAndLand(ctx, o);
  if (lite) {
    const res = drawBirds(ctx, o, ms, true);
    drawHud(ctx, o, ms, res, progress);
    return res.shown;
  }

  if (o.heat) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85;
    ctx.drawImage(scene.heat, 0, 0);
    ctx.restore();
  }

  if (o.night) drawNight(ctx, o, ms);
  if (o.stars && o.night) drawStars(ctx, o, ms);
  if (o.lights) drawCityLights(ctx, o, ms);

  if (o.wind && state.weather) {
    stepWind(o, ms, dtFrames);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.9;
    ctx.drawImage(scene.wind, 0, 0);
    ctx.restore();
  }
  if ((o.clouds || o.rain) && state.weather) drawClouds(ctx, o, ms);

  const result = drawBirds(ctx, o, ms);
  drawHud(ctx, o, ms, result, progress);
  return result.shown;
}

/* ---------------------------------------------------------------- timeline

   Recording effort is overwhelmingly diurnal, so a clip that runs through
   every hour pulses once a day: a surge of records at dawn, nothing overnight.
   That is an artefact of when people are looking, not of when birds are
   about. Skipping the dark hours removes it - the clip then runs through
   daylight only, and the clock jumps from dusk to the next dawn. */

// A point near the middle of the country stands in for the whole view; the
// terminator still crosses it, so the segments land in roughly the right place.
const TIMELINE_REF = { lat: 54.2, lon: -3.0 };

function buildTimeline(mode, t0, t1) {
  if (mode !== 'day' && mode !== 'night') {
    return { segments: [[t0, t1]], total: t1 - t0, mode: 'all' };
  }
  const segments = [];
  const dayMs = 86400000;
  const first = Math.floor(t0 / dayMs) * dayMs;
  for (let d = first; d <= t1; d += dayMs) {
    const win = daylightWindow(d, TIMELINE_REF.lat, TIMELINE_REF.lon);
    if (!win) continue;
    const spans = mode === 'day'
      ? [win]
      : [[d, win[0]], [win[1], d + dayMs]];     // before sunrise, after sunset
    for (const [a, b] of spans) {
      const lo = Math.max(a, t0), hi = Math.min(b, t1);
      if (hi > lo) segments.push([lo, hi]);
    }
  }
  segments.sort((a, b) => a[0] - b[0]);
  const total = segments.reduce((n, [a, b]) => n + (b - a), 0);
  if (!segments.length || total <= 0) {
    return { segments: [[t0, t1]], total: t1 - t0, mode: 'all' };
  }
  return { segments, total, mode };
}

/** How much *shown* time has elapsed by `ms`. Excluded hours contribute
    nothing, so a record's age keeps increasing smoothly across a skipped
    night instead of the whole screen emptying at dusk and refilling at dawn. */
function posIn(tl, t0, ms) {
  if (!tl || tl.mode === 'all') return ms - t0;
  let acc = 0;
  for (const [a, b] of tl.segments) {
    if (ms <= a) break;
    acc += Math.min(ms, b) - a;
  }
  return acc;
}

function timelinePos(ms) { return posIn(scene.timeline, scene.t0, ms); }

/** Is this moment one of the hours the clip actually shows? */
function inTimeline(tl, ms) {
  if (!tl || tl.mode === 'all') return true;
  for (const [a, b] of tl.segments) {
    if (ms >= a && ms <= b) return true;
    if (ms < a) return false;
  }
  return false;
}

/** Clip progress (0..1) -> a real timestamp, skipping excluded hours. */
function timeAt(progress) {
  const tl = scene.timeline;
  if (!tl || tl.mode === 'all') return lerp(scene.t0, scene.t1, progress);
  let want = clamp(progress, 0, 1) * tl.total;
  for (const [a, b] of tl.segments) {
    const span = b - a;
    if (want <= span) return a + want;
    want -= span;
  }
  return tl.segments[tl.segments.length - 1][1];
}

/* --------------------------------------------- the map / settings split

   On a phone the two share one column, and how it is divided is a matter of
   what you are doing: picking a species wants the settings, watching the clip
   wants the map. So the grip between them resizes it, the chevron folds the
   settings away entirely, and the split is remembered. */

const ICON_CHEV_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M6 9.5l6 6 6-6"/></svg>';
const ICON_CHEV_UP = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M6 14.5l6-6 6 6"/></svg>';

const SPLIT_KEY = 'sheetH';
const MIN_KEY = 'panelMin';

/* Where the basic controls live when the panel is open. Captured once, before
   anything is moved, so putting them back is exact rather than approximate. */
let _controlHomes = null;

/* What stays reachable when the sheet is down. The group was left out at
   first, on the reasoning that it is a starting point you set once - but it
   is the broadest way to change what the clip is about, and leaving it in the
   panel meant lifting the whole sheet to swap waders for raptors. The chips
   come with the picker, or the folded bar would not show what is selected. */
function basicControls() {
  return [$('o-group').closest('.field'),
          $('o-species-input').closest('.field'),
          $('o-species-chips'),
          $('o-from').closest('.field')].filter(Boolean);
}

/* Every control any layout is allowed to move, by name. */
function controlNodes() {
  return {
    toggle: $('panel-toggle'),
    group: $('o-group').closest('.field'),
    species: $('o-species-input').closest('.field'),
    chips: $('o-species-chips'),
    dates: $('o-from').closest('.field'),
  };
}

function rememberControlHomes() {
  if (_controlHomes) return;
  // Captured once, before anything moves, so putting a node back is exact.
  _controlHomes = Object.values(controlNodes()).filter(Boolean)
    .map((el) => [el, el.parentNode, el.nextSibling]);
}

function restoreControls() {
  for (const [el, parent, next] of _controlHomes || []) {
    parent.insertBefore(el, next && next.parentNode === parent ? next : null);
  }
}

/* Moved, not copied. A copy would have to be kept in step with the original,
   and two elements cannot share an id; moving a node keeps its listeners, so
   the real Group and Dates controls simply carry on working down there. */
/* While folded there is no room for a row of chips, so the selection is shown
   as the search box's own placeholder - it reads as "this is what you are
   looking at, type to change it". The input's value stays empty, so typing
   still searches exactly as it does in the open panel. */
function syncMiniPlaceholder() {
  const input = $('o-species-input');
  if (!input) return;
  // At home in the panel the chips show the selection; anywhere else there
  // is no room for them, so the box itself has to say what is chosen.
  if (input.closest('#panel')) {
    if (input.dataset.openPlaceholder) {
      input.placeholder = input.dataset.openPlaceholder;
    }
    return;
  }
  if (!input.dataset.openPlaceholder) {
    input.dataset.openPlaceholder = input.placeholder;
  }
  const names = selectedSpecies();
  const grp = activeGroup();
  input.placeholder = names.length
    ? (names.length > 2 ? `${names[0]} + ${names.length - 1} more` : names.join(', '))
    : (grp ? grp.label : 'All species');
}

/* The ✕ beside the species box resets the subject rather than just emptying
   the text. It has to: with the sheet folded the box carries the selection as
   its placeholder and the group sits beside it, so a clear that left the group
   standing would look like it had done nothing. */
function resetSubject() {
  $('o-species').value = '';
  loadSpeciesPhotos([]);
  applyGroup('');          // also re-prepares the records and the picker
  syncMiniPlaceholder();
  $('o-species').dispatchEvent(new Event('change', { bubbles: true }));
}

function moveBasicControls(toMini) {
  rememberControlHomes();
  const mini = $('mini-bar');
  if (toMini) {
    mini.hidden = false;
    mini.appendChild($('panel-toggle'));      // first, so it reads as a header
    for (const el of basicControls()) mini.appendChild(el);
  } else {
    restoreControls();
    mini.hidden = true;
  }
}

function setPanelMinimised(on, refit = true) {
  const layout = document.body.dataset.layout || 'theatre';
  if (layout !== 'sidebar') return;      // the other layouts have no sheet
  document.body.classList.toggle('panel-min', on);
  const btn = $('panel-toggle');
  btn.innerHTML = on ? ICON_CHEV_UP : ICON_CHEV_DOWN;
  btn.title = on ? 'Show the settings' : 'Hide the settings';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-expanded', String(!on));
  moveBasicControls(on);
  syncMiniPlaceholder();
  try { localStorage.setItem(MIN_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  // At boot the caller is about to fit anyway; fitting twice would load the
  // basemap twice for nothing.
  if (refit) fitPreview();
}

/* ------------------------------------------------------- the settings menu

   Nine stacked accordions is a pile rather than a structure: everything is
   present at once, nothing is findable, and the thing you want is always
   three folds down. So the panel shows a MENU of sections, and picking one
   swaps the panel to that section with a way back.

   The sections are the markup's own `details.sect` elements, converted here
   rather than written twice - the HTML stays one readable list of sections,
   and this decides how they are navigated. It must run before any layout has
   moved a control, because `rememberControlHomes()` records where each
   control lives and this changes those parents. */

const SHEET_KEY = 'panelSheet';

function buildPanelMenu() {
  const panel = $('panel');
  const sects = [...panel.querySelectorAll('details.sect')];
  if (!sects.length) return;

  const menu = document.createElement('nav');
  menu.id = 'panel-menu';
  menu.setAttribute('aria-label', 'Settings sections');

  for (const d of sects) {
    const h2 = d.querySelector('summary h2');
    const title = h2 ? h2.textContent.trim() : 'Settings';
    const id = d.id || ('sect-' + title.toLowerCase().replace(/[^a-z]+/g, '-'));

    // details -> a plain pane, carrying everything but its own summary.
    const pane = document.createElement('section');
    pane.className = 'sheet';
    pane.id = 'sheet-' + id;
    pane.dataset.title = title;
    pane.hidden = true;
    for (const node of [...d.childNodes]) {
      if (node.nodeName.toLowerCase() === 'summary') continue;
      pane.appendChild(node);
    }
    // The pane replaces the whole <section class="panel"> wrapper.
    const wrap = d.closest('section.panel') || d;
    wrap.parentNode.insertBefore(pane, wrap);
    wrap.remove();

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'menu-row';
    row.dataset.sheet = pane.id;
    row.innerHTML = `<span class="menu-name">${title}</span>`
      + '<span class="menu-value"></span>'
      + '<svg class="menu-chev" viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M9 6l6 6-6 6"/></svg>';
    row.addEventListener('click', () => openSheet(pane.id));
    menu.appendChild(row);
  }

  // The menu sits where the first section used to.
  const first = panel.querySelector('.sheet');
  panel.insertBefore(menu, first);

  const back = $('sheet-back');
  if (back) back.addEventListener('click', () => openSheet(null));
  // Escape backs out of a section before it closes the drawer.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.body.classList.contains('sheet-open')) {
      openSheet(null);
      e.stopPropagation();
    }
  }, true);

  syncMenuValues();
  let saved = null;
  try { saved = localStorage.getItem(SHEET_KEY); } catch (e) { /* ignore */ }
  /* Land on The subject, not the bare menu. Its species tally and the movers
     list are the things worth seeing the moment the panel opens - they used
     to be on screen permanently, and a menu that hid them behind two clicks
     would be a worse panel, not a tidier one. The menu is one tap away. */
  const start = saved !== null
    ? (saved && $(saved) ? saved : null)
    : (panel.querySelector('.sheet') || {}).id || null;
  openSheet(start, false);
}

/* What each section currently says, shown beside its name so the menu answers
   "what is my backdrop again?" without being opened. Only the one control
   that defines a section is worth showing; the rest is detail. */
const MENU_VALUES = {
  'sheet-sect-the-subject': () => {
    const names = selectedSpecies();
    const grp = activeGroup();
    if (names.length) {
      return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
    }
    return grp ? grp.label : 'All species';
  },
  'sheet-sect-the-clip': () => `${$('o-duration').value}s`,
  'sheet-sect-the-world': () => selectedText('o-basemap'),
  'sheet-sect-the-birds': () => selectedText('o-mark-style'),
  'sheet-sect-captions': () => selectedText('o-hud-layout'),
  'sheet-sect-output': () => selectedText('o-size'),
  'sheet-sect-app-layout': () => selectedText('o-layout'),
};

function selectedText(id) {
  const el = $(id);
  if (!el || !el.selectedOptions || !el.selectedOptions[0]) return '';
  // Option labels carry an explanatory tail after an em dash; the menu wants
  // only the name.
  return el.selectedOptions[0].textContent.split('\u2014')[0].trim();
}

function syncMenuValues() {
  for (const row of document.querySelectorAll('.menu-row')) {
    const fn = MENU_VALUES[row.dataset.sheet];
    const cell = row.querySelector('.menu-value');
    if (!cell) continue;
    let text = '';
    try { text = fn ? fn() : ''; } catch (e) { text = ''; }
    cell.textContent = text || '';
  }
}

function openSheet(id, save = true) {
  const panel = $('panel');
  if (!panel) return;
  for (const p of panel.querySelectorAll('.sheet')) p.hidden = (p.id !== id);
  const open = !!id;
  document.body.classList.toggle('sheet-open', open);
  $('sheet-head').hidden = !open;
  if (open) {
    $('sheet-title').textContent = $(id).dataset.title || '';
    panel.scrollTop = 0;
  }
  if (save) {
    try { localStorage.setItem(SHEET_KEY, id || ''); } catch (e) { /* ignore */ }
  }
}

/* ------------------------------------------------------------- app layouts

   Which of the movable controls each layout takes, and where. The sidebar
   keeps everything in the panel (the phone sheet handles its own fold).
   Theatre and dashboard put the subject controls in a toolbar; search puts
   only the species box in a pill. Everything else stays in the panel, which
   becomes a drawer (theatre, search) or a rail of cards (dashboard). */
const LAYOUT_SLOTS = {
  sidebar: {},
  /* The group travels with the species picker in every layout. It was left out
     of theatre and search at first on the grounds that it is set once and then
     forgotten - which was wrong twice over: it is the quickest way to change
     what the clip is about, and in theatre (the default) that left no way to
     reach it at all without opening the drawer. */
  theatre: { toolbar: ['group', 'species', 'chips', 'dates'] },
  dashboard: { toolbar: ['group', 'species', 'chips', 'dates'] },
  search: { 'search-pill': ['group', 'species', 'chips'] },
};

function applyLayout(key, refit = true) {
  if (!LAYOUT_SLOTS[key]) key = 'theatre';
  rememberControlHomes();
  // Everything home first; then the layout takes what it wants.
  restoreControls();
  for (const id of ['mini-bar', 'toolbar', 'search-pill']) $(id).hidden = true;
  document.body.classList.remove('drawer-open');
  document.body.dataset.layout = key;
  const sel = $('o-layout');
  if (sel && sel.value !== key) sel.value = key;

  if (key === 'sidebar') {
    let wasMin = false;
    try { wasMin = localStorage.getItem(MIN_KEY) === '1'; } catch (e) { /* ignore */ }
    setPanelMinimised(wasMin, false);
  } else {
    // A folded sheet carried over from the sidebar would collapse the drawer.
    document.body.classList.remove('panel-min');
  }
  const nodes = controlNodes();
  for (const [slotId, names] of Object.entries(LAYOUT_SLOTS[key])) {
    const slot = $(slotId);
    slot.hidden = false;
    for (const n of names) if (nodes[n]) slot.appendChild(nodes[n]);
  }
  const dt = $('drawer-toggle');
  if (dt) dt.hidden = !(key === 'theatre' || key === 'search');
  syncMiniPlaceholder();
  if (typeof syncUrl === 'function') syncUrl();
  if (refit) fitPreview();
}

function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  // Two ways in and out: the ≡ on the map opens it, the Hide button at the
  // top of the panel closes it. Both report the same state to a screenreader.
  for (const id of ['drawer-toggle', 'drawer-close']) {
    const b = $(id);
    if (!b) continue;
    b.setAttribute('aria-expanded', String(open));
    if (id === 'drawer-toggle') {
      b.title = open ? 'Hide the settings' : 'Show the settings';
      b.setAttribute('aria-label', b.title);
    }
  }
}

function initLayouts() {
  const sel = $('o-layout');
  if (sel) sel.addEventListener('change', () => applyLayout(sel.value));
  const dt = $('drawer-toggle');
  if (dt) {
    dt.addEventListener('click', () => {
      setDrawer(!document.body.classList.contains('drawer-open'));
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) {
      setDrawer(false);
    }
  });
}

function initPanelSplit() {
  const app = $('app');
  const grip = $('panel-grip');
  if (!grip) return;
  const MIN_SHEET = 120;
  const MIN_MAP = 200;

  const setSheetHeight = (px, save = true) => {
    const cap = Math.max(MIN_SHEET, window.innerHeight - MIN_MAP);
    const h = clamp(Math.round(px), MIN_SHEET, cap);
    app.style.setProperty('--sheet-h', h + 'px');
    if (save) {
      try { localStorage.setItem(SPLIT_KEY, String(h)); } catch (e) { /* ignore */ }
    }
    return h;
  };

  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    if (saved > 0) setSheetHeight(saved, false);
  } catch (e) { /* ignore */ }

  let startY = 0;
  let startH = 0;
  let dragging = false;

  grip.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#panel-toggle')) return;
    dragging = true;
    startY = e.clientY;
    startH = $('panel').getBoundingClientRect().height;
    grip.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });

  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    /* Up makes the sheet taller, hence the subtraction. The map is pinned to
       the viewport and no longer resizes with the sheet, so dragging costs
       nothing but a style write - no canvas refit at all. */
    setSheetHeight(startH - (e.clientY - startY));
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('dragging');
    try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    const now = $('panel').getBoundingClientRect().height;
    if (e.key === 'ArrowUp') { setSheetHeight(now + step); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { setSheetHeight(now - step); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      setPanelMinimised(!document.body.classList.contains('panel-min'));
      e.preventDefault();
    }
  });

  $('panel-toggle').addEventListener('click', () => {
    setPanelMinimised(!document.body.classList.contains('panel-min'));
  });

  rememberControlHomes();
  let wasMin = false;
  try { wasMin = localStorage.getItem(MIN_KEY) === '1'; } catch (e) { /* ignore */ }
  setPanelMinimised(wasMin, false);
}

/* ------------------------------------------------------- record preparation */

function prepareRecords() {
  const d = state.data;
  if (!d) return;
  const o = {
    species: $('o-species').value,
    untimed: $('o-untimed').value,
    colour: $('o-bird-colour').value,
  };
  const sources = new Set(
    [...document.querySelectorAll('#o-sources input:checked')]
      .map((el) => Number(el.dataset.idx)));

  // One species, several, or none at all.
  const wanted = new Set();
  for (const name of (o.species || '').split('|')) {
    if (!name) continue;
    const i = d.species.findIndex((s) => s[0] === name);
    if (i >= 0) wanted.add(i);
  }

  const fromIso = $('o-from').value || d.dates[0];
  const toIso = $('o-to').value || d.dates[d.dates.length - 1];
  state.t0 = Date.parse(fromIso + 'T00:00:00Z');
  state.t1 = Date.parse(toIso + 'T23:59:59Z');
  state.timeline = buildTimeline($('o-hours').value, state.t0, state.t1);

  const grp = activeGroup();
  const inGroup = (rec) => {
    if (!grp) return true;
    if (grp.flag) return !!(rec[FLAG] & F_NOTABLE);
    return !state.groupSet || state.groupSet.has(rec[SP]);
  };

  /* Acoustic aggregates carry no honest date, so where they sit on the
     timeline has to be estimated. The best estimate available is the shape of
     the *dated* records for the same selection: if Redwing arrive on the 17th
     then the station totals for Redwing belong around the 17th too. Smearing
     them evenly over the range instead invents birds on days that had almost
     none, which is the opposite of what this map is for. */
  const nDays = Math.max(1, Math.round((state.t1 - state.t0) / 86400000));
  const profile = new Float64Array(nDays);
  let datedTotal = 0;
  for (let i = 0; i < d.recs.length; i++) {
    const rec = d.recs[i];
    if (rec[FLAG] & F_AGGREGATE) continue;
    if (!sources.has(rec[SRC]) || !inGroup(rec)) continue;
    if (wanted.size && !wanted.has(rec[SP])) continue;
    const day = Math.floor(
      (Date.parse(d.dates[rec[DT]] + 'T00:00:00Z') - state.t0) / 86400000);
    if (day < 0 || day >= nDays) continue;
    profile[day] += 1;
    datedTotal += 1;
  }
  /* Under about a dozen dated records the shape is noise, not a signal, and
     spreading to it would pin whole stations onto one arbitrary day. */
  let cdf = null;
  if (datedTotal >= 12) {
    // A small floor keeps a quiet day from being impossible rather than rare.
    const floor = 0.05 * (datedTotal / nDays);
    cdf = new Float64Array(nDays);
    let acc = 0;
    for (let k = 0; k < nDays; k++) { acc += profile[k] + floor; cdf[k] = acc; }
    for (let k = 0; k < nDays; k++) cdf[k] /= acc;
  }

  const out = [];
  const candidates = [];
  const opt = opts();
  for (let i = 0; i < d.recs.length; i++) {
    const rec = d.recs[i];
    if (!sources.has(rec[SRC]) || !inGroup(rec)) continue;
    candidates.push(i);
    if (wanted.size && !wanted.has(rec[SP])) continue;
    const iso = d.dates[rec[DT]];
    const dayMs = Date.parse(iso + 'T00:00:00Z');
    if (dayMs + 86400000 < state.t0 || dayMs > state.t1) continue;

    let t;
    let baseDay = dayMs;
    /* Acoustic rows are aggregates over a window, dated to the end of the
       bucket they fall in - so tens of thousands of them land on two days and
       swamp a running total, which is why the ranking mid-clip bore no
       relation to which birds are actually most reported. Spreading each one
       across the range it covers is closer to what the record means than
       pinning it to a single evening. */
    if ((rec[FLAG] & F_AGGREGATE) && !rec[TIME] && o.untimed === 'spread') {
      const u = hash32(i * 40503 + 7);
      let pick = nDays - 1;
      if (cdf) {
        for (let k = 0; k < nDays; k++) { if (u <= cdf[k]) { pick = k; break; } }
      } else {
        pick = Math.floor(u * nDays);
      }
      /* The filed date is not a ceiling: these rows are stamped with the end
         of the fetch bucket they fell in, so all of them sit on a handful of
         days regardless of when the birds called. Clamping to it only piles
         them onto the start of the clip. The profile places them instead. */
      baseDay = state.t0 + pick * 86400000;
    }
    const dayStart = baseDay - (baseDay % 86400000);
    if (rec[TIME]) {
      const [hh, mm] = rec[TIME].split(':').map(Number);
      t = dayMs + (hh * 60 + mm) * 60000;
    } else if (o.untimed === 'skip') {
      continue;
    } else if (o.untimed === 'noon') {
      t = dayStart + 43200000;
    } else {
      const win = daylightWindow(dayStart, rec[LAT], rec[LON])
                  || [dayStart + 28800000, dayStart + 61200000];
      t = o.untimed === 'dawn'
        ? win[0] + 600000
        : win[0] + hash32(i * 2654435761) * Math.max(0, win[1] - win[0]);
    }
    if (t < state.t0 || t > state.t1) continue;
    // Records from the hours being skipped are left out rather than pinned to
    // the edge of the gap: a night's worth piling up on dusk and expiring
    // together is exactly the pulse this mode exists to remove.
    if (!inTimeline(state.timeline, t)) continue;

    const count = rec[CNT] || 1;
    out.push({
      t,
      lat: rec[LAT], lon: rec[LON],
      r: (rec[FLAG] & F_AGGREGATE) ? 3.2
         : clamp(2.6 + Math.sqrt(count) * 0.85, 2.6, 16),
      notable: !!(rec[FLAG] & F_NOTABLE),
      colour: birdColour(opt, rec),
      // Fixed thinning score. Keyed off the record's own index so it survives
      // re-preparing, and off a different constant from the time jitter so
      // which marks are kept is independent of when they appear.
      u: hash32(i * 2246822519 + 11),
      [SP]: rec[SP], [SRC]: rec[SRC],
    });
  }
  state.candidates = candidates;
  out.sort((a, b) => a.t - b.t);
  for (const r of out) r.tp = posIn(state.timeline, state.t0, r.t);
  state.records = out;
  buildCumulative(out, state.timeline, state.t0, state.t1);
  // The preview always reflects the current settings; a render in progress
  // keeps the copy it started with.
  previewCtx.scene.records = out;
  previewCtx.scene.t0 = state.t0;
  previewCtx.scene.t1 = state.t1;
  previewCtx.scene.timeline = state.timeline;

  updateEstimate();
  renderInView();
}

/* What is in frame right now, irrespective of which species are selected -
   the same question the tile map's sidebar answers, asked of the animation. */
function renderInView() {
  const d = state.data;
  const list = $('in-view-list');
  const chosenNames = selectedSpecies();
  const chosenIdx = new Set(chosenNames
    .map((n) => d.species.findIndex((sp) => sp[0] === n))
    .filter((i) => i >= 0));

  /* Count the records the clip actually animates, not every candidate row:
     some are dropped because their estimated time falls outside the window or
     inside a skipped hour, and a panel that counts those disagrees with the
     tally on the map - which is the same number, asked a different way. The
     species filter is already applied upstream, so when one is chosen this
     holds only that bird, and when none is it holds them all. */
  const counts = new Map();
  const b = FOCUS;
  for (const r of (state.records || [])) {
    if (!inBox(r, b)) continue;
    counts.set(r[SP], (counts.get(r[SP]) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b2) => b2[1] - a[1]);
  const top = ranked.slice(0, 8);

  const scopeWord = (b.east - b.west) > 20 ? 'across the region' : 'in view';

  // The headline counts describe what is on screen, not the whole country -
  // zooming into an estuary should say how much is in the estuary.
  let inViewTotal = 0;
  for (const n of counts.values()) inViewTotal += n;
  const span = Math.max(1, Math.round((state.t1 - state.t0) / 86400000));
  $('subject-summary').innerHTML =
    `<b>${inViewTotal.toLocaleString('en-GB')}</b> records · `
    + `<b>${counts.size.toLocaleString('en-GB')}</b> species `
    + `<span class="muted">${scopeWord}, over ${span} days</span>`;
  const max = top.length ? top[0][1] : 1;
  const chosen = new Set(selectedSpecies());

  $('in-view-scope').textContent = scopeWord;
  // With a selection, the heading describes the selection, not a top eight.
  $('in-view-heading').textContent = chosenIdx.size ? 'Selected' : 'Most reported';

  list.innerHTML = '';
  for (const [sp, c] of top) {
    const s2 = d.species[sp];
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = chosen.has(s2[0]) ? 'on' : '';
    btn.title = `${s2[0]} — ${c.toLocaleString('en-GB')} records in view`;
    btn.innerHTML =
      (s2[3] ? `<img class="thumb" src="${proxiedPhoto(s2[3])}" alt="" loading="lazy">`
             : '<span class="thumb empty"></span>')
      + `<span><span class="name">${s2[0]}</span>`
      + `<span class="bar" style="width:${Math.max(3, (c / max) * 100)}%"></span></span>`
      + `<span class="cnt">${c.toLocaleString('en-GB')}</span>`;
    btn.onclick = () => {
      const now = new Set(selectedSpecies());
      if (now.has(s2[0])) now.delete(s2[0]); else now.add(s2[0]);
      const names = [...now];
      state.speciesCombo.setSelection(names);
      $('o-species').value = names.join('|');
      loadSpeciesPhotos(names.map((n) => (d.species.find((x) => x[0] === n) || [])[3]));
      $('o-species').dispatchEvent(new Event('change', { bubbles: true }));
    };
    li.appendChild(btn);
    list.appendChild(li);
  }
  if (!top.length) {
    list.innerHTML = '<li class="muted small" style="padding:6px 4px">'
      + (chosenIdx.size
          ? 'None of the selected species in this frame — zoom out or widen the dates.'
          : 'Nothing in this frame — zoom out or widen the dates.') + '</li>';
  }
}

/* Running totals, not a rolling window. The marks fade so the map stays
   readable, but a counter that rose and fell with the trail window made the
   ranked list jitter; these are cumulative from the start of the clip, so
   species only ever climb. Counts are snapshotted at intervals and topped up
   from the few records since, which keeps it exact without rescanning
   hundreds of thousands of records every frame. */
const CUM_BUCKETS = 240;

function inBox(r, b) {
  return r.lat >= b.south && r.lat <= b.north
      && r.lon >= b.west && r.lon <= b.east;
}

/* The running total counts what is in frame, not what is in Europe: zooming
   into an estuary that holds 40 Redwing should not keep reading 2,951. The
   sidebar has always scoped itself this way; the tally had not, so the two
   disagreed by the whole continent. */
function buildCumulative(records, timeline, t0, t1) {
  const total = (timeline && timeline.total) || Math.max(1, t1 - t0);
  const bounds = [];
  const index = [];     // cursor into `records` - every record, in frame or not
  const seen = [];      // the number actually in frame, which is what is shown
  const counts = [];
  const running = new Map();
  const box = { ...FOCUS };
  let k = 0;
  let n = 0;
  for (let b = 0; b < CUM_BUCKETS; b++) {
    const edge = ((b + 1) / CUM_BUCKETS) * total;
    while (k < records.length && records[k].tp <= edge) {
      if (inBox(records[k], box)) {
        const sp = records[k][SP];
        running.set(sp, (running.get(sp) || 0) + 1);
        n++;
      }
      k++;
    }
    bounds.push(edge);
    index.push(k);
    seen.push(n);
    counts.push(new Map(running));
  }
  /* What the longest bar will reach by the end of the clip. Scaling the bars
     to the *current* leader instead keeps the leader permanently full and
     everyone else at a fixed ratio, so nothing appears to grow - which is the
     one thing a running total is supposed to show. */
  let finalMax = 1;
  for (const v of running.values()) if (v > finalMax) finalMax = v;
  state.cumulative = { bounds, index, seen, counts, total, box, finalMax };
  previewCtx.scene.cumulative = state.cumulative;
}

let _tallyCacheKey = -1;
let _tallyCache = null;

function rebuildCumulative() {
  if (!state.records) return;
  buildCumulative(state.records, state.timeline, state.t0, state.t1);
  _tallyCacheKey = -1;          // the cached totals describe the old frame
  _tallyCache = null;
}

function cumulativeAt(nowPos) {
  // The totals move slowly; recomputing them on every frame was pure cost.
  const cum0 = scene.cumulative;
  if (cum0) {
    const key = Math.floor((nowPos / cum0.total) * 600);
    if (key === _tallyCacheKey && _tallyCache && _tallyCache.scene === scene) {
      return _tallyCache.value;
    }
    const value = cumulativeCompute(nowPos);
    _tallyCacheKey = key;
    _tallyCache = { scene, value };
    return value;
  }
  return cumulativeCompute(nowPos);
}

function cumulativeCompute(nowPos) {
  // Read from the active context: a background render keeps the snapshot it
  // started with, so changing the settings mid-render cannot shift its totals.
  const cum = scene.cumulative;
  const recs = scene.records || [];
  if (!cum) return { tally: new Map(), shown: 0 };
  let b = Math.floor((nowPos / cum.total) * CUM_BUCKETS) - 1;
  b = clamp(b, -1, CUM_BUCKETS - 1);
  const tally = b >= 0 ? new Map(cum.counts[b]) : new Map();
  let i = b >= 0 ? cum.index[b] : 0;
  let shown = b >= 0 ? cum.seen[b] : 0;
  const box = cum.box;
  while (i < recs.length && recs[i].tp <= nowPos) {
    if (!box || inBox(recs[i], box)) {
      const sp = recs[i][SP];
      tally.set(sp, (tally.get(sp) || 0) + 1);
      shown++;
    }
    i++;
  }
  return { tally, shown };
}

function updateEstimate() {
  const o = opts();
  const frames = Math.round(o.duration * o.fps);
  const span = (state.timeline && state.timeline.total) || (state.t1 - state.t0);
  const perFrame = span / frames / 60000;
  const mode = state.timeline && state.timeline.mode;
  const est =
    `<b>${frames.toLocaleString('en-GB')}</b> frames · `
    + `each one covers <b>${perFrame < 90 ? perFrame.toFixed(0) + ' min'
                                          : (perFrame / 60).toFixed(1) + ' hrs'}</b>`
    + (mode === 'day' ? ' · nights skipped'
       : mode === 'night' ? ' · daylight skipped' : '');
  $('frame-estimate').innerHTML = est;
  const dlg = $('export-estimate');
  if (dlg) {
    const [ew, eh] = $('o-size').value.split('x').map(Number);
    dlg.innerHTML = est + ` · <b>${ew} × ${eh}</b>`;
  }
}

/* --------------------------------------------------------------- preview */

let previewRaf = null;
let lastPreviewTs = 0;

function previewFrame(ts) {
  if (!state.playing) return;
  const o = opts();
  const frames = Math.round(o.duration * o.fps);
  const dt = lastPreviewTs ? (ts - lastPreviewTs) / 1000 : 1 / o.fps;
  lastPreviewTs = ts;
  state.previewT += dt / o.duration;
  if (state.previewT > 1) { state.previewT = 0; resetDynamic(); }
  renderPreviewAt(state.previewT, o, Math.max(0.2, dt * o.fps));
  previewRaf = requestAnimationFrame(previewFrame);
}

function renderPreviewAt(progress, o, dtFrames) {
  useContext(previewCtx);
  const ms = timeAt(progress);
  drawFrame(ms, progress, o || opts(), dtFrames == null ? 1 : dtFrames);
  $('scrub').value = String(Math.round(progress * 1000));
  $('scrub-label').textContent = new Date(ms).toLocaleString('en-GB',
    { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit',
      minute: '2-digit', timeZone: 'UTC' });
}

const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M9 5v14M15 5v14"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M7 4.6v14.8L19.5 12z" class="solid"/></svg>';

function setPlaying(on) {
  state.playing = on;
  const btn = $('btn-play');
  // Text glyphs for these render as empty boxes on a lot of systems, so the
  // transport icons are drawn rather than typed.
  btn.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
  btn.title = on ? 'Pause' : 'Play';
  if (on) {
    lastPreviewTs = 0;
    previewRaf = requestAnimationFrame(previewFrame);
  } else if (previewRaf) {
    cancelAnimationFrame(previewRaf);
  }
}

/* ---------------------------------------------------------------- render */

async function renderClip() {
  if (state.rendering) return;
  const o = opts(true);
  if (!state.records.length) {
    alert('No records match those settings — widen the dates or the species.');
    return;
  }
  state.rendering = true;

  const frames = Math.round(o.duration * o.fps);
  const overlay = $('render-overlay');
  overlay.hidden = false;
  overlay.classList.remove('minimised');
  $('btn-render').disabled = true;
  $('btn-render').textContent = 'Rendering…';
  $('render-download').hidden = true;
  $('render-error').textContent = '';
  $('render-title').textContent = 'Rendering';
  $('render-sub').textContent = 'Drawing frames…';
  $('render-frames').textContent =
    `${frames.toLocaleString('en-GB')} frames to draw — this can take a while`;
  setProgress(0, '');

  // The render gets its own canvas and its own copy of everything, so the
  // preview and the settings stay live while it runs.
  prepareRecords();
  const offscreen = document.createElement('canvas');
  useContext(renderCtx);
  buildScene(o.w, o.h, offscreen);
  renderCtx.scene.records = state.records.slice();
  renderCtx.scene.t0 = state.t0;
  renderCtx.scene.t1 = state.t1;
  renderCtx.scene.timeline = state.timeline;
  renderCtx.scene.cumulative = state.cumulative;
  $('render-sub').textContent = 'Fetching the backdrop…';
  await loadBasemap(o.basemap);
  resetDynamic();
  useContext(previewCtx);
  $('render-sub').textContent = 'Drawing frames…';

  const label = `${(o.title || defaultTitle())} ${$('o-from').value}`;
  let job = null;
  try {
    if (state.caps.ffmpeg) {
      const res = await fetch('/api/render/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, ...sanitiseOpts(o) }),
      });
      job = (await res.json()).job;
      state.job = job;
    }

    const started = performance.now();
    // Uploads run alongside the drawing of the next frame rather than
    // blocking it, with a small cap so memory stays bounded.
    const inFlight = [];
    const MAX_IN_FLIGHT = 4;

    for (let f = 0; f < frames; f++) {
      if (!state.rendering) throw new Error('cancelled');
      useContext(renderCtx);
      const progress = f / (frames - 1 || 1);
      const ms = timeAt(progress);
      drawFrame(ms, progress, o, 1);
      useContext(previewCtx);

      if (job) {
        const blob = await new Promise((res) =>
          offscreen.toBlob(res, 'image/jpeg', 0.93));
        const post = fetch(`/api/render/frame/${job}/${f}`,
                           { method: 'POST', body: blob })
          .finally(() => {
            const i = inFlight.indexOf(post);
            if (i >= 0) inFlight.splice(i, 1);
          });
        inFlight.push(post);
        if (inFlight.length >= MAX_IN_FLIGHT) await Promise.race(inFlight);
      }

      const done = (f + 1) / frames;
      const elapsed = (performance.now() - started) / 1000;
      const eta = f > 3 ? (elapsed / done) * (1 - done) : 0;
      setProgress(done * (job ? 0.82 : 1),
                  eta > 1 ? `about ${formatEta(eta)} left` : '');
      $('render-frames').textContent =
        `frame ${(f + 1).toLocaleString('en-GB')} of ${frames.toLocaleString('en-GB')}`
        + ` · ${o.w}×${o.h}`;

      if (f % 4 === 0 || f === frames - 1) {
        drawThumb();
        await new Promise((r) => setTimeout(r, 0));   // keep the UI alive
      }
    }
    await Promise.all(inFlight);

    if (!job) {
      $('render-title').textContent = 'Frames are drawn';
      $('render-sub').textContent =
        'ffmpeg is not available, so there is no video to assemble. Start the '
        + 'app with ./run.sh to enable MP4 export.';
      setProgress(1, '');
      state.rendering = false;
      return;
    }

    $('render-sub').textContent = 'Encoding the video…';
    $('render-frames').textContent = `${frames.toLocaleString('en-GB')} frames sent`;
    await fetch(`/api/render/finish/${job}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fps: o.fps, format: o.format }),
    });

    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      if (!state.rendering) throw new Error('cancelled');
      const st = await (await fetch(`/api/render/status/${job}`)).json();
      if (st.state === 'done') {
        setProgress(1, '');
        $('render-title').textContent = 'Ready';
        $('render-sub').textContent =
          `${o.format.toUpperCase()} · ${(st.size / 1e6).toFixed(1)} MB · `
          + `${o.duration}s at ${o.fps}fps`;
        $('render-frames').textContent = `took ${formatEta(
          (performance.now() - started) / 1000)}`;
        const a = $('render-download');
        a.href = st.url;
        a.hidden = false;
        break;
      }
      if (st.state === 'error') throw new Error(st.error || 'encoding failed');
      setProgress(0.9, 'encoding…');
      $('render-frames').textContent = 'ffmpeg is assembling the video';
    }
  } catch (e) {
    if (String(e.message) !== 'cancelled') {
      $('render-title').textContent = 'That did not work';
      $('render-error').textContent = String(e.message || e);
    } else {
      overlay.hidden = true;
    }
  } finally {
    state.rendering = false;
    useContext(previewCtx);
    $('btn-render').disabled = false;
    $('btn-render').textContent = 'Render the clip';
  }
}

function sanitiseOpts(o) {
  const { palette, ...rest } = o;
  return rest;
}

function setProgress(fraction, note) {
  $('render-bar').style.width = `${(fraction * 100).toFixed(1)}%`;
  // A whole number sits on 0% for the first nine frames of a 900-frame clip,
  // which reads as "nothing is happening".
  const pct = fraction * 100;
  $('render-pct').textContent = pct < 10 ? `${pct.toFixed(1)}%`
                                         : `${Math.round(pct)}%`;
  $('render-eta').textContent = note || '';
}

function formatEta(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${Math.round(seconds - m * 60)}s`;
}

function drawThumb() {
  const t = $('render-thumb');
  const rv = renderCtx.view, rs = renderCtx.scene;
  if (!rs.main) return;
  const g = t.getContext('2d');
  const sc = Math.min(t.width / rv.w, t.height / rv.h);
  const w = rv.w * sc, h = rv.h * sc;
  g.fillStyle = '#05070c';
  g.fillRect(0, 0, t.width, t.height);
  g.drawImage(rs.main, (t.width - w) / 2, (t.height - h) / 2, w, h);
}

/* -------------------------------------------------------------------- UI */

let areaReloadTimer = null;
let focusRaf = null;
let interactTimer = null;

/* Dragging a map with a quarter of a million records on it has to stop doing
   the expensive work: the animation pauses, the heavy layers are skipped and
   the redraw is coalesced onto animation frames rather than firing on every
   pointer event. Everything comes back the moment the hand comes off. */
function beginInteract() {
  if (!state.interacting) {
    state.interacting = true;
    if (state.playing) { state.resumeAfter = true; setPlaying(false); }
  }
  clearTimeout(interactTimer);
}

function endInteract() {
  clearTimeout(interactTimer);
  interactTimer = setTimeout(() => {
    state.interacting = false;
    rebuildCumulative();
    if (state.resumeAfter) { state.resumeAfter = false; setPlaying(true); }
    else renderPreviewAt(state.previewT, opts(), 1);
    renderInView();
  }, 240);
}

function setFocus(box, { markCustom = true, reloadTiles = true } = {}) {
  // Keep the frame sane: no inverted or microscopic boxes.
  const minSpan = 0.08;
  FOCUS = {
    south: box.south, west: box.west,
    north: Math.max(box.north, box.south + minSpan),
    east: Math.max(box.east, box.west + minSpan),
  };
  // The area dropdown is gone - zoom and pan are the framing controls now -
  // but keep it in step if a build still has one.
  const areaSel = $('o-area');
  if (markCustom && areaSel) {
    areaSel.value = 'custom';
    const opt = areaSel.querySelector('option[value="custom"]');
    if (opt) opt.hidden = false;
  }
  // Coalesce onto the next animation frame; a drag fires far more pointer
  // events than the scene can be rebuilt for.
  if (focusRaf) cancelAnimationFrame(focusRaf);
  focusRaf = requestAnimationFrame(() => {
    focusRaf = null;
    const o = opts();
    useContext(previewCtx);
    buildScene(o.w, o.h, $('view'));
    renderPreviewAt(state.previewT, o, 1);
    if (!state.interacting) { rebuildCumulative(); renderInView(); }
    syncUrl();            // panning and zooming are part of the view too
  });
  if (reloadTiles) {
    clearTimeout(areaReloadTimer);
    areaReloadTimer = setTimeout(async () => {
      await loadBasemap($('o-basemap').value);
      if (!state.playing) renderPreviewAt(state.previewT, opts(), 1);
    }, 350);
  }
}

/* Scroll to zoom, drag to pan - the quickest way to frame a clip on a
   particular estuary or hillside without hunting for a preset. */
function initFraming() {
  const cv = $('view');

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    beginInteract();
    endInteract();
    const rect = cv.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    const lonSpan = (FOCUS.east - FOCUS.west) * k;
    const latSpan = (FOCUS.north - FOCUS.south) * k;
    // Zoom about the pointer rather than the centre.
    const anchorLon = FOCUS.west + (FOCUS.east - FOCUS.west) * fx;
    const anchorLat = FOCUS.north - (FOCUS.north - FOCUS.south) * fy;
    setFocus({
      west: anchorLon - lonSpan * fx,
      east: anchorLon + lonSpan * (1 - fx),
      north: anchorLat + latSpan * fy,
      south: anchorLat - latSpan * (1 - fy),
    });
  }, { passive: false });

  // Two-finger pinch, for touch devices where there is no wheel.
  const active = new Map();
  let pinch = null;

  cv.addEventListener('pointerdown', (e) => {
    beginInteract();
    active.set(e.pointerId, e);
    if (active.size === 2) {
      const [a, b] = [...active.values()];
      pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
                box: { ...FOCUS } };
      drag = null;
    }
  });
  const clearPointer = (e) => {
    endInteract();
    active.delete(e.pointerId);
    if (active.size < 2 && pinch) {
      pinch = null;
      setFocus({ ...FOCUS }, { reloadTiles: true });
    }
  };
  cv.addEventListener('pointerup', clearPointer);
  cv.addEventListener('pointercancel', clearPointer);
  cv.addEventListener('pointermove', (e) => {
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, e);
    if (!pinch || active.size !== 2) return;
    const [a, b] = [...active.values()];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!dist || !pinch.dist) return;
    const k = pinch.dist / dist;
    const cx = (pinch.box.west + pinch.box.east) / 2;
    const cy = (pinch.box.south + pinch.box.north) / 2;
    const halfLon = (pinch.box.east - pinch.box.west) / 2 * k;
    const halfLat = (pinch.box.north - pinch.box.south) / 2 * k;
    setFocus({ west: cx - halfLon, east: cx + halfLon,
               south: cy - halfLat, north: cy + halfLat },
             { reloadTiles: false });
  }, { passive: true });

  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    if (active.size > 1) return;
    drag = { x: e.clientX, y: e.clientY, box: { ...FOCUS } };
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = 'grabbing';
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag || pinch) return;
    const rect = cv.getBoundingClientRect();
    const dLon = ((e.clientX - drag.x) / rect.width) * (drag.box.east - drag.box.west);
    const dLat = ((e.clientY - drag.y) / rect.height) * (drag.box.north - drag.box.south);
    setFocus({
      west: drag.box.west - dLon, east: drag.box.east - dLon,
      north: drag.box.north + dLat, south: drag.box.south + dLat,
    }, { reloadTiles: false });
  });
  const endDrag = () => {
    endInteract();
    if (!drag) return;
    drag = null;
    cv.style.cursor = 'grab';
  cv.style.touchAction = 'none';
    setFocus({ ...FOCUS }, { reloadTiles: true });
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.style.cursor = 'grab';
  cv.style.touchAction = 'none';

  const areaSel = $('o-area');       // absent since framing moved to zoom/pan
  if (areaSel) {
    areaSel.addEventListener('change', (e) => {
      const a = AREAS[e.target.value];
      if (a) setFocus(a, { markCustom: false });
    });
  }
  $('o-area-reset').addEventListener('click', () => {
    if (areaSel) areaSel.value = 'uk';
    setFocus(AREAS.uk, { markCustom: false });
  });
}

async function fitPreview() {
  const o = opts();
  useContext(previewCtx);
  $('view').style.width = Math.round(o.w / Math.min(window.devicePixelRatio || 1, 2)) + 'px';
  $('view').style.height = Math.round(o.h / Math.min(window.devicePixelRatio || 1, 2)) + 'px';
  buildScene(o.w, o.h, $('view'));
  prepareRecords();
  await loadBasemap(o.basemap);
  renderPreviewAt(state.previewT, o, 1);
}

function populateControls() {
  const d = state.data;

  /* Type-ahead rather than a 400-row dropdown. The week-on-week movers the
     export already works out are carried onto the items, so the picker can
     lead with the birds whose numbers have actually changed - and show why,
     rather than reordering itself for no visible reason. */
  const moveBySp = new Map();
  for (const m of (d.movers || [])) moveBySp.set(m.sp, m);
  const speciesItems = d.species
    .map((sp, i) => {
      const m = moveBySp.get(i);
      return {
        idx: i, value: sp[0], label: sp[0], sub: sp[1],
        count: sp[2], thumb: sp[3] || '',
        move: m ? m.score : 0,
        moveDir: m ? m.direction : '',
        moveLabel: m ? `${m.direction === 'up' ? '\u25B2' : '\u25BC'}\u00D7${m.score.toFixed(1)}` : '',
      };
    })
    .sort((a, b) => (b.move - a.move) || (b.count - a.count));

  state.speciesItems = speciesItems;
  state.speciesCombo = makeCombobox({
    input: $('o-species-input'),
    listEl: $('o-species-list'),
    chipsEl: $('o-species-chips'),
    clearBtn: $('o-species-clear'),
    multi: true,
    photoUrl: proxiedPhoto,
    placeholder: 'All species — type to search',
    hasExtra: () => !!state.group,
    onClear: resetSubject,
    getItems: () => (state.groupSet
      ? speciesItems.filter((it) => state.groupSet.has(it.idx))
      : speciesItems),
    onSelect: (items) => {
      $('o-species').value = items.map((i) => i.value).join('|');
      loadSpeciesPhotos(items.map((i) => i.thumb));
      syncMiniPlaceholder();
      $('o-species').dispatchEvent(new Event('change', { bubbles: true }));
    },
  });

  // A real date range, bounded by what the database actually holds.
  for (const el of [$('o-from'), $('o-to')]) {
    el.min = d.dates[0];
    el.max = d.dates[d.dates.length - 1];
  }
  // The last week is what "recent" usually means here; the full range is one
  // change away for anyone who wants it.
  $('o-from').value = d.dates[Math.max(0, d.dates.length - 7)];
  $('o-to').value = d.dates[d.dates.length - 1];

  const ul = $('o-sources');
  d.sources.forEach((s, i) => {
    // Every source is in by default, acoustic records included. They are
    // aggregates over a window rather than timed observations, so they step
    // rather than flow - untick BirdWeather if that reads oddly in a clip.
    const on = true;
    const li = document.createElement('li');
    li.innerHTML = `<label><input type="checkbox" data-idx="${i}" ${on ? 'checked' : ''}>`
      + `<span>${s.label}</span><span class="cnt">${s.count.toLocaleString('en-GB')}</span></label>`;
    ul.appendChild(li);
  });

  const fmt = $('o-format');
  if (!state.caps.ffmpeg) {
    $('capabilities').textContent =
      'ffmpeg was not found, so video export is unavailable. Start the app with '
      + './run.sh to enable it.';
    fmt.disabled = true;
  } else {
    $('capabilities').textContent =
      'Rendered here on this machine — nothing is uploaded anywhere.';
  }
}

/* The app looks at the week just gone against the week before and offers the
   species whose reporting rate has moved most - which in late October is
   exactly the thrushes arriving. One click sets up that clip. */
function renderSuggestions() {
  const d = state.data;
  const box = $('suggestions');
  const list = $('suggestion-list');
  const movers = d.movers || [];
  if (!movers.length) { box.hidden = true; return; }
  box.hidden = false;
  list.innerHTML = '';

  for (const m of movers.slice(0, 6)) {
    const sp = d.species[m.sp];
    if (!sp) continue;
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'suggestion ' + m.direction;
    const change = m.direction === 'up'
      ? `×${m.score.toFixed(1)} more` : `×${m.score.toFixed(1)} fewer`;
    b.title = `${sp[0]}: ${m.was.toLocaleString('en-GB')} last week, `
            + `${m.now.toLocaleString('en-GB')} this week`;
    b.innerHTML =
      (sp[3] ? `<img class="thumb" src="${proxiedPhoto(sp[3])}" alt="" loading="lazy">`
             : '<span class="thumb empty"></span>')
      + `<span class="sug-text"><span class="sug-name">${sp[0]}</span>`
      + `<span class="sug-change">${m.direction === 'up' ? '▲' : '▼'} ${change}`
      + ` · ${m.now.toLocaleString('en-GB')} records</span></span>`;
    b.onclick = () => {
      state.speciesCombo.setSelection([sp[0]]);
      $('o-species').value = sp[0];
      loadSpeciesPhotos([sp[3]]);
      // A mover is a week-on-week story, so frame the clip on that week.
      const dates = d.dates;
      $('o-from').value = dates[Math.max(0, dates.length - (d.trendWindow || 7))];
      $('o-to').value = dates[dates.length - 1];
      $('o-species').dispatchEvent(new Event('change', { bubbles: true }));
    };
    li.appendChild(b);
    list.appendChild(li);
  }
}


/* ------------------------------------------------------- quick filters

   Named groups of birds, matched on genus (the first word of the scientific
   name) plus a few explicit species. Genus is the right key: it survives the
   vernacular differences between sources, and it is how the groups birders
   actually talk about - "phylloscs", "the thrushes" - are defined. */
const SPECIES_GROUPS = [
  { key: 'notable', label: 'Rare & unusual', flag: true },
  { key: 'pelagic', label: 'Seabirds & pelagics', genera: [
      'hydrobates', 'oceanodroma', 'oceanites', 'puffinus', 'calonectris',
      'ardenna', 'morus', 'fulmarus', 'stercorarius', 'phalaropus', 'alle',
      'fratercula', 'uria', 'alca', 'cepphus', 'rissa', 'hydrocoloeus',
      'xema', 'pagophila'] },
  { key: 'waders', label: 'Waders', genera: [
      'charadrius', 'thinornis', 'eudromias', 'pluvialis', 'vanellus',
      'calidris', 'tringa', 'actitis', 'arenaria', 'numenius', 'limosa',
      'gallinago', 'lymnocryptes', 'scolopax', 'haematopus', 'recurvirostra',
      'burhinus', 'himantopus', 'phalaropus'] },
  { key: 'wildfowl', label: 'Wildfowl', genera: [
      'anas', 'mareca', 'spatula', 'aythya', 'netta', 'branta', 'anser',
      'cygnus', 'tadorna', 'aix', 'bucephala', 'mergus', 'mergellus',
      'somateria', 'melanitta', 'clangula', 'alopochen', 'histrionicus'] },
  { key: 'raptors', label: 'Birds of prey', genera: [
      'accipiter', 'astur', 'buteo', 'milvus', 'circus', 'pernis', 'pandion',
      'falco', 'aquila', 'haliaeetus', 'hieraaetus', 'clanga', 'elanus'] },
  { key: 'owls', label: 'Owls', genera: [
      'tyto', 'strix', 'asio', 'athene', 'bubo', 'aegolius', 'surnia'] },
  { key: 'phyllosc', label: 'Phylloscopus warblers', genera: ['phylloscopus'] },
  { key: 'warblers', label: 'Warblers', genera: [
      'phylloscopus', 'sylvia', 'curruca', 'acrocephalus', 'locustella',
      'helopsaltes', 'cettia', 'hippolais', 'iduna', 'regulus'] },
  { key: 'thrushes', label: 'Thrushes', genera: [
      'turdus', 'zoothera', 'catharus', 'geokichla'] },
  { key: 'chats', label: 'Chats & flycatchers', genera: [
      'oenanthe', 'saxicola', 'phoenicurus', 'luscinia', 'erithacus',
      'muscicapa', 'ficedula', 'monticola', 'calliope', 'tarsiger'] },
  { key: 'gulls', label: 'Gulls & terns', genera: [
      'larus', 'chroicocephalus', 'hydrocoloeus', 'ichthyaetus', 'rissa',
      'xema', 'pagophila', 'sterna', 'sternula', 'thalasseus', 'chlidonias',
      'gelochelidon', 'hydroprogne'] },
  { key: 'herons', label: 'Herons & egrets', genera: [
      'ardea', 'egretta', 'bubulcus', 'botaurus', 'nycticorax', 'ixobrychus',
      'platalea', 'plegadis', 'ciconia', 'phoenicopterus'] },
  { key: 'finches', label: 'Finches & buntings', genera: [
      'fringilla', 'chloris', 'carduelis', 'spinus', 'linaria', 'acanthis',
      'loxia', 'pyrrhula', 'coccothraustes', 'serinus', 'emberiza',
      'plectrophenax', 'calcarius'] },
  { key: 'hirundines', label: 'Hirundines & Swift', genera: [
      'hirundo', 'delichon', 'riparia', 'ptyonoprogne', 'apus', 'tachymarptis'] },
  { key: 'woodpeckers', label: 'Woodpeckers', genera: [
      'picus', 'dendrocopos', 'dryobates', 'dryocopus', 'jynx'] },
  { key: 'corvids', label: 'Crows', genera: [
      'corvus', 'coloeus', 'pica', 'garrulus', 'pyrrhocorax', 'nucifraga'] },
  { key: 'tits', label: 'Tits', genera: [
      'parus', 'cyanistes', 'periparus', 'poecile', 'lophophanes',
      'aegithalos', 'panurus', 'remiz'] },
  { key: 'wintervisitor', label: 'Winter arrivals', species: [
      'turdus iliacus', 'turdus pilaris', 'bombycilla garrulus',
      'anser brachyrhynchus', 'anser albifrons', 'cygnus cygnus',
      'cygnus columbianus', 'branta leucopsis', 'branta bernicla',
      'plectrophenax nivalis', 'calcarius lapponicus', 'acanthis flammea',
      'acanthis cabaret', 'fringilla montifringilla', 'anthus spinoletta'] },
  { key: 'summermigrant', label: 'Summer migrants', species: [
      'hirundo rustica', 'delichon urbicum', 'riparia riparia', 'apus apus',
      'cuculus canorus', 'caprimulgus europaeus', 'phylloscopus trochilus',
      'phylloscopus sibilatrix', 'sylvia borin', 'curruca communis',
      'acrocephalus scirpaceus', 'acrocephalus schoenobaenus',
      'muscicapa striata', 'ficedula hypoleuca', 'oenanthe oenanthe',
      'saxicola rubetra', 'phoenicurus phoenicurus',
      'luscinia megarhynchos', 'streptopelia turtur', 'merops apiaster'] },
];

function groupMatches(group, sp) {
  const sci = (state.data.species[sp][1] || '').toLowerCase();
  if (group.species && group.species.includes(sci)) return true;
  if (group.genera && group.genera.includes(sci.split(' ')[0])) return true;
  return false;
}

function groupIndices(group) {
  if (group.flag) return null;        // handled by the notable flag instead
  const out = new Set();
  state.data.species.forEach((_sp, i) => {
    if (groupMatches(group, i)) out.add(i);
  });
  return out;
}

function renderQuickFilters() {
  const sel = $('o-group');
  if (!sel.options.length || sel.options.length === 1) {
    for (const g of SPECIES_GROUPS) {
      const opt = document.createElement('option');
      opt.value = g.key;
      opt.textContent = g.label;
      sel.appendChild(opt);
    }
  }
  sel.value = state.group || '';
}

function applyGroup(key) {
  state.group = key || null;
  // A group is several species at once, so colour them apart by default.
  if (state.group && $('o-bird-colour').value === 'warm') {
    $('o-bird-colour').value = 'species';
  }
  state.groupSet = state.group
    ? groupIndices(SPECIES_GROUPS.find((x) => x.key === state.group)) : null;
  renderQuickFilters();
  // The species picker narrows to the group, so a chosen group can be
  // refined by hand rather than replaced.
  if (state.speciesCombo) state.speciesCombo.refresh();
  prepareRecords();
  restart();
  syncUrl();
}

function activeGroup() {
  return state.group ? SPECIES_GROUPS.find((g) => g.key === state.group) : null;
}

function wireControls() {
  const rerender = () => { prepareRecords(); restart(); };
  const rebuild = () => { fitPreview(); };

  // Any control anywhere in the panel or the settings sheet updates the URL.
  // Delegated so a control added later is covered without being listed here.
  for (const root of [$('app')]) {
    root.addEventListener('change', syncUrl);
    root.addEventListener('input', syncUrl);
  }

  // Remember which sections were left folded shut.
  for (const d of document.querySelectorAll('#panel details[id]')) {
    const key = 'fold:' + d.id;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) d.open = saved === '1';
    } catch (e) { /* private browsing: just use the markup's default */ }
    d.addEventListener('toggle', () => {
      try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (e) { /* ignore */ }
    });
  }

  for (const id of ['o-species', 'o-from', 'o-to', 'o-untimed',
                    'o-bird-colour', 'o-hours']) {
    $(id).addEventListener('change', rerender);
  }
  $('o-sources').addEventListener('change', rerender);
  $('o-group').addEventListener('change', (e) => applyGroup(e.target.value));

  // Each weather slider belongs to its switch, and hides when it is off.
  const syncSubControls = () => {
    for (const el of document.querySelectorAll('.field.sub[data-for]')) {
      const owner = $(el.dataset.for);
      el.hidden = !(owner && owner.checked);
    }
  };
  for (const el of document.querySelectorAll('.field.sub[data-for]')) {
    const owner = $(el.dataset.for);
    if (owner) owner.addEventListener('change', syncSubControls);
  }
  syncSubControls();
  $('o-size').addEventListener('change', () => { rebuild(); });
  for (const id of ['o-duration', 'o-fps']) {
    $(id).addEventListener('change', () => { updateEstimate(); rerender(); });
  }
  for (const id of ['o-night', 'o-lights', 'o-wind', 'o-clouds', 'o-rain',
                    'o-stars', 'o-wind-speed', 'o-wind-fade', 'o-cloud-alpha', 'o-rain-alpha',
                    'o-light-glow', 'o-night-depth', 'o-trail', 'o-wind-weight',
                    'o-wind-alpha',
                    'o-dot-size', 'o-dot-glow', 'o-size-by-count', 'o-ripple',
                    'o-mark-style', 'o-hud-layout',
                    'o-heat', 'o-show-clock', 'o-show-counter',
                    'o-show-progress', 'o-show-credit', 'o-title',
                    'o-subtitle', 'o-format']) {
    $(id).addEventListener('input', () => {
      if (!state.playing) renderPreviewAt(state.previewT, opts(), 1);
    });
  }
  // The gear and its overlay are gone - every setting is a category in the
  // panel now, so "hide the panel" is the only thing left to wire.
  const close = $('drawer-close');
  if (close) close.addEventListener('click', () => setDrawer(false));

  $('o-basemap').addEventListener('change', async () => {
    $('o-basemap').disabled = true;
    await loadBasemap($('o-basemap').value);
    $('o-basemap').disabled = false;
    if (!state.playing) renderPreviewAt(state.previewT, opts(), 1);
  });
  $('o-wind-count').addEventListener('change', () => {
    seedParticles(Number($('o-wind-count').value));
    if (!state.playing) renderPreviewAt(state.previewT, opts(), 1);
  });
  $('o-heat').addEventListener('change', () => scene.hctx.clearRect(0, 0, view.w, view.h));

  $('scrub').addEventListener('input', (e) => {
    setPlaying(false);
    state.previewT = Number(e.target.value) / 1000;
    renderPreviewAt(state.previewT, opts(), 1);
  });
  $('btn-play').addEventListener('click', () => setPlaying(!state.playing));
  const exportDlg = $('export-dialog');
  const showExport = (on) => { exportDlg.hidden = !on; if (on) updateEstimate(); };
  $('btn-render').addEventListener('click', () => showExport(true));
  $('export-close').addEventListener('click', () => showExport(false));
  exportDlg.addEventListener('click', (e) => {
    if (e.target === exportDlg) showExport(false);
  });
  $('o-size').addEventListener('change', updateEstimate);
  $('export-start').addEventListener('click', () => {
    showExport(false);
    renderClip();
  });
  $('render-min').addEventListener('click', () => {
    $('render-overlay').classList.toggle('minimised');
  });
  $('render-cancel').addEventListener('click', () => {
    if (state.rendering) { state.rendering = false; }
    $('render-overlay').hidden = true;
    if (state.job) {
      fetch(`/api/render/cancel/${state.job}`, { method: 'POST' }).catch(() => {});
      state.job = null;
    }
  });
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    const [sightings, geo, cities] = await Promise.all([
      fetch('data/sightings.json').then((r) => r.json()),
      fetch('data/geo.json').then((r) => r.json()),
      fetch('data/cities.json').then((r) => r.json()),
    ]);
    state.data = sightings;
    state.geo = geo;
    state.cities = cities;
  } catch (e) {
    $('boot').innerHTML = '<p>Could not load the data. Run '
      + '<code>python3 -m src.fetch_all</code> and '
      + '<code>python3 -m src.geodata</code> first.</p>';
    return;
  }

  try {
    state.weather = await fetch('data/weather.json').then((r) => r.json());
  } catch (e) {
    state.weather = null;      // weather layers simply stay unavailable
  }
  try {
    state.caps = await fetch('/api/capabilities').then((r) => r.json());
    state.backend = true;
  } catch (e) {
    // Served from a static host (GitHub Pages), so there is no API behind us:
    // export falls back to in-browser capture and photos are fetched direct.
    state.caps = { ffmpeg: false, formats: [] };
    state.backend = false;
  }

  if (!state.weather) {
    for (const id of ['o-wind', 'o-clouds', 'o-rain']) {
      $(id).checked = false;
      $(id).disabled = true;
      $(id).closest('label').title =
        'Run python3 -m src.fetch_all to download the weather grid';
    }
  }

  populateControls();
  renderQuickFilters();
  renderSuggestions();
  wireControls();
  initFraming();
  captureDefaults();
  // Before initPanelSplit: it records where every movable control lives, and
  // this moves them into their panes.
  buildPanelMenu();
  initPanelSplit();
  initLayouts();
  const q = applyQuery();
  applyLayout($('o-layout').value, false);
  if (q.drawer) setDrawer(true);
  await fitPreview();
  $('boot').hidden = true;
  document.addEventListener('fullscreenchange',
                           () => setTimeout(() => fitPreview(), 120));

  let resizeTimer = null;
  const refit = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { fitPreview(); }, 180);
  };
  window.addEventListener('resize', refit);

  /* The canvas is sized from the stage's box, but at boot the stage has not
     settled at its final height yet - so the first fit came out short and
     nothing ever re-measured it. On a phone that left a 348px map sitting in
     a 530px stage with the slack split above and below it. A ResizeObserver
     catches the settle, and orientation changes and the mobile address bar
     collapsing with it, none of which reliably fire `resize`.

     Keyed on the STAGE's box, not the canvas's: fitting resizes the canvas,
     which is inside the element being observed, so keying on the canvas would
     feed back on itself. */
  let lastFitBox = '';
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      const el = $('stage');
      const box = `${el.clientWidth}x${el.clientHeight}`;
      if (box === lastFitBox) return;
      lastFitBox = box;
      refit();
    }).observe($('stage'));
  }

  if (q.autorender) {
    // Lets a render be kicked off straight from a URL, which is handy for
    // scripting a nightly clip as well as for testing.
    renderClip();
  } else if (q.frozen) {
    // setPlaying, not a bare redraw: it is what puts the icon on the button.
    setPlaying(false);
    renderPreviewAt(state.previewT, opts(), 1);
  } else {
    setPlaying(true);
  }
}

/* ------------------------------------------------------- the shareable URL

   The address bar is the save file. Everything the viewer is looking at that
   is not the data itself lives there, so a link reproduces it on someone
   else's machine and a refresh picks up where you left off. One table drives
   both directions - a setting added to it is read and written without any
   further thought, and the two can never drift apart. */

const URL_CHECKS = {
  night: 'o-night', lights: 'o-lights', wind: 'o-wind', clouds: 'o-clouds',
  rain: 'o-rain', stars: 'o-stars', heat: 'o-heat', ripple: 'o-ripple',
  clock: 'o-show-clock', counter: 'o-show-counter',
};

const URL_VALUES = {
  species: 'o-species', from: 'o-from', to: 'o-to', duration: 'o-duration',
  fps: 'o-fps', size: 'o-size', format: 'o-format', basemap: 'o-basemap',
  hours: 'o-hours',
  windWeight: 'o-wind-weight', nightDepth: 'o-night-depth',
  windAlpha: 'o-wind-alpha',
  colour: 'o-bird-colour', trail: 'o-trail', title: 'o-title',
  subtitle: 'o-subtitle', untimed: 'o-untimed', windCount: 'o-wind-count',
  hudLayout: 'o-hud-layout', markStyle: 'o-mark-style', layout: 'o-layout',
  windSpeed: 'o-wind-speed', dotSize: 'o-dot-size', dotGlow: 'o-dot-glow',
};

/* The page's own starting values, captured before any URL is applied. Only
   what differs from these is written back, which is what keeps a link for
   "Redwing since the 10th" down to two parameters instead of twenty-five. */
let URL_DEFAULTS = null;

function captureDefaults() {
  URL_DEFAULTS = {};
  for (const [key, id] of Object.entries(URL_CHECKS)) {
    URL_DEFAULTS[key] = $(id).checked;
  }
  for (const [key, id] of Object.entries(URL_VALUES)) {
    URL_DEFAULTS[key] = $(id).value;
  }
}

function boxesMatch(a, b) {
  return ['south', 'west', 'north', 'east']
    .every((k) => Math.abs(a[k] - b[k]) < 1e-4);
}

function currentQuery() {
  const p = new URLSearchParams();
  if (!URL_DEFAULTS) return p;
  for (const [key, id] of Object.entries(URL_CHECKS)) {
    if ($(id).checked !== URL_DEFAULTS[key]) {
      p.set(key, $(id).checked ? '1' : '0');
    }
  }
  for (const [key, id] of Object.entries(URL_VALUES)) {
    if ($(id).value !== URL_DEFAULTS[key]) p.set(key, $(id).value);
  }
  if (state.group) p.set('group', state.group);
  // Three decimals is about a hundred metres - finer than the framing is
  // meaningful, and short enough that the link stays readable.
  if (!boxesMatch(FOCUS, DEFAULT_FOCUS)) {
    p.set('box', [FOCUS.south, FOCUS.west, FOCUS.north, FOCUS.east]
      .map((n) => Number(n.toFixed(3))).join(','));
  }
  return p;
}

/* `t` and `play` are deliberately left out: writing the playhead would churn
   the URL sixty times a second, and a shared link that opens frozen on one
   frame is not what someone following it wants to see. They still work on the
   way in, for scripting a screenshot. */
let urlTimer = null;

function syncUrl() {
  if (typeof syncMenuValues === 'function') syncMenuValues();
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const qs = currentQuery().toString();
    // replaceState rather than pushState: dragging a slider should not bury
    // the back button under a hundred intermediate positions.
    history.replaceState(null, '', qs ? '?' + qs : location.pathname);
  }, 300);
}

/* Settings can be passed in the URL, so a particular look - or a particular
   frame - can be shared, bookmarked or screenshotted:
   ?species=Redwing&from=2026-10-10&to=2026-10-24 */
function applyQuery() {
  const p = new URLSearchParams(location.search);
  if (!p.toString()) return { frozen: false };

  for (const [key, id] of Object.entries(URL_CHECKS)) {
    if (p.has(key) && !$(id).disabled) $(id).checked = p.get(key) !== '0';
  }
  for (const [key, id] of Object.entries(URL_VALUES)) {
    if (p.has(key)) $(id).value = p.get(key);
  }
  if (p.has('windCount')) seedParticles(Number($('o-wind-count').value));
  if (p.has('basemap')) $('o-basemap').value = p.get('basemap');

  const group = p.get('group') || (p.get('notable') === '1' ? 'notable' : '');
  if (group && SPECIES_GROUPS.some((g) => g.key === group)) {
    state.group = group;
    state.groupSet = groupIndices(SPECIES_GROUPS.find((g) => g.key === group));
    $('o-group').value = group;        // the dropdown read "All birds" before
    renderQuickFilters();
    if (state.speciesCombo) state.speciesCombo.refresh();
    if ($('o-bird-colour').value === 'warm') $('o-bird-colour').value = 'species';
  }

  // Framing can arrive as a named region or as an explicit box, which is how
  // the map hands over whatever you were looking at.
  if (p.has('area') && AREAS[p.get('area')]) {
    const sel = $('o-area');
    if (sel) sel.value = p.get('area');
    setFocus(AREAS[p.get('area')], { markCustom: false, reloadTiles: false });
  }
  const box = (p.get('box') || '').split(',').map(Number);
  if (box.length === 4 && box.every((n) => !Number.isNaN(n))) {
    setFocus({ south: box[0], west: box[1], north: box[2], east: box[3] },
             { reloadTiles: false });
  }

  if (p.has('species') && state.speciesCombo) {
    const names = p.get('species').split('|').filter(Boolean);
    state.speciesCombo.setSelection(names);
    $('o-species').value = names.join('|');
    const d = state.data;
    loadSpeciesPhotos(names.map((n) => (d.species.find((s) => s[0] === n) || [])[3]));
  }


  const t = Number(p.get('t'));
  if (!Number.isNaN(t) && p.has('t')) state.previewT = clamp(t, 0, 1);
  return { frozen: p.get('play') === '0' || p.has('t'),
           autorender: p.get('autorender') === '1',
           // Opened after the layout is applied, since applying a layout
           // closes the drawer to clear whatever the last one left behind.
           drawer: p.get('settings') === '1' };
}

boot();
