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
  particles: [],
  w: 0, h: 0, dpr: 1,
};

/* The view. Britain, Iceland and the Norwegian Sea - the triangle this
   species actually uses - rather than the whole European export. */
const VIEW = { west: -25, east: 5, south: 49, north: 68 };

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

function seed(n) {
  state.particles = [];
  for (let i = 0; i < n; i++) {
    const x = Math.random() * state.w, y = Math.random() * state.h;
    state.particles.push({ x, y, trail: [x, y],
                           age: Math.random() * 70, life: 40 + Math.random() * 60 });
  }
}

function respawn(p) {
  /* Dropped back where the birds are, not uniformly. A particle seeded in the
     middle of the Atlantic spends its whole life in still air and contributes
     nothing but a dead pixel. */
  for (let tries = 0; tries < 24; tries++) {
    const x = Math.random() * state.w, y = Math.random() * state.h;
    if (sample('n', latAt(y), lonAt(x), state.t) > 0.05 + Math.random() * 0.25) {
      p.x = x; p.y = y; p.age = 0; p.life = 40 + Math.random() * 60;
      p.trail = [x, y];
      return;
    }
  }
  p.x = Math.random() * state.w; p.y = Math.random() * state.h;
  p.age = 0; p.life = 40 + Math.random() * 60;
  p.trail = [p.x, p.y];
}

function drawFlow(ctx, dt) {
  // Degrees per day -> pixels per frame, at the clip's own rate.
  const degPerPxLon = (VIEW.east - VIEW.west) / state.w;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const p of state.particles) {
    const lat = latAt(p.y), lon = lonAt(p.x);
    const u = sample('u', lat, lon, state.t);
    const v = sample('v', lat, lon, state.t);
    const sp = Math.hypot(u, v);
    const n = sample('n', lat, lon, state.t);
    if (sp < 0.02 || n < 0.03) { p.age += dt * 3; if (p.age > p.life) respawn(p); continue; }

    // Degrees per day, moved for one frame's worth of days.
    const k = dt * daysPerFrame() / degPerPxLon;
    p.x += u * k;
    p.y -= v * k * (Math.cos(lat * Math.PI / 180) || 1);   // screen y grows down
    p.age += dt;

    /* The trail is the mark, not the step. One segment per frame drew a
       four-pixel dash; keeping the last few positions and stroking them as a
       tapering polyline is what makes it read as something flying. */
    p.trail.push(p.x, p.y);
    if (p.trail.length > TRAIL * 2) p.trail.splice(0, 2);

    const a = Math.min(1, p.age / 8) * Math.max(0, 1 - p.age / p.life);
    const bright = 0.62 * a * Math.min(1, n * 2.4);
    for (let i = 2; i < p.trail.length; i += 2) {
      const f = i / (p.trail.length - 2);
      ctx.strokeStyle = `rgba(226, 240, 255, ${bright * f * f})`;
      ctx.lineWidth = 0.5 + 1.1 * f;
      ctx.beginPath();
      ctx.moveTo(p.trail[i - 2], p.trail[i - 1]);
      ctx.lineTo(p.trail[i], p.trail[i + 1]);
      ctx.stroke();
    }

    if (p.age > p.life || p.x < -10 || p.y < -10
        || p.x > state.w + 10 || p.y > state.h + 10) respawn(p);
  }
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
  drawFlow(ctx, dt);
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
  seed(1400);
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
  // ?week=N holds the clip at one week (the particles still fly, so a still
  // frame has its streaks); ?play=0 pauses wherever it starts.
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
