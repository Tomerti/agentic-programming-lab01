// The renderer, the seated camera with its eased mouse-look, and the lights that the room and the outside
// world share. The room is built into roomGroup (room.js) and the world outside the window into
// outsideGroup (outside.js); outside.applyLighting() drives the lights from the day/night clock.
import * as THREE from 'three';

const SEAT = new THREE.Vector3(0, 1.42, 1.45);
const REST_PITCH = -0.05; // radians; slightly down, so the window and the console share the view
const YAW_RANGE = 0.3; // look angle with the pointer at the edge of the screen
const PITCH_RANGE = 0.15;
const LOOK_EASE = 4; // per second: each frame closes 1 − e^(−4·dt) of the gap to the pointer's angle
// Vertical field of view in degrees at [aspect, fov] stops, linear in between and held beyond the ends:
// narrower screens get a taller view so the whole window stays in frame.
const FOV_STOPS = [[1.0, 70], [1.33, 62], [1.6, 55]];
const MAX_PIXEL_RATIO = 1.5;
// The room stands on a hill above the city: the outside group's y position, below the room's floor. A point at world
// height y is at height y − OUTSIDE_Y in the outside group's coordinates.
export const OUTSIDE_Y = -0.6;
// The day/night colours carry the hemisphere light's brightness, so its intensity stays fixed. With those
// colours read as sRGB, 4 lights the night city about as brightly as the approved mockup's night.
const HEMI_INTENSITY = 4;
const SHADOW_EXTENT = 12; // the sun's shadow camera covers ±12 around the room
const CEILING_LIGHTS = [
  { z: 0.6, intensity: 14, castShadow: true },
  { z: -1.6, intensity: 8, castShadow: false },
];

function fovFor(aspect) {
  const first = FOV_STOPS[0];
  if (aspect <= first[0]) return first[1];
  for (let i = 1; i < FOV_STOPS.length; i++) {
    const [a1, f1] = FOV_STOPS[i];
    if (aspect < a1) {
      const [a0, f0] = FOV_STOPS[i - 1];
      return f0 + ((f1 - f0) * (aspect - a0)) / (a1 - a0);
    }
  }
  return FOV_STOPS[FOV_STOPS.length - 1][1];
}

function createRenderer(shadows) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (error) {
    throw new Error(`WebGL is not available (${error.message})`);
  }
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  return renderer;
}

function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0x8fb4ff, 0x4a3326, HEMI_INTENSITY);

  // The sun by day and the moon by night. Its target stays at the origin, so the shadow camera is
  // centred on the room (the walls must shade it) and reaches the near part of the city.
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(-4, 7, -9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT, bottom: -SHADOW_EXTENT, near: 10, far: 100,
  });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.02;

  const ceiling = CEILING_LIGHTS.map(({ z, intensity, castShadow }) => {
    const light = new THREE.PointLight(0xfff2e0, intensity, 9, 2);
    light.position.set(0, 2.85, z);
    light.userData.baseIntensity = intensity; // applyLighting scales it by the room light level
    light.castShadow = castShadow;
    if (castShadow) light.shadow.mapSize.set(1024, 1024);
    return light;
  });

  const monitorGlow = new THREE.PointLight(0x4ea1ff, 3, 2.5, 2);
  monitorGlow.position.set(0, 1.2, 0.3);

  scene.add(hemi, sun, sun.target, ...ceiling, monitorGlow);
  return { hemi, sun, ceiling, monitorGlow };
}

// createScene({ container, settings }): mounts a canvas in `container` and returns the scene API.
// settings.shadows (default on) switches the shadow maps; setShadows() changes it later.
export function createScene({ container, settings = {} }) {
  const renderer = createRenderer(settings.shadows !== false);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1026);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 120); // resize() sets the fov and aspect
  camera.rotation.order = 'YXZ';

  const roomGroup = new THREE.Group();
  roomGroup.name = 'room';
  const outsideGroup = new THREE.Group();
  outsideGroup.name = 'outside';
  outsideGroup.position.y = OUTSIDE_Y;
  scene.add(roomGroup, outsideGroup);

  const lights = createLights(scene);

  const pointer = new THREE.Vector2(0, 0); // normalised device coordinates, −1..1 with +y up
  const look = { yaw: 0, pitch: REST_PITCH };
  const shakeOffset = new THREE.Vector3(); // effects.js writes it; added to the seat every frame

  function setPointer(nx, ny) {
    pointer.set(THREE.MathUtils.clamp(nx, -1, 1), THREE.MathUtils.clamp(ny, -1, 1));
  }

  function update(dt) {
    const k = 1 - Math.exp(-LOOK_EASE * dt);
    look.yaw += (-pointer.x * YAW_RANGE - look.yaw) * k;
    look.pitch += (REST_PITCH + pointer.y * PITCH_RANGE - look.pitch) * k;
    camera.rotation.set(look.pitch, look.yaw, 0);
    camera.position.copy(SEAT).add(shakeOffset);
  }

  function render() {
    renderer.render(scene, camera);
  }

  function resize() {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.fov = fovFor(camera.aspect);
    camera.updateProjectionMatrix();
  }

  // Materials compile with or without shadow code, so they must recompile after a switch.
  function setShadows(on) {
    if (renderer.shadowMap.enabled === on) return;
    renderer.shadowMap.enabled = on;
    scene.traverse(object => {
      for (const material of [object.material ?? []].flat()) material.needsUpdate = true;
    });
  }

  window.addEventListener('resize', resize);
  resize();
  update(0);

  return {
    renderer, scene, camera, lights, roomGroup, outsideGroup, pointer, look, shakeOffset,
    setPointer, update, render, resize, setShadows,
  };
}
