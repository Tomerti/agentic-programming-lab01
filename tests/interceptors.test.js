import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createInterceptor, advanceInterceptor } from '../js/game/interceptors.js';
import { WORLD } from '../js/config.js';
const target = (x = 0, y = 5, z = -11) => ({ state: 'inbound', position: { x, y, z } });
test('flies toward the target at 16 u/s and hits', () => { const it = createInterceptor({ id: 1, from: { x: 0, y: 0, z: 5 }, targetId: 9, hit: true }); const t = target(0, 0, -11); assert.equal(advanceInterceptor(it, t, 0.5), 'flying'); assert.ok(Math.abs(it.position.z - (-3)) < 1e-9); assert.ok(it.direction.z < 0); assert.equal(advanceInterceptor(it, t, 0.49), 'flying'); assert.equal(advanceInterceptor(it, t, 0.1), 'hit'); assert.equal(it.state, 'hit'); assert.equal(advanceInterceptor(it, t, 1), 'hit'); });
test('a miss overshoots 1.5 units then reports missed', () => { const it = createInterceptor({ id: 2, from: { x: 0, y: 0, z: 5 }, targetId: 9, hit: false }); const t = target(0, 0, -11); for (let i = 0; i < 10; i++) advanceInterceptor(it, t, 0.1); assert.equal(advanceInterceptor(it, t, 0.05), 'flying'); assert.equal(it.passed, true); let s; for (let i = 0; i < 5; i++) s = advanceInterceptor(it, t, 0.05); assert.equal(s, 'missed'); assert.ok(it.position.z < -11 - 1.4); });
test('target gone → lost', () => { const it = createInterceptor({ id: 3, from: { x: 0, y: 0, z: 0 }, targetId: 9, hit: true }); assert.equal(advanceInterceptor(it, { state: 'impacted', position: { x: 0, y: 0, z: -5 } }, 0.1), 'lost'); assert.equal(advanceInterceptor(it, null, 0.1), 'lost'); });

// Behaviour the plan's tests above leave open.
const near = (a, b) => Math.abs(a - b) < 1e-9;
const samePoint = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z);
const origin = () => ({ x: 0, y: 0, z: 0 });
// An interceptor launched from the origin; `options` override its fields.
const launch = (options = {}) => createInterceptor({ id: 1, from: origin(), targetId: 9, hit: true, ...options });

test('createInterceptor builds the documented record, with its own copy of the launch point', () => {
  const from = WORLD.launchPoint; // frozen: an interceptor that moved this very object would throw
  const it = createInterceptor({ id: 4, from, targetId: 9, hit: true });
  assert.deepEqual(it, { id: 4, targetId: 9, hit: true, speed: WORLD.interceptorSpeed, position: { ...from }, direction: { x: 0, y: 1, z: 0 }, state: 'flying', overshoot: 0, passed: false });
  assert.notEqual(it.position, from);
  advanceInterceptor(it, target(), 0.1);
  assert.notDeepEqual(it.position, from);
  assert.equal(createInterceptor({ id: 5, from, targetId: 9, hit: false, speed: 3 }).speed, 3);
});

test('it homes in 3D along a unit direction, updating position and direction in place', () => {
  const it = launch(), { position, direction } = it;
  assert.equal(advanceInterceptor(it, target(2, 4, 4), 0.125), 'flying'); // 6 away, one step of 2
  assert.equal(it.position, position);
  assert.equal(it.direction, direction);
  assert.ok(samePoint(direction, { x: 1 / 3, y: 2 / 3, z: 2 / 3 }));
  assert.ok(near(Math.hypot(direction.x, direction.y, direction.z), 1));
  assert.ok(samePoint(position, { x: 2 / 3, y: 4 / 3, z: 4 / 3 }));
});

test('it re-aims at the target\'s current position on every call', () => {
  const it = launch(), t = target(0, 0, -20);
  advanceInterceptor(it, t, 0.25); // 4 units towards -z
  t.position.x = 12; t.position.z = -4; // the target is now 12 units off to the side
  advanceInterceptor(it, t, 0.25);
  assert.ok(samePoint(it.direction, { x: 1, y: 0, z: 0 }));
  assert.ok(samePoint(it.position, { x: 4, y: 0, z: -4 }));
});

test('hit, missed and lost are final: later calls return the state and move nothing', () => {
  const hit = launch(), missed = launch({ hit: false }), lost = launch();
  advanceInterceptor(hit, target(0, 0, -1), 1);
  advanceInterceptor(missed, target(0, 0, -1), 1); // reaches the target and passes it ...
  advanceInterceptor(missed, target(0, 0, -1), 1); // ... then flies on past the overshoot limit
  advanceInterceptor(lost, null, 1);
  assert.deepEqual([hit.state, missed.state, lost.state], ['hit', 'missed', 'lost']);
  for (const it of [hit, missed, lost]) {
    const before = structuredClone(it);
    for (const t of [target(0, 0, -50), { state: 'impacted', position: origin() }, null]) {
      assert.equal(advanceInterceptor(it, t, 1), before.state);
    }
    assert.deepEqual(it, before);
  }
});

test('a missing or no-longer-inbound target loses the interceptor before it moves, even once it has passed', () => {
  const impacted = { state: 'impacted', position: { x: 0, y: 0, z: -5 } };
  for (const gone of [null, undefined, impacted, { ...impacted, state: 'intercepted' }]) {
    const it = launch();
    assert.equal(advanceInterceptor(it, gone, 0.1), 'lost');
    assert.deepEqual(it.position, origin());
  }
  const it = launch({ hit: false }), t = target(0, 0, -1);
  advanceInterceptor(it, t, 0.0625); // one unit: reaches the target and passes it
  assert.equal(it.passed, true);
  t.state = 'intercepted';
  assert.equal(advanceInterceptor(it, t, 0.1), 'lost');
});

test('within the hit distance it hits though its step cannot reach the target; exactly at it, not yet', () => {
  const world = { interceptorHitDistance: 1, interceptorMissOvershoot: 2 };
  const it = launch({ speed: 1 }), t = target(0, 0, -3);
  assert.equal(advanceInterceptor(it, t, 1, world), 'flying'); // 3 away at the start of the call
  assert.equal(advanceInterceptor(it, t, 1, world), 'flying'); // 2 away
  assert.equal(advanceInterceptor(it, t, 0.1, world), 'flying'); // exactly 1 away: not within it
  assert.equal(advanceInterceptor(it, t, 0.1, world), 'hit'); // 0.9 away, with a step of only 0.1
});

test('a step that reaches the target stops on it: a hit lands there, a miss starts its overshoot there', () => {
  for (const hit of [true, false]) {
    const it = launch({ hit }), t = target(3, 0, -4); // 5 away, and one step is 8
    assert.equal(advanceInterceptor(it, t, 0.5), hit ? 'hit' : 'flying');
    assert.equal(it.passed, !hit);
    assert.ok(samePoint(it.position, t.position));
    assert.equal(it.overshoot, 0);
  }
});

test('a miss that has passed flies straight on, ignoring the target, until the overshoot limit is reached', () => {
  const world = { interceptorHitDistance: 0.4, interceptorMissOvershoot: 3 };
  const it = launch({ hit: false, speed: 1 }), t = target(0, 0, -1);
  assert.equal(advanceInterceptor(it, t, 1, world), 'flying'); // reaches the target and passes it
  assert.equal(it.passed, true);
  t.position.x = 5; // the target swerves away: the interceptor does not follow
  assert.equal(advanceInterceptor(it, t, 1, world), 'flying');
  assert.deepEqual(it.direction, { x: 0, y: 0, z: -1 });
  assert.deepEqual(it.position, { x: 0, y: 0, z: -2 });
  assert.equal(it.overshoot, 1);
  assert.equal(advanceInterceptor(it, t, 1, world), 'flying'); // overshoot 2 of 3
  assert.equal(advanceInterceptor(it, t, 1, world), 'missed'); // overshoot 3: the limit itself counts
  assert.deepEqual(it.position, { x: 0, y: 0, z: -4 });
});

test('the thresholds default to WORLD: interceptorHitDistance to hit, interceptorMissOvershoot to miss', () => {
  const { interceptorHitDistance: hitDistance, interceptorMissOvershoot: limit } = WORLD;
  const afterOneStep = away => advanceInterceptor(launch({ speed: 1 }), target(0, 0, -away), 0.01); // far too short a step to arrive
  assert.equal(afterOneStep(hitDistance + 0.01), 'flying');
  assert.equal(afterOneStep(hitDistance - 0.01), 'hit');
  const it = launch({ hit: false, speed: 1 }), t = target(0, 0, -1);
  advanceInterceptor(it, t, 1); // reaches the target and passes it
  assert.equal(advanceInterceptor(it, t, limit - 0.1), 'flying');
  assert.equal(advanceInterceptor(it, t, 0.2), 'missed');
});

test('an interceptor already on its target keeps its direction rather than turning it into NaN', () => {
  const it = createInterceptor({ id: 1, from: { x: 1, y: 2, z: 3 }, targetId: 9, hit: true });
  assert.equal(advanceInterceptor(it, target(1, 2, 3), 0.1), 'hit');
  assert.deepEqual(it.direction, { x: 0, y: 1, z: 0 });
  assert.deepEqual(it.position, { x: 1, y: 2, z: 3 });
});
