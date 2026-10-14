// The effects: explosions outside the window, the shake of the view and of the loose things on the console, and the
// red flash at the edges of the screen. An explosion is a translucent sphere that grows and fades, with a burst of
// light, in the outside group's coordinates (the session's positions are). shake() moves the camera through
// scene.shakeOffset, which scene.update() adds to the seat. With settings.reduceMotion on, shake() and flash() do
// nothing. Three.js is passed in, as the other scene builders take it.
//
// The explosions' lights are a pool made once, at the start: adding or removing a light makes three.js recompile
// every lit material, a visible hitch, so an idle light only goes dark.

// Explosions by kind (spec §8): the sphere's colour, how far it grows (its radius ends at startRadius + size), its
// light's peak intensity, and its opacity at the start.
const EXPLOSIONS = {
  intercept: { color: 0xfff1c0, size: 2.2, flash: 120, opacity: 0.95 }, // white-yellow
  damage: { color: 0xffffff, size: 1.0, flash: 40, opacity: 0.95 }, // a hit that leaves a cruise missile flying, a miss
  populated: { color: 0xff3b3b, size: 3.0, flash: 80, opacity: 0.95 },
  open: { color: 0xffa040, size: 1.6, flash: 60, opacity: 0.95 },
  decoy: { color: 0xb4bcc8, size: 0.8, flash: 10, opacity: 0.45 }, // faint: it burns up
  launch: { color: 0xfff1c0, size: 0.8, flash: 20, opacity: 0.95 },
};
// time: seconds an explosion lasts; lights: the pool, lent to the newest explosions; range: how far a light reaches.
const EXPLOSION = { time: 0.7, startRadius: 0.2, lights: 3, range: 30 };
// time: seconds a shake takes to die away; camera and props: the offset, in world units, per unit of strength.
const SHAKE = { time: 0.6, camera: 0.05, props: 0.01 };
const FLASH_TIME = 0.25; // seconds #flash stays on; its CSS fades it out after that

// A random number in [−amount, amount].
const jitter = amount => (Math.random() * 2 - 1) * amount;

// createEffects({ THREE, scene, outsideGroup, settings, props }) returns:
//   explosion(pos, kind)  an explosion of a kind from EXPLOSIONS at pos ({ x, y, z } in outside coordinates)
//   shake(strength)       shakes the view (and props) for SHAKE.time, starting at strength and dying away; a weaker
//                         shake than the one still running changes nothing, a stronger one starts again
//   flash()               shows the red edge flash (#flash.on) for FLASH_TIME
//   update(dt)            runs the explosions, the shake and the flash
//   shakeOffset           scene.shakeOffset, the camera's offset from the seat
// `scene` is createScene's object, `props` room.props (the loose objects on the console that a shake jitters) and
// `settings` the saved settings, whose reduceMotion is read at every call.
export function createEffects({ THREE, scene, outsideGroup, settings = {}, props = [] }) {
  const { shakeOffset } = scene;
  const flashElement = document.getElementById('flash');
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  // Each explosion fades on its own, so each has its own material. Not tone mapped: that turns the pale ones grey.
  const sphereMaterial = () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  const lights =Array.from({ length: EXPLOSION.lights }, () => {
    const light = new THREE.PointLight(0xffffff, 0, EXPLOSION.range, 2);
    outsideGroup.add(light);
    return light;
  });
  let nextLight = 0; // the light lent longest ago: every explosion lasts as long, so it is free first
  const live = []; // the explosions under way: { mesh, spec, t, light (null once lent on) }
  const spare = []; // finished ones, kept to be used again
  const jittered = Array.from(props, object => ({ object, rest: object.position.clone() }));
  let shakeStrength = 0; // the running shake's strength at its start ...
  let shakeLeft = 0; // ... and the seconds it has still to run
  let flashLeft = 0;

  // Draws an explosion k of the way through (0..1): it grows fast at first and fades out steadily.
  function show(fx, k) {
    const { spec, mesh, light } = fx;
    mesh.scale.setScalar(EXPLOSION.startRadius + spec.size * Math.sqrt(k));
    mesh.material.opacity = spec.opacity * (1 - k);
    if (light) light.intensity = spec.flash * (1 - k);
  }

  function explosion(pos, kind) {
    const spec = EXPLOSIONS[kind];
    if (!spec) throw new Error(`unknown explosion kind "${kind}"`);
    const fx = spare.pop() ?? { mesh: new THREE.Mesh(sphere, sphereMaterial()) };
    fx.mesh.material.color.setHex(spec.color);
    fx.mesh.position.set(pos.x, pos.y, pos.z);
    outsideGroup.add(fx.mesh);
    const light = lights[nextLight];
    nextLight = (nextLight + 1) % lights.length;
    for (const other of live) if (other.light === light) other.light = null;
    light.color.setHex(spec.color);
    light.position.copy(fx.mesh.position);
    Object.assign(fx, { spec, t: 0, light });
    live.push(fx);
    show(fx, 0);
  }

  // The strength the running shake has left.
  const shakeNow = () => (shakeLeft > 0 ? (shakeStrength * shakeLeft) / SHAKE.time : 0);

  function shake(strength) {
    if (settings.reduceMotion || !(strength > shakeNow())) return;
    shakeStrength = strength;
    shakeLeft = SHAKE.time;
  }

  function flash() {
    if (settings.reduceMotion || !flashElement) return;
    flashElement.classList.add('on');
    flashLeft = FLASH_TIME;
  }

  function updateExplosions(dt) {
    for (let i = live.length - 1; i >= 0; i--) {
      const fx = live[i];
      fx.t += dt;
      const k = Math.min(fx.t / EXPLOSION.time, 1);
      show(fx, k);
      if (k < 1) continue;
      outsideGroup.remove(fx.mesh);
      live.splice(i, 1);
      spare.push(fx);
    }
  }

  // The camera moves by up to SHAKE.camera and each prop by up to SHAKE.props per unit of the strength left, a new
  // random offset every frame; the props only hop up, so that none sinks into the desk. At the end all come to rest.
  function updateShake(dt) {
    if (shakeLeft <= 0) return;
    shakeLeft = settings.reduceMotion ? 0 : Math.max(0, shakeLeft - dt);
    const strength = shakeNow();
    if (strength > 0) {
      const camera = SHAKE.camera * strength;
      shakeOffset.set(jitter(camera), jitter(camera), jitter(camera));
      const prop = SHAKE.props * strength;
      for (const { object, rest } of jittered) {
        object.position.set(rest.x + jitter(prop), rest.y + Math.abs(jitter(prop)), rest.z + jitter(prop));
      }
      return;
    }
    shakeOffset.set(0, 0, 0);
    for (const { object, rest } of jittered) object.position.copy(rest);
  }

  function updateFlash(dt) {
    if (flashLeft <= 0) return;
    flashLeft = settings.reduceMotion ? 0 : flashLeft - dt;
    if (flashLeft <= 0) flashElement.classList.remove('on');
  }

  function update(dt) {
    updateExplosions(dt);
    updateShake(dt);
    updateFlash(dt);
  }

  return { explosion, shake, flash, update, shakeOffset };
}
