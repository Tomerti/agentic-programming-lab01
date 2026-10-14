// Boots the game and runs the frame loop. This first version shows the scene and the outside world under the
// day/night lighting; later tasks add the room, the session, the controls, the HUD, the screens and audio.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { advanceClock, lightingFor } from './game/daynight.js';
import { DEFAULT_SETTINGS } from './game/state.js';
import { buildOutside } from './scene/outside.js';
import { createScene } from './scene/scene.js';

const MAX_DT = 0.1; // seconds: a hidden tab or a long frame must not jump the clock
const START_HOUR = 12;

const game = (window.__game ??= { debugHour: null }); // index.html creates it before the modules load
const scene = createScene({ container: document.getElementById('viewport'), settings: DEFAULT_SETTINGS });
const outside = buildOutside(scene.outsideGroup, { THREE, RoundedBoxGeometry });
Object.assign(game, { scene, outside });

// A bare floor until the room is built (Task 11), so the view shows the city where the window will be.
const floor = new THREE.Mesh(new THREE.BoxGeometry(7, 0.1, 7), new THREE.MeshStandardMaterial({ color: 0x232c38, roughness: 0.8 }));
floor.position.set(0, -0.05, 0.4);
floor.receiveShadow = true;
scene.roomGroup.add(floor);

window.addEventListener('pointermove', event => {
  scene.setPointer((event.clientX / window.innerWidth) * 2 - 1, 1 - (event.clientY / window.innerHeight) * 2);
});

let hour = START_HOUR;
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_DT);
  last = now;
  hour = typeof game.debugHour === 'number' ? game.debugHour : advanceClock(hour, dt);
  outside.applyLighting(lightingFor(hour), scene);
  outside.update(dt);
  scene.update(dt);
  scene.render();
}
requestAnimationFrame(frame);
