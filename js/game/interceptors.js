// Interceptors: how one is created and how it flies. Pure functions over the interceptor record and plain
// { x, y, z } points. The numbers are WORLD in config.js. Whether a shot hits is rolled at launch (the `hit`
// flag), so the flight only plays it out: a hit homes in and lands, a miss homes in, passes the target and
// flies on until it is interceptorMissOvershoot further.
import { WORLD } from '../config.js';

// A new interceptor at `from` (copied), homing on the threat `targetId`. `direction` is the unit vector it
// flies along (the scene points the mesh that way); it points up until the first advance aims it.
export function createInterceptor({ id, from, targetId, hit, speed = WORLD.interceptorSpeed }) {
  return {
    id,
    targetId,
    hit,
    speed,
    position: { ...from },
    direction: { x: 0, y: 1, z: 0 },
    state: 'flying', // 'flying' | 'hit' | 'missed' | 'lost'
    overshoot: 0, // how far a miss has flown on since reaching its target
    passed: false, // whether a miss has reached its target and is flying on
  };
}

// Moves the interceptor `length` along its direction, in place.
const flyAlong = (it, length) => {
  it.position.x += it.direction.x * length;
  it.position.y += it.direction.y * length;
  it.position.z += it.direction.z * length;
};

// Flies the interceptor dt seconds on and returns its state:
//   'flying'  on its way, or (`passed`) a miss flying on beyond its target
//   'hit'     reached the target, and was to hit
//   'missed'  was to miss, and has flown interceptorMissOvershoot on beyond the target
//   'lost'    the target is gone (null, or no longer 'inbound'): the interceptor self-destructs
// 'hit', 'missed' and 'lost' are final: a later call returns the state and leaves the interceptor alone.
// It homes in on the target's position as it is now, speed * dt per call but never past the target. Arrival
// is judged from where the call starts: the target within interceptorHitDistance, or a step that reaches it.
// A hit ends there; a miss sets `passed` and from then on keeps its heading, without homing in again, and
// counts the distance it flies in `overshoot`. `world` is the table to read; tests pass their own.
export function advanceInterceptor(it, target, dt, world = WORLD) {
  if (it.state !== 'flying') return it.state;
  if (!target || target.state !== 'inbound') {
    it.state = 'lost';
    return it.state;
  }
  const step = it.speed * dt;
  if (it.passed) {
    flyAlong(it, step);
    it.overshoot += step;
    if (it.overshoot >= world.interceptorMissOvershoot) it.state = 'missed';
    return it.state;
  }
  const dx = target.position.x - it.position.x;
  const dy = target.position.y - it.position.y;
  const dz = target.position.z - it.position.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > 0) { // already on the target: there is no way to aim, so the direction stays
    it.direction.x = dx / distance;
    it.direction.y = dy / distance;
    it.direction.z = dz / distance;
  }
  flyAlong(it, Math.min(step, distance));
  if (distance < world.interceptorHitDistance || step >= distance) {
    if (it.hit) it.state = 'hit';
    else it.passed = true;
  }
  return it.state;
}
