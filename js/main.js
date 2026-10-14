// Boots the game and runs the frame loop: the scene, the world outside under the day/night lighting, the
// control room with its monitors and console controls, and the game session that they show and drive. The
// campaign starts at once for now. Later tasks bring the effects, the HUD, the screens and audio.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createBus } from './core/events.js';
import { createRng } from './core/rng.js';
import { formatClock, lightingFor, phaseName } from './game/daynight.js';
import { createSession, sortedDetectedThreats } from './game/session.js';
import { createPersistence, DEFAULT_SETTINGS } from './game/state.js';
import { createControls } from './scene/controls.js';
import { createMonitorPainter, radarBlipAt, threatRowAt } from './scene/monitors.js';
import { buildOutside } from './scene/outside.js';
import { buildRoom } from './scene/room.js';
import { createScene } from './scene/scene.js';

const MAX_DT = 0.1; // seconds: a hidden tab or a long frame must not jump the clock

// The browser's local storage, or null where the page may not use it (reading it throws then).
function localStorageOrNull() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const game = (window.__game ??= { debugHour: null }); // index.html creates it before the modules load
const scene = createScene({ container: document.getElementById('viewport'), settings: DEFAULT_SETTINGS });
const outside = buildOutside(scene.outsideGroup, { THREE, RoundedBoxGeometry });
const room = buildRoom(scene.roomGroup, { THREE, RoundedBoxGeometry });
const bus = createBus();
const session = createSession({ rng: createRng(), persistence: createPersistence(localStorageOrNull()), bus });
const { state } = session;

let zoom = 1; // the radar zoom, 1× or 2×; the dial switches it
let time = 0;
let hour = state.clockHour; // the hour the scene is lit for and the screens show
const monitors = createMonitorPainter(room.monitors, session, () => ({
  time,
  revealDecoys: session.revealsDecoys(),
  zoom,
  phaseName: phaseName(hour),
  clockText: formatClock(hour),
}));

// A click on a screen selects the track whose radar blip or list row is under it. A jammed radar shows none.
function selectOnScreen({ monitor, px, py }) {
  if (state.jammed) return;
  const tracks = sortedDetectedThreats(state);
  const { width, height } = room.monitors.radar;
  let id = null;
  if (monitor === 'radar') id = radarBlipAt(tracks, { width, height, zoom }, px, py);
  else if (monitor === 'threats') id = threatRowAt(tracks, py);
  if (id !== null) session.selectTrack(id);
}

// What each console control does. The lever, the toggles, the system buttons and the mug do nothing in the game.
const actions = {
  engage: () => session.engage(),
  alert: () => session.soundAlert(),
  hold: () => session.toggleHold(),
  resetRadar: () => session.resetRadar(),
  hq: () => session.callHQ(),
  dial: () => { zoom = zoom === 1 ? 2 : 1; },
  monitor: selectOnScreen,
};
const controls = createControls({
  THREE, RoundedBoxGeometry, scene, camera: scene.camera, desk: room.desk, monitors: room.monitors, room,
  onAction: (name, detail) => actions[name]?.(detail),
});

bus.on('hold:changed', ({ on }) => controls.setLamp('hold', on));
bus.on('hazard:jamming', ({ on }) => controls.setLamp('resetRadar', on));
const showLives = () => room.setLives(state.lives, state.maxLives);
for (const type of ['round:start', 'life:lost', 'life:gained', 'shop:purchased']) bus.on(type, showLives);

// Presses a control the way a click on it does: points at it, picks what is under the pointer and clicks.
// True when the click hit something. The pick uses the control's own position even when it is off screen,
// where the scene's pointer stops at the edge.
function clickControl(name) {
  const at = controls.screenPositionOf(name);
  if (!at) return false;
  scene.setPointer(at.x, at.y);
  controls.update(0, at);
  return controls.click();
}

Object.assign(game, { scene, outside, room, monitors, session, controls, bus, debug: { clickControl } });

const canvas = scene.renderer.domElement;
function pointAt(event) {
  const rect = canvas.getBoundingClientRect();
  scene.setPointer(((event.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((event.clientY - rect.top) / rect.height) * 2);
}
window.addEventListener('pointermove', pointAt);
// A press acts at once, on the primary button, and picks again first: the pointer may have moved since the
// last frame (a touch has no hover at all).
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  pointAt(event);
  controls.update(0, scene.pointer);
  controls.click();
});

session.startCampaign();

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_DT);
  last = now;
  time += dt;
  session.update(dt);
  hour = typeof game.debugHour === 'number' ? game.debugHour : state.clockHour;
  room.update(dt);
  controls.update(dt, scene.pointer);
  monitors.update(dt);
  outside.applyLighting(lightingFor(hour), scene);
  outside.update(dt);
  scene.update(dt);
  scene.render();
}
requestAnimationFrame(frame);
