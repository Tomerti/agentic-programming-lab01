import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createMissionTracker } from '../js/game/missions.js';
import { MISSIONS, TIMING } from '../js/config.js';
test('tracker lists missions with text, reward and goal', () => { const m = createMissionTracker(['alertGilo', 'streak3']); assert.equal(m.missions.length, 2); assert.equal(m.missions[1].goal, 3); assert.equal(m.missions[0].reward, 150); assert.match(m.missions[0].text, /Gilo/); });
test('alertGilo completes once', () => { const m = createMissionTracker(['alertGilo']); assert.deepEqual(m.onEvent('alert:sounded', { zone: 'talpiot', inTime: true }), []); assert.deepEqual(m.onEvent('alert:sounded', { zone: 'gilo', inTime: false }), []); assert.deepEqual(m.onEvent('alert:sounded', { zone: 'gilo', inTime: true }), [{ id: 'alertGilo', reward: 150 }]); assert.deepEqual(m.onEvent('alert:sounded', { zone: 'gilo', inTime: true }), []); assert.equal(m.status()[0].done, true); });
test('streak3 resets on a miss or populated impact', () => { const m = createMissionTracker(['streak3']); const hit = () => m.onEvent('threat:intercepted', { threat: { type: 'rocket' } }); hit(); hit(); m.onEvent('interceptor:missed', {}); assert.equal(m.status()[0].progress, 0); hit(); hit(); m.onEvent('threat:impact', { populated: false }); assert.equal(m.status()[0].progress, 2); assert.deepEqual(hit(), [{ id: 'streak3', reward: 200 }]); });
test('wave-based missions', () => { const m = createMissionTracker(['noWaste', 'holdWave']); assert.deepEqual(m.onEvent('wave:end', { openOnly: false, shotsWasted: 1, holdAllWave: false }), []); assert.deepEqual(m.onEvent('wave:end', { openOnly: true, shotsWasted: 0, holdAllWave: true }), [{ id: 'holdWave', reward: 150 }]); assert.deepEqual(m.onEvent('wave:end', { openOnly: false, shotsWasted: 0, holdAllWave: false }), [{ id: 'noWaste', reward: 200 }]); });
test('callUav, clearJam, perfectRound, cruiseKill', () => { const m = createMissionTracker(['callUav', 'clearJam', 'perfectRound', 'cruiseKill']); assert.deepEqual(m.onEvent('hq:line', { uavOnRadar: false }), []); assert.equal(m.onEvent('hq:line', { uavOnRadar: true })[0].id, 'callUav'); assert.deepEqual(m.onEvent('hazard:jamming', { on: false, elapsed: 6 }), []); assert.equal(m.onEvent('hazard:jamming', { on: false, elapsed: 4.9 })[0].id, 'clearJam'); assert.equal(m.onEvent('round:end', { summary: { impactsPopulated: 0 } })[0].reward, 400); assert.equal(m.onEvent('threat:intercepted', { threat: { type: 'cruise' } })[0].id, 'cruiseKill'); });

// Behaviour the plan's tests above leave open.
// The single event that completes each mission except streak3, as [event type, payload].
const COMPLETING = {
  alertGilo: ['alert:sounded', { zone: 'gilo', inTime: true }],
  noWaste: ['wave:end', { openOnly: false, shotsWasted: 0, holdAllWave: false }],
  holdWave: ['wave:end', { openOnly: true, shotsWasted: 0, holdAllWave: true }],
  callUav: ['hq:line', { uavOnRadar: true }],
  clearJam: ['hazard:jamming', { on: false, elapsed: 3 }],
  perfectRound: ['round:end', { summary: { impactsPopulated: 0 } }],
  cruiseKill: ['threat:intercepted', { threat: { type: 'cruise' } }],
};
const rocketDown = { threat: { type: 'rocket' } };

test('each mission but streak3 completes on its own event, paying its reward from MISSIONS, and on no other type of event', () => {
  assert.deepEqual([...Object.keys(COMPLETING), 'streak3'].sort(), Object.keys(MISSIONS).sort());
  const types = [...new Set(Object.values(COMPLETING).map(([type]) => type)), 'round:start', 'wave:start', 'threat:impact', 'interceptor:missed', 'coins:changed', 'shop:open'];
  for (const [id, [own, payload]] of Object.entries(COMPLETING)) {
    for (const type of types.filter(t => t !== own)) assert.deepEqual(createMissionTracker([id]).onEvent(type, payload), [], `${id} on ${type}`);
    const m = createMissionTracker([id]);
    assert.deepEqual(m.onEvent(own, payload), [{ id, reward: MISSIONS[id].reward }], id);
    assert.deepEqual(m.status(), [{ id, ...MISSIONS[id], progress: MISSIONS[id].goal, done: true }], id);
  }
});

test('a rule needs all of its conditions: near misses complete nothing', () => {
  const nearMisses = [
    ['holdWave', 'wave:end', { openOnly: true, shotsWasted: 0, holdAllWave: false }], // fire was released during the open-area wave
    ['holdWave', 'wave:end', { openOnly: false, shotsWasted: 0, holdAllWave: true }], // held, but through an ordinary wave
    ['perfectRound', 'round:end', { summary: { impactsPopulated: 1 } }],
    ['cruiseKill', 'threat:intercepted', rocketDown],
  ];
  for (const [id, type, payload] of nearMisses) assert.deepEqual(createMissionTracker([id]).onEvent(type, payload), [], `${id} ${JSON.stringify(payload)}`);
});

test('a wave:end that does not say whether the wave was open-area only counts as an ordinary wave', () => {
  const m = createMissionTracker(['holdWave', 'noWaste']);
  assert.deepEqual(m.onEvent('wave:end', { shotsWasted: 0, holdAllWave: true }), [{ id: 'noWaste', reward: 200 }]);
});

test('streak3 counts the current streak: a populated impact ends it, an open-area or unreported one does not, and it stops at its goal', () => {
  const m = createMissionTracker(['streak3']);
  const progress = () => m.status()[0].progress;
  m.onEvent('threat:intercepted', rocketDown);
  m.onEvent('threat:intercepted', rocketDown);
  assert.equal(progress(), 2);
  m.onEvent('threat:impact', { populated: true });
  assert.equal(progress(), 0);
  m.onEvent('threat:intercepted', rocketDown);
  for (const payload of [{ populated: false }, {}, null, undefined]) m.onEvent('threat:impact', payload); // open ground, a decoy, or no word on it
  m.onEvent('wave:start', { wave: 2, openOnly: false });
  assert.equal(progress(), 1);
  m.onEvent('threat:intercepted'); // a bare interception still counts
  assert.equal(progress(), 2);
  assert.deepEqual(m.onEvent('threat:intercepted', rocketDown), [{ id: 'streak3', reward: 200 }]);
  assert.deepEqual(m.status(), [{ id: 'streak3', ...MISSIONS.streak3, progress: 3, done: true }]);
  // Done for good: nothing more is paid, counted or reset.
  assert.deepEqual(m.onEvent('threat:intercepted', rocketDown), []);
  m.onEvent('interceptor:missed', {});
  m.onEvent('threat:impact', { populated: true });
  assert.deepEqual(m.status(), [{ id: 'streak3', ...MISSIONS.streak3, progress: 3, done: true }]);
});

test('clearJam takes a jamming that ends within TIMING.clearJamWindow, the limit included, and nothing else', () => {
  const limit = TIMING.clearJamWindow;
  const jam = payload => createMissionTracker(['clearJam']).onEvent('hazard:jamming', payload);
  assert.deepEqual(jam({ on: false, elapsed: limit }), [{ id: 'clearJam', reward: 250 }]);
  assert.deepEqual(jam({ on: false, elapsed: limit + 0.01 }), []);
  assert.deepEqual(jam({ on: true, elapsed: 1 }), []); // the jamming starting is not it ending
  assert.deepEqual(jam({ elapsed: 1 }), []);
  assert.deepEqual(jam({ on: false }), []); // no word on how long it took
  const m = createMissionTracker(['clearJam']);
  assert.deepEqual(m.onEvent('hazard:jamming', { on: false, elapsed: limit + 3 }), []); // a late clear is not the end of the mission
  assert.deepEqual(m.onEvent('hazard:jamming', { on: false, elapsed: 2 }), [{ id: 'clearJam', reward: 250 }]);
});

test('one event can complete several missions; they come back in the order the tracker lists them', () => {
  const m = createMissionTracker(['cruiseKill', 'streak3']);
  m.onEvent('threat:intercepted', rocketDown);
  m.onEvent('threat:intercepted', rocketDown);
  assert.deepEqual(m.onEvent('threat:intercepted', { threat: { type: 'cruise' } }), [{ id: 'cruiseKill', reward: 300 }, { id: 'streak3', reward: 200 }]);
  assert.deepEqual(m.status().map(({ done }) => done), [true, true]);
});

test('payloads that lack the fields a rule reads never throw and complete nothing', () => {
  const m = createMissionTracker(Object.keys(COMPLETING)); // without streak3, which counts every interception
  const types = [...Object.values(COMPLETING).map(([type]) => type), 'interceptor:missed', 'threat:impact', 'wave:start', 'round:start', 'shop:open'];
  const payloads = [undefined, null, 0, '', 'text', [], {}, { threat: null, summary: null }, { threat: {}, summary: {} }, { zone: 'gilo' }, { inTime: true }, { on: false }, { openOnly: true }];
  for (const type of types) for (const payload of payloads) assert.deepEqual(m.onEvent(type, payload), [], `${type} ${JSON.stringify(payload)}`);
  assert.deepEqual(m.status().map(({ progress, done }) => [progress, done]), Object.keys(COMPLETING).map(() => [0, false]));
});

test('status() returns fresh copies: neither changing them nor a later event crosses over', () => {
  const m = createMissionTracker(['streak3']);
  const before = m.status();
  assert.notEqual(m.status(), before); // a new array on every call ...
  assert.notEqual(m.status()[0], before[0]); // ... of new objects
  m.onEvent('threat:intercepted', rocketDown);
  assert.equal(before[0].progress, 0); // a snapshot does not follow the tracker
  before[0].progress = 99;
  before[0].done = true;
  before.length = 0;
  assert.deepEqual(m.status(), [{ id: 'streak3', ...MISSIONS.streak3, progress: 1, done: false }]);
  assert.equal(m.missions.length, 1);
});

test('an id that is not a mission is a programming error: it throws an Error that names the id', () => {
  assert.throws(() => createMissionTracker(['alertGilo', 'bogus']), { name: 'Error', message: /bogus/ });
  for (const id of ['constructor', 'toString', '__proto__']) assert.throws(() => createMissionTracker([id]), { name: 'Error', message: new RegExp(id) }, id); // inherited names are no missions
  // Both tables must know the id: a row in MISSIONS without a handler, and a handler without a row.
  const extra = { MISSIONS: { ...MISSIONS, mystery: { text: '?', reward: 1, goal: 1 } }, TIMING };
  assert.throws(() => createMissionTracker(['mystery'], extra), { name: 'Error', message: /mystery/ });
  assert.throws(() => createMissionTracker(['callUav'], { MISSIONS: {}, TIMING }), { name: 'Error', message: /callUav/ });
});

test('the tables passed in decide the text, reward and goal of a mission and the clearJam window', () => {
  const config = {
    MISSIONS: { ...MISSIONS, streak3: { text: 'Two in a row', reward: 11, goal: 2 }, clearJam: { ...MISSIONS.clearJam, reward: 7 } },
    TIMING: { ...TIMING, clearJamWindow: 2 },
  };
  const m = createMissionTracker(['streak3', 'clearJam'], config);
  assert.deepEqual(m.missions, [
    { id: 'streak3', text: 'Two in a row', reward: 11, goal: 2, progress: 0, done: false },
    { id: 'clearJam', text: MISSIONS.clearJam.text, reward: 7, goal: 1, progress: 0, done: false },
  ]);
  assert.deepEqual(m.onEvent('hazard:jamming', { on: false, elapsed: 3 }), []); // inside the real window of 5, outside this one
  assert.deepEqual(m.onEvent('hazard:jamming', { on: false, elapsed: 2 }), [{ id: 'clearJam', reward: 7 }]);
  m.onEvent('threat:intercepted', rocketDown);
  assert.deepEqual(m.onEvent('threat:intercepted', rocketDown), [{ id: 'streak3', reward: 11 }]);
  assert.equal(m.status()[0].progress, 2);
});
