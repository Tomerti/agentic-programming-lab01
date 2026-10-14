// Boots the game and runs the frame loop: the scene, the world outside under the day/night lighting, and the
// control room, whose monitors show a stub of the game state for now. Later tasks bring the session, the
// controls, the effects, the HUD, the screens and audio.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MISSIONS, ROUNDS, WORLD } from './config.js';
import { createRng } from './core/rng.js';
import { advanceClock, formatClock, lightingFor, phaseName } from './game/daynight.js';
import { advanceInterceptor, createInterceptor } from './game/interceptors.js';
import { createInitialState, DEFAULT_SETTINGS } from './game/state.js';
import { createThreat, threatPosition } from './game/threats.js';
import { createMonitorPainter } from './scene/monitors.js';
import { buildOutside } from './scene/outside.js';
import { buildRoom } from './scene/room.js';
import { createScene } from './scene/scene.js';

const MAX_DT = 0.1; // seconds: a hidden tab or a long frame must not jump the clock
const START_HOUR = 12;
const STUB_SEED = 1; // puts the Gilo rocket right of the city and the open-area rocket left of it

// A stand-in for the session (Task 12 brings the real one): round 3, wave 2, a detected rocket on Gilo and one
// on open ground, both about 9 units from the city centre, and an interceptor on its way to the first.
function createStubSession() {
  const state = createInitialState();
  const rng = createRng(STUB_SEED);
  const rocket = (id, zone, t) => {
    const threat = createThreat({ id, type: 'rocket', zone, rng });
    threat.t = t;
    threatPosition(threat, t, threat.position);
    threat.detected = true;
    return threat;
  };
  const onGilo = rocket(217, 'gilo', 0.4);
  const onOpen = rocket(218, 'open', 0.3);
  const interceptor = createInterceptor({ id: 1, from: WORLD.launchPoint, targetId: onGilo.id, hit: true });
  advanceInterceptor(interceptor, onGilo, 0.25);
  onGilo.engagedBy = interceptor.id;
  const round = ROUNDS[2];
  Object.assign(state, {
    phase: 'wave', round: round.round, wave: 2, waveCount: round.waves, hold: false,
    coins: 1240, ammo: 17, selectedId: onGilo.id, threats: [onGilo, onOpen], interceptors: [interceptor],
    missions: round.missions.map(id => ({ id, ...MISSIONS[id], progress: id === 'streak3' ? 1 : 0, done: false })),
    log: ['TRK-217 ENGAGED', 'TRK-218 NEW TRACK', 'TRK-217 NEW TRACK'],
  });
  return { state };
}

const game = (window.__game ??= { debugHour: null }); // index.html creates it before the modules load
const scene = createScene({ container: document.getElementById('viewport'), settings: DEFAULT_SETTINGS });
const outside = buildOutside(scene.outsideGroup, { THREE, RoundedBoxGeometry });
const room = buildRoom(scene.roomGroup, { THREE, RoundedBoxGeometry });
const session = createStubSession();
room.setLives(session.state.lives, session.state.maxLives);

let hour = START_HOUR;
let time = 0;
const monitors = createMonitorPainter(room.monitors, session, () => ({
  time,
  revealDecoys: false,
  zoom: 1,
  phaseName: phaseName(hour),
  clockText: formatClock(hour),
}));
Object.assign(game, { scene, outside, room, monitors, session });

window.addEventListener('pointermove', event => {
  scene.setPointer((event.clientX / window.innerWidth) * 2 - 1, 1 - (event.clientY / window.innerHeight) * 2);
});

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_DT);
  last = now;
  time += dt;
  hour = typeof game.debugHour === 'number' ? game.debugHour : advanceClock(hour, dt);
  outside.applyLighting(lightingFor(hour), scene);
  outside.update(dt);
  room.update(dt);
  monitors.update(dt);
  scene.update(dt);
  scene.render();
}
requestAnimationFrame(frame);
