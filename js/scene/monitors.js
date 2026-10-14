// The three console screens, drawn with the Canvas 2D API into the canvases that room.js maps onto the
// monitors: the radar (centre), the resources (left) and the threat list with the missions and the log
// (right). No Three.js here, so the mapping between the world and the screens (radarProject, radarBlipAt,
// threatRowAt) runs in Node's tests; the drawing functions take the 2D context they paint.
//
// A `view` is { width, height, zoom }: the canvas size in pixels (y down) and the radar zoom, 1 or 2. The
// radar shows the outside world from above, centred on WORLD.cityCenter, with −z (away from the room) up;
// its ring covers WORLD.radarRadius / zoom units. `opts` is { time, revealDecoys, zoom, phaseName,
// clockText }: the time in seconds (it turns the sweep), whether the Signature analyzer reveals decoys, the
// zoom (the painter copies it into the views) and the clock to show. The selection is state.selectedId.
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
const LABEL_SIZE = 15;
const LABEL_CAP = 11; // the height of a label's capitals
const LABEL_GAP = 10; // between a blip and its label
const STATIC_SPECKS = 900;

// The threat list: row i is centred on y = ROW_TOP + ROW_STEP · i and is hit from ROW_ABOVE above that
// line to ROW_BELOW below it.
const ROW_TOP = 56;
const ROW_STEP = 38;
const ROW_ABOVE = 18;
const ROW_BELOW = 12;
const MAX_ROWS = 5;
const LOG_LINES = 6;
const MAX_MISSIONS = 2;

// Canvas positions on the threat screen: the jammed notice, and the area under the fifth row, with the
// missions on the left and the log on the right. Baselines are y values; a column runs from x to right.
const LAYOUT = {
  signal: { y: 100, hintY: 132 },
  lower: {
    top: 226, // the divider, 6 px under the fifth row
    labelY: 239,
    firstLine: 254,
    missions: { x: 14, textX: 30, right: 246, line: 15, gap: 6 },
    split: 256, // the line between the columns
    log: { x: 266, right: 498, line: 14 },
  },
};

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

const project = (pos, { cx, cy, scale }) => ({
  x: cx + (pos.x - WORLD.cityCenter.x) * scale,
  y: cy + (pos.z - WORLD.cityCenter.z) * scale,
});
const inScope = ({ x, y }, { cx, cy, radius }) => Math.hypot(x - cx, y - cy) <= radius;

// Where an outside point (its x and z) shows on the radar canvas.
export function radarProject(pos, view) {
  return project(pos, scopeOf(view));
}

// The id of the threat whose blip is nearest to the canvas point (px, py), if it is within maxDist pixels;
// otherwise null. A threat beyond the ring has no blip, only a marker on the rim, and is picked from the
// threat list instead.
export function radarBlipAt(threats, view, px, py, maxDist = 18) {
  const scope = scopeOf(view);
  let found = null;
  let nearest = Infinity;
  for (const threat of threats) {
    const blip = project(threat.position, scope);
    if (!inScope(blip, scope)) continue;
    const distance = Math.hypot(blip.x - px, blip.y - py);
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

function drawInterceptors(ctx, scope, state) {
  for (const interceptor of state.interceptors ?? []) {
    const from = project(interceptor.position, scope);
    if (!inScope(from, scope)) continue; // beyond the ring: not shown
    const target = state.threats.find(t => t.id === interceptor.targetId);
    if (target) {
      const to = project(target.position, scope);
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

function drawSelection(ctx, x, y, time) {
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 2.5;
  circle(ctx, x, y, BLIP_RADIUS + 6 + Math.sin(time * 6) * 1.5);
  ctx.stroke();
}

// A track beyond the ring: a hollow chevron on the rim at its bearing, pointing out towards it.
function drawRimMarker(ctx, { cx, cy, radius }, blip, color, selected, time) {
  const bearing = Math.atan2(blip.y - cy, blip.x - cx);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(bearing);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(radius - 13, -6);
  ctx.lineTo(radius - 5, 0);
  ctx.lineTo(radius - 13, 6);
  ctx.stroke();
  if (selected) drawSelection(ctx, radius - 9, 0, time);
  ctx.restore();
}

// Writes the blips' labels, most urgent first. A label goes at its blip's upper right, above it, at its upper
// left, or the same three below it: the first of these inside the ring that covers no blip and no label
// written before it, else the first inside the ring, else the upper right (cut off by the ring). Straight
// above or below a blip, a label clears the selection ring.
function drawLabels(ctx, { cx, cy, radius }, labels) {
  ctx.font = font(LABEL_SIZE);
  const halfChord = row => Math.sqrt(Math.max(radius ** 2 - (row - cy) ** 2, 0)); // the ring's half-width there
  const inRing = box => {
    const half = Math.min(halfChord(box.top), halfChord(box.bottom));
    return box.left >= cx - half && box.right <= cx + half;
  };
  const taken = labels.map(({ blip: { x, y } }) => ({
    left: x - BLIP_RADIUS, right: x + BLIP_RADIUS, top: y - BLIP_RADIUS, bottom: y + BLIP_RADIUS,
  }));
  const free = box => taken.every(t => box.right < t.left || box.left > t.right || box.bottom < t.top || box.top > t.bottom);
  for (const { string, blip: { x, y }, color } of labels) {
    const width = ctx.measureText(string).width;
    const box = (left, baseline) => ({ left, right: left + width, top: baseline - LABEL_CAP, bottom: baseline, baseline });
    const places = [
      box(x + LABEL_GAP, y - 8), box(x - width / 2, y - 16), box(x - LABEL_GAP - width, y - 8),
      box(x + LABEL_GAP, y + 20), box(x - width / 2, y + 26), box(x - LABEL_GAP - width, y + 20),
    ];
    const place = places.find(b => inRing(b) && free(b)) ?? places.find(inRing) ?? places[0];
    taken.push(place);
    text(ctx, string, place.left, place.baseline, { size: LABEL_SIZE, color });
  }
}

function drawTracks(ctx, scope, tracks, opts, selectedId) {
  const time = opts.time ?? 0;
  const labels = [];
  for (const threat of tracks) {
    const blip = project(threat.position, scope);
    const hostile = looksPopulated(threat, opts);
    const revealed = isRevealedDecoy(threat, opts);
    const color = revealed ? C.decoy : hostile ? C.red : C.grey;
    if (!inScope(blip, scope)) {
      drawRimMarker(ctx, scope, blip, color, threat.id === selectedId, time);
      continue;
    }
    circle(ctx, blip.x, blip.y, BLIP_RADIUS);
    if (revealed) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (threat.id === selectedId) drawSelection(ctx, blip.x, blip.y, time);
    labels.push({ string: revealed ? `TRK-${threat.id} DECOY` : `TRK-${threat.id}`, blip, color: hostile ? C.redSoft : C.greySoft });
  }
  drawLabels(ctx, scope, labels);
}

// The radar: rings, the sweep, the city, the tracks (red populated, grey open, hollow when a revealed
// decoy), the interceptors with a line to their target, a ring around the selected track, the status. All
// of it stays inside the ring: a track beyond it shows as a chevron on the rim, an interceptor not at all.
export function drawRadar(ctx, view, state, opts = {}) {
  const { width, height } = view;
  const scope = scopeOf(view);
  const { cx, cy, radius } = scope;
  const zoom = view.zoom ?? 1;
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
    ctx.save();
    circle(ctx, cx, cy, radius);
    ctx.clip();
    ctx.fillStyle = C.gold;
    ctx.fillRect(cx - 5, cy - 5, 10, 10); // the city
    drawInterceptors(ctx, scope, state);
    drawTracks(ctx, scope, tracks, opts, state.selectedId);
    ctx.restore();
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
  ctx.strokeRect(x, y, 11, 11);
  if (!done) return;
  ctx.beginPath();
  ctx.moveTo(x + 2.5, y + 6);
  ctx.lineTo(x + 5, y + 8.5);
  ctx.lineTo(x + 9, y + 2.5);
  ctx.stroke();
}

// Breaks `string` into lines that fit widths[0], widths[1], ... in the font set on ctx, one line per width.
// When words are left over, the last line ends in an ellipsis.
function wrap(ctx, string, widths) {
  const words = string.split(' ');
  const lines = [];
  let next = 0;
  for (const width of widths) {
    if (next >= words.length) break;
    let line = words[next++];
    while (next < words.length && ctx.measureText(`${line} ${words[next]}`).width <= width) line += ` ${words[next++]}`;
    lines.push(line);
  }
  if (next < words.length) {
    const last = lines.length - 1;
    let line = lines[last];
    while (line.length > 1 && ctx.measureText(`${line}…`).width > widths[last]) line = line.slice(0, -1);
    lines[last] = `${line.trimEnd()}…`;
  }
  return lines;
}

// The left column under the rows: the round's missions, each with a checkbox, its text on up to two lines
// and its progress.
function drawMissions(ctx, missions) {
  const { labelY, firstLine, missions: column } = LAYOUT.lower;
  text(ctx, 'MISSIONS', column.x, labelY, { size: 12, color: C.amber });
  let y = firstLine;
  for (const mission of missions.slice(0, MAX_MISSIONS)) {
    const progress = `${mission.progress}/${mission.goal}`;
    ctx.font = font(13);
    const progressWidth = ctx.measureText(progress).width + 6;
    text(ctx, progress, column.right, y, { size: 13, color: mission.done ? C.green : C.ink, align: 'right' });
    drawCheckbox(ctx, column.x, y - 10, mission.done);
    const width = column.right - column.textX;
    ctx.font = font(13, 600);
    const lines = wrap(ctx, mission.text, [width - progressWidth, width]);
    for (const line of lines) {
      text(ctx, line, column.textX, y, { size: 13, weight: 600, color: mission.done ? C.muted : C.ink, maxWidth: width });
      y += column.line;
    }
    y += column.gap;
  }
}

// The right column under the rows: the newest log lines, coloured by what they report.
function drawLog(ctx, log) {
  const { labelY, firstLine, log: column } = LAYOUT.lower;
  text(ctx, 'LOG', column.x, labelY, { size: 12, color: C.muted });
  log.slice(0, LOG_LINES).forEach((line, i) => {
    const color = LOG_COLORS.find(([pattern]) => pattern.test(line))?.[1] ?? C.greySoft;
    text(ctx, line, column.x, firstLine + column.line * i, { size: 13, color, maxWidth: column.right - column.x });
  });
}

// The threat list: up to five tracks by time to impact (SIGNAL LOST while jammed), and under them the
// round's missions with their progress beside the newest log lines.
export function drawThreats(ctx, view, state, opts = {}) {
  const { width } = view;
  const tracks = sortedDetectedThreats(state);
  ctx.save();
  fillBackground(ctx, view, C.panel);
  header(ctx, view, 'THREAT TRACKS');
  text(ctx, `${state.jammed ? '—' : tracks.length}`, width - 16, 24, { size: 19, color: C.muted, align: 'right' });

  if (state.jammed) {
    const blink = Math.floor((opts.time ?? 0) * 2) % 2 === 0;
    text(ctx, 'SIGNAL LOST', width / 2, LAYOUT.signal.y, { size: 38, color: blink ? C.red : '#a8323a', align: 'center' });
    text(ctx, 'PRESS RESET RADAR', width / 2, LAYOUT.signal.hintY, { size: 17, color: C.muted, align: 'center' });
  } else if (!tracks.length) {
    text(ctx, 'NO HOSTILE TRACKS', 22, 66, { size: 20, color: C.green });
  } else {
    drawRows(ctx, view, tracks, opts, state.selectedId);
  }

  const { top, split } = LAYOUT.lower;
  ctx.fillStyle = C.track;
  ctx.fillRect(12, top, width - 24, 2);
  ctx.fillRect(split, top + 8, 1, view.height - top - 14);
  drawMissions(ctx, state.missions ?? []);
  drawLog(ctx, state.log ?? []);
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
