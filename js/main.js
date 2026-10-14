// Boots the game and runs the frame loop: the scene, the world outside under the day/night lighting, the
// control room with its monitors and console controls, the game session that they show and drive, the
// rockets, interceptors, explosions, shakes and siren that show its events, the 2D HUD over the view (the
// resources bar, the mission line, toasts and banners), and the screens and the shop over it all. The game
// opens on the title screen. The audio arrives in Task 16, the rest of the keyboard in Task 17.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TIMING, WORLD } from './config.js';
import { createBus } from './core/events.js';
import { createRng } from './core/rng.js';
import { formatClock, lightingFor, phaseName } from './game/daynight.js';
import { createSession, sortedDetectedThreats } from './game/session.js';
import { createPersistence } from './game/state.js';
import { createControls } from './scene/controls.js';
import { createEffects } from './scene/effects.js';
import { createMonitorPainter, radarBlipAt, threatRowAt } from './scene/monitors.js';
import { buildOutside } from './scene/outside.js';
import { createProjectiles } from './scene/projectiles.js';
import { buildRoom } from './scene/room.js';
import { createScene } from './scene/scene.js';
import { createHud } from './ui/hud.js';
import { createScreens } from './ui/screens.js';
import { createShop } from './ui/shop.js';

const MAX_DT = 0.1; // seconds: a hidden tab or a long frame must not jump the clock
// The window's centre, world (0, 1.9, −2.6), in the outside group's coordinates, which the session's positions use.
const WINDOW_CENTRE = { x: 0, y: 2.5, z: -2.6 };
// effects.shake() strengths (spec §8): an impact on a neighborhood, one on open ground, and an interception
// closer than WORLD.shakeNearDistance to the window.
const SHAKES = { populated: 1.0, open: 0.35, nearIntercept: 0.15 };

// The browser's local storage, or null where the page may not use it (reading it throws then).
function localStorageOrNull() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const game = (window.__game ??= { debugHour: null }); // index.html creates it before the modules load
const persistence = createPersistence(localStorageOrNull());
const settings = persistence.loadSettings();
const scene = createScene({ container: document.getElementById('viewport'), settings });
const outside = buildOutside(scene.outsideGroup, { THREE, RoundedBoxGeometry });
const room = buildRoom(scene.roomGroup, { THREE, RoundedBoxGeometry });
const projectiles = createProjectiles({ THREE, outsideGroup: scene.outsideGroup });
const effects = createEffects({ THREE, scene, outsideGroup: scene.outsideGroup, settings, props: room.props });
const bus = createBus();
const session = createSession({ rng: createRng(), persistence, bus });
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

const nearWindow = ({ x, y, z }) => (
  Math.hypot(x - WINDOW_CENTRE.x, y - WINDOW_CENTRE.y, z - WINDOW_CENTRE.z) < WORLD.shakeNearDistance
);
const soundSiren = () => room.beacon.spin(TIMING.alertSiren);
// What the session's events show, outside and in the room. Their positions are outside coordinates.
const reactions = {
  'threat:intercepted': ({ position }) => {
    effects.explosion(position, 'intercept');
    if (nearWindow(position)) effects.shake(SHAKES.nearIntercept);
  },
  'threat:damaged': ({ threat }) => effects.explosion(threat.position, 'damage'),
  'threat:impact': ({ position, populated, decoy }) => {
    if (decoy) {
      effects.explosion(position, 'decoy');
    } else if (populated) {
      effects.explosion(position, 'populated');
      effects.shake(SHAKES.populated);
      effects.flash();
    } else {
      effects.explosion(position, 'open');
      effects.shake(SHAKES.open);
    }
  },
  'interceptor:missed': ({ position }) => effects.explosion(position, 'damage'),
  'interceptor:launched': () => effects.explosion(WORLD.launchPoint, 'launch'),
  'alert:sounded': soundSiren, // in time or not, the siren sounds (spec §6)
  'life:lost': soundSiren,
};
for (const [type, react] of Object.entries(reactions)) bus.on(type, react);

// The HUD shows itself when a round starts and hides on game over and victory. The low-resource warning has
// no sound until the audio arrives (Task 16).
const hud = createHud({ root: document.getElementById('app'), bus, session, settings, onLowResource: () => {} });

// The screens and the shop take turns in the overlay container, one at a time. While it holds one, the room gets no
// pointer input (see the pointer handlers and the frame loop). The settings screen changes `settings` in place: the
// effects and the HUD read it as they go, the shadows are switched here, and the audio (Task 16, none yet) is told
// by the screen itself.
const overlay = document.getElementById('overlay');
const audio = null;
const screens = createScreens({
  root: overlay, session, persistence, settings, audio, hud,
  onSettingsChange: () => scene.setShadows(settings.shadows !== false),
});
const shop = createShop({ root: overlay, session, economy: session.economy });
const screenShown = () => overlay.childElementCount > 0;

// Which screen the session's events bring up. A round starting clears whatever screen started it.
const flow = {
  'round:start': () => {
    shop.close();
    screens.hide();
  },
  // The last campaign round ends in victory, whose own screen follows at once.
  'round:end': ({ summary }) => {
    if (state.phase !== 'victory') screens.show('summary', summary);
  },
  'shop:open': () => {
    hud.hide();
    shop.open();
  },
  'coins:changed': () => shop.render(),
  'game:over': ({ summary }) => screens.show('gameover', summary),
  // The campaign is over: no checkpoint is left to continue from.
  'campaign:victory': ({ summary, rating }) => {
    persistence.clearCheckpoint();
    screens.show('victory', { summary, rating });
  },
};
for (const [type, react] of Object.entries(flow)) bus.on(type, react);

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

Object.assign(game, {
  scene, outside, room, monitors, session, controls, bus, projectiles, effects, hud, screens, shop,
  debug: { clickControl },
});

// The pointer acts on the room only while it is over the canvas: not over a screen, not outside the window. The HUD
// lets the pointer through, so a move over it is a move over the canvas.
const canvas = scene.renderer.domElement;
let pointerOnRoom = false;
function pointAt(event) {
  const rect = canvas.getBoundingClientRect();
  scene.setPointer(((event.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((event.clientY - rect.top) / rect.height) * 2);
}
window.addEventListener('pointermove', event => {
  pointerOnRoom = event.target === canvas;
  if (pointerOnRoom) pointAt(event);
});
for (const type of ['pointerleave', 'pointercancel']) canvas.addEventListener(type, () => { pointerOnRoom = false; });
// A press acts at once, on the primary button, and picks again first: the pointer may have moved since the
// last frame (a touch has no hover at all).
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || screenShown()) return;
  pointerOnRoom = true;
  pointAt(event);
  controls.update(0, scene.pointer);
  controls.click();
});

// Esc pauses a round being played and resumes it from the pause screen.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.repeat) return;
  if (screens.current === 'pause') {
    session.resume();
    screens.hide();
  } else if (!screenShown() && session.pause()) {
    screens.show('pause');
  }
});

screens.show('title');

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_DT);
  last = now;
  time += dt;
  session.update(dt);
  projectiles.sync(state);
  hour = typeof game.debugHour === 'number' ? game.debugHour : state.clockHour;
  room.update(dt);
  // Behind a screen the room has no pointer: no control lights up, and the view comes to rest facing the window.
  if (screenShown()) scene.setPointer(0, 0);
  controls.update(dt, pointerOnRoom && !screenShown() ? scene.pointer : null);
  monitors.update(dt);
  hud.update(dt);
  outside.applyLighting(lightingFor(hour), scene);
  outside.update(dt);
  effects.update(dt);
  room.beacon.update(dt);
  scene.update(dt);
  scene.render();
}
requestAnimationFrame(frame);
