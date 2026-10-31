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

function setProjection(w, h) {
  MY0 = merc(VIEW.south); MY1 = merc(VIEW.north);
  // Fit the bbox while keeping Mercator square, so nothing is stretched.
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
  px = (lon) => ox + ((lon - VIEW.west) / (VIEW.east - VIEW.west)) * cw;
  py = (lat) => oy + ch - ((merc(lat) - MY0) / (MY1 - MY0)) * ch;
  lonAt = (x) => VIEW.west + ((x - ox) / cw) * (VIEW.east - VIEW.west);
  latAt = (y) => {
    const m = MY0 + ((oy + ch - y) / ch) * (MY1 - MY0);
    return (Math.atan(Math.exp(m)) - Math.PI / 4) * 360 / Math.PI;
  };
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
  ctx.fillStyle = '#0a0d11';
  ctx.fillRect(0, 0, state.w, state.h);
  ctx.fillStyle = '#1b2026';
  for (const r of state.geo.land) if (near(r)) { ring(r); ctx.fill(); }
  ctx.fillStyle = '#0a0d11';
  for (const r of state.geo.lakes) if (near(r)) { ring(r); ctx.fill(); }
  ctx.strokeStyle = 'rgba(190, 205, 220, .20)';
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
          const t1 = phase - (seg / 5) * COMET;
          const t2 = phase - ((seg + 1) / 5) * COMET;
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

/* ------------------------------------------------------------------ HUD */

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function drawHud(ctx, t) {
  const d = state.d, W = state.w;
  const i = Math.max(0, Math.min(d.times.length - 1, Math.round(t)));
  const when = new Date(d.times[i] + 'T12:00:00');
  const S = state.h / 1920;                     // everything scales with the frame
  const pad = 54 * S;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${Math.round(86 * S)}px system-ui, -apple-system, sans-serif`;
  ctx.letterSpacing = `${2 * S}px`;
  ctx.fillText(d.species.common.toUpperCase(), W / 2, 150 * S);
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
  const axW = 330 * S, axX = W - pad - axW, axY = 288 * S;
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
  ctx.fillText('Bright: birds reported', pad, state.h - 112 * S);
  ctx.fillStyle = 'rgba(255,255,255,.62)';
  ctx.font = `500 ${Math.round(16 * S)}px system-ui, sans-serif`;
  ctx.fillText('Lines: modelled movement, not tracked birds', pad, state.h - 86 * S);
  ctx.fillStyle = 'rgba(255,255,255,.34)';
  ctx.font = `500 ${Math.round(13 * S)}px system-ui, sans-serif`;
  ctx.fillText(`${d.species.sci} · ${d.records.toLocaleString('en-GB')} reports · `
    + 'eBird/GBIF · Natural Earth', pad, state.h - 58 * S);
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
  const [w, h] = $('size').value.split('x').map(Number);
  // Fit both ways. Scaling by height alone let a 4:5 frame run off the side
  // of a narrow window, taking the title with it.
  const scale = Math.min((window.innerHeight - 96) / h,
                         (window.innerWidth - 40) / w, 1);
  const c = $('c');
  state.dpr = Math.min(2, window.devicePixelRatio || 1);
  state.w = w; state.h = h;
  c.width = w * state.dpr; c.height = h * state.dpr;
  c.style.width = Math.round(w * scale) + 'px';
  c.style.height = Math.round(h * scale) + 'px';
  state.ctx = c.getContext('2d');
  state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  setProjection(w, h);
}

async function boot() {
  const [d, geo] = await Promise.all([
    fetch('data/migration.json').then((r) => r.json()),
    fetch('data/geo.json').then((r) => r.json()),
  ]).catch(() => []);
  if (!d) {
    $('loading').textContent = 'No migration field. Run: python3 -m src.backfill '
      + '--species "Anser brachyrhynchus" then python3 -m src.migration --species ...';
    return;
  }
  state.d = d; state.geo = geo; state.weeks = d.times.length;
  $('scrub').max = state.weeks - 1;
  $('loading').hidden = true;
  $('bar').hidden = false;
  // ?week=N holds the clip at one week (the journeys still animate, so a
  // still frame has its comets); ?play=0 pauses wherever it starts.
  const q = new URLSearchParams(location.search);
  if (q.has('week')) {
    state.t = Math.max(0, Math.min(state.weeks - 1, Number(q.get('week'))));
    state.playing = false;
  }
  if (q.get('play') === '0') state.playing = false;

  resize();
  window.addEventListener('resize', resize);
  $('size').onchange = resize;
  $('play').textContent = state.playing ? 'Pause' : 'Play';
  $('when').textContent = d.times[Math.round(state.t)];
  $('scrub').value = state.t;
  $('play').onclick = () => {
    state.playing = !state.playing;
    $('play').textContent = state.playing ? 'Pause' : 'Play';
  };
  $('scrub').oninput = (e) => {
    state.playing = false; $('play').textContent = 'Play';
    state.t = Number(e.target.value);
    $('when').textContent = d.times[Math.round(state.t)];
  };
  requestAnimationFrame(frame);
}

boot();
