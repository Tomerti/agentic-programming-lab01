// Boots the game and runs the frame loop: the scene, the world outside under the day/night lighting, the
// control room with its monitors and console controls, the game session that they show and drive, the
// rockets, interceptors, explosions, shakes and siren that show its events, the sound of its events and of
// the controls, the 2D HUD over the view (the resources bar, the mission line, toasts and banners), the
// screens and the shop over it all, and the keyboard. The game opens on the title screen.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createAudio } from './audio.js';
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
import { buildRoom, WINDOW_CENTRE_WORLD } from './scene/room.js';
import { createScene, OUTSIDE_Y } from './scene/scene.js';
import { createHud } from './ui/hud.js';
import { createScreens } from './ui/screens.js';
import { createShop } from './ui/shop.js';

const MAX_DT = 0.1; // seconds: a hidden tab or a long frame must not jump the clock
// The window's centre in the outside group's coordinates, which the session's positions use.
const WINDOW_CENTRE = Object.freeze({ ...WINDOW_CENTRE_WORLD, y: WINDOW_CENTRE_WORLD.y - OUTSIDE_Y });
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
const room = buildRoom(scene.roomGroup, { THREE, RoundedBoxGeometry, settings });
const projectiles = createProjectiles({ THREE, outsideGroup: scene.outsideGroup });
const effects = createEffects({ THREE, scene, outsideGroup: scene.outsideGroup, settings, props: room.props });
const bus = createBus();
const session = createSession({ rng: createRng(), persistence, bus });
const { state } = session;
// The sound plays the session's events, its explosions heard from the window. It stays silent until a screen's button
// that starts play unlocks it (browsers allow sound only after a user gesture). It keeps the volume and the mute in
// `settings`; the settings screen saves its own changes, and a mute toggled from the keyboard (M) is saved here.
const audio = createAudio(settings, { onMutedChange: () => persistence.saveSettings(settings) });
audio.bind(bus, session, { listener: WINDOW_CENTRE });

let time = 0;
let hour = state.clockHour; // the hour the scene is lit for and the screens show
const monitors = createMonitorPainter(room.monitors, session, () => ({
  time,
  revealDecoys: session.revealsDecoys(),
  zoom: radarZoom(),
  phaseName: phaseName(hour),
  clockText: formatClock(hour),
}));

// The radar zoom, 1× or 2×, is the range dial's setting and is kept nowhere else: a click on the dial and the Z key
// both turn the dial. (Read only once the controls exist: by the painter's first frame and by clicks.)
function radarZoom() {
  return controls.controlsByName.dial.on ? 2 : 1;
}

// Selects a track with a soft click. Nothing happens for an id that is no track on radar.
function pickTrack(id) {
  if (id !== null && id !== undefined && session.selectTrack(id)) audio.play('click', { gain: 0.5 });
}

// A click on a screen selects the track whose radar blip or list row is under it. A jammed radar shows none.
function selectOnScreen({ monitor, px, py }) {
  if (state.jammed) return;
  const tracks = sortedDetectedThreats(state);
  const { width, height } = room.monitors.radar;
  if (monitor === 'radar') pickTrack(radarBlipAt(tracks, { width, height, zoom: radarZoom() }, px, py));
  else if (monitor === 'threats') pickTrack(threatRowAt(tracks, py));
}

// The sound of each console control as it is pressed, as [sound, gain]: the big buttons click, the toggles, the lever,
// the dial and the system buttons clack, and the mug and the clipboard knock softly. The phone rings through the
// session's hq:line.
const CONTROL_SOUNDS = Object.freeze({
  engage: ['click', 1], alert: ['click', 1], hold: ['click', 1], resetRadar: ['click', 1],
  toggle: ['clack', 1], lever: ['clack', 1], dial: ['clack', 1], system: ['clack', 1],
  mug: ['clack', 0.45], clipboard: ['clack', 0.45],
});
// What each console control does. The lever, the toggles, the system buttons, the mug and the clipboard do nothing in
// the game, and the dial only turns: the radar reads its zoom from it (radarZoom).
const actions = {
  engage: () => session.engage(),
  alert: () => session.soundAlert(),
  hold: () => session.toggleHold(),
  resetRadar: () => session.resetRadar(),
  hq: () => session.callHQ(),
  monitor: selectOnScreen,
};
const controls = createControls({
  THREE, RoundedBoxGeometry, scene, camera: scene.camera, desk: room.desk, monitors: room.monitors, room,
  onAction: (name, detail) => {
    if (Object.hasOwn(CONTROL_SOUNDS, name)) {
      const [sound, gain] = CONTROL_SOUNDS[name];
      audio.play(sound, { gain });
    }
    actions[name]?.(detail);
  },
});

bus.on('hold:changed', ({ on }) => controls.setLamp('hold', on));
bus.on('hazard:jamming', ({ on }) => controls.setLamp('resetRadar', on));
// The lamps show the lives, and a retry's shop shows those of its checkpoint behind it.
const showLives = () => room.setLives(state.lives, state.maxLives);
for (const type of ['round:start', 'shop:open', 'life:lost', 'life:gained', 'shop:purchased']) bus.on(type, showLives);

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

// The HUD shows itself when a round starts and hides on game over and victory. While a resource is low it sounds
// the warning beeps (at most every 8 s).
const hud = createHud({
  root: document.getElementById('app'), bus, session, settings, onLowResource: () => audio.play('warning'),
});

// The screens and the shop take turns in the overlay container, one at a time. While it holds one, the room gets no
// pointer input (see the pointer handlers and the frame loop). The settings screen changes `settings` in place: the
// effects and the HUD read it as they go, and the shadows, the volume and the mute are applied here. The buttons
// that start play unlock the audio.
const overlay = document.getElementById('overlay');
const screens = createScreens({
  root: overlay, session, persistence, settings, audio, hud,
  onSettingsChange: () => {
    scene.setShadows(settings.shadows !== false);
    audio.setVolume(settings.volume);
    audio.setMuted(settings.muted);
  },
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
// True when that control was under the pointer and pressed; false, and no click, when something else stands in
// front of it (or it is unknown). The pick uses the control's own position even when it is off screen, where the
// scene's pointer stops at the edge.
function clickControl(name) {
  const at = controls.screenPositionOf(name);
  if (!at) return false;
  scene.setPointer(at.x, at.y);
  controls.update(0, at);
  return controls.hovered === name && controls.click();
}

Object.assign(game, {
  scene, outside, room, monitors, session, controls, bus, projectiles, effects, hud, screens, shop, audio,
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

// --- The keyboard ---

// A key's name for the shortcuts: a letter or a digit as its key cap reads, in lower case, or, on a layout that does
// not type Latin letters (Hebrew, say), the letter or digit of the same key on a US keyboard; any other key as
// event.key has it (' ', 'Tab', 'Escape').
function keyName({ key, code = '' }) {
  if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
  const us = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  return us ? (us[1] ?? us[2]).toLowerCase() : key;
}

// Tab steps through the tracks in the threat list's order (Shift+Tab back), with the soft click of a pick on a screen;
// a jammed radar shows none to step through.
function stepTracks(dir) {
  if (!state.jammed && session.cycleSelection(dir) !== null) audio.play('click', { gain: 0.5 });
}

// 1–5 pick that row of the threat list (sortedDetectedThreats, as the screen lists them).
function selectRow(row) {
  if (!state.jammed) pickTrack(sortedDetectedThreats(state)[row]?.id);
}

// M switches the sound off or on, saved like the settings screen's mute, and a toast says which.
function toggleSound() {
  hud.toast(audio.toggleMuted() ? 'Sound off' : 'Sound on');
}

// The console's keys (spec §6), by keyName(). A button's key presses it as a click does (controls.press), so the
// button moves and clicks and runs the same action; Z turns the range dial. They act only while no screen is up, and
// once per press: a key held down does not repeat, except Tab, which steps on through the tracks.
const KEYS = {
  ' ': () => controls.press('engage'),
  a: () => controls.press('alert'),
  h: () => controls.press('hold'),
  r: () => controls.press('resetRadar'),
  z: () => controls.press('dial'),
  m: toggleSound,
  Tab: event => stepTracks(event.shiftKey ? -1 : 1),
  ...Object.fromEntries([1, 2, 3, 4, 5].map(n => [n, () => selectRow(n - 1)])),
};
const REPEATING_KEYS = new Set(['Tab']);

// Esc pauses a round being played and resumes it from the pause screen. Every other key of KEYS is the room's only
// while no screen is up (the pause screen takes Esc alone); a key that acts is kept from the page, where Space would
// scroll and Tab move the focus. The browser's own shortcuts (Ctrl, Alt or Meta held) are left alone.
window.addEventListener('keydown', event => {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const name = keyName(event);
  if (name === 'Escape') {
    if (event.repeat) return;
    if (screens.current === 'pause') {
      event.preventDefault();
      session.resume();
      screens.hide();
    } else if (screens.current === null && session.pause()) {
      event.preventDefault();
      screens.show('pause');
    }
    return;
  }
  if (!Object.hasOwn(KEYS, name) || screens.current !== null) return;
  event.preventDefault();
  if (!event.repeat || REPEATING_KEYS.has(name)) KEYS[name](event);
});

// A screen that opens by itself (a round's summary, game over, victory, the shop) gives the keyboard to its main
// button, which Space and Enter press. Meant for the console a moment too late, or held down as the screen opened,
// they would press that button and skip the screen. So on a screen the browser's default is prevented, and the
// button stays up, for a Space or an Enter pressed less than SCREEN_KEY_DELAY ms after the screen opened (by the
// key's own time stamp: a slow frame may hand the page the key later), for every repeat of a key held down (held,
// a key presses a button once at most) and for the release of a key that the screen did not take.
const SCREEN_KEY_DELAY = 300; // ms
const PRESS_KEYS = new Set([' ', 'Enter']);
const pressedOnScreen = new Set(); // the PRESS_KEYS held down now that the screen shown has taken
let screenOpenedAt = -Infinity; // performance.now() when the overlay last changed screens
function screenChanged() {
  screenOpenedAt = performance.now();
  pressedOnScreen.clear(); // a key held down from the screen before is not this one's
}
const screenChanges = new MutationObserver(screenChanged);
screenChanges.observe(overlay, { childList: true });
function guardScreenKeys(event) {
  if (!PRESS_KEYS.has(event.key)) return;
  if (screenChanges.takeRecords().length) screenChanged(); // a change in this same task, not reported yet
  if (event.type === 'keyup') {
    if (!pressedOnScreen.delete(event.key) && screens.current !== null) event.preventDefault();
  } else if (screens.current !== null) {
    if (event.repeat || event.timeStamp - screenOpenedAt < SCREEN_KEY_DELAY) event.preventDefault();
    else pressedOnScreen.add(event.key);
  }
}
window.addEventListener('keydown', guardScreenKeys, true);
window.addEventListener('keyup', guardScreenKeys, true);

// Hiding the tab (another tab, a minimised window) pauses a round being played, as Esc does, unless a screen is up:
// the player comes back to the pause screen, not to a wave that goes on the moment the tab shows again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && screens.current === null && session.pause()) screens.show('pause');
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
  // The game is on screen: from now on index.html reports an uncaught error with a toast, not as a failure to start.
  game.started = true;
}
requestAnimationFrame(frame);
