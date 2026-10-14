// The projectiles outside the window: a mesh group for each inbound threat, shaped by its type, and one for each
// interceptor in flight, kept in step with the session's state. sync(state) builds a group for each new record,
// moves every group to its record's position, points it along its flight and removes the groups whose records are
// gone. Positions are the outside group's coordinates, as the session's are. Three.js is passed in, as the other
// scene builders take it.
//
// A group's local +y points along the flight. Its parts hang on an inner `body` group that sync() turns about that
// axis so that wings stay level. Rockets and their kin trail an open cone of flame. A few point lights, made once at
// the start, glow behind the newest projectiles that burn: adding or removing a light makes three.js recompile
// every lit material, a visible hitch, so the lights are pooled and an unused one only goes dark.
import { threatTangent } from '../game/threats.js';

const TAU = Math.PI * 2;
const FLAME_LIGHTS = 4; // the pool; burning projectiles beyond it show their flame without a light
const LIGHT_BEHIND = 0.15; // a flame light sits this far behind the tail
const FIN_OFFSET = 0.03; // the fins stand this far out from the body ...
const FIN_OVERHANG = 0.06; // ... and reach this far back past its tail
const THICKNESS = 0.025; // of the wings and the tail

// The looks; lengths are world units. body: a cylinder along the flight, centred on the group's origin; nose: a cone
// on its front; fins: three plates around its tail, size [thickness, height, depth]; wings: a flat plate across the
// body, level with the ground; tail: an upright plate on top, at the back; flame: the open trail cone behind the
// tail; light: the pooled flame light it gets.
const ROCKET = {
  body: { radius: 0.11, length: 0.7, color: 0xe8ecf1 },
  nose: { length: 0.3, color: 0xff4b4b },
  fins: { size: [0.03, 0.22, 0.18], color: 0xff4b4b },
  flame: { radius: 0.16, length: 2.4, color: 0xff8a3d, opacity: 0.7 },
  light: { color: 0xff7a2a, intensity: 6, distance: 6 },
};
const LOOKS = {
  rocket: ROCKET,
  longrange: { ...ROCKET, body: { radius: 0.12, length: 1.1, color: 0x4a525e } },
  uav: {
    body: { radius: 0.07, length: 0.8, color: 0x8c96a2 },
    nose: { length: 0.12, color: 0x8c96a2 },
    wings: { span: 1.2, chord: 0.18, color: 0x7a838e },
    tail: { height: 0.18, chord: 0.14, color: 0x7a838e },
  },
  mortar: {
    ...ROCKET,
    body: { radius: 0.13, length: 0.32, color: 0xe8ecf1 },
    nose: { length: 0.16, color: 0xff4b4b },
    fins: { size: [0.025, 0.14, 0.12], color: 0xff4b4b },
    flame: { radius: 0.13, length: 1.1, color: 0xff8a3d, opacity: 0.6 },
  },
  decoy: ROCKET, // a decoy looks exactly like a rocket (spec §4)
  cruise: {
    body: { radius: 0.09, length: 1.3, color: 0xd5dbe3 },
    nose: { length: 0.22, color: 0x9aa7b5 },
    fins: { size: [0.02, 0.16, 0.14], color: 0x9aa7b5 },
    wings: { span: 0.7, chord: 0.16, color: 0x9aa7b5 },
    flame: { radius: 0.11, length: 1.6, color: 0x5aa8ff, opacity: 0.75 },
    light: { color: 0x4f8cff, intensity: 5, distance: 5 },
  },
};
const INTERCEPTOR = {
  body: { radius: 0.06, length: 0.5, color: 0xf4f6fa },
  nose: { length: 0.18, color: 0x2ad1b0 },
  flame: { radius: 0.1, length: 1.8, color: 0x8ff3ff, opacity: 0.75 },
  light: { color: 0x8ff3ff, intensity: 5, distance: 5 },
};

// The meshes of a look, as parts { geometry, material, position, rotation } that every group of that look shares,
// and where its flame light goes (y along the flight; behind the tail).
function makeParts(THREE, look) {
  const { body, nose, fins, wings, tail, flame } = look;
  const mat = color => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0 });
  const back = -body.length / 2;
  const parts = [];
  const add = (geometry, material, position, rotation = [0, 0, 0]) => parts.push({ geometry, material, position, rotation });

  add(new THREE.CylinderGeometry(body.radius, body.radius, body.length, 12), mat(body.color), [0, 0, 0]);
  add(new THREE.ConeGeometry(body.radius, nose.length, 12), mat(nose.color), [0, -back + nose.length / 2, 0]);
  if (fins) {
    const [, height] = fins.size;
    const finGeometry = new THREE.BoxGeometry(...fins.size);
    const finMaterial = mat(fins.color);
    const out = body.radius + FIN_OFFSET;
    const y = back + height / 2 - FIN_OVERHANG;
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * TAU; // the first fin points up once the body is turned level (see place)
      add(finGeometry, finMaterial, [Math.sin(angle) * out, y, Math.cos(angle) * out], [0, angle, 0]);
    }
  }
  // The body's local x stays level and its z points up (see place).
  if (wings) {
    add(new THREE.BoxGeometry(wings.span, wings.chord, THICKNESS), mat(wings.color), [0, 0.05 * body.length, 0]);
  }
  if (tail) {
    const at = [0, back + tail.chord / 2, body.radius + tail.height / 2];
    add(new THREE.BoxGeometry(THICKNESS, tail.chord, tail.height), mat(tail.color), at);
  }
  if (flame) {
    const cone = new THREE.ConeGeometry(flame.radius, flame.length, 10, 1, true);
    const glow = new THREE.MeshBasicMaterial({
      color: flame.color, transparent: true, opacity: flame.opacity, side: THREE.DoubleSide, depthWrite: false,
    });
    add(cone, glow, [0, back - flame.length / 2, 0], [Math.PI, 0, 0]); // its tip trails behind
  }
  return { parts, lightY: back - LIGHT_BEHIND };
}

// createProjectiles({ THREE, outsideGroup }) returns:
//   sync(state)  makes the groups in outsideGroup match state.threats (the inbound ones) and state.interceptors (the
//                ones in flight): new ones are built, all are moved and turned, those gone are removed; the pooled
//                flame lights go to the newest burning projectiles. Call it every frame after session.update(): the
//                session replaces those arrays at a new round, so they are read anew each time.
//   clear()      removes every group and darkens the lights
//   threats, interceptors   the groups by threat or interceptor id (Maps), each { group, body, look, ... }
export function createProjectiles({ THREE, outsideGroup }) {
  const UP = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  const partsByLook = new Map(); // look -> its shared parts, made on first use
  const threats = new Map();
  const interceptors = new Map();
  let born = 0; // counts the groups built, so the newest can be told
  const burning = []; // reused by lightFlames()

  const flameLights = Array.from({ length: FLAME_LIGHTS }, () => {
    const light = new THREE.PointLight(0xffffff, 0, 1, 2);
    outsideGroup.add(light);
    return light;
  });

  function build(look) {
    if (!partsByLook.has(look)) partsByLook.set(look, makeParts(THREE, look));
    const { parts, lightY } = partsByLook.get(look);
    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);
    for (const { geometry, material, position, rotation } of parts) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      body.add(mesh);
    }
    outsideGroup.add(group);
    return { group, body, look, lightY, born: born++, seen: false };
  }

  // Moves the group to `position` and points its +y along the unit vector `dir`. The shortest turn from +y leaves its
  // axis, UP × dir = (dir.z, 0, −dir.x), where it was: that axis is level, and turning the body by atan2(−dir.x, −dir.z)
  // lays its local x along it (the wings level) with its local z on the upper side.
  function place({ group, body }, position, dir) {
    direction.set(dir.x, dir.y, dir.z);
    group.position.set(position.x, position.y, position.z);
    group.quaternion.setFromUnitVectors(UP, direction);
    body.rotation.y = Math.atan2(-dir.x, -dir.z);
  }

  // Brings the groups of one kind in line with its records: `flying` picks the records to show, `lookOf` and
  // `directionOf` give a record's look and its flight direction.
  function syncKind(groups, records, flying, lookOf, directionOf) {
    for (const entry of groups.values()) entry.seen = false;
    for (const record of records) {
      if (!flying(record)) continue;
      let entry = groups.get(record.id);
      if (!entry) {
        entry = build(lookOf(record));
        groups.set(record.id, entry);
      }
      entry.seen = true;
      place(entry, record.position, directionOf(record));
    }
    for (const [id, entry] of groups) {
      if (entry.seen) continue;
      outsideGroup.remove(entry.group);
      groups.delete(id);
    }
  }

  // The flame lights go to the newest projectiles that burn, behind their tails; the rest of the pool goes dark.
  function lightFlames() {
    burning.length = 0;
    for (const groups of [threats, interceptors]) {
      for (const entry of groups.values()) if (entry.look.light) burning.push(entry);
    }
    burning.sort((a, b) => b.born - a.born);
    flameLights.forEach((light, i) => {
      const entry = burning[i];
      if (!entry) {
        light.intensity = 0;
        return;
      }
      const { color, intensity, distance } = entry.look.light;
      light.color.setHex(color);
      light.intensity = intensity;
      light.distance = distance;
      light.position.set(0, entry.lightY, 0).applyQuaternion(entry.group.quaternion).add(entry.group.position);
    });
  }

  function sync(state) {
    // An unknown type would show as a rocket; every THREATS type has a look.
    const lookOf = threat => LOOKS[threat.type] ?? ROCKET;
    syncKind(threats, state.threats, t => t.state === 'inbound', lookOf, t => threatTangent(t, t.t));
    syncKind(interceptors, state.interceptors, it => it.state === 'flying', () => INTERCEPTOR, it => it.direction);
    lightFlames();
  }

  function clear() {
    for (const groups of [threats, interceptors]) {
      for (const { group } of groups.values()) outsideGroup.remove(group);
      groups.clear();
    }
    for (const light of flameLights) light.intensity = 0;
  }

  return { sync, clear, threats, interceptors };
}
