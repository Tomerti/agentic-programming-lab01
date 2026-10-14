// The console's physical controls and the picking under the pointer. On room.js's desk: the big buttons
// ENGAGE, ALERT and HOLD FIRE (latching, with a lamp ring) and the square RESET RADAR with its jamming lens,
// each with a label plate in front of it; the HQ phone, the radar range dial, the power lever, six system
// buttons and four toggles; and room.js's mug. update() casts a ray from the camera through the pointer into
// the controls and the three monitor screens: the control under it lights up, and over a control or a screen
// the cursor becomes a pointer. click() presses that control (its cap dips, a switch flips) and reports its
// action to onAction(action), or reports the canvas pixel of the screen under the pointer as
// onAction('monitor', { monitor, px, py }). The controls change nothing in the game: main.js maps the
// actions to the session's commands, and setLamp() shows the session's HOLD FIRE and jamming.
//
// Positions are desk coordinates: the desk group's origin is on its top at x 0, z 0, with z towards the
// seat. Every material comes from room.material(), so the controls are lit like the console they stand on.

const TAU = Math.PI * 2;
const PRESS_TIME = 0.22; // seconds a press takes
const PRESS_DEPTH = 0.018; // how far a pressed cap dips
const LATCH_DEPTH = 0.008; // a latched button (HOLD FIRE while it is on) rests this far down
const HIGHLIGHT = { color: 0xffffff, intensity: 0.25 }; // the emissive of the control under the pointer
const SWING_EASE = 14; // per second: a switch, the lever or the dial closes 1 − e^(−14·dt) of its turn
const WOBBLE = { angle: 0.12, time: 0.45 }; // the clicked mug rocks this many radians, for this long

// Where the controls stand (x, z) and how they look. Each control's name is the key of controlsByName; its
// action, the name onAction() gets, is the same unless given.
//
// Seen from the seat, whatever stands between the eye and the monitors hides their lower edge, and the life
// lamps on the riser sit right behind HOLD FIRE. So the big buttons (the mockup's at 0.85 scale, 0.1275 tall)
// stand forward at z 0.3, where they pass under the line of sight to the radar's bottom edge and to the life
// lamps, and their label plates still lie in view. The mug (room.js, at (0.66, 0.47)) hides the desk behind
// it out to about (0.85, 0.25); RESET RADAR and its plate stand clear of that, left of it and further back.
//
// The caps are a shade deeper than the palette's red, amber and blue: under the ceiling light and the monitor
// glow just above them, the palette's own colours render pink, yellow and nearly white.
const BIG_BUTTON_Z = 0.3;
const BIG_BUTTONS = [
  { name: 'engage', x: 0, color: 0xd81e1e, label: 'ENGAGE' },
  { name: 'alert', x: -0.42, color: 0xe08a00, label: 'ALERT' },
  { name: 'hold', x: 0.42, color: 0x2563eb, label: 'HOLD FIRE', latching: true },
];
const RESET = { x: 0.62, z: 0.15, color: 0xaeb8c4, label: 'RESET RADAR' };
// The system buttons' lights, and how much of its colour an unlit one keeps.
const SYSTEM = {
  from: -1.45, to: -1.0, z: 0.38, colors: [0x2ad1b0, 0x3f8cff, 0xffb020, 0xff4b4b, 0x2ad1b0, 0xc77dff], unlit: 0.2,
};
const TOGGLES = { from: 0.95, to: 1.25, z: 0.42, count: 4, angle: 0.5 };
const LEVER = { x: 1.45, z: 0.1, angle: 0.55 };
const DIAL = { x: -1.5, z: 0.05, angles: [0.6, -0.6] }; // the pointer's turn at radar zoom 1× and 2×
// The phone stands behind the system buttons (at z 0.3 it would cover them). A call lifts its handset.
const PHONE = { x: -1.15, z: 0.2, yaw: 0.35, lift: 0.03 };
// The label plates: their size, how far in front of a button's edge they lie, the canvas and its lettering.
const PLATE = { width: 0.2, depth: 0.05, gap: 0.025, lift: 0.001, glow: 0.2, canvas: [256, 64] };
const PLATE_FONT = '700 30px "Chakra Petch", Inter, system-ui, sans-serif';
// Lamp emissive intensities, [off, on].
const LAMPS = { ring: [0.05, 2.4], jam: [0, 2], system: [0, 1.2] };

const COLORS = {
  bezel: 0x1b2230, body: 0x2b3747, metal: 0x9aa7b5, chrome: 0xd7dee6, knob: 0xff4b4b, phone: 0xe03b3b,
  ring: 0x1d3a66, ringGlow: 0x4d9dff, lens: 0x4a1418, lensGlow: 0xff2a2a, plate: '#1b2230', plateText: '#f4f6fa',
};

const spread = (from, to, count) => Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));

function makeKit(THREE, RoundedBoxGeometry, room) {
  const mat = (color, extra = {}) => room.material({ color, roughness: 0.8, metalness: 0, ...extra });
  const rbox = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 3, r);
  function mesh(geometry, material, x, y, z, parent) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  // An empty object at (x, y, z) in `parent`, inside a control: screenPositionOf() aims at it.
  function marker(parent, x, y, z) {
    const point = new THREE.Object3D();
    point.position.set(x, y, z);
    parent.add(point);
    return point;
  }
  // A control's group, standing on the desk top at (x, z).
  function place(desk, x, z) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    desk.add(group);
    return group;
  }
  return { THREE, material: room.material, mat, rbox, mesh, marker, place };
}

// A label's canvas texture: light lettering on a dark plate, repainted once its web font has loaded.
function labelTexture(THREE, text) {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = PLATE.canvas;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8; // the plates lie flat and are seen at a slant
  const paint = () => {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.fillStyle = COLORS.plate;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = COLORS.plateText;
    ctx.font = PLATE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2 + 2, width - 24);
    texture.needsUpdate = true;
  };
  paint();
  document.fonts?.load(PLATE_FONT).then(paint, () => {}); // until then the fallback font shows
  return texture;
}

// A label plate flat on the desk in front of a control whose front edge is `front` from its centre. It is
// part of the control's group, so pointing at the label points at the control.
function labelPlate({ THREE, material, mesh }, group, text, front) {
  const map = labelTexture(THREE, text);
  const plate = mesh(new THREE.PlaneGeometry(PLATE.width, PLATE.depth),
    material({ map, roughness: 0.7, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: PLATE.glow }),
    0, PLATE.lift, front + PLATE.gap + PLATE.depth / 2, group);
  plate.rotation.x = -Math.PI / 2;
  plate.castShadow = false;
}

// A control as the builders return it:
//   name, action  its key in controlsByName and the name onAction() gets (the name unless given)
//   group         the Object3D whose meshes the picking hits; its userData.control is the name
//   anchor        an object inside the control that screenPositionOf() projects
//   highlight     the materials that light up under the pointer (no other control shares them)
//   caps          objects that dip by `travel` (default −PRESS_DEPTH) when pressed; with `latching` they
//                 rest LATCH_DEPTH lower while the control is on
//   on, flips     the control's state, and whether a press flips it (otherwise only setLamp() sets it)
//   lamp, levels  a material whose emissive intensity is levels[1] while on, levels[0] while off
//   swing         { pivot, axis, angles }: the pivot turns to angles[1] while on, angles[0] while off
//   wobble        an object that rocks when pressed, for pressTime seconds

// ENGAGE, ALERT and HOLD FIRE: a mushroom cap on a dark base. HOLD FIRE latches and has a lamp ring.
function buildBigButton(kit, desk, { name, x, color, label, latching = false }) {
  const { THREE, mat, mesh, marker } = kit;
  const group = kit.place(desk, x, BIG_BUTTON_Z);
  mesh(new THREE.CylinderGeometry(0.072, 0.081, 0.03, 24), mat(COLORS.bezel), 0, 0.015, 0, group);
  const cap = mat(color, { roughness: 0.45, emissive: color, emissiveIntensity: 0.08 });
  const caps = [
    mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.0425, 24), cap, 0, 0.05125, 0, group),
    mesh(new THREE.SphereGeometry(0.055, 24, 12, 0, TAU, 0, Math.PI / 2), cap, 0, 0.0725, 0, group),
  ];
  labelPlate(kit, group, label, 0.081);
  const control = { name, group, caps, highlight: [cap], anchor: marker(group, 0, 0.075, 0), latching };
  if (latching) {
    const ring = mat(COLORS.ring, { emissive: COLORS.ringGlow, roughness: 0.3, metalness: 0.6 });
    const torus = mesh(new THREE.TorusGeometry(0.067, 0.0075, 8, 40), ring, 0, 0.03, 0, group);
    torus.rotation.x = Math.PI / 2; // flat around the cap, on the base
    torus.castShadow = false;
    Object.assign(control, { lamp: ring, levels: LAMPS.ring });
  }
  return control;
}

// RESET RADAR: a square cap on a dark base, with a lens in the cap that lights while the radar is jammed.
function buildResetButton(kit, desk) {
  const { THREE, mat, rbox, mesh, marker } = kit;
  const group = kit.place(desk, RESET.x, RESET.z);
  mesh(rbox(0.11, 0.025, 0.11, 0.01), mat(COLORS.bezel), 0, 0.0125, 0, group);
  const cap = mat(RESET.color, { roughness: 0.5 });
  // Dark when off: a bright red lens facing the ceiling light would look lit even then.
  const lens = mat(COLORS.lens, { emissive: COLORS.lensGlow, roughness: 0.5 });
  const caps = [
    mesh(rbox(0.08, 0.03, 0.08, 0.01), cap, 0, 0.04, 0, group),
    mesh(new THREE.BoxGeometry(0.05, 0.004, 0.05), lens, 0, 0.0555, 0, group),
  ];
  caps[1].castShadow = false;
  labelPlate(kit, group, RESET.label, 0.055);
  return {
    name: 'resetRadar', group, caps, highlight: [cap], anchor: marker(group, 0, 0.04, 0), lamp: lens, levels: LAMPS.jam,
  };
}

// A small system button: a dark body with a coloured light on top that each press switches on or off.
function buildSystemButton(kit, desk, i, x) {
  const { THREE, mat, rbox, mesh, marker } = kit;
  const color = SYSTEM.colors[i];
  const group = kit.place(desk, x, SYSTEM.z);
  const body = mat(COLORS.body, { roughness: 0.6 });
  // Dark unless lit: in full colour, an unlit light under the ceiling light would look lit.
  const light = mat(new THREE.Color(color).multiplyScalar(SYSTEM.unlit), { emissive: color });
  const caps = [
    mesh(rbox(0.075, 0.045, 0.075, 0.012), body, 0, 0.0225, 0, group),
    mesh(new THREE.BoxGeometry(0.045, 0.012, 0.02), light, 0, 0.05, -0.015, group),
  ];
  caps[1].castShadow = false;
  return {
    name: `system${i}`, action: 'system', group, caps, highlight: [body], anchor: marker(group, 0, 0.025, 0),
    lamp: light, levels: LAMPS.system, on: true, flips: true,
  };
}

// A toggle switch: a chrome stem on a metal boss, flipped towards the seat or away from it.
function buildToggle(kit, desk, i, x) {
  const { THREE, mat, mesh, marker } = kit;
  const group = kit.place(desk, x, TOGGLES.z);
  const boss = mat(COLORS.metal, { metalness: 0.4, roughness: 0.4 });
  mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.03, 16), boss, 0, 0.015, 0, group);
  const pivot = new THREE.Group();
  pivot.position.y = 0.02;
  group.add(pivot);
  const chrome = mat(COLORS.chrome, { metalness: 0.5, roughness: 0.3 });
  mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 10), chrome, 0, 0.035, 0, pivot);
  mesh(new THREE.SphereGeometry(0.014, 12, 10), chrome, 0, 0.07, 0, pivot);
  return {
    name: `toggle${i}`, action: 'toggle', group, highlight: [boss, chrome], anchor: marker(group, 0, 0.015, 0),
    swing: { pivot, axis: 'x', angles: [TOGGLES.angle, -TOGGLES.angle] }, flips: true,
  };
}

// The power lever: a metal arm with a red knob that swings between the seat side and the far side of its track.
function buildLever(kit, desk) {
  const { THREE, mat, rbox, mesh, marker } = kit;
  const group = kit.place(desk, LEVER.x, LEVER.z);
  mesh(rbox(0.12, 0.03, 0.36, 0.01), mat(COLORS.bezel), 0, 0.015, 0, group);
  const pivot = new THREE.Group();
  pivot.position.y = 0.03;
  group.add(pivot);
  const arm = mat(COLORS.metal, { metalness: 0.4, roughness: 0.4 });
  const knob = mat(COLORS.knob, { roughness: 0.4 });
  mesh(new THREE.BoxGeometry(0.03, 0.2, 0.03), arm, 0, 0.1, 0, pivot);
  mesh(new THREE.SphereGeometry(0.04, 16, 12), knob, 0, 0.2, 0, pivot);
  return {
    name: 'lever', group, highlight: [arm, knob], anchor: marker(pivot, 0, 0.2, 0),
    swing: { pivot, axis: 'x', angles: [LEVER.angle, -LEVER.angle] }, flips: true,
  };
}

// The radar range dial: a metal knob whose red pointer turns between the 1× and the 2× mark.
function buildDial(kit, desk) {
  const { THREE, mat, mesh, marker } = kit;
  const group = kit.place(desk, DIAL.x, DIAL.z);
  const pivot = new THREE.Group();
  group.add(pivot);
  const metal = mat(COLORS.metal, { metalness: 0.3, roughness: 0.5 });
  mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.05, 24), metal, 0, 0.025, 0, pivot);
  mesh(new THREE.BoxGeometry(0.012, 0.012, 0.06), mat(COLORS.knob), 0, 0.052, -0.03, pivot);
  return {
    name: 'dial', group, highlight: [metal], anchor: marker(group, 0, 0.025, 0),
    swing: { pivot, axis: 'y', angles: DIAL.angles }, flips: true,
  };
}

// The red HQ phone, turned towards the seat. A call lifts the handset off its cradle for a moment.
function buildPhone(kit, desk) {
  const { THREE, mat, rbox, mesh, marker } = kit;
  const group = kit.place(desk, PHONE.x, PHONE.z);
  group.rotation.y = PHONE.yaw;
  const red = mat(COLORS.phone, { roughness: 0.5 });
  mesh(rbox(0.2, 0.07, 0.16, 0.02), red, 0, 0.035, 0, group);
  const handset = new THREE.Group();
  handset.position.y = 0.095;
  group.add(handset);
  mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.2, 10), red, 0, 0, 0, handset).rotation.z = Math.PI / 2;
  for (const side of [-1, 1]) mesh(new THREE.SphereGeometry(0.03, 12, 10), red, side * 0.1, -0.01, 0, handset);
  return {
    name: 'phone', action: 'hq', group, caps: [handset], travel: PHONE.lift, highlight: [red],
    anchor: marker(group, 0, 0.035, 0),
  };
}

// room.js's coffee mug, which rocks when clicked. Its materials are its own.
function mugControl({ marker }, mug) {
  const highlight = new Set();
  mug.traverse(object => { if (object.isMesh) highlight.add(object.material); });
  return {
    name: 'mug', group: mug, highlight: [...highlight], anchor: marker(mug, 0, 0.05, 0), wobble: mug, pressTime: WOBBLE.time,
  };
}

// Fills in a control's defaults and remembers what its animations and highlight return to.
function prepare(control) {
  const filled = {
    action: control.name, caps: [], travel: -PRESS_DEPTH, pressTime: PRESS_TIME, on: false, flips: false,
    latching: false, ...control, pressT: -1,
  };
  filled.capRest = filled.caps.map(cap => cap.position.y);
  if (filled.swing) {
    const { pivot, axis, angles } = filled.swing;
    pivot.rotation[axis] = angles[filled.on ? 1 : 0];
  }
  for (const material of filled.highlight) {
    material.userData.rest = { emissive: material.emissive.clone(), intensity: material.emissiveIntensity };
  }
  filled.group.userData.control = filled.name;
  return filled;
}

// createControls({ THREE, RoundedBoxGeometry, scene, camera, desk, monitors, room, onAction }) builds the
// controls into `desk` (room.desk) and returns:
//   update(dt, pointer)   picks what is under `pointer` (normalised device coordinates, {x, y}), lights it
//                         up, sets the cursor and runs the animations; with `pointer` null (no pointer over the
//                         room) nothing is under it, so no control stays lit and the cursor is the default one
//   click()               presses the control under the pointer, or reports the screen pixel under it; true
//                         when the pointer was on either, false when it was on neither
//   hovered               the name of the control or monitor under the pointer, or null
//   setLamp(name, on)     switches a control's lamp: 'hold' (its ring; the button latches down) and
//                         'resetRadar' (the jamming lens)
//   press(name)           presses a control as a click does (keyboard shortcuts); false for an unknown name
//   screenPositionOf(name)  where the control shows, in normalised device coordinates { x, y }, or null
//   controlsByName        the controls by name
// `scene` is createScene's object (its renderer's canvas shows the cursor), `monitors` room.monitors.
export function createControls({ THREE, RoundedBoxGeometry, scene, camera, desk, monitors, room, onAction }) {
  const kit = makeKit(THREE, RoundedBoxGeometry, room);
  const list = [
    ...BIG_BUTTONS.map(spec => buildBigButton(kit, desk, spec)),
    buildResetButton(kit, desk),
    ...spread(SYSTEM.from, SYSTEM.to, SYSTEM.colors.length).map((x, i) => buildSystemButton(kit, desk, i, x)),
    ...spread(TOGGLES.from, TOGGLES.to, TOGGLES.count).map((x, i) => buildToggle(kit, desk, i, x)),
    buildLever(kit, desk),
    buildDial(kit, desk),
    buildPhone(kit, desk),
    mugControl(kit, room.props.mugGroup),
  ].map(prepare);
  const controlsByName = Object.fromEntries(list.map(control => [control.name, control]));
  const targets = [...list.map(control => control.group), ...Object.values(monitors).map(monitor => monitor.screen)];
  const raycaster = new THREE.Raycaster();
  const canvas = scene.renderer.domElement;
  const point = new THREE.Vector3();
  let hover = null; // { control } or { monitor, px, py }
  let lit = null; // the control whose highlight is on
  let cursor = '';
  animate(0); // the lamps and caps start in their state
  desk.updateWorldMatrix(true, true); // so the picking works before the first frame has rendered

  // What the ray through `pointer` hits first: a control, a screen with the canvas pixel under it, or null.
  function pick(pointer) {
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;
    for (let object = hit.object; object; object = object.parent) {
      const name = object.userData.control;
      if (name) return { control: controlsByName[name] };
    }
    const name = hit.object.userData.monitor;
    if (!name || !hit.uv) return null;
    const { width, height } = monitors[name];
    return { monitor: name, px: hit.uv.x * width, py: (1 - hit.uv.y) * height }; // the plane's v is 1 at the top
  }

  function lightUp(control, on) {
    for (const material of control?.highlight ?? []) {
      const { rest } = material.userData;
      material.emissive.set(on ? HIGHLIGHT.color : rest.emissive);
      material.emissiveIntensity = on ? HIGHLIGHT.intensity : rest.intensity;
    }
  }

  // The lamps, the cap heights, the swings and the mug's rocking, from each control's state and press.
  function animate(dt) {
    const swing = 1 - Math.exp(-SWING_EASE * dt);
    for (const control of list) {
      let dip = 0;
      if (control.pressT >= 0) {
        control.pressT += dt;
        const k = Math.min(control.pressT / control.pressTime, 1); // how far through the press
        if (k >= 1) control.pressT = -1;
        dip = control.travel * Math.sin(k * Math.PI);
        if (control.wobble) control.wobble.rotation.z = WOBBLE.angle * Math.sin(k * TAU) * (1 - k);
      }
      const rest = control.latching && control.on ? -LATCH_DEPTH : 0;
      control.caps.forEach((cap, i) => { cap.position.y = control.capRest[i] + rest + dip; });
      if (control.lamp) control.lamp.emissiveIntensity = control.levels[control.on ? 1 : 0];
      if (control.swing) {
        const { pivot, axis, angles } = control.swing;
        pivot.rotation[axis] += (angles[control.on ? 1 : 0] - pivot.rotation[axis]) * swing;
      }
    }
  }

  function update(dt, pointer) {
    hover = pointer ? pick(pointer) : null;
    const control = hover?.control ?? null;
    if (control !== lit) {
      lightUp(lit, false);
      lit = control;
      lightUp(lit, true);
    }
    const wanted = hover ? 'pointer' : '';
    if (wanted !== cursor) {
      cursor = wanted;
      canvas.style.cursor = cursor;
    }
    animate(dt);
  }

  function pressControl(control) {
    control.pressT = 0;
    if (control.flips) control.on = !control.on;
    onAction(control.action);
  }

  function click() {
    if (!hover) return false;
    if (hover.control) pressControl(hover.control);
    else onAction('monitor', { monitor: hover.monitor, px: hover.px, py: hover.py });
    return true;
  }

  function press(name) {
    const control = controlsByName[name];
    if (!control) return false;
    pressControl(control);
    return true;
  }

  function setLamp(name, on) {
    const control = controlsByName[name];
    if (control) control.on = Boolean(on);
  }

  function screenPositionOf(name) {
    const control = controlsByName[name];
    if (!control) return null;
    camera.updateMatrixWorld();
    control.anchor.getWorldPosition(point).project(camera);
    return { x: point.x, y: point.y };
  }

  return {
    update, click, press, setLamp, screenPositionOf, controlsByName,
    get hovered() { return hover ? (hover.control?.name ?? hover.monitor) : null; },
  };
}
