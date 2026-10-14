// The control room around the seat: the floor, the walls with the window, the ceiling and its light panels,
// the console desk with the riser that carries the three monitors (monitors.js paints their canvases), the
// strip of life lamps, the wall sign, the siren beacon, the server rack and the props. Three.js is passed in,
// as outside.js takes it. Coordinates are world units: x to the right, y up, the window in the front wall at
// z −2.6 and the seat at (0, 1.42, 1.45) (scene.js). The interactive controls are added by controls.js.
//
// The monitors lean back on a low riser so that their tops stay at or below y 1.22: seen from the seat they
// sit wholly below the window sill, and the city shows above them.
//
// The hemisphere light stands for the open sky. Its strength suits the city, but indoors only the window lets
// the sky in, so every room material carries an ambient-occlusion map that lets SKY_INDOORS of it through
// (three.js applies an aoMap to the hemisphere light, not to direct lights): without it the room turned blue by day.

const TAU = Math.PI * 2;
const SKY_INDOORS = 0.5;
const ROOM = { halfWidth: 3.5, back: 3.9, height: 3.05, wall: 0.2 }; // the walls are centred on these lines
const WINDOW = { z: -2.6, halfWidth: 2.3, bottom: 1.2, top: 2.6, mullions: [-0.77, 0.77] };
const FRAME = { width: 0.06, depth: 0.26, mullion: 0.04 };
// The desk top surface. The desk group's origin is on it at x 0, z 0, so a control placed at (x, 0, z) in
// the group stands on the top.
const DESK_TOP = 0.88;
const RISER = { width: 2.44, height: 0.025, front: 0.045, back: -0.29 }; // z of its front and back edges
const MONITOR_TILT = 0.75; // radians the monitors lean back; it keeps their tops at or below y 1.22
const BEZEL = 0.024; // the housing's border around a screen
const HOUSING_DEPTH = 0.035;
const SCREEN_GAP = 0.002; // the screen stands this far in front of its housing
const CANVAS_WIDTH = 512;
// The screens' sizes and where each screen's centre stands (x, z); yaw turns a side monitor towards the
// seat. The leaning puts a housing's bottom edge 0.13 in front of its screen's centre, so the screens stand
// far enough back for every bottom edge to rest on the riser, which ends at z 0.045.
const MONITORS = {
  resources: { w: 0.5, h: 0.32, x: -0.85, z: -0.17, yaw: 0.35 },
  radar: { w: 0.62, h: 0.34, x: 0, z: -0.1, yaw: 0 },
  threats: { w: 0.5, h: 0.32, x: 0.85, z: -0.17, yaw: -0.35 },
};
// The lamps are mostly metallic: a matte red dome under the ceiling light would look lit even when it is off.
const LIFE_LAMPS = { count: 8, from: 0.36, to: 0.78, z: 0.02, radius: 0.018, lit: 1.4, unlit: 0.08, metalness: 0.85 };
const SIGN = { text: 'IRON DOME · JERUSALEM BATTERY', width: 1.5, height: 0.28, y: 2.83, canvas: [1024, 192] };
const SIGN_FONT = '700 84px "Chakra Petch", Inter, system-ui, sans-serif';
// The siren beacon hangs on the front wall to the right of the window, where the seat sees it. On the right
// wall it would stand about 59° to the side, out of view even with the mouse-look turned fully right.
const BEACON = { x: 2.62, y: 2.35, z: WINDOW.z + ROOM.wall / 2 + 0.03 };
// The beacon spinning: the pivot's turn in rad/s, the spotlight's intensity, and the dome's glow, which pulses by
// ± pulse around `glow` at `rate` rad/s; `idle` is its glow at rest, when the light is off.
const SIREN = { turn: 6, light: 40, glow: 1.2, pulse: 0.6, rate: 20, idle: 0.15 };
const RACK_LIGHT_COLORS = [0x2ad1b0, 0x3f8cff, 0xffb020];

const COLORS = {
  wall: 0x3a5466, floor: 0x232c38, ceiling: 0x4b5f70, frame: 0x1f2a36, glass: 0x9fd0ff,
  deskTop: 0x46607a, deskBody: 0x2d3d4f, stripe: 0xffc933, riser: 0x3b5169, bezel: 0x1b2230,
  lamp: 0xff4b4b, lampGlow: 0xff2a2a, dark: 0x222c38, slot: 0x33404f, teal: 0x2ad1b0,
  mug: 0xf2f4f7, coffee: 0x3b2416, board: 0x8a5a3b, paper: 0xf5f1e6, metal: 0x9aa7b5,
  pot: 0xc46b3b, leaf: 0x3fae6a,
};

function makeKit(group, THREE, RoundedBoxGeometry) {
  // aoMap reads the red channel: (0 − 1) · aoMapIntensity + 1 = SKY_INDOORS of the hemisphere light gets in.
  const occlusion = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  occlusion.needsUpdate = true;
  const standard = params => new THREE.MeshStandardMaterial({ aoMap: occlusion, aoMapIntensity: 1 - SKY_INDOORS, ...params });
  const mat = (color, extra = {}) => standard({ color, roughness: 0.8, metalness: 0, ...extra });
  const rbox = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 3, r);
  function mesh(geometry, material, x = 0, y = 0, z = 0, parent = group) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  return { THREE, group, standard, mat, rbox, mesh };
}

// Floor, ceiling, walls, the window with its frame, mullions and glass, the ceiling light panels and the
// hazard stripe along the back wall.
function buildShell({ THREE, standard, mat, rbox, mesh }) {
  const { halfWidth, back, height, wall: thickness } = ROOM;
  const wall = mat(COLORS.wall);
  const roomDepth = 7; // the floor, ceiling and side walls run from z −3.1 to the back wall
  const roomZ = back - roomDepth / 2;
  mesh(new THREE.BoxGeometry(halfWidth * 2, 0.1, roomDepth), mat(COLORS.floor), 0, -0.05, roomZ).castShadow = false;
  mesh(new THREE.BoxGeometry(halfWidth * 2, 0.1, roomDepth), mat(COLORS.ceiling), 0, height, roomZ);
  const wallHeight = height + 0.05; // from y −0.05 to the ceiling's middle
  const wallY = wallHeight / 2 - 0.05;
  for (const side of [-1, 1]) mesh(new THREE.BoxGeometry(thickness, wallHeight, roomDepth), wall, side * halfWidth, wallY, roomZ);
  mesh(new THREE.BoxGeometry(halfWidth * 2, wallHeight, thickness), wall, 0, wallY, back);

  // The front wall around the opening.
  const { z, halfWidth: open, bottom, top } = WINDOW;
  const jambWidth = halfWidth - open;
  for (const side of [-1, 1]) mesh(new THREE.BoxGeometry(jambWidth, wallHeight, thickness), wall, side * (open + jambWidth / 2), wallY, z);
  mesh(new THREE.BoxGeometry(open * 2, bottom + 0.05, thickness), wall, 0, (bottom - 0.05) / 2, z);
  mesh(new THREE.BoxGeometry(open * 2, height - top, thickness), wall, 0, (height + top) / 2, z);

  const frame = mat(COLORS.frame);
  const openHeight = top - bottom;
  const middle = (top + bottom) / 2;
  for (const y of [bottom, top]) mesh(new THREE.BoxGeometry(open * 2 + FRAME.width, FRAME.width, FRAME.depth), frame, 0, y, z);
  for (const side of [-1, 1]) mesh(new THREE.BoxGeometry(FRAME.width, openHeight, FRAME.depth), frame, side * open, middle, z);
  for (const x of WINDOW.mullions) mesh(new THREE.BoxGeometry(FRAME.mullion, openHeight, FRAME.depth - 0.04), frame, x, middle, z);
  const glass = mesh(new THREE.PlaneGeometry(open * 2, openHeight), standard({
    color: COLORS.glass, transparent: true, opacity: 0.07, roughness: 0.1,
  }), 0, middle, z);
  glass.castShadow = false; // the sun shines in through it
  glass.receiveShadow = false;

  const panel = standard({ color: 0xffffff, emissive: 0xfff4e0, emissiveIntensity: 1.2 });
  for (const panelZ of [0.6, -1.6]) mesh(rbox(1.3, 0.06, 0.45, 0.02), panel, 0, height - 0.07, panelZ).castShadow = false;
  mesh(new THREE.BoxGeometry(halfWidth * 2, 0.12, 0.02), mat(COLORS.stripe), 0, 0.1, back - thickness / 2 - 0.01);
}

// A canvas texture with the sign's text, repainted once its web font has loaded.
function signTexture(THREE) {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = SIGN.canvas;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const paint = () => {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.fillStyle = '#15202b';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 6;
    ctx.strokeRect(14, 14, width - 28, height - 28);
    ctx.fillStyle = '#ffd166';
    ctx.font = SIGN_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(SIGN.text, width / 2, height / 2 + 4, width - 90);
    texture.needsUpdate = true;
  };
  paint();
  document.fonts?.load(SIGN_FONT).then(paint, () => {}); // until then the fallback font shows
  return texture;
}

// The sign above the window: a dark board with the lettering on its face.
function buildSign({ THREE, standard, mat, rbox, mesh, group }) {
  const sign = new THREE.Group();
  sign.position.set(0, SIGN.y, WINDOW.z + ROOM.wall / 2);
  group.add(sign);
  mesh(rbox(SIGN.width + 0.06, SIGN.height + 0.06, 0.03, 0.01), mat(COLORS.dark), 0, 0, 0.015, sign);
  const map = signTexture(THREE);
  const face = mesh(new THREE.PlaneGeometry(SIGN.width, SIGN.height), standard({
    map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.6, roughness: 0.6,
  }), 0, 0, 0.032, sign);
  face.castShadow = false;
  return sign;
}

// The console: the top slab with the yellow stripe on its front edge, the body under it and the low riser
// at the back that carries the monitors and the life lamps.
function buildDesk({ THREE, mat, rbox, mesh, group }) {
  const desk = new THREE.Group();
  desk.name = 'desk';
  desk.position.y = DESK_TOP;
  group.add(desk);
  mesh(rbox(3.6, 0.08, 0.9, 0.03), mat(COLORS.deskTop), 0, -0.04, 0.15, desk);
  const bodyHeight = DESK_TOP - 0.08;
  mesh(rbox(3.5, bodyHeight, 0.82, 0.03), mat(COLORS.deskBody), 0, -0.08 - bodyHeight / 2, 0.12, desk);
  // Hazard paint: a little glow keeps it yellow on its front face, which the ceiling lights only graze.
  mesh(new THREE.BoxGeometry(3.62, 0.035, 0.03), mat(COLORS.stripe, { emissive: COLORS.stripe, emissiveIntensity: 0.3 }), 0, -0.04, 0.6, desk);
  const riser = mesh(rbox(RISER.width, RISER.height, RISER.front - RISER.back, 0.008), mat(COLORS.riser),
    0, RISER.height / 2, (RISER.front + RISER.back) / 2, desk);
  return { desk, riser };
}

// A monitor leaning back on the riser: a dark housing and, in front of it, the screen that shows the canvas.
// The housing's back bottom edge rests on the riser.
function buildMonitor({ THREE, standard, rbox, mesh }, desk, bezel, name, { w, h, x, z, yaw }) {
  const group = new THREE.Group();
  group.name = `monitor-${name}`;
  const tilt = new THREE.Group();
  tilt.rotation.x = -MONITOR_TILT;
  tilt.position.y = (HOUSING_DEPTH / 2) * Math.sin(MONITOR_TILT);
  group.add(tilt);
  const housingHeight = h + 2 * BEZEL;
  mesh(rbox(w + 2 * BEZEL, housingHeight, HOUSING_DEPTH, 0.012), bezel, 0, housingHeight / 2, 0, tilt);

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = Math.round((CANVAS_WIDTH * h) / w);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8; // the screens are seen at a slant
  // Fully rough: leaning back, a glossier screen mirrors the front ceiling light across its whole face.
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h), standard({
    map: texture, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.9, roughness: 1,
  }));
  const screenZ = HOUSING_DEPTH / 2 + SCREEN_GAP;
  screen.position.set(0, BEZEL + h / 2, screenZ);
  screen.userData.monitor = name; // controls.js tells the screens apart by this
  tilt.add(screen);

  // Leaning back puts the screen's centre `lean` along the group's z from its origin (negative: behind it),
  // so the group stands that far in front of (x, z) along its yaw.
  const lean = -(BEZEL + h / 2) * Math.sin(MONITOR_TILT) + screenZ * Math.cos(MONITOR_TILT);
  group.position.set(x - lean * Math.sin(yaw), RISER.height, z - lean * Math.cos(yaw));
  group.rotation.y = yaw;
  desk.add(group);
  return { group, screen, canvas, ctx: canvas.getContext('2d'), texture, width: canvas.width, height: canvas.height };
}

// Eight red domes on a dark strip along the riser, between the radar and the right monitor. Each has its own
// material, so setLives() can light them one by one.
function buildLifeLamps({ THREE, standard, rbox, mat, mesh }, desk) {
  const { count, from, to, z, radius, lit, metalness } = LIFE_LAMPS;
  const stripTop = RISER.height + 0.008;
  mesh(rbox(to - from + 0.03, 0.008, 0.05, 0.003), mat(COLORS.bezel, { roughness: 0.6 }), (from + to) / 2, RISER.height + 0.004, z, desk);
  const dome = new THREE.SphereGeometry(radius, 14, 8, 0, TAU, 0, Math.PI / 2);
  return Array.from({ length: count }, (_, i) => {
    const lamp = mesh(dome, standard({
      color: COLORS.lamp, emissive: COLORS.lampGlow, emissiveIntensity: lit, metalness, roughness: 0.3,
    }), from + ((to - from) * i) / (count - 1), stripTop, z, desk);
    lamp.castShadow = false;
    return lamp;
  });
}

// The siren beacon: a dark base on the wall and a red dome, with a red spotlight on a pivot that a spin turns
// (the light stays off until then). The group's local −x, where the dome and the light face, points into
// the room. spin(seconds) sets it going, or on to the later end when it is going already; update(dt) turns
// it, and stops it when the time is up.
function buildBeacon({ THREE, standard, mat, mesh, group }) {
  const beacon = new THREE.Group();
  beacon.position.set(BEACON.x, BEACON.y, BEACON.z);
  beacon.rotation.y = Math.PI / 2;
  group.add(beacon);
  mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.06, 16), mat(COLORS.dark), 0, 0, 0, beacon).rotation.z = Math.PI / 2;
  const dome = mesh(new THREE.SphereGeometry(0.11, 16, 12, 0, TAU, 0, Math.PI / 2), standard({
    color: 0xff4b4b, emissive: 0xff2020, emissiveIntensity: SIREN.idle, roughness: 0.3,
  }), -0.04, 0, 0, beacon);
  dome.rotation.z = Math.PI / 2;
  const pivot = new THREE.Group();
  beacon.add(pivot);
  const light = new THREE.SpotLight(0xff3030, 0, 10, Math.PI / 5, 0.5, 1.5);
  light.position.set(-0.1, 0, 0);
  light.target.position.set(-3, -1, 0);
  pivot.add(light, light.target);

  let spinLeft = 0; // seconds of spinning still to go
  let time = 0; // the pulse's clock
  function spin(seconds) {
    spinLeft = Math.max(spinLeft, seconds);
  }
  function update(dt) {
    if (spinLeft <= 0) return;
    spinLeft -= dt;
    if (spinLeft > 0) {
      time += dt;
      pivot.rotation.y += SIREN.turn * dt;
      light.intensity = SIREN.light;
      dome.material.emissiveIntensity = SIREN.glow + Math.sin(time * SIREN.rate) * SIREN.pulse;
    } else {
      light.intensity = 0;
      dome.material.emissiveIntensity = SIREN.idle;
    }
  }
  return { group: beacon, dome, light, pivot, spin, update };
}

// The server rack against the left wall, with twelve status lights that update() blinks.
function buildRack({ THREE, standard, mat, rbox, mesh, group }) {
  const rack = new THREE.Group();
  rack.position.set(-3.1, 0, -0.8);
  group.add(rack);
  mesh(rbox(0.6, 2.1, 0.8, 0.03), mat(COLORS.dark), 0, 1.05, 0, rack);
  for (let i = 0; i < 6; i++) mesh(new THREE.BoxGeometry(0.02, 0.09, 0.5), mat(COLORS.slot), 0.305, 0.45 + i * 0.3, 0.05, rack);
  return Array.from({ length: 12 }, (_, i) => {
    const color = RACK_LIGHT_COLORS[i % RACK_LIGHT_COLORS.length];
    const light = mesh(new THREE.BoxGeometry(0.02, 0.05, 0.05), standard({ color, emissive: color, emissiveIntensity: 1.5 }),
      0.31, 0.35 + i * 0.14, -0.25 + (i % 2) * 0.12, rack);
    light.castShadow = false;
    return light;
  });
}

// The loose things on the desk: a coffee mug, the teal desk lamp with its warm bulb, a clipboard. They are
// the props that an impact jitters.
function buildProps({ THREE, mat, rbox, mesh }, desk) {
  const mug = new THREE.Group();
  mug.name = 'mug';
  mug.position.set(0.66, 0, 0.47);
  desk.add(mug);
  const china = mat(COLORS.mug, { roughness: 0.4 });
  mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 16), china, 0, 0.05, 0, mug);
  mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.01, 16), mat(COLORS.coffee), 0, 0.097, 0, mug);
  mesh(new THREE.TorusGeometry(0.03, 0.008, 8, 16), china, 0.05, 0.05, 0, mug);

  const lamp = new THREE.Group();
  lamp.name = 'desk-lamp';
  lamp.position.set(1.6, 0, -0.2);
  desk.add(lamp);
  const teal = mat(COLORS.teal);
  mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.03, 16), teal, 0, 0.015, 0, lamp);
  const arm = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.45, 8), teal, -0.08, 0.24, 0.05, lamp);
  arm.rotation.set(-0.2, 0, 0.35);
  const head = mesh(new THREE.ConeGeometry(0.1, 0.14, 16, 1, true), mat(COLORS.teal, { side: THREE.DoubleSide }), -0.2, 0.45, 0.12, lamp);
  head.rotation.set(0.3, 0, 1.0);
  const bulb = new THREE.PointLight(0xffb060, 4, 2.2, 2);
  bulb.position.set(-0.26, 0.4, 0.14);
  lamp.add(bulb);

  const clipboard = mesh(rbox(0.22, 0.012, 0.3, 0.005), mat(COLORS.board), -0.7, 0.006, 0.42, desk);
  clipboard.name = 'clipboard';
  clipboard.rotation.y = -0.25;
  mesh(new THREE.BoxGeometry(0.19, 0.004, 0.26), mat(COLORS.paper), 0, 0.008, 0.005, clipboard);
  mesh(rbox(0.08, 0.014, 0.03, 0.005), mat(COLORS.metal, { metalness: 0.4, roughness: 0.4 }), 0, 0.01, -0.13, clipboard);

  const props = [mug, lamp, clipboard];
  props.mugGroup = mug; // controls.js makes the mug clickable
  return props;
}

// The chair behind the seat, and a potted plant in the front right corner under the beacon.
function buildChairAndPlant({ THREE, group, mat, rbox, mesh }) {
  const seat = mat(COLORS.deskBody);
  mesh(rbox(0.6, 0.12, 0.6, 0.04), seat, 0, 0.55, 1.6);
  mesh(rbox(0.6, 0.7, 0.12, 0.04), seat, 0, 0.95, 1.9);
  mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.45, 10), mat(COLORS.bezel), 0, 0.27, 1.6);

  const plant = new THREE.Group();
  plant.position.set(2.75, 0, -2.1);
  group.add(plant);
  mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.3, 10), mat(COLORS.pot), 0, 0.15, 0, plant);
  const leaf = new THREE.ConeGeometry(0.1, 0.6, 5);
  const green = mat(COLORS.leaf);
  for (let i = 0; i < 6; i++) {
    const stem = new THREE.Group(); // turned about the pot's axis, then leaning out from it
    stem.position.y = 0.28;
    stem.rotation.set(0.35 + (i % 2) * 0.25, (i / 6) * TAU, 0, 'YXZ');
    plant.add(stem);
    mesh(leaf, green, 0, 0.3, 0, stem);
  }
}

// buildRoom(roomGroup, { THREE, RoundedBoxGeometry }) builds the room into roomGroup and returns:
//   desk        the console group; its origin is on the desk top at x 0, z 0 (world y 0.88)
//   monitors    { resources, radar, threats }, each { group, screen, canvas, ctx, texture, width, height }; the
//               screen mesh carries userData.monitor = its name
//   beacon      { group, dome, light, pivot, spin(seconds), update(dt) }: the siren; spin() lights it and turns
//               the pivot, which sweeps the light, for that long (update() runs it, every frame)
//   lifeLamps   the eight lamp meshes, left to right; setLives(lives, maxLives) lights `lives` of them, dims
//               the rest up to maxLives and hides the others
//   sign, riser the wall sign group and the riser mesh
//   props       the loose objects on the desk, for the impact jitter; props.mugGroup is the mug
//   material(params)  a MeshStandardMaterial with the room's occlusion of the sky light, for anything else
//               built into the room (the controls), so that it is lit like the rest
//   update(dt)  blinks the rack lights
export function buildRoom(group, { THREE, RoundedBoxGeometry }) {
  const kit = makeKit(group, THREE, RoundedBoxGeometry);
  buildShell(kit);
  const sign = buildSign(kit);
  const { desk, riser } = buildDesk(kit);
  const bezel = kit.mat(COLORS.bezel, { roughness: 0.6 });
  const monitors = Object.fromEntries(Object.entries(MONITORS).map(([name, spec]) => [name, buildMonitor(kit, desk, bezel, name, spec)]));
  const lifeLamps = buildLifeLamps(kit, desk);
  const beacon = buildBeacon(kit);
  const rackLights = buildRack(kit);
  const props = buildProps(kit, desk);
  buildChairAndPlant(kit);

  function setLives(lives, maxLives) {
    lifeLamps.forEach((lamp, i) => {
      lamp.visible = i < maxLives;
      lamp.material.emissiveIntensity = i < lives ? LIFE_LAMPS.lit : LIFE_LAMPS.unlit;
    });
  }

  let time = 0;
  function update(dt) {
    time += dt;
    rackLights.forEach((light, i) => {
      light.material.emissiveIntensity = 0.8 + Math.sin(time * (2 + i * 0.37) + i) * 0.7;
    });
  }

  return { desk, monitors, beacon, lifeLamps, setLives, sign, props, riser, material: kit.standard, update };
}
