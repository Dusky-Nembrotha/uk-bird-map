/* UK Bird Sightings - the map.

   The dataset arrives as parallel arrays (see src/export_web.py) and is
   filtered in place: a filter pass produces a list of record indices, and
   only those get Leaflet layers.

   Colour encodes recency on a single-hue sequential ramp by default. Source
   identity is carried by the filter list, the legend, and - when asked for -
   three categorical hues plus a fold, because no colourblind-safe categorical
   set supports five simultaneous hues on point marks.

   Marker area encodes how many birds were reported, so a flock of 200
   Starlings reads as a flock. Acoustic records are excluded from that scale:
   their "count" is detections at a microphone, not birds. */

'use strict';

const SP = 0, LAT = 1, LON = 2, DT = 3, SRC = 4, CNT = 5, SITE = 6,
      OBS = 7, FLAG = 8, REF = 9, TIME = 10;

const F_NOTABLE = 1, F_SITE = 2, F_OBSCURED = 4, F_AGGREGATE = 8;

const RECENCY_BUCKETS = [
  { maxDays: 1,   label: 'Today / yesterday', varName: '--rec-1' },
  { maxDays: 3,   label: '2-3 days',          varName: '--rec-2' },
  { maxDays: 6,   label: '4-6 days',          varName: '--rec-3' },
  { maxDays: 10,  label: '7-10 days',         varName: '--rec-4' },
  { maxDays: 1e9, label: '11+ days',          varName: '--rec-5' },
];

const SOURCE_SLOTS = ['--series-1', '--series-2', '--series-3'];

const PRECISION_NOTE = {
  site: 'Pinned to the centre of the named place, not an exact position.',
  obscured: 'Position blurred by iNaturalist to protect a sensitive species.',
};

// Esri's Canvas basemaps are used for the plain backdrop because they are the
// only keyless dark tiles that still look good: CARTO now watermarks every
// style without an API key.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const BASEMAPS = {
  plain: {
    dark: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    darkLabels: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    light: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    lightLabels: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    attr: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    max: 16,
  },
  terrain: {
    dark: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    light: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    attr: '&copy; OpenTopoMap, &copy; OpenStreetMap contributors', max: 17,
  },
  satellite: {
    dark: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    light: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    labelsAlways: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    attr: 'Imagery &copy; Esri, Maxar, Earthstar Geographics', max: 18,
  },
  ocean: {
    dark: `${ESRI}/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}`,
    light: `${ESRI}/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}`,
    labelsAlways: `${ESRI}/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}`,
    attr: 'Tiles &copy; Esri, GEBCO, NOAA', max: 13,
  },
  street: {
    dark: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr: '&copy; OpenStreetMap contributors', max: 19,
  },
};

const state = {
  data: null,
  fromIdx: 0,
  sources: new Set(),
  species: null,
  onlyNotable: false,
  hideApprox: false,
  colourBy: 'species',
  cluster: true,
  view: 'clusters',      // or one of the TREATMENTS keys
  search: '',
  basemap: 'satellite',
  glow: true,
  inView: [],
  visible: [],
  sourceRank: [],
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-GB');

let vizRoot = null;
function cssVar(name) {
  if (!vizRoot) vizRoot = document.querySelector('.viz-root');
  return getComputedStyle(vizRoot).getPropertyValue(name).trim();
}

/* -------------------------------------------------------------------- map */

let map, canvasRenderer, clusterLayer, plainLayer, baseLayer, labelLayer;
let treatmentLayer = null;

/* Leaflet's canvas renderer draws flat discs. Setting a shadow before the
   fill gives the marks the same bloom the studio uses, which is what makes a
   dark map read as lit rather than printed. */
const GlowCanvas = L.Canvas.extend({
  _updateCircle(layer) {
    const ctx = this._ctx;
    const blur = layer.options.glowBlur;
    if (!blur || !ctx) return L.Canvas.prototype._updateCircle.call(this, layer);
    ctx.save();
    ctx.shadowBlur = blur;
    ctx.shadowColor = layer.options.fillColor;
    L.Canvas.prototype._updateCircle.call(this, layer);
    ctx.restore();
  },
});

function initMap() {
  map = L.map('map', {
    center: [54.4, -3.1], zoom: 6, preferCanvas: true,
    zoomControl: true, worldCopyJump: false, zoomSnap: 0.5,
  });
  map.attributionControl.setPrefix('');
  canvasRenderer = new GlowCanvas({ padding: 0.3 });

  clusterLayer = L.markerClusterGroup({
    chunkedLoading: true,
    chunkInterval: 100,
    /* Clicking a cluster used to fly in and scatter it into its individual
       points, which answers a question nobody asked: what a cluster needs to
       say is what is *here* - the place, who recorded it and which birds -
       not where each of the twenty-four dots sits. Zooming in is still one
       click away from inside the popup. */
    spiderfyOnMaxZoom: false,
    zoomToBoundsOnClick: false,
    showCoverageOnHover: false,
    removeOutsideVisibleBounds: true,
    maxClusterRadius: (z) => (z < 8 ? 68 : z < 11 ? 52 : 38),
    iconCreateFunction: clusterIcon,
  });
  plainLayer = L.layerGroup();

  treatmentLayer = new TreatmentLayer({
    draw: (ctx, W, H) => drawTreatment(ctx, W, H),
  });

  /* The treatments draw to a canvas with no hit targets of its own, so the
     map keeps its click behaviour by hand: the nearest record within a
     thumb's reach of the pointer. Without this, switching away from the discs
     would silently cost you every popup on the page. */
  map.on('click', (e) => {
    if (state.view === 'clusters' || !state.mercator) return;
    const p = map.latLngToContainerPoint(e.latlng);
    const size = map.getSize();
    const pts = trProject(map, state.data, state.visible,
                          state.mercator.nx, state.mercator.ny, size.x, size.y, 40);
    let best = -1, bd = 26 * 26;
    for (let k = 0; k < pts.n; k++) {
      const dx = pts.x[k] - p.x, dy = pts.y[k] - p.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = pts.i[k]; }
    }
    if (best < 0) return;
    const rec = state.data.recs[best];
    /* Everything logged at that coordinate, not the one record nearest the
       pointer. On a site like Landguard that is 400 records and 100 species,
       and handing back a single Robin would be the same failure the discs
       have: the depth at the point is the thing worth seeing. */
    const pid = state.data.pointId[best];
    const stack = [];
    for (const i of state.visible) if (state.data.pointId[i] === pid) stack.push(i);
    L.popup({ maxWidth: 300, autoPanPadding: [36, 36], closeButton: true })
      .setLatLng([rec[LAT], rec[LON]])
      .setContent(stack.length > 1
        ? clusterPopupHtml(stack.map((i) => ({ _rid: i })))
        : popupHtml(rec))
      .openOn(map);
  });
  setBasemap(state.basemap);
}

function setBasemap(key) {
  const spec = BASEMAPS[key] || BASEMAPS.plain;
  const dark = document.documentElement.dataset.resolvedTheme === 'dark';
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }

  baseLayer = L.tileLayer(dark ? spec.dark : spec.light, {
    attribution: spec.attr, maxZoom: spec.max, maxNativeZoom: spec.max,
    detectRetina: false,
  }).addTo(map);
  baseLayer.setZIndex(0);

  // Place names ride above the base but below the data.
  const labels = spec.labelsAlways
    || (dark ? spec.darkLabels : spec.lightLabels);
  if (labels) {
    labelLayer = L.tileLayer(labels, { maxZoom: spec.max,
                                       maxNativeZoom: spec.max,
                                       detectRetina: false }).addTo(map);
    labelLayer.setZIndex(1);
  }

  // OpenTopoMap has no dark edition, so it is tone-shifted to sit behind the
  // marks. Satellite imagery is left alone - inverted aerial is unreadable.
  $('map').classList.toggle('dark-tiles',
                            dark && (key === 'terrain' || key === 'street'));
}

function clusterIcon(cluster) {
  const n = cluster.getChildCount();
  const size = n < 10 ? 30 : n < 100 ? 37 : n < 1000 ? 45 : 54;
  const step = n < 10 ? '--rec-4' : n < 100 ? '--rec-3'
             : n < 1000 ? '--rec-2' : '--rec-1';
  const dark = document.documentElement.dataset.resolvedTheme === 'dark';
  // On dark the ramp runs light-to-dark as volume falls, so ink flips.
  const darkInk = !dark && (step === '--rec-1' || step === '--rec-2');
  const label = n < 1000 ? n : (Math.round(n / 100) / 10) + 'k';
  return L.divIcon({
    html: `<div class="cluster-icon${darkInk ? '' : (dark ? '' : ' dark-ink')}"`
        + ` style="width:${size}px;height:${size}px;background:${cssVar(step)}">`
        + `${label}</div>`,
    className: '', iconSize: [size, size],
  });
}

/* ---------------------------------------------------------------- encoding */

function daysAgo(dIdx) { return state.data.dates.length - 1 - dIdx; }

function recencyColour(dIdx) {
  const d = daysAgo(dIdx);
  for (const b of RECENCY_BUCKETS) if (d <= b.maxDays) return cssVar(b.varName);
  return cssVar('--rec-5');
}

function sourceColour(srcIdx) {
  const rank = state.sourceRank.indexOf(srcIdx);
  return rank >= 0 && rank < SOURCE_SLOTS.length
    ? cssVar(SOURCE_SLOTS[rank]) : cssVar('--series-other');
}

/* 400-odd species is far past what any colourblind-safe categorical set can
   carry, so these hues are decorative: identity comes from the popup, the
   legend and the species list, never from the colour alone. The golden-angle
   step keeps neighbours in the list far apart on the wheel. */
function speciesColour(idx) {
  const dark = document.documentElement.dataset.resolvedTheme === 'dark';
  const h = Math.round((idx * 137.508) % 360);
  return dark ? `hsl(${h},72%,64%)` : `hsl(${h},64%,42%)`;
}

function colourFor(rec) {
  switch (state.colourBy) {
    case 'source': return sourceColour(rec[SRC]);
    case 'species': return speciesColour(rec[SP]);
    case 'single': return cssVar('--rec-3');
    default: return recencyColour(rec[DT]);
  }
}

// Area, not radius, carries the count - radius grows with its square root.
function radiusFor(rec) {
  if (rec[FLAG] & F_AGGREGATE) return 4.2;
  const n = rec[CNT] || 1;
  return Math.min(24, 4.2 + Math.sqrt(n) * 1.35);
}

/* ----------------------------------------------------------------- popups */

function recordUrl(rec) {
  const src = state.data.sources[rec[SRC]];
  const ref = rec[REF] >= 0 ? state.data.refs[rec[REF]] : '';
  return ref && src.url ? src.url.replace('{ref}', ref) : '';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function prettyDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(+d)) return iso;
  const today = new Date(state.data.dates[state.data.dates.length - 1] + 'T12:00:00');
  const days = Math.round((today - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function popupHtml(rec) {
  const d = state.data;
  const sp = d.species[rec[SP]];
  const site = rec[SITE] >= 0 ? d.sites[rec[SITE]] : '';
  const obs = rec[OBS] >= 0 ? d.observers[rec[OBS]] : '';
  const src = d.sources[rec[SRC]];
  const url = recordUrl(rec);
  const notable = rec[FLAG] & F_NOTABLE;
  const agg = rec[FLAG] & F_AGGREGATE;

  let note = '';
  if (rec[FLAG] & F_OBSCURED) note = PRECISION_NOTE.obscured;
  else if (rec[FLAG] & F_SITE) note = PRECISION_NOTE.site;
  if (agg) {
    note = (rec[CNT] ? `${fmt(rec[CNT])} detection${rec[CNT] > 1 ? 's' : ''}`
                     : 'Detections')
         + ' by a sound recorder over this period — identified by software '
         + 'from the bird\'s call, not seen by a person.';
  }

  const when = prettyDate(d.dates[rec[DT]]) + (rec[TIME] ? ', ' + rec[TIME] : '');

  return '<div class="pop">'
    + (sp[3] ? `<img class="pop-photo" src="${esc(sp[3])}" alt="" loading="lazy">` : '')
    + '<div class="pop-body">'
    + `<div class="pop-sp">${esc(sp[0])}`
    + (notable ? ' <span class="star" title="Rare or unusual here">★</span>' : '')
    + '</div>'
    + (sp[1] ? `<div class="pop-sci">${esc(sp[1])}</div>` : '')
    + `<div class="pop-row"><b>${esc(when)}</b>`
    + (rec[CNT] && !agg ? ` · ${fmt(rec[CNT])} bird${rec[CNT] > 1 ? 's' : ''}` : '')
    + '</div>'
    + (site ? `<div class="pop-row">${esc(site)}</div>` : '')
    + (obs && obs !== site ? `<div class="pop-row muted">${esc(obs)}</div>` : '')
    + `<div class="pop-badge"><span class="swatch" style="background:${colourFor(rec)}"></span>`
    + `${esc(src.label)}${notable ? ' · rare here' : ''}</div>`
    + (note ? `<div class="pop-note">${esc(note)}</div>` : '')
    + (url ? `<a class="pop-link" href="${esc(url)}" target="_blank" rel="noopener">`
             + 'See the original record →</a>' : '')
    + (sp[4] ? `<div class="pop-credit">Photo ${esc(sp[4])}</div>` : '')
    + '</div></div>';
}

/* What a group of records at one place adds up to. Counted rather than
   listed: the question a cluster answers is "what is here", and twenty-four
   separate popups never answered it. */
function clusterPopupHtml(markers) {
  const d = state.data;
  const recs = d.recs;
  const bySp = new Map();
  const bySrc = new Map();
  const bySite = new Map();
  let lo = Infinity;
  let hi = -Infinity;
  let notable = 0;
  let agg = 0;
  let birds = 0;

  for (const m of markers) {
    const rec = recs[m._rid];
    if (!rec) continue;
    bySp.set(rec[SP], (bySp.get(rec[SP]) || 0) + 1);
    bySrc.set(rec[SRC], (bySrc.get(rec[SRC]) || 0) + 1);
    if (rec[SITE] >= 0) bySite.set(rec[SITE], (bySite.get(rec[SITE]) || 0) + 1);
    if (rec[DT] < lo) lo = rec[DT];
    if (rec[DT] > hi) hi = rec[DT];
    if (rec[FLAG] & F_NOTABLE) notable++;
    if (rec[FLAG] & F_AGGREGATE) agg++;
    birds += rec[CNT] || 0;
  }

  const total = markers.length;
  const sites = [...bySite.entries()].sort((a, b) => b[1] - a[1]);
  /* Only lead with a place when the records really are from that place. A
     cluster spanning 38 sites headed "BirdNET-Pi - Glenrothes" is just the
     busiest station standing in for all of Fife; the count is the honest
     headline there, with the main site named underneath. */
  const topSite = sites.length ? d.sites[sites[0][0]] : '';
  const dominant = sites.length === 1
    || (sites.length > 1 && sites[0][1] / total >= 0.5);
  const place = dominant && topSite
    ? topSite
    : (sites.length > 1 ? `${fmt(sites.length)} places` : 'This area');
  const species = [...bySp.entries()].sort((a, b) => b[1] - a[1]);
  const sources = [...bySrc.entries()].sort((a, b) => b[1] - a[1]);

  const dayFmt = (i) => new Date(d.dates[i] + 'T12:00:00')
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const when = lo === hi ? prettyDate(d.dates[hi]) : `${dayFmt(lo)} – ${dayFmt(hi)}`;

  // One swatch per species, taken from a real record of it so the colour
  // matches the dot on the map.
  const swatchFor = (spIdx) => {
    for (const m of markers) {
      const rec = recs[m._rid];
      if (rec && rec[SP] === spIdx) return colourFor(rec);
    }
    return 'currentColor';
  };

  const shown = species.slice(0, 8);
  const rest = species.length - shown.length;

  return '<div class="pop pop-cluster"><div class="pop-body">'
    + `<div class="pop-sp">${esc(place || 'This area')}</div>`
    + `<div class="pop-sci">${fmt(total)} record${total > 1 ? 's' : ''}`
    + ` · ${fmt(species.length)} species`
    + (dominant && sites.length > 1 ? ` · ${fmt(sites.length)} places` : '')
    + '</div>'
    + `<div class="pop-row"><b>${esc(when)}</b>`
    + (birds ? ` · ${fmt(birds)} birds counted` : '')
    + '</div>'
    + (!dominant && topSite
        ? `<div class="pop-row muted">most at ${esc(topSite)}</div>` : '')
    + '<ul class="pop-list">'
    + shown.map(([spIdx, n]) => {
      const sp = d.species[spIdx];
      return '<li>'
        + `<span class="swatch" style="background:${swatchFor(spIdx)}"></span>`
        + `<span class="pop-list-name">${esc(sp[0])}</span>`
        + `<span class="pop-list-n">${fmt(n)}</span></li>`;
    }).join('')
    + '</ul>'
    + (rest > 0 ? `<div class="pop-row muted">and ${fmt(rest)} more species</div>` : '')
    + '<div class="pop-badge">'
    + sources.map(([si, n]) => `${esc(d.sources[si].label)} ${fmt(n)}`).join(' · ')
    + '</div>'
    + (notable ? `<div class="pop-row"><span class="star">\u2605</span> `
                 + `${fmt(notable)} rare or unusual here</div>` : '')
    + (agg ? '<div class="pop-note">'
             + `${fmt(agg)} of these are sound-recorder detections, identified `
             + 'by software from the call rather than seen by a person.</div>' : '')
    + '<a class="pop-link pop-zoom" href="#">Zoom in to see each record \u2192</a>'
    + '</div></div>';
}

/* -------------------------------------------------------------- filtering */

function passes(rec, ignore) {
  if (rec[DT] < state.fromIdx) return false;
  if (!state.sources.has(rec[SRC])) return false;
  if (state.onlyNotable && !(rec[FLAG] & F_NOTABLE)) return false;
  if (state.hideApprox && (rec[FLAG] & (F_SITE | F_OBSCURED))) return false;
  if (ignore !== 'species' && state.species !== null && rec[SP] !== state.species)
    return false;
  return true;
}

function applyFilters() {
  const recs = state.data.recs;
  const out = [];
  for (let i = 0; i < recs.length; i++) if (passes(recs[i])) out.push(i);
  state.visible = out;
}

/* ---------------------------------------------------------------- drawing */

/* What the current treatment last reported about itself - counts the legend
   needs and cannot work out on its own. */
let treatmentStats = {};

function drawTreatment(ctx, W, H) {
  if (state.view === 'clusters' || !state.data || !state.mercator) return;
  const pts = trProject(map, state.data, state.visible,
                        state.mercator.nx, state.mercator.ny, W, H, 60);
  const accent = cssVar('--accent') || '#a9e34b';
  const fn = {
    hex: () => trHex(ctx, W, H, pts),
    relief: () => trRelief(ctx, W, H, pts),
    ridge: () => trRidge(ctx, W, H, pts),
    dots: () => trDots(ctx, W, H, pts, state.data, state.speciesClass),
    cells: () => trCells(ctx, W, H, pts, state.data),
    rare: () => trRare(ctx, W, H, pts, state.data, accent),
    richness: () => trRichness(ctx, W, H, pts, state.data),
    rosette: () => trRosette(ctx, W, H, pts, state.data, state.speciesClass),
    covey: () => trCovey(ctx, W, H, pts, state.data, state.speciesClass),
  }[state.view];
  treatmentStats = (fn ? fn() : {}) || {};
  treatmentStats.shown = pts.n;
  renderLegend();
}

function draw() {
  const recs = state.data.recs;

  if (state.view !== 'clusters') {
    // The discs and the treatments are alternatives, not layers: leaving the
    // markers underneath would put the clustering artefact straight back on
    // top of the thing that replaces it.
    clusterLayer.clearLayers();
    plainLayer.clearLayers();
    if (map.hasLayer(clusterLayer)) map.removeLayer(clusterLayer);
    if (map.hasLayer(plainLayer)) map.removeLayer(plainLayer);
    if (!map.hasLayer(treatmentLayer)) map.addLayer(treatmentLayer);
    else treatmentLayer.redraw();
    return;
  }
  if (map.hasLayer(treatmentLayer)) map.removeLayer(treatmentLayer);
  const ring = cssVar('--surface-1');
  const critical = cssVar('--status-critical');

  clusterLayer.clearLayers();
  plainLayer.clearLayers();

  const layers = [];
  for (const i of state.visible) {
    const rec = recs[i];
    const notable = rec[FLAG] & F_NOTABLE;
    const r = radiusFor(rec);
    const m = L.circleMarker([rec[LAT], rec[LON]], {
      renderer: canvasRenderer,
      radius: r,
      fillColor: colourFor(rec),
      fillOpacity: notable ? 0.92 : (state.glow ? 0.86 : 0.78),
      color: notable ? critical : ring,
      weight: notable ? 2 : (state.glow ? 0.8 : 1.2),
      opacity: notable ? 1 : (state.glow ? 0.45 : 0.65),
      glowBlur: state.glow ? Math.min(26, r * 2.2) : 0,
    });
    m._rid = i;
    layers.push(m);
  }

  const target = state.cluster ? clusterLayer : plainLayer;
  const other = state.cluster ? plainLayer : clusterLayer;
  if (map.hasLayer(other)) map.removeLayer(other);
  if (!map.hasLayer(target)) map.addLayer(target);

  if (state.cluster) clusterLayer.addLayers(layers);
  else for (const l of layers) plainLayer.addLayer(l);

  target.off('click').on('click', (e) => {
    const rid = e.layer && e.layer._rid;
    if (rid === undefined) return;
    L.popup({ maxWidth: 280, autoPanPadding: [36, 36], closeButton: true })
      .setLatLng(e.layer.getLatLng())
      .setContent(popupHtml(recs[rid]))
      .openOn(map);
  });

  clusterLayer.off('clusterclick').on('clusterclick', (e) => {
    const markers = e.layer.getAllChildMarkers();
    const popup = L.popup({ maxWidth: 300, autoPanPadding: [36, 36],
                            closeButton: true })
      .setLatLng(e.layer.getLatLng())
      .setContent(clusterPopupHtml(markers))
      .openOn(map);
    // The way down to the individual records, for when that is what you want.
    const el = popup.getElement && popup.getElement();
    const zoom = el && el.querySelector('.pop-zoom');
    if (zoom) {
      zoom.addEventListener('click', (ev) => {
        ev.preventDefault();
        map.closePopup();
        map.fitBounds(e.layer.getBounds(), { padding: [48, 48], maxZoom: 17 });
      });
    }
  });
}

/* --------------------------------------------------------------------- UI */

function renderStats() {
  const recs = state.data.recs;
  const sp = new Set(), sites = new Set();
  for (const i of state.visible) {
    sp.add(recs[i][SP]);
    if (recs[i][SITE] >= 0) sites.add(recs[i][SITE]);
  }
  $('stat-records').textContent = fmt(state.visible.length);
  $('stat-species').textContent = fmt(sp.size);
  $('stat-sites').textContent = fmt(sites.size);

  // The collapsed sheet is the only headline a phone sees, so it carries the
  // same numbers the desktop header does.
  $('sheet-count').textContent = fmt(state.visible.length);
  $('sheet-sub').textContent = state.species !== null
    ? `${state.data.species[state.species][0]} · tap to change`
    : `sightings · ${fmt(sp.size)} species`;
  const days = state.data.dates.length - state.fromIdx;
  $('stat-window').textContent = state.species !== null
    ? `${esc(state.data.species[state.species][0])} records`
    : (days <= 1 ? 'sightings today' : `sightings in ${days} days`);
}

function datePresetOptions() {
  const n = state.data.dates.length;
  return [
    { label: 'Today', days: 1 },
    { label: 'Last 3 days', days: 3 },
    { label: 'Last 7 days', days: 7 },
    { label: `All ${n} days`, days: n },
  ].filter((o, i, a) => o.days < n || i === a.length - 1);
}

function renderDatePresets() {
  const d = state.data, n = d.dates.length;
  const opts = datePresetOptions();
  const counts = opts.map((o) => {
    const from = Math.max(0, n - o.days);
    let c = 0;
    for (const rec of d.recs) {
      if (rec[DT] < from) continue;
      if (!state.sources.has(rec[SRC])) continue;
      if (state.onlyNotable && !(rec[FLAG] & F_NOTABLE)) continue;
      if (state.species !== null && rec[SP] !== state.species) continue;
      c++;
    }
    return c;
  });

  const box = $('date-presets');
  box.innerHTML = '';
  opts.forEach((o, i) => {
    const from = Math.max(0, n - o.days);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(from === state.fromIdx));
    b.innerHTML = `<span>${esc(o.label)}</span><span class="cnt">${fmt(counts[i])}</span>`;
    b.onclick = () => { state.fromIdx = from; refresh(); };
    box.appendChild(b);
  });

  const slider = $('date-from');
  slider.max = String(n - 1);
  slider.value = String(state.fromIdx);
  $('date-from-label').textContent = prettyDate(d.dates[state.fromIdx]);
}

function renderSources() {
  const d = state.data;
  const ul = $('source-list');
  ul.innerHTML = '';
  d.sources.forEach((s, i) => {
    const li = document.createElement('li');
    const colour = state.colourBy === 'source' ? sourceColour(i) : cssVar('--rec-3');
    li.innerHTML = `<label><input type="checkbox" ${state.sources.has(i) ? 'checked' : ''}>`
      + `<span class="swatch" style="background:${colour}"></span>`
      + `<span>${esc(s.label)}</span><span class="cnt">${fmt(s.count)}</span></label>`;
    li.querySelector('input').onchange = (e) => {
      if (e.target.checked) state.sources.add(i); else state.sources.delete(i);
      if (!state.sources.size) d.sources.forEach((_, j) => state.sources.add(j));
      refresh();
    };
    ul.appendChild(li);
  });
}

function rankSources() {
  // Ranked once over every source, never over the visible ones: a colour
  // belongs to a source, so hiding one must not repaint the others.
  state.sourceRank = state.data.sources
    .map((s, i) => [i, s.count])
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);
}

/* The sidebar answers "what is being seen *here*", so it counts only what is
   inside the current viewport. The search box still searches everything that
   passes the filters, otherwise you could not find a bird in order to go
   and look at it. */
function computeInView() {
  const recs = state.data.recs;
  const b = map.getBounds();
  const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
  const out = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r[LAT] < s || r[LAT] > n || r[LON] < w || r[LON] > e) continue;
    if (!passes(r, 'species')) continue;
    out.push(i);
  }
  state.inView = out;
  // Is the view wide enough that "here" means the whole country?
  state.viewIsNational = (n - s) > 9 && (e - w) > 11;
}

function countsOver(indices) {
  const recs = state.data.recs;
  const counts = new Map();
  for (const i of indices) {
    counts.set(recs[i][SP], (counts.get(recs[i][SP]) || 0) + 1);
  }
  return counts;
}

function speciesCounts() {
  const counts = new Map();
  const recs = state.data.recs;
  for (let i = 0; i < recs.length; i++) {
    if (!passes(recs[i], 'species')) continue;
    counts.set(recs[i][SP], (counts.get(recs[i][SP]) || 0) + 1);
  }
  return counts;
}

function renderSpecies() {
  const d = state.data;
  const counts = speciesCounts();
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || d.species[a[0]][0].localeCompare(d.species[b[0]][0]));

  const viewCounts = countsOver(state.inView);
  const viewRanked = [...viewCounts.entries()]
    .sort((a, b) => b[1] - a[1] || d.species[a[0]][0].localeCompare(d.species[b[0]][0]));
  const top = viewRanked.slice(0, 8);
  const max = top.length ? top[0][1] : 1;

  $('scope-label').textContent = state.viewIsNational ? 'across the UK' : 'in view';

  const ol = $('species-top');
  ol.innerHTML = '';
  for (const [sp, c] of top) {
    const s = d.species[sp];
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = state.species === sp ? 'on' : '';
    b.title = `${s[0]} — ${fmt(c)} records`;
    b.innerHTML =
      (s[3] ? `<img class="thumb" src="${esc(s[3])}" alt="" loading="lazy">`
            : '<span class="thumb empty"></span>')
      + `<span><span class="name">${esc(s[0])}</span>`
      + `<span class="bar" style="width:${Math.max(3, (c / max) * 100)}%"></span></span>`
      + `<span class="cnt">${fmt(c)}</span>`;
    b.onclick = () => {
      state.species = state.species === sp ? null : sp;
      refresh();
      if (isPhone() && state.species !== null) setSheet(false);
    };
    li.appendChild(b);
    ol.appendChild(li);
  }

  if (!top.length) {
    ol.innerHTML = '<li class="muted small" style="padding:6px 4px">'
      + 'Nothing in view — zoom out or widen the dates.</li>';
  }
  renderSiteDetail();

  $('species-clear').hidden = state.species === null;
  if (state.speciesCombo && document.activeElement !== $('species-search')) {
    state.speciesCombo.setValue(
      state.species === null ? '' : d.species[state.species][0]);
  }

  // What the type-ahead searches: every species that survives the other
  // filters, with its live count.
  state.speciesItems = ranked.map(([sp, c]) => ({
    idx: sp, value: d.species[sp][0], label: d.species[sp][0],
    sub: d.species[sp][1], count: c, thumb: d.species[sp][3] || '',
  }));
}

/* Zoomed in far enough that everything on screen is one place? Then the
   useful thing to show is that place, not a national top eight. */
function renderSiteDetail() {
  const box = $('site-detail');
  const d = state.data, recs = d.recs;
  const all = state.inView.filter((i) => passes(recs[i]));
  if (!all.length) { box.hidden = true; box.innerHTML = ''; return; }

  // Strictly one site, or one that clearly dominates what is on screen -
  // zoomed into a reservoir, a couple of stray garden records nearby should
  // not stop the reservoir being described.
  const tally = new Map();
  for (const i of all) {
    const si = recs[i][SITE];
    if (si >= 0) tally.set(si, (tally.get(si) || 0) + 1);
  }
  if (!tally.size) { box.hidden = true; box.innerHTML = ''; return; }
  const [siteIdx, topCount] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominant = tally.size === 1
    || (map.getZoom() >= 11 && topCount >= 3 && topCount / all.length >= 0.6);
  if (!dominant) { box.hidden = true; box.innerHTML = ''; return; }

  const shown = all.filter((i) => recs[i][SITE] === siteIdx);
  const species = new Map();
  const sources = new Set();
  const observers = new Set();
  let newest = '', oldest = '', biggest = null, lat = 0, lon = 0;
  for (const i of shown) {
    const r = recs[i];
    species.set(r[SP], (species.get(r[SP]) || 0) + 1);
    sources.add(d.sources[r[SRC]].label);
    if (r[OBS] >= 0) observers.add(d.observers[r[OBS]]);
    const day = d.dates[r[DT]];
    if (!newest || day > newest) newest = day;
    if (!oldest || day < oldest) oldest = day;
    if (r[CNT] && (!biggest || r[CNT] > biggest[0])) biggest = [r[CNT], r[SP]];
    lat += r[LAT]; lon += r[LON];
  }
  lat /= shown.length; lon /= shown.length;

  const topHere = [...species.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  box.hidden = false;
  box.innerHTML =
    `<div class="site-name">${esc(d.sites[siteIdx])}</div>`
    + `<div class="site-stats"><span><b>${fmt(shown.length)}</b> records</span>`
    + `<span><b>${fmt(species.size)}</b> species</span>`
    + `<span><b>${esc(prettyDate(newest))}</b> latest</span></div>`
    + (biggest ? `<div class="site-row">Largest count: <b>${fmt(biggest[0])}</b> `
                 + `${esc(d.species[biggest[1]][0])}</div>` : '')
    + `<div class="site-row">Most seen: `
    + topHere.map(([sp, c]) => `${esc(d.species[sp][0])} (${fmt(c)})`).join(', ')
    + '</div>'
    + `<div class="site-row muted">${[...sources].join(' · ')}`
    + (observers.size ? ` · ${fmt(observers.size)} observer${observers.size > 1 ? 's' : ''}` : '')
    + '</div>'
    + `<div class="site-row muted">${lat.toFixed(4)}, ${lon.toFixed(4)} · `
    + `${esc(oldest)} to ${esc(newest)}</div>`;
}

const TR_LEGEND_NOTE = {
  richness: 'Distinct species per cell, not records. One long checklist no'
          + ' longer lights a cell the way forty separate visits do.',
  rosette: 'One spoke per species at that exact coordinate, ordered by group,'
         + ' length by how often it was logged there. The point does not move.',
  covey: 'Each record scattered inside a disc around its own point, so a stack'
       + ' reads as a stack. The scatter is invented — positions within a'
       + ' covey mean nothing, only the covey does.',
  hex: 'Equal-area cells, quantile steps. The count belongs to the ground, not'
     + ' to the zoom level.',
  relief: 'A kernel density surface cut into bands, with an isoline on each'
        + ' break. Closer lines mean a steeper gradient.',
  ridge: 'Each ridge is one band of latitude, read west to east; near ridges'
       + ' occlude far ones.',
  cells: 'Ground nearest each recording site, shaded by what that site'
       + ' reports. This maps the observers, not the birds.',
};

function treatmentLegend() {
  const kind = (TREATMENTS[state.view] || {}).legend;
  const note = TR_LEGEND_NOTE[state.view];
  let html = `<div class="legend-title">${esc(TREATMENTS[state.view].label)}</div>`;

  if (kind === 'ramp') {
    html += '<div class="legend-ramp">'
      + TR_RAMP.map((c) => `<span style="background:${c}"></span>`).join('')
      + '</div><div class="legend-ends"><span>few</span><span>many</span></div>';
  } else if (kind === 'groups') {
    const c = treatmentStats.counts || [0, 0, 0];
    html += TR_GROUPS.map((g, i) =>
      `<div class="legend-row"><span class="swatch" style="background:${TR_CAT[i]}"></span>`
      + `${esc(g.label)} <span class="muted">${fmt(c[i] || 0)}</span></div>`).join('')
      + `<div class="legend-row"><span class="swatch" style="background:${TR_OTHER}"></span>`
      + `All other species <span class="muted">${fmt(treatmentStats.other || 0)}</span></div>`
      + '<div class="legend-row muted small">Three hues is the cap for marks that'
      + ' can land beside any other. The scarcest group is drawn last, so the'
      + ' counts are here in case the top hue looks commoner than it is.</div>';
  } else {
    html += `<div class="legend-row"><span class="swatch" style="background:${cssVar('--accent')}"></span>`
      + `Notable record <span class="muted">${fmt(treatmentStats.notable || 0)}</span></div>`
      + `<div class="legend-row"><span class="swatch" style="background:${TR_OTHER}"></span>`
      + 'Everything else</div>';
  }
  if (note) html += `<div class="legend-row muted small">${note}</div>`;
  html += '<div class="legend-row muted small">Click the map for everything'
        + ' logged at that coordinate — all of it, not the one record nearest'
        + ' the pointer.</div>';
  return html;
}

function renderLegend() {
  const box = $('legend');
  if (state.view !== 'clusters') { box.innerHTML = treatmentLegend(); return; }
  let html;
  if (state.colourBy === 'species') {
    const d = state.data;
    const top = [...countsOver(state.inView).entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6);
    html = '<div class="legend-title">Colour — species</div>'
      + top.map(([sp]) =>
          `<div class="legend-row"><span class="swatch" style="background:${speciesColour(sp)}"></span>`
          + `${esc(d.species[sp][0])}</div>`).join('')
      + '<div class="legend-row muted small">A hue per species — too many to tell'
      + ' apart by colour alone, so names are on every pin.</div>';
  } else if (state.colourBy === 'single') {
    html = '<div class="legend-title">Colour — one tone</div>';
  } else if (state.colourBy === 'recency') {
    html = '<div class="legend-title">Colour — how recent</div>'
      + '<div class="legend-ramp">'
      + RECENCY_BUCKETS.map((b) =>
          `<span style="background:${cssVar(b.varName)}" title="${esc(b.label)}"></span>`).join('')
      + '</div><div class="legend-ends"><span>Today</span><span>11+ days</span></div>';
  } else {
    const d = state.data;
    html = '<div class="legend-title">Colour — source</div>'
      + state.sourceRank.filter((i) => state.sources.has(i)).map((i) => {
          const rank = state.sourceRank.indexOf(i);
          const colour = rank < SOURCE_SLOTS.length
            ? cssVar(SOURCE_SLOTS[rank]) : cssVar('--series-other');
          return `<div class="legend-row"><span class="swatch" style="background:${colour}"></span>`
               + `${esc(d.sources[i].label)}</div>`;
        }).join('')
      + (state.sourceRank.filter((i) => state.sources.has(i)).length > SOURCE_SLOTS.length
          ? '<div class="legend-row muted small">Smaller sources share a colour — no'
            + ' colourblind-safe palette separates more than three.</div>' : '');
  }

  html += '<div class="legend-sizes">'
    + [1, 10, 100, 1000].map((n) => {
        const r = Math.min(24, 4.2 + Math.sqrt(n) * 1.35);
        return `<figure><span class="dot" style="width:${r * 2}px;height:${r * 2}px"></span>`
             + `<figcaption>${n >= 1000 ? '1k+' : n}</figcaption></figure>`;
      }).join('')
    + '</div><div class="legend-ends"><span>birds reported</span></div>';

  html += `<div class="legend-row" style="margin-top:9px">`
    + `<span class="swatch" style="background:transparent;box-shadow:0 0 0 2px ${cssVar('--status-critical')}"></span>`
    + 'Rare or unusual <span class="star">★</span></div>';
  box.innerHTML = html;
}

function renderTable() {
  const panel = $('table-panel');
  if (panel.hidden) return;
  const d = state.data, recs = d.recs;
  const rows = state.visible.slice(0, 500);
  $('table').tBodies[0].innerHTML = rows.map((i) => {
    const r = recs[i];
    const prec = (r[FLAG] & F_OBSCURED) ? 'blurred'
               : (r[FLAG] & F_SITE) ? 'site centre' : 'exact';
    return '<tr>'
      + `<td>${esc(d.species[r[SP]][0])}${(r[FLAG] & F_NOTABLE) ? ' ★' : ''}</td>`
      + `<td class="num">${r[CNT] ? fmt(r[CNT]) : ''}</td>`
      + `<td class="num">${esc(d.dates[r[DT]])}</td>`
      + `<td>${esc(r[SITE] >= 0 ? d.sites[r[SITE]] : '')}</td>`
      + `<td>${esc(d.sources[r[SRC]].label)}</td>`
      + `<td>${prec}</td></tr>`;
  }).join('');
  $('table-note').textContent =
    `· ${fmt(rows.length)} of ${fmt(state.visible.length)}`;
}

/* ------------------------------------------------- shareable URL state */

let restoring = false;

function writeHash() {
  if (restoring || !state.data) return;
  const d = state.data;
  const p = new URLSearchParams();
  if (state.fromIdx) p.set('from', d.dates[state.fromIdx]);
  if (state.species !== null) p.set('sp', d.species[state.species][0]);
  if (state.sources.size !== d.sources.length) {
    p.set('src', [...state.sources].map((i) => d.sources[i].key).join(','));
  }
  if (state.onlyNotable) p.set('notable', '1');
  if (state.hideApprox) p.set('exact', '1');
  if (state.colourBy !== 'species') p.set('colour', state.colourBy);
  if (!state.glow) p.set('glow', '0');
  if (!state.cluster) p.set('cluster', '0');
  if (state.view !== 'clusters') p.set('view', state.view);
  if (state.basemap !== 'satellite') p.set('base', state.basemap);
  if (!$('table-panel').hidden) p.set('table', '1');
  if (document.documentElement.dataset.theme === 'light') p.set('theme', 'light');
  const c = map.getCenter();
  p.set('at', `${c.lat.toFixed(3)},${c.lng.toFixed(3)},${map.getZoom()}`);
  history.replaceState(null, '', '#' + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.toString()) return;
  restoring = true;
  const d = state.data;

  const from = p.get('from');
  if (from) { const i = d.dates.indexOf(from); if (i >= 0) state.fromIdx = i; }
  const sp = p.get('sp');
  if (sp) { const i = d.species.findIndex((s) => s[0] === sp); if (i >= 0) state.species = i; }
  const src = p.get('src');
  if (src) {
    const keys = new Set(src.split(','));
    const picked = d.sources.map((s, i) => (keys.has(s.key) ? i : -1)).filter((i) => i >= 0);
    if (picked.length) state.sources = new Set(picked);
  }
  state.onlyNotable = p.get('notable') === '1';
  state.hideApprox = p.get('exact') === '1';
  const colour = p.get('colour');
  if (['species', 'recency', 'source', 'single'].includes(colour)) {
    state.colourBy = colour;
  }
  state.glow = p.get('glow') !== '0';
  state.cluster = p.get('cluster') !== '0';
  const v = p.get('view');
  if (v && TREATMENTS[v]) state.view = v;
  if (BASEMAPS[p.get('base')]) state.basemap = p.get('base');
  if (p.get('table') === '1') {
    $('table-panel').hidden = false;
    $('table-toggle').setAttribute('aria-expanded', 'true');
    $('table-toggle').textContent = 'Hide the table';
  }
  if (p.get('theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
    resolveTheme();
  }
  const at = (p.get('at') || '').split(',').map(Number);
  if (at.length === 3 && at.every((n) => !Number.isNaN(n))) map.setView([at[0], at[1]], at[2]);

  $('only-notable').checked = state.onlyNotable;
  $('hide-approx').checked = state.hideApprox;
  $('colour-by').value = state.colourBy;
  $('cluster-toggle').checked = state.cluster;
  $('view-mode').value = state.view;
  const discs = state.view === 'clusters';
  $('cluster-toggle').disabled = !discs;
  $('glow-toggle').disabled = !discs;
  $('colour-by').disabled = !discs;
  $('glow-toggle').checked = state.glow;
  $('basemap').value = state.basemap;
  restoring = false;
}

/* ------------------------------------------------------------------ glue */

let refreshTimer = null;
function refresh() {
  writeHash();
  applyFilters();
  computeInView();
  renderStats();
  renderDatePresets();
  renderSources();
  renderSpecies();
  renderLegend();
  renderTable();
  draw();
}
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 110);
}

function resolveTheme() {
  const t = document.documentElement.dataset.theme;
  const dark = t !== 'light';
  document.documentElement.dataset.resolvedTheme = dark ? 'dark' : 'light';
  return dark;
}

const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

function setSheet(open) {
  const el = $('sidebar');
  el.classList.toggle('sheet-open', open);
  $('sheet-handle').setAttribute('aria-expanded', String(open));
  if (!open) el.scrollTop = 0;
}

function initSheet() {
  const handle = $('sheet-handle');
  const sidebar = $('sidebar');

  handle.addEventListener('click', () => {
    setSheet(!sidebar.classList.contains('sheet-open'));
  });

  // Drag the handle to open or close, the way a sheet should behave.
  let startY = null, startOpen = false, moved = 0;
  handle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    startOpen = sidebar.classList.contains('sheet-open');
    moved = 0;
    sidebar.style.transition = 'none';
  }, { passive: true });

  handle.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    moved = e.touches[0].clientY - startY;
    const base = startOpen ? 0 : sidebar.offsetHeight - 74;
    const y = Math.max(0, Math.min(sidebar.offsetHeight - 74, base + moved));
    sidebar.style.transform = `translateY(${y}px)`;
  }, { passive: true });

  const end = () => {
    if (startY === null) return;
    sidebar.style.transition = '';
    sidebar.style.transform = '';
    // A short drag is a tap; the click handler deals with that.
    if (Math.abs(moved) > 40) setSheet(moved < 0);
    startY = null;
  };
  handle.addEventListener('touchend', end);
  handle.addEventListener('touchcancel', end);

  // Opening a record is a "look at the map" moment - get the sheet out of
  // the way so the pin is not hidden behind it.
  map.on('popupopen', () => { if (isPhone()) setSheet(false); });

  // ?sheet=1 opens the panel on load, for linking someone straight to the
  // filters on a phone.
  if (new URLSearchParams(location.search).get('sheet') === '1') setSheet(true);
}

function initControls() {
  $('theme-toggle').onclick = () => {
    const dark = document.documentElement.dataset.resolvedTheme === 'dark';
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    resolveTheme();
    setBasemap(state.basemap);
    refresh();
  };
  $('sidebar-toggle').onclick = () => {
    $('sidebar').classList.toggle('hidden');
    setTimeout(() => map.invalidateSize(), 80);
  };
  $('date-from').oninput = (e) => {
    state.fromIdx = Number(e.target.value);
    $('date-from-label').textContent = prettyDate(state.data.dates[state.fromIdx]);
    refreshSoon();
  };
  $('only-notable').onchange = (e) => { state.onlyNotable = e.target.checked; refresh(); };
  $('hide-approx').onchange = (e) => { state.hideApprox = e.target.checked; refresh(); };
  $('colour-by').onchange = (e) => { state.colourBy = e.target.value; refresh(); };
  $('cluster-toggle').onchange = (e) => { state.cluster = e.target.checked; refresh(); };
  $('view-mode').onchange = (e) => {
    state.view = e.target.value;
    // Grouping and glow belong to the discs; the treatments do their own
    // thing, so the controls that no longer apply say so rather than lying.
    const discs = state.view === 'clusters';
    $('cluster-toggle').disabled = !discs;
    $('glow-toggle').disabled = !discs;
    $('colour-by').disabled = !discs;
    refresh();
    writeHash();
  };
  $('glow-toggle').onchange = (e) => { state.glow = e.target.checked; refresh(); };
  $('species-clear').onclick = () => {
    state.species = null;
    if (state.speciesCombo) state.speciesCombo.setValue('');
    refresh();
  };
  state.speciesCombo = makeCombobox({
    input: $('species-search'),
    listEl: $('species-list'),
    clearBtn: $('species-search-clear'),
    getItems: () => state.speciesItems || [],
    onSelect: (item) => {
      state.species = item ? item.idx : null;
      refresh();
      if (item && isPhone()) setSheet(false);
    },
  });
  $('basemap').onchange = (e) => { state.basemap = e.target.value; setBasemap(state.basemap); writeHash(); };
  $('table-toggle').onclick = () => {
    const panel = $('table-panel');
    panel.hidden = !panel.hidden;
    $('table-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    $('table-toggle').textContent = panel.hidden ? 'Show as a table' : 'Hide the table';
    renderTable();
    writeHash();
    setTimeout(() => map.invalidateSize(), 80);
  };
  $('table-close').onclick = () => $('table-toggle').click();

  // Carry the current view, species and dates across to the studio, so
  // "animate what I am looking at" is one click.
  for (const el of document.querySelectorAll('a[href="index.html"]')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      location.href = 'index.html?' + studioQuery();
    });
  }
}

function studioQuery() {
  const d = state.data;
  const b = map.getBounds();
  const p = new URLSearchParams();
  p.set('box', [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
    .map((n) => n.toFixed(3)).join(','));
  if (state.species !== null) p.set('species', d.species[state.species][0]);
  p.set('from', d.dates[state.fromIdx]);
  p.set('to', d.dates[d.dates.length - 1]);
  return p.toString();
}

async function boot() {
  resolveTheme();
  initMap();
  initControls();
  initSheet();
  try {
    const res = await fetch('data/sightings.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (e) {
    $('loading').innerHTML = '<p>Could not load the sightings.<br>'
      + 'Run <code>python3 -m src.fetch_all</code>, then serve this folder over HTTP.</p>';
    return;
  }

  const d = state.data;
  // Mercator per record and the group each species belongs to: both are fixed
  // for the life of the page, and both are needed before the first paint.
  state.mercator = trMercator(d.recs);
  // Which records share a coordinate - the thing the spread-out
  // treatments cannot see, and three of them are entirely about.
  d.pointId = trPointIds(d.recs).id;
  state.speciesClass = trClassify(d.species);
  d.sources.forEach((_, i) => state.sources.add(i));
  rankSources();
  // Open on the last few days: it is what people mean by "right now", and it
  // paints far faster than the whole window.
  state.fromIdx = Math.max(0, d.dates.length - 3);
  readHash();
  // The URL may have restored a different theme or backdrop than the one the
  // map was created with.
  setBasemap(state.basemap);
  // Panning changes what "most reported here" means, but not the markers,
  // so only the sidebar is rebuilt.
  let viewTimer = null;
  map.on('moveend zoomend', () => {
    writeHash();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      computeInView();
      renderSpecies();
      renderLegend();
    }, 90);
  });

  $('stat-generated').textContent =
    `${fmt(d.recs.length)} records · ${d.dates[0]} to ${d.dates[d.dates.length - 1]}`
    + ` · updated ${d.generated.slice(0, 16).replace('T', ' ')}`;

  refresh();
  $('loading').hidden = true;
}

boot();
