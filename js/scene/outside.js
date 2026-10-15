// The world outside the window: ground, sky, sun, moon, stars, hills, the city with its golden-dome landmark,
// and the launcher. applyLighting() turns the day/night parameters from lightingFor() into colours,
// positions and light levels every frame. Coordinates are the outside group's (world units, ground at y 0,
// the city towards −z). Three.js is passed in, like the other scene builders take it.
import { WORLD } from '../config.js';

const SKY_RADIUS = 48; // the sun and the moon circle the city centre at this distance
// The sky is a 140 × 50 plane at z −50 spanning y −11..39. Seen from the seat the horizon meets it near
// y 0 and the window's top edge near y 17, so the gradient changes mostly over that band.
// Stops: [canvas position from the top, share of the horizon colour].
const SKY_STOPS = [[0, 0], [0.2, 0], [0.42, 0.18], [0.56, 0.42], [0.67, 0.7], [0.75, 0.9], [0.79, 1], [1, 1]];
const SKY_REDRAW_STEP = 0.01; // repaint the gradient once a colour channel has moved this far
// The sun and moon discs. At the light's own position they would never be seen (the noon sun stands 55°
// above the seat's eye line, the window shows sky up to about 16°), so a disc keeps the light's east–west
// position but its height is squeezed into the window's band of sky: it rises behind the hills at y 5
// and the noon sun stands at y 5 + 8.5 · sin(1.2), clear of the window's top edge. The discs sit on a
// plane just in front of the stars.
const DISC_HORIZON = 5;
const DISC_RISE = 8.5;
const DISC_Z = -47;
const LIGHT_FADE = 0.12; // radians of altitude over which the light fades out where sun and moon hand over
const STAR_COUNT = 500;
const WINDOW_GLOW = 1.4; // city window emissive intensity at windowsOn = 1
const MIN_ROOM_LIGHT = 0.75;

const GROUND = 0x8d9a5e;
const HILLS = [[-16, -24, 9, 0x6c9457], [10, -27, 11, 0x5e8752], [-2, -30, 14, 0x557d66], [22, -22, 7, 0x6c9457]];
const SANDSTONE = [0xe0bd88, 0xd4ad7a, 0xeed2a4, 0xc49a6a];
const CITY_SEED = 7; // the mockup's seed: the same city as the approved mockup
const STAR_SEED = 11;
const LANDMARK = { x: -1.5, z: -11 };
// The launcher is placed from WORLD.launchPoint, the centre of its tube block's muzzle face, where the interceptors
// appear: the muzzle stands MUZZLE.height above the launcher's base and MUZZLE.ahead in front of its centre (towards
// the room), so the launcher and the launch point cannot drift apart.
const MUZZLE = { height: 1.6, ahead: 0.2 };
const LAUNCHER = { x: WORLD.launchPoint.x, z: WORLD.launchPoint.z - MUZZLE.ahead, yaw: -0.4 };
// The launcher stands on an earth berm, a truncated cone with a flat top, so that it shows above the
// window sill: seen from the seat, the sill hides everything below y ≈ 1.55 at the launcher's distance.
const BERM = { topRadius: 1.4, radius: 2.2, height: WORLD.launchPoint.y - MUZZLE.height, color: 0x7d9455 };
const TUBE_LENGTH = 1.2;
const TUBE_TILT = 0.8; // radians from vertical, leaning towards the city

// The mockup's Park–Miller generator, so the seed reproduces its city.
function seededRandom(seed) {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

const smoothstep = t => {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * (3 - 2 * x);
};
const mixColors = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const cssColor = rgb => `rgb(${rgb.map(v => Math.round(Math.min(Math.max(v, 0), 1) * 255)).join(', ')})`;

// The plan's sky position: cityCenter + 48 · (cos(alt)·cos(az), sin(alt), −cos(alt)·sin(az)).
function skyPoint(alt, az, out) {
  const flat = SKY_RADIUS * Math.cos(alt);
  return out.set(WORLD.cityCenter.x + flat * Math.cos(az), SKY_RADIUS * Math.sin(alt), WORLD.cityCenter.z - flat * Math.sin(az));
}

// Where a disc is drawn for that sky position (see DISC_HORIZON).
function discPoint(alt, az, out) {
  return out.set(WORLD.cityCenter.x + SKY_RADIUS * Math.cos(alt) * Math.cos(az), DISC_HORIZON + DISC_RISE * Math.sin(alt), DISC_Z);
}

function makeKit(group, THREE, RoundedBoxGeometry) {
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...extra });
  const rbox = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 3, r);
  function mesh(geometry, material, x = 0, y = 0, z = 0, parent = group) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  return { THREE, group, mat, rbox, mesh };
}

function buildSky({ THREE, group }) {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Unlit and not tone mapped: the sky shows the day/night colours as designed.
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(140, 50), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  mesh.position.set(0, 14, -50);
  group.add(mesh);

  function paint(top, horizon) {
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    for (const [at, share] of SKY_STOPS) gradient.addColorStop(at, cssColor(mixColors(top, horizon, share)));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
  }
  return { mesh, canvas, texture, paint };
}

function buildStars({ THREE, group }) {
  const rnd = seededRandom(STAR_SEED);
  const positions = new Float32Array(STAR_COUNT * 3);
  const base = new Float32Array(STAR_COUNT * 3);
  const phase = new Float32Array(STAR_COUNT);
  const speed = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    positions.set([(rnd() - 0.5) * 130, 3 + rnd() * 32, -49.5 + rnd() * 1.5], i * 3);
    const brightness = 0.45 + 0.55 * rnd();
    const warmth = rnd() - 0.5; // a few stars lean blue, a few lean yellow
    base.set([brightness * (1 + 0.15 * warmth), brightness, brightness * (1 - 0.15 * warmth)], i * 3);
    phase[i] = rnd() * Math.PI * 2;
    speed[i] = 1.5 + rnd() * 2.5;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(base.slice(), 3));
  const material = new THREE.PointsMaterial({
    size: 0.22, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
  });
  const stars = new THREE.Points(geometry, material);
  group.add(stars);

  let time = 0;
  function twinkle(dt) {
    time += dt;
    const colors = geometry.attributes.color;
    for (let i = 0; i < STAR_COUNT; i++) {
      const k = 0.75 + 0.25 * Math.sin(time * speed[i] + phase[i]);
      colors.setXYZ(i, base[i * 3] * k, base[i * 3 + 1] * k, base[i * 3 + 2] * k);
    }
    colors.needsUpdate = true;
  }
  return { stars, twinkle };
}

// A soft white spot that fades to nothing at its edge, tinted per use.
function haloTexture(THREE) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.35)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// An unlit sphere with a halo around it; the halo is a child, so it shows and hides with the disc.
function buildDisc({ THREE, group }, { color, halo: map, haloSize, haloOpacity }) {
  const disc = new THREE.Mesh(new THREE.SphereGeometry(1.6, 24, 16), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map, color, opacity: haloOpacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  halo.scale.setScalar(haloSize);
  disc.add(halo);
  group.add(disc);
  return { disc, halo };
}

function buildHills({ THREE, mat, mesh }) {
  for (const [x, z, radius, color] of HILLS) {
    const hill = mesh(new THREE.SphereGeometry(radius, 20, 12), mat(color), x, 0, z);
    hill.scale.y = 0.32;
    hill.castShadow = false;
  }
}

// Sandstone blocks placed exactly as in the mockup, each with up to three windows on the side facing the
// room. All windows share one material, so one emissive intensity lights the whole city.
function buildCity({ THREE, mat, rbox, mesh }) {
  const stones = SANDSTONE.map(color => mat(color));
  const windows = new THREE.MeshStandardMaterial({ color: 0x2c3e55, roughness: 0.35, emissive: 0xffc866, emissiveIntensity: 0 });
  const windowGeometry = new THREE.BoxGeometry(0.12, 0.14, 0.02);
  const rnd = seededRandom(CITY_SEED);
  for (let i = 0; i < 110; i++) {
    const x = -16 + rnd() * 32;
    const z = -8 - rnd() * 9;
    if (Math.abs(x - LANDMARK.x) < 2.2 && Math.abs(z - LANDMARK.z) < 2.2) continue; // the landmark's plaza
    const w = 0.6 + rnd() * 1.2;
    const d = 0.6 + rnd() * 1.2;
    const h = 0.6 + rnd() * rnd() * 4.2;
    const block = mesh(rbox(w, h, d, 0.04), stones[i % stones.length], x, h / 2, z);
    for (let k = 0; k < 3; k++) {
      if (rnd() <= 0.45) continue;
      const wx = (rnd() - 0.5) * w * 0.7;
      const wy = h * (0.2 + rnd() * 0.6) - h / 2;
      mesh(windowGeometry, windows, wx, wy, d / 2 + 0.005, block).castShadow = false;
    }
  }
  return windows;
}

// The golden dome on its blue octagon, and a minaret behind it to the right.
function buildLandmark({ THREE, group, mat, mesh }) {
  const landmark = new THREE.Group();
  landmark.position.set(LANDMARK.x, 0, LANDMARK.z);
  group.add(landmark);
  mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.9, 8), mat(0x4a7ab8), 0, 0.45, 0, landmark);
  mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.7, 16), mat(0x2f5e9e), 0, 1.25, 0, landmark);
  const gold = mat(0xf2c14e, { metalness: 0.35, roughness: 0.3, emissive: 0x4a3608, emissiveIntensity: 0.6 });
  mesh(new THREE.SphereGeometry(0.95, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), gold, 0, 1.6, 0, landmark);
  mesh(new THREE.CylinderGeometry(0.22, 0.28, 3.2, 10), mat(0xe8d6b2), 3.4, 1.6, -1.5, landmark);
  mesh(new THREE.ConeGeometry(0.3, 0.6, 10), mat(0x6c8fb8), 3.4, 3.5, -1.5, landmark);
}

// A trailer with a block of 20 tubes leaning towards the city, on top of its berm. The block is placed so
// that the centre of its muzzle face is WORLD.launchPoint, where the interceptors appear.
function buildLauncher({ THREE, group, mat, rbox, mesh }) {
  mesh(new THREE.CylinderGeometry(BERM.topRadius, BERM.radius, BERM.height, 14), mat(BERM.color), LAUNCHER.x, BERM.height / 2, LAUNCHER.z);
  const launcher = new THREE.Group();
  launcher.position.set(LAUNCHER.x, BERM.height, LAUNCHER.z);
  launcher.rotation.y = LAUNCHER.yaw;
  group.add(launcher);
  const dark = mat(0x1b2230);
  mesh(rbox(1.3, 0.5, 2.0, 0.05), mat(0x5e6b4a), 0, 0.45, 0, launcher);
  for (const wx of [-0.55, 0.55]) {
    for (const wz of [-0.6, 0.6]) {
      mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.25, 12), dark, wx, 0.22, wz, launcher).rotation.z = Math.PI / 2;
    }
  }

  const tubes = new THREE.Group();
  tubes.rotation.x = -TUBE_TILT;
  const axis = new THREE.Vector3(0, 1, 0).applyEuler(tubes.rotation);
  const { x, y, z } = WORLD.launchPoint;
  const muzzle = new THREE.Vector3(x - LAUNCHER.x, y - BERM.height, z - LAUNCHER.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -LAUNCHER.yaw);
  tubes.position.copy(muzzle).addScaledVector(axis, -TUBE_LENGTH / 2);
  launcher.add(tubes);
  mesh(rbox(1.1, TUBE_LENGTH, 0.9, 0.05), mat(0x6f7a57), 0, 0, 0, tubes);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 12), dark, -0.4 + col * 0.2, TUBE_LENGTH / 2 + 0.02, -0.3 + row * 0.2, tubes);
    }
  }
  return { group: launcher, tubes };
}

// buildOutside(outsideGroup, { THREE, RoundedBoxGeometry }) builds the world into outsideGroup and returns
// its parts with applyLighting(params, scene), where `scene` is the createScene() result, and update(dt).
export function buildOutside(group, { THREE, RoundedBoxGeometry }) {
  const kit = makeKit(group, THREE, RoundedBoxGeometry);
  const setColor = (color, [r, g, b]) => color.setRGB(r, g, b, THREE.SRGBColorSpace);

  kit.mesh(new THREE.BoxGeometry(80, 0.2, 60), kit.mat(GROUND), 0, -0.1, -20).castShadow = false;
  const sky = buildSky(kit);
  const { stars, twinkle } = buildStars(kit);
  const halo = haloTexture(THREE);
  const { disc: sun, halo: sunHalo } = buildDisc(kit, { color: 0xfff1c4, halo, haloSize: 14, haloOpacity: 0.75 });
  const { disc: moon } = buildDisc(kit, { color: 0xe4ebf7, halo, haloSize: 8, haloOpacity: 0.3 });
  buildHills(kit);
  const cityWindowsMaterial = buildCity(kit);
  buildLandmark(kit);
  const launcher = buildLauncher(kit);

  // The sky's colours as last painted, kept channel by channel so that the check below allocates nothing.
  const paintedTop = [0, 0, 0];
  const paintedHorizon = [0, 0, 0];
  let skyPainted = false;

  // Whether a channel of the sky's colours has moved more than SKY_REDRAW_STEP since the last paint.
  function skyMoved(top, horizon) {
    for (let i = 0; i < 3; i++) {
      if (Math.abs(top[i] - paintedTop[i]) > SKY_REDRAW_STEP) return true;
      if (Math.abs(horizon[i] - paintedHorizon[i]) > SKY_REDRAW_STEP) return true;
    }
    return false;
  }

  function applyLighting(params, { scene, lights }) {
    const { sunAltitude: alt, sunAzimuth: az } = params;
    if (!skyPainted || skyMoved(params.skyTop, params.skyHorizon)) {
      skyPainted = true;
      for (let i = 0; i < 3; i++) {
        paintedTop[i] = params.skyTop[i];
        paintedHorizon[i] = params.skyHorizon[i];
      }
      sky.paint(params.skyTop, params.skyHorizon);
      if (scene.background?.isColor) setColor(scene.background, params.skyTop);
    }

    const sunUp = alt >= 0;
    discPoint(alt, az, sun.position);
    discPoint(-alt, az + Math.PI, moon.position); // the moon stands opposite the sun
    sun.visible = sunUp;
    moon.visible = !sunUp;
    setColor(sun.material.color, params.sunColor);
    sunHalo.material.color.copy(sun.material.color);

    // The light comes from the sun by day and from the moon by night (the night keyframes are moonlight),
    // fading out near the horizon so the swap from one side of the sky to the other does not jump.
    skyPoint(sunUp ? alt : -alt, sunUp ? az : az + Math.PI, lights.sun.position).add(group.position);
    setColor(lights.sun.color, params.sunColor);
    lights.sun.intensity = params.sunIntensity * smoothstep(Math.abs(alt) / LIGHT_FADE);
    setColor(lights.hemi.color, params.hemiSky);
    setColor(lights.hemi.groundColor, params.hemiGround);

    stars.material.opacity = params.starAlpha;
    stars.visible = params.starAlpha > 0;
    cityWindowsMaterial.emissiveIntensity = WINDOW_GLOW * params.windowsOn;
    const roomLevel = Math.max(MIN_ROOM_LIGHT, params.roomLight);
    for (const light of lights.ceiling) light.intensity = light.userData.baseIntensity * roomLevel;
  }

  function update(dt) {
    if (stars.visible) twinkle(dt);
  }

  return {
    sky: { mesh: sky.mesh, canvas: sky.canvas, texture: sky.texture },
    sun, moon, stars, cityWindowsMaterial, launcher, applyLighting, update,
  };
}
