// The three console screens, drawn with the Canvas 2D API into the canvases that room.js maps onto the
// monitors: the radar (centre), the resources (left) and the threat list with the missions and the log
// (right). No Three.js here, so the mapping between the world and the screens (radarProject, radarBlipAt,
// threatRowAt) runs in Node's tests; the drawing functions take the 2D context they paint.
//
// A `view` is { width, height, zoom }: the canvas size in pixels (y down) and the radar zoom, 1 or 2. The
// radar shows the outside world from above, centred on WORLD.cityCenter, with −z (away from the room) up.
// `opts` is { time, selectedId, revealDecoys, zoom, phaseName, clockText }: the time in seconds (it turns
// the sweep), the selected track, whether the Signature analyzer reveals decoys, and the clock to show.
import { WORLD, THREATS } from '../config.js';
import { timeToImpact } from '../game/threats.js';
import { sortedDetectedThreats } from '../game/session.js';
import { formatClock, phaseName } from '../game/daynight.js';

const TAU = Math.PI * 2;
const FRAME = 1 / 24; // seconds between redraws

// The radar scope: centre (width / 2, height / 2 + SCOPE_DROP), radius height / 2 − SCOPE_MARGIN.
const SCOPE_DROP = 10;
const SCOPE_MARGIN = 22;
const SWEEP_RATE = 1.2; // radians per second
const SWEEP_TRAIL = 0.9; // radians of fading glow behind the sweep line
const BLIP_RADIUS = 5.5;
const STATIC_SPECKS = 900;

// The threat list: row i is centred on y = ROW_TOP + ROW_STEP · i and is hit from ROW_ABOVE above that
// line to ROW_BELOW below it.
const ROW_TOP = 56;
const ROW_STEP = 38;
const ROW_ABOVE = 18;
const ROW_BELOW = 12;
const MAX_ROWS = 5;
const LOG_LINES = 6;

const FAMILY = '"Chakra Petch", Inter, system-ui, sans-serif';
const font = (size, weight = 700) => `${weight} ${size}px ${FAMILY}`;

const C = {
  screen: '#07111f', panel: '#0b1420', band: '#112035', track: '#1c2a3c',
  ink: '#e8eef5', muted: '#93a4b8', title: '#7dd3fc', ring: 'rgba(56, 189, 248, 0.35)',
  gold: '#ffd166', teal: '#2ad1b0', cyan: '#8ff3ff', green: '#5ad08a', amber: '#ffb020',
  red: '#ff5c5c', redSoft: '#ffb3b3', grey: '#a0a8b4', greySoft: '#c5ccd6', decoy: '#d7dee6',
  lampOn: '#ff4b4b', lampOff: '#3a2028', lampRim: '#5c3440',
};
const STATIC_SHADES = ['rgba(255, 255, 255, 0.8)', 'rgba(170, 205, 235, 0.65)', 'rgba(80, 115, 150, 0.7)', 'rgba(0, 0, 0, 0.7)'];
// Log lines take the colour of the first pattern they match.
const LOG_COLORS = [
  [/INTERCEPTED/, C.green], [/IMPACT/, C.red], [/ENGAGED/, C.cyan], [/NEW TRACK|ALERT/, C.amber],
  [/JAMMED|RESET/, C.title],
];

// --- Mapping between the world and the screens ---

function scopeOf({ width, height, zoom = 1 }) {
  const radius = height / 2 - SCOPE_MARGIN;
  return { cx: width / 2, cy: height / 2 + SCOPE_DROP, radius, scale: radius / (WORLD.radarRadius / zoom) };
}

// Where an outside point (its x and z) shows on the radar canvas.
export function radarProject(pos, view) {
  const { cx, cy, scale } = scopeOf(view);
  return { x: cx + (pos.x - WORLD.cityCenter.x) * scale, y: cy + (pos.z - WORLD.cityCenter.z) * scale };
}

// The id of the threat whose blip is nearest to the canvas point (px, py), if it is within maxDist pixels;
// otherwise null.
export function radarBlipAt(threats, view, px, py, maxDist = 18) {
  let found = null;
  let nearest = Infinity;
  for (const threat of threats) {
    const { x, y } = radarProject(threat.position, view);
    const distance = Math.hypot(x - px, y - py);
    if (distance <= maxDist && distance < nearest) {
      found = threat.id;
      nearest = distance;
    }
  }
  return found;
}

const rowY = i => ROW_TOP + ROW_STEP * i;

// The id of the threat in the list row at canvas height py, the threats taken in the order given (the list
// shows sortedDetectedThreats), or null between and below the rows.
export function threatRowAt(threats, py) {
  const rows = Math.min(threats.length, MAX_ROWS);
  for (let i = 0; i < rows; i++) {
    if (py >= rowY(i) - ROW_ABOVE && py <= rowY(i) + ROW_BELOW) return threats[i].id;
  }
  return null;
}

// --- What the screens say about a track ---

// A decoy that the Signature analyzer has not revealed looks exactly like a rocket on populated ground.
const isRevealedDecoy = (threat, opts) => threat.decoy && Boolean(opts.revealDecoys);
const looksPopulated = (threat, opts) => threat.populated || (threat.decoy && !opts.revealDecoys);
const typeLabel = (threat, opts) => {
  if (isRevealedDecoy(threat, opts)) return 'DECOY';
  return (threat.decoy ? THREATS.rocket : THREATS[threat.type]).name.toUpperCase();
};
const zoneLabel = ({ zone }) => (
  zone === 'open' ? 'OPEN' : (WORLD.neighborhoods.find(n => n.id === zone)?.name ?? zone).toUpperCase()
);
const selectedOf = (state, opts) => opts.selectedId ?? state.selectedId ?? null;
const clockOf = (state, opts) => ({
  clock: opts.clockText ?? formatClock(state.clockHour),
  phase: (opts.phaseName ?? phaseName(state.clockHour)).toUpperCase(),
});

// --- Drawing helpers ---

function text(ctx, string, x, y, { size = 18, weight = 700, color = C.ink, align = 'left', maxWidth } = {}) {
  ctx.font = font(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if (maxWidth === undefined) ctx.fillText(string, x, y);
  else ctx.fillText(string, x, y, maxWidth); // squeezed to fit
}

function circle(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
}

function fillBackground(ctx, { width, height }, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
}

function header(ctx, { width }, title, height = 34) {
  ctx.fillStyle = C.band;
  ctx.fillRect(0, 0, width, height);
  text(ctx, title, 14, height - 10, { size: 19, color: C.title });
}

// --- Radar ---

function drawSweep(ctx, cx, cy, radius, time) {
  const angle = (time * SWEEP_RATE) % TAU;
  ctx.save();
  circle(ctx, cx, cy, radius);
  ctx.clip();
  if (typeof ctx.createConicGradient === 'function') {
    // The glow runs from SWEEP_TRAIL behind the line up to the line, where it cuts off.
    const gradient = ctx.createConicGradient(angle - SWEEP_TRAIL, cx, cy);
    const lead = SWEEP_TRAIL / TAU;
    gradient.addColorStop(0, 'rgba(56, 189, 248, 0)');
    gradient.addColorStop(lead, 'rgba(56, 189, 248, 0.5)');
    gradient.addColorStop(lead + 0.002, 'rgba(56, 189, 248, 0)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  ctx.stroke();
  ctx.restore();
}

// Jamming: the scope fills with noise and shows nothing else.
function drawStatic(ctx, cx, cy, radius) {
  ctx.save();
  circle(ctx, cx, cy, radius);
  ctx.clip();
  ctx.fillStyle = '#16283a';
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  for (let i = 0; i < STATIC_SPECKS; i++) {
    ctx.fillStyle = STATIC_SHADES[Math.floor(Math.random() * STATIC_SHADES.length)];
    ctx.fillRect(cx - radius + Math.random() * radius * 2, cy - radius + Math.random() * radius * 2, 2 + Math.random() * 5, 1 + Math.random() * 2);
  }
  ctx.fillStyle = 'rgba(190, 225, 255, 0.3)';
  for (let i = 0; i < 4; i++) ctx.fillRect(cx - radius, cy - radius + Math.random() * radius * 2, radius * 2, 1 + Math.random() * 3);
  ctx.restore();
}

function drawInterceptors(ctx, view, state) {
  for (const interceptor of state.interceptors ?? []) {
    const from = radarProject(interceptor.position, view);
    const target = state.threats.find(t => t.id === interceptor.targetId);
    if (target) {
      const to = radarProject(target.position, view);
      ctx.strokeStyle = 'rgba(143, 243, 255, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = C.cyan;
    circle(ctx, from.x, from.y, 4);
    ctx.fill();
  }
}

function drawTracks(ctx, view, tracks, opts, selectedId) {
  for (const threat of tracks) {
    const { x, y } = radarProject(threat.position, view);
    const hostile = looksPopulated(threat, opts);
    if (isRevealedDecoy(threat, opts)) {
      ctx.strokeStyle = C.decoy;
      ctx.lineWidth = 2;
      circle(ctx, x, y, BLIP_RADIUS);
      ctx.stroke();
    } else {
      ctx.fillStyle = hostile ? C.red : C.grey;
      circle(ctx, x, y, BLIP_RADIUS);
      ctx.fill();
    }
    if (threat.id === selectedId) {
      ctx.strokeStyle = C.gold;
      ctx.lineWidth = 2.5;
      circle(ctx, x, y, BLIP_RADIUS + 6 + Math.sin((opts.time ?? 0) * 6) * 1.5);
      ctx.stroke();
    }
    const label = isRevealedDecoy(threat, opts) ? `TRK-${threat.id} DECOY` : `TRK-${threat.id}`;
    const onLeft = x > view.width - 100; // near the right edge the label goes on the blip's left
    text(ctx, label, onLeft ? x - 10 : x + 10, y - 8, {
      size: 15, color: hostile ? C.redSoft : C.greySoft, align: onLeft ? 'right' : 'left',
    });
  }
}

// The radar: rings, the sweep, the city, the tracks (red populated, grey open, hollow when a revealed
// decoy), the interceptors with a line to their target, a ring around the selected track, the status.
export function drawRadar(ctx, view, state, opts = {}) {
  const { width, height } = view;
  const { cx, cy, radius } = scopeOf(view);
  const zoom = view.zoom ?? opts.zoom ?? 1;
  const tracks = sortedDetectedThreats(state);
  ctx.save();
  fillBackground(ctx, view, C.screen);

  ctx.strokeStyle = C.ring;
  ctx.lineWidth = 1.5;
  for (let i = 1; i <= 4; i++) {
    circle(ctx, cx, cy, (radius * i) / 4);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  if (state.jammed) drawStatic(ctx, cx, cy, radius);
  else {
    drawSweep(ctx, cx, cy, radius, opts.time ?? 0);
    ctx.fillStyle = C.gold;
    ctx.fillRect(cx - 5, cy - 5, 10, 10); // the city
    drawInterceptors(ctx, view, state);
    drawTracks(ctx, view, tracks, opts, selectedOf(state, opts));
  }

  text(ctx, 'RADAR · JERUSALEM', 14, 24, { size: 18, color: C.title });
  const [status, statusColor] = state.jammed ? ['RADAR JAMMED', C.red]
    : state.hold ? ['HOLD FIRE', C.amber] : ['WEAPONS FREE', C.green];
  text(ctx, status, width - 14, 24, { size: 18, color: statusColor, align: 'right' });
  if (!state.jammed) text(ctx, `${tracks.length} TRACK${tracks.length === 1 ? '' : 'S'}`, 14, height - 10, { size: 15, color: C.muted });
  text(ctx, `RANGE ${WORLD.radarRadius / zoom} KM · ${zoom}×`, width - 14, height - 10, { size: 15, color: C.muted, align: 'right' });
  ctx.restore();
}

// --- Resources ---

function drawCoin(ctx, x, y, radius) {
  ctx.fillStyle = C.gold;
  circle(ctx, x, y, radius);
  ctx.fill();
  ctx.strokeStyle = '#b8892a';
  ctx.lineWidth = 3;
  circle(ctx, x, y, radius * 0.62);
  ctx.stroke();
}

// A sun by day, dawn and dusk; a crescent moon at night.
function drawSky(ctx, x, y, night) {
  ctx.fillStyle = night ? '#dfe7f5' : C.gold;
  circle(ctx, x, y, 10);
  ctx.fill();
  if (night) {
    ctx.fillStyle = C.panel;
    circle(ctx, x + 5, y - 4, 9);
    ctx.fill();
  }
}

// The resources: coins, the interceptors with their bar, the lives as lamps, the round and wave, the clock.
export function drawResources(ctx, view, state, opts = {}) {
  const { width } = view;
  const right = width - 18;
  ctx.save();
  fillBackground(ctx, view, C.panel);
  header(ctx, view, 'RESOURCES');

  text(ctx, 'COINS', 18, 64, { size: 17, color: C.muted });
  drawCoin(ctx, 38, 99, 18);
  text(ctx, state.coins.toLocaleString('en-US'), 66, 120, { size: 58, color: C.gold, maxWidth: right - 66 });

  text(ctx, 'INTERCEPTORS', 18, 152, { size: 17, color: C.muted });
  text(ctx, `${state.ammo} / ${state.ammoCapacity}`, right, 154, { size: 24, align: 'right' });
  const share = state.ammoCapacity > 0 ? Math.min(Math.max(state.ammo / state.ammoCapacity, 0), 1) : 0;
  ctx.fillStyle = C.track;
  ctx.fillRect(18, 162, right - 18, 22);
  ctx.fillStyle = C.teal;
  ctx.fillRect(18, 162, (right - 18) * share, 22);

  text(ctx, 'LIVES', 18, 222, { size: 17, color: C.muted });
  for (let i = 0; i < state.maxLives; i++) {
    const lit = i < state.lives;
    const x = 104 + i * 34;
    ctx.save();
    if (lit) {
      ctx.shadowColor = C.lampOn;
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = lit ? C.lampOn : C.lampOff;
    circle(ctx, x, 215, 12);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = lit ? '#ffb3b3' : C.lampRim;
    ctx.lineWidth = 2;
    circle(ctx, x, 215, 12);
    ctx.stroke();
  }

  text(ctx, `ROUND ${state.round} · WAVE ${state.wave}/${state.waveCount}`, 18, 274, { size: 28, maxWidth: right - 18 });

  const { clock, phase } = clockOf(state, opts);
  drawSky(ctx, 30, 306, phase === 'NIGHT');
  text(ctx, clock, 50, 316, { size: 28 });
  text(ctx, phase, right, 316, { size: 22, color: C.amber, align: 'right' });
  ctx.restore();
}

// --- Threats, missions and log ---

function drawRows(ctx, view, tracks, opts, selectedId) {
  const right = view.width - 22;
  tracks.slice(0, MAX_ROWS).forEach((threat, i) => {
    const y = rowY(i);
    const hostile = looksPopulated(threat, opts);
    ctx.fillStyle = hostile ? 'rgba(255, 77, 79, 0.2)' : 'rgba(160, 168, 180, 0.14)';
    ctx.fillRect(12, y - ROW_ABOVE, view.width - 24, ROW_ABOVE + ROW_BELOW);
    if (threat.id === selectedId) {
      ctx.strokeStyle = C.gold;
      ctx.lineWidth = 3;
      ctx.strokeRect(13.5, y - ROW_ABOVE + 1.5, view.width - 27, ROW_ABOVE + ROW_BELOW - 3);
    }
    const soft = hostile ? C.redSoft : C.greySoft;
    text(ctx, `TRK-${threat.id}`, 22, y + 4, { size: 20 });
    text(ctx, typeLabel(threat, opts), 116, y + 4, { size: 20, maxWidth: 190 });
    text(ctx, zoneLabel(threat), 316, y + 4, { size: 20, color: soft, maxWidth: 110 });
    text(ctx, `${timeToImpact(threat).toFixed(1)}s`, right, y + 4, { size: 20, color: soft, align: 'right' });
  });
}

function drawCheckbox(ctx, x, y, done) {
  ctx.strokeStyle = done ? C.green : C.muted;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, 13, 13);
  if (!done) return;
  ctx.beginPath();
  ctx.moveTo(x + 3, y + 7);
  ctx.lineTo(x + 6, y + 10);
  ctx.lineTo(x + 11, y + 3);
  ctx.stroke();
}

// The threat list: up to five tracks by time to impact (SIGNAL LOST while jammed), then the round's
// missions with their progress and the newest log lines.
export function drawThreats(ctx, view, state, opts = {}) {
  const { width, height } = view;
  const right = width - 16;
  const tracks = sortedDetectedThreats(state);
  ctx.save();
  fillBackground(ctx, view, C.panel);
  header(ctx, view, 'THREAT TRACKS');

  let lowerTop;
  if (state.jammed) {
    const blink = Math.floor((opts.time ?? 0) * 2) % 2 === 0;
    text(ctx, 'SIGNAL LOST', width / 2, 100, { size: 38, color: blink ? C.red : '#a8323a', align: 'center' });
    text(ctx, 'PRESS RESET RADAR', width / 2, 132, { size: 17, color: C.muted, align: 'center' });
    lowerTop = 150;
  } else if (!tracks.length) {
    text(ctx, 'NO HOSTILE TRACKS', 22, 66, { size: 20, color: C.green });
    lowerTop = 150;
  } else {
    drawRows(ctx, view, tracks, opts, selectedOf(state, opts));
    lowerTop = Math.max(rowY(Math.min(tracks.length, MAX_ROWS)) - 8, 150);
  }
  text(ctx, `${state.jammed ? '—' : tracks.length}`, right, 24, { size: 19, color: C.muted, align: 'right' });

  ctx.fillStyle = C.track;
  ctx.fillRect(12, lowerTop, width - 24, 2);
  let y = lowerTop + 21;
  text(ctx, 'MISSIONS', 16, y, { size: 15, color: C.amber });
  for (const mission of state.missions ?? []) {
    y += 20;
    drawCheckbox(ctx, 16, y - 12, mission.done);
    text(ctx, mission.text, 38, y, { size: 16, weight: 600, color: mission.done ? C.muted : C.ink, maxWidth: right - 38 - 56 });
    text(ctx, `${mission.progress}/${mission.goal}`, right, y, { size: 16, color: mission.done ? C.green : C.ink, align: 'right' });
  }
  y += 8;
  ctx.fillStyle = C.track;
  ctx.fillRect(12, y, width - 24, 1);
  text(ctx, 'LOG', 16, y + 17, { size: 14, color: C.muted });
  for (const line of (state.log ?? []).slice(0, LOG_LINES)) {
    y += 17;
    if (y > height - 4) break; // a long list of tracks leaves room for fewer lines
    const color = LOG_COLORS.find(([pattern]) => pattern.test(line))?.[1] ?? C.greySoft;
    text(ctx, line, 56, y, { size: 16, weight: 600, color, maxWidth: right - 56 });
  }
  ctx.restore();
}

// --- Painter ---

// Redraws the three screens from session.state at 24 frames per second: update(dt) adds up the time and
// paints when a frame is due (the first call paints at once). getOpts() supplies the opts of each paint.
// `monitors` is room.js's { resources, radar, threats }, each with its ctx, texture, width and height.
export function createMonitorPainter(monitors, session, getOpts) {
  const screens = [
    [monitors.radar, drawRadar],
    [monitors.resources, drawResources],
    [monitors.threats, drawThreats],
  ].map(([monitor, draw]) => ({ monitor, draw, view: { width: monitor.width, height: monitor.height, zoom: 1 } }));
  let elapsed = FRAME;

  function update(dt) {
    elapsed += dt;
    if (elapsed < FRAME) return;
    elapsed = (elapsed - FRAME) % FRAME;
    const opts = getOpts();
    for (const { monitor, draw, view } of screens) {
      view.zoom = opts.zoom ?? 1;
      draw(monitor.ctx, view, session.state, opts);
      monitor.texture.needsUpdate = true;
    }
  }

  return { update };
}
