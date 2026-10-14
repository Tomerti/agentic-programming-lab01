import { test } from 'node:test'; import assert from 'node:assert/strict';
import * as CONFIG from '../js/config.js';
import { ECONOMY, ROUNDS, TIMING, TUTORIAL, WORLD, MISSIONS, DAYNIGHT } from '../js/config.js';
import { createBus } from '../js/core/events.js';
import { createRng } from '../js/core/rng.js';
import { createPersistence, emptyStats } from '../js/game/state.js';
import { createThreat, distanceToCity, threatPosition } from '../js/game/threats.js';
import { createSession, ratingFor, sortedDetectedThreats } from '../js/game/session.js';

// A scripted generator: the values given, in order, then 0.5 forever; `push` queues more, so a test decides the
// next hit roll (0 hits, 0.99 misses). With 0.5 for every draw, round 1 has three waves of three rockets at 0.5 s,
// 6.5 s and 12.5 s into the wave (the first aimed at Gilo, the others at Talpiot), each detected about 1.3 s after
// its spawn, and every shot hits (0.5 < hitChance).
const seq = (...values) => {
  const rng = () => (values.length ? values.shift() : 0.5);
  rng.push = (...more) => values.push(...more);
  return rng;
};
const memStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m }; };
// Records every event emitted on `bus` as [type, payload], in order.
const collect = bus => {
  const events = [];
  const emit = bus.emit;
  bus.emit = (type, payload) => { events.push([type, payload]); emit(type, payload); };
  return events;
};
const DT = 0.1;
const setup = ({ rng = seq(), config } = {}) => {
  const bus = createBus();
  const events = collect(bus);
  const persistence = createPersistence(memStorage());
  const session = createSession({ config, rng, persistence, bus });
  return { session, state: session.state, events, persistence, rng, bus };
};
const typesOf = events => events.map(([type]) => type);
const payloads = (events, type) => events.filter(([t]) => t === type).map(([, payload]) => payload);
// Steps update(DT) until done() holds and returns the number of steps; fails after `limit` steps.
const stepUntil = (session, done, limit = 5000) => {
  for (let steps = 0; steps <= limit; steps++) {
    if (done()) return steps;
    session.update(DT);
  }
  return assert.fail('the condition never held');
};
// Plays the round out with an engager that fires whenever it can, until the phase is no longer wave or breather.
const playOut = (session, limit = 20000) => {
  const { state } = session;
  for (let i = 0; i < limit && ['wave', 'breather'].includes(state.phase); i++) {
    if (state.phase === 'wave') session.engage();
    session.update(DT);
  }
};
// A hand-made inbound threat, `left` seconds from impact (just spawned when not given), on radar unless told
// otherwise. Ids below 217 never meet the session's own.
const craft = ({ id, type = 'rocket', zone = 'gilo', left, detected = true }) => {
  const threat = createThreat({ id, type, zone, rng: createRng(id) });
  if (left !== undefined) threat.t = 1 - left / threat.dur;
  threatPosition(threat, threat.t, threat.position);
  threat.detected = detected;
  return threat;
};
// The real tables with round 1 changed, for rules the real round 1 never shows.
const withRound1 = overrides => ({ ...CONFIG, ROUNDS: [{ ...ROUNDS[0], ...overrides }, ...ROUNDS.slice(1)] });
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);

test('startCampaign resets state, plans round 1 and starts wave 1', () => {
  const { session, state, events, persistence } = setup();
  Object.assign(state, { coins: 5, lives: 1, score: 99, upgrades: { radar: 3 }, log: ['OLD'] }); // an earlier game
  session.startCampaign();
  assert.deepEqual([state.mode, state.phase, state.round, state.wave, state.waveCount, state.clockHour], ['campaign', 'wave', 1, 1, 3, 10]);
  assert.deepEqual([state.coins, state.lives, state.score, state.upgrades, state.log], [1000, 5, 0, {}, []]);
  assert.deepEqual(state.missions.map(m => m.id), ['alertGilo']);
  assert.deepEqual(typesOf(events), ['round:start', 'wave:start']);
  assert.deepEqual(payloads(events, 'round:start'), [{ round: 1, mode: 'campaign', missions: state.missions, startHour: 10, phaseName: 'day', waveCount: 3 }]);
  assert.deepEqual(payloads(events, 'wave:start'), [{ wave: 1, count: 3, openOnly: false }]);
  assert.equal(persistence.loadCheckpoint().round, 1);
});

test('spawns appear at their scheduled times and are detected by range', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  const [first] = session.schedule.waves[0].spawns;
  stepUntil(session, () => state.threats.length > 0);
  assert.ok(state.waveElapsed >= first.at && state.waveElapsed - DT < first.at, 'on the first update at or past its time');
  const [threat] = state.threats;
  assert.deepEqual([threat.id, threat.type, threat.zone, threat.detected], [217, 'rocket', 'gilo', false]);
  assert.deepEqual(payloads(events, 'threat:spawned'), [{ threat }]);
  assert.ok(!state.log.some(line => line.includes('NEW TRACK')));
  stepUntil(session, () => {
    if (!threat.detected) assert.ok(distanceToCity(threat.position) > WORLD.detectionBase, 'hidden while out of range');
    return threat.detected;
  });
  assert.ok(distanceToCity(threat.position) <= WORLD.detectionBase);
  for (let i = 0; i < 20; i++) session.update(DT);
  assert.deepEqual(payloads(events, 'threat:detected'), [{ threat }]);
  assert.ok(state.log.includes('TRK-217 NEW TRACK'));
  // Radar range 3 (20 units) sees the spawn point at once.
  const far = setup();
  far.session.startCampaign();
  far.state.upgrades.radar = 3;
  stepUntil(far.session, () => far.state.threats.length > 0);
  assert.equal(far.state.threats[0].detected, true);
});

test('engage refuses in order: hold, jammed, cooldown, coins, ammo, noTarget', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  Object.assign(state, { hold: true, jammed: true, fireCooldown: 1, coins: ECONOMY.shotCost - 1, ammo: 0 });
  const refuses = reason => {
    const before = [state.coins, state.ammo, state.interceptors.length];
    assert.deepEqual(session.engage(), { ok: false, reason });
    assert.deepEqual([state.coins, state.ammo, state.interceptors.length], before);
    assert.deepEqual(events.at(-1), ['engage:refused', { reason }]);
  };
  refuses('hold');
  state.hold = false;
  refuses('jammed');
  state.jammed = false;
  refuses('cooldown');
  state.fireCooldown = 0;
  refuses('coins');
  state.coins = 1000;
  refuses('ammo');
  state.ammo = 20;
  refuses('noTarget'); // nothing on radar yet
  state.threats.push(craft({ id: 1 }));
  assert.deepEqual(session.engage(), { ok: true });
  state.fireCooldown = 0;
  refuses('alreadyEngaged'); // one interceptor in flight and one hit needed
  state.selectedId = null; // nothing selected: the most urgent track is the one in flight
  const selections = payloads(events, 'threat:selected').length;
  refuses('alreadyEngaged');
  assert.deepEqual([state.selectedId, payloads(events, 'threat:selected').length], [null, selections], 'a refusal selects nothing');
});

test('engage spends 80 and one interceptor and launches at the most urgent populated track', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  const open = craft({ id: 1, zone: 'open', left: 2 }); // the most urgent, but it lands on open ground
  const later = craft({ id: 2, zone: 'ramot', left: 8 });
  const urgent = craft({ id: 3, zone: 'talpiot', left: 5 });
  const hidden = craft({ id: 4, zone: 'gilo', left: 1, detected: false }); // not on radar
  state.threats.push(open, later, urgent, hidden);
  assert.equal(session.mostUrgent(), urgent);
  assert.deepEqual(session.engage(), { ok: true });
  const [it] = state.interceptors;
  assert.deepEqual([state.coins, state.ammo, state.selectedId, urgent.engagedBy], [920, 19, 3, it.id]);
  assert.deepEqual([it.id, it.targetId, it.hit, it.position], [1, 3, true, WORLD.launchPoint]);
  assert.equal(state.fireCooldown, ECONOMY.fireCooldown);
  assert.deepEqual([state.stats.round.shots, state.stats.round.shotsWasted, state.stats.total.shots], [1, 0, 1]);
  assert.equal(state.log[0], 'TRK-3 ENGAGED');
  assert.deepEqual(events.slice(-5), [
    ['threat:selected', { id: 3 }],
    ['interceptor:launched', { interceptor: it, target: urgent }],
    ['tutorial:show', { text: TUTORIAL[1].text }], // round 1's toast for the first launch
    ['coins:changed', { coins: 920, delta: -80, reason: 'shot' }],
    ['ammo:changed', { ammo: 19, capacity: 20 }],
  ]);
  // A shot at an open-area track is wasted, in the round, the total and the wave.
  state.fireCooldown = 0;
  assert.equal(session.selectTrack(1), true);
  assert.deepEqual(session.engage(), { ok: true });
  assert.deepEqual([state.stats.round.shotsWasted, state.stats.total.shotsWasted, state.stats.wave.shotsWasted], [1, 1, 1]);
});

test('a hit intercepts, pays 150, scores and clears the selection', () => {
  const { session, state, events, rng } = setup();
  session.startCampaign();
  stepUntil(session, () => state.threats[0]?.detected);
  const [threat] = state.threats;
  rng.push(0);
  assert.deepEqual(session.engage(), { ok: true });
  const [it] = state.interceptors;
  assert.equal(it.hit, true);
  assert.equal(state.selectedId, threat.id);
  stepUntil(session, () => threat.state !== 'inbound');
  assert.equal(threat.state, 'intercepted');
  assert.deepEqual(payloads(events, 'threat:intercepted'), [{ threat, interceptor: it, position: threat.position, reward: 150 }]);
  assert.deepEqual([state.coins, state.score, state.selectedId], [1000 - 80 + 150, 150, null]);
  assert.deepEqual([state.threats.length, state.interceptors.length], [0, 0]);
  assert.deepEqual([state.stats.round.intercepted, state.stats.round.coinsEarned], [1, 150]);
  assert.deepEqual(payloads(events, 'coins:changed').at(-1), { coins: 1070, delta: 150, reason: 'intercept' });
  assert.equal(state.log[0], `TRK-${threat.id} INTERCEPTED ✓`);
});

test('a miss allows re-engagement and resets the streak', () => {
  const { session, state, events, rng } = setup();
  session.startCampaign();
  session.startRound(3); // missions streak3 and holdWave
  const streak = () => state.missions.find(m => m.id === 'streak3').progress;
  stepUntil(session, () => state.threats[0]?.detected);
  rng.push(0);
  session.engage();
  stepUntil(session, () => state.stats.round.intercepted === 1);
  assert.equal(streak(), 1);
  stepUntil(session, () => state.threats[0]?.detected); // the next threat
  const [threat] = state.threats;
  rng.push(0.99);
  assert.deepEqual(session.engage(), { ok: true });
  const [it] = state.interceptors;
  assert.equal(it.hit, false);
  stepUntil(session, () => it.state !== 'flying');
  assert.equal(it.state, 'missed');
  assert.deepEqual(payloads(events, 'interceptor:missed'), [{ interceptor: it, position: it.position }]);
  assert.deepEqual([threat.state, threat.engagedBy, threat.hitsRemaining, state.interceptors.length], ['inbound', null, 1, 0]);
  assert.deepEqual([state.stats.round.missed, state.stats.round.intercepted], [1, 1]);
  assert.equal(state.log[0], `TRK-${threat.id} MISS`);
  assert.equal(streak(), 0);
  assert.deepEqual(payloads(events, 'mission:progress'), [{ id: 'streak3', progress: 1, goal: 3 }, { id: 'streak3', progress: 0, goal: 3 }]);
  stepUntil(session, () => state.fireCooldown === 0);
  rng.push(0);
  assert.deepEqual(session.engage(), { ok: true });
  assert.equal(state.interceptors[0].targetId, threat.id);
});

test('cruise needs two hits', () => {
  const { session, state, events, rng } = setup();
  session.startCampaign();
  const cruise = craft({ id: 1, type: 'cruise' });
  state.threats.push(cruise);
  assert.equal(session.selectTrack(1), true);
  rng.push(0);
  session.engage();
  for (let i = 0; i < 3; i++) session.update(DT);
  state.fireCooldown = 0;
  rng.push(0);
  assert.deepEqual(session.engage(), { ok: true }, 'two hits needed: a second interceptor may follow the first');
  const [first, second] = state.interceptors;
  assert.equal(cruise.engagedBy, second.id);
  stepUntil(session, () => first.state !== 'flying');
  assert.equal(first.state, 'hit');
  assert.deepEqual(payloads(events, 'threat:damaged'), [{ threat: cruise, interceptor: first, position: cruise.position }]);
  assert.deepEqual([cruise.state, cruise.hitsRemaining, cruise.engagedBy], ['inbound', 1, second.id], 'the second is still on its way');
  state.fireCooldown = 0;
  assert.deepEqual(session.engage(), { ok: false, reason: 'alreadyEngaged' }, 'one hit left and an interceptor on the way');
  stepUntil(session, () => cruise.state !== 'inbound');
  assert.equal(cruise.state, 'intercepted');
  assert.deepEqual(payloads(events, 'threat:intercepted').map(p => [p.threat, p.interceptor, p.reward]), [[cruise, second, 400]]);
  assert.equal(state.coins, 1000 - 2 * 80 + 400);
  // One interceptor at a time works too: a hit frees the track for the next shot.
  const solo = setup();
  solo.session.startCampaign();
  const lone = craft({ id: 2, type: 'cruise' });
  solo.state.threats.push(lone);
  solo.session.selectTrack(2);
  solo.session.engage();
  stepUntil(solo.session, () => lone.hitsRemaining === 1);
  assert.equal(lone.engagedBy, null);
  stepUntil(solo.session, () => solo.state.fireCooldown === 0);
  assert.deepEqual(solo.session.engage(), { ok: true });
  stepUntil(solo.session, () => lone.state !== 'inbound');
  assert.deepEqual([lone.state, solo.state.coins], ['intercepted', 1000 - 2 * 80 + 400]);
});

test('populated impact costs a life and open-area does not; decoys burn up', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  const hit = craft({ id: 1, zone: 'gilo', left: DT / 2 });
  const open = craft({ id: 2, zone: 'open', left: DT / 2 });
  const decoy = craft({ id: 3, type: 'decoy', zone: 'talpiot', left: DT / 2 });
  state.threats.push(hit, open, decoy);
  session.update(DT);
  assert.equal(state.lives, 4);
  assert.deepEqual([state.stats.round.impactsPopulated, state.stats.round.impactsOpen, state.stats.total.impactsPopulated], [1, 1, 1]);
  assert.deepEqual(payloads(events, 'threat:impact'), [
    { threat: hit, zone: 'gilo', position: hit.p2, populated: true, decoy: false },
    { threat: open, zone: 'open', position: open.p2, populated: false, decoy: false },
    { threat: decoy, zone: 'talpiot', position: decoy.p2, populated: false, decoy: true },
  ]);
  assert.deepEqual(payloads(events, 'life:lost'), [{ lives: 4 }]);
  assert.ok(typesOf(events).indexOf('life:lost') === typesOf(events).indexOf('threat:impact') + 1, 'right after its impact');
  assert.deepEqual(state.log.slice(0, 3), ['TRK-3 DECOY BURNED UP', 'IMPACT · OPEN', 'IMPACT · GILO']);
  assert.deepEqual(state.threats, []);
  assert.equal(state.phase, 'wave');
});

test('zero lives ends the game', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  state.lives = 1;
  state.threats.push(craft({ id: 1, zone: 'gilo', left: DT / 2 }), craft({ id: 2, zone: 'ramot', left: DT / 2 }));
  session.update(DT);
  assert.deepEqual([state.phase, state.lives, state.stats.round.impactsPopulated], ['gameover', 0, 1], 'the second impact is not processed');
  const [over] = payloads(events, 'game:over');
  assert.equal(payloads(events, 'game:over').length, 1);
  assert.deepEqual([over.summary.round, over.summary.lives, over.summary.stats.impactsPopulated], [1, 0, 1]);
  const hour = state.clockHour;
  const count = events.length;
  for (let i = 0; i < 50; i++) session.update(DT);
  assert.deepEqual([state.clockHour, events.length, state.threats[1].t], [hour, count, 1 - (DT / 2) / state.threats[1].dur]);
});

test('wave ends when all spawns resolved; breather lasts 5 s; round ends after last wave with +1 life and stipend', () => {
  const { session, state, events, bus } = setup();
  session.startCampaign();
  state.lives = 3;
  const atWaveEnd = [];
  bus.on('wave:end', () => atWaveEnd.push([state.stats.round.spawned, state.threats.length, state.interceptors.length]));
  const phases = [];
  for (let i = 0; i < 5000 && state.phase !== 'summary'; i++) {
    if (state.phase === 'wave') session.engage();
    phases.push(state.phase);
    session.update(DT);
  }
  assert.equal(state.phase, 'summary');
  assert.deepEqual(atWaveEnd, [[3, 0, 0], [6, 0, 0], [9, 0, 0]], 'every spawn fired, nothing in the air');
  assert.deepEqual(payloads(events, 'wave:end'), [1, 2, 3].map(wave => ({ wave, openOnly: false, shotsWasted: 0, holdAllWave: false })));
  assert.deepEqual(payloads(events, 'wave:start').map(p => p.wave), [1, 2, 3]);
  const breathers = phases.join(' ').split(/\s*wave\s*/).filter(Boolean).map(run => run.split(' ').length * DT);
  assert.equal(breathers.length, 3, 'one breather after each wave, the last one before the round ends');
  for (const seconds of breathers) near(seconds, TIMING.breather, DT + 1e-9);
  const stipend = ECONOMY.stipendBase + ECONOMY.stipendPerRound * 1;
  assert.deepEqual(payloads(events, 'life:gained'), [{ lives: 4 }]);
  assert.deepEqual(payloads(events, 'coins:changed').at(-1), { coins: state.coins, delta: stipend, reason: 'stipend' });
  assert.equal(stipend, 350);
  assert.deepEqual([state.lives, state.coins, state.score], [4, 1000 - 9 * 80 + 9 * 150 + 350, 9 * 150], 'the stipend does not score');
  const [{ summary }] = payloads(events, 'round:end');
  assert.deepEqual(summary, {
    round: 1, mode: 'campaign', stats: state.stats.round, total: state.stats.total, impactsPopulated: 0,
    coinsEarned: 9 * 150 + 350, missions: state.missions, lives: 4, livesReplenished: 1, score: 9 * 150,
  });
  assert.equal(summary.stats.intercepted, 9);
  assert.deepEqual(typesOf(events).slice(-3), ['life:gained', 'coins:changed', 'round:end']);
});

test('summary → shop → next round saves a checkpoint', () => {
  const { session, state, events, persistence } = setup();
  session.startCampaign();
  playOut(session);
  assert.equal(state.phase, 'summary');
  assert.deepEqual([state.lives, payloads(events, 'round:end')[0].summary.livesReplenished], [5, 0], 'no life above maxLives');
  assert.deepEqual(payloads(events, 'life:gained'), []);
  assert.deepEqual(session.buy('radar'), { ok: false, reason: 'phase' }, 'the shop is not open yet');
  assert.equal(session.leaveShop(), false);
  assert.equal(session.continueFromSummary(), true);
  assert.equal(state.phase, 'shop');
  assert.deepEqual(events.at(-1), ['shop:open', { round: 1 }]);
  const coins = state.coins;
  assert.deepEqual(session.buy('radar'), { ok: true, level: 1 });
  assert.deepEqual(events.slice(-2), [['shop:purchased', { itemId: 'radar', level: 1 }], ['coins:changed', { coins: coins - 350, delta: -350, reason: 'shop' }]]);
  assert.equal(session.continueFromSummary(), false);
  state.hold = true; // left on in the last breather
  assert.equal(session.leaveShop(), true);
  assert.deepEqual([state.round, state.wave, state.phase, state.hold], [2, 1, 'wave', false]);
  assert.deepEqual(state.stats.round, emptyStats());
  assert.equal(state.stats.total.intercepted, 9, 'round 1 stays in the totals');
  const cp = persistence.loadCheckpoint();
  assert.deepEqual([cp.round, cp.upgrades.radar, cp.coins, cp.lives, cp.mode], [2, 1, coins - 350, state.lives, 'campaign']);
});

test('engage and alert are ignored outside the wave phase', () => {
  const quiet = (session, state, events) => {
    const before = [state.coins, state.ammo, events.length, state.phase];
    assert.deepEqual(session.engage(), { ok: false, reason: 'phase' });
    assert.deepEqual(session.soundAlert(), { ok: false, reason: 'phase' });
    assert.deepEqual([state.coins, state.ammo, events.length, state.phase], before);
  };
  const title = setup();
  quiet(title.session, title.state, title.events); // no round was ever started
  for (const phase of ['summary', 'shop', 'breather', 'gameover', 'victory']) {
    const { session, state, events } = setup();
    session.startCampaign();
    state.threats.push(craft({ id: 1 }));
    state.phase = phase;
    quiet(session, state, events);
  }
  const { session, state, events } = setup();
  session.startCampaign();
  state.threats.push(craft({ id: 1 }));
  assert.equal(session.pause(), true);
  quiet(session, state, events);
});

test('update clamps dt to 0.1', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  stepUntil(session, () => state.threats.length > 0);
  const [threat] = state.threats;
  const [t, hour, elapsed] = [threat.t, state.clockHour, state.waveElapsed];
  session.update(60);
  near(state.clockHour - hour, 0.004);
  near(threat.t - t, 0.1 / threat.dur);
  near(state.waveElapsed - elapsed, 0.1);
  for (const dt of [0, -1, NaN, undefined]) session.update(dt);
  near(state.waveElapsed - elapsed, 0.1);
  // The clock ticks when the hour changes.
  state.clockHour = 10.999;
  session.update(DT);
  assert.deepEqual(payloads(events, 'clock:tick'), [{ hour: state.clockHour }]);
  near(state.clockHour, 10.999 + DT * DAYNIGHT.hoursPerSecond);
});

test('alert pays 40 once per populated track; auto-alert does it on detection', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  stepUntil(session, () => state.threats[0]?.detected); // TRK-217, aimed at Gilo
  assert.deepEqual(session.soundAlert(), { ok: true });
  assert.equal(state.threats[0].alerted, true);
  assert.deepEqual(payloads(events, 'alert:sounded'), [{ zone: 'gilo', zoneName: 'Gilo', inTime: true, threatId: 217 }]);
  assert.deepEqual(payloads(events, 'mission:complete'), [{ id: 'alertGilo', reward: MISSIONS.alertGilo.reward }]);
  assert.deepEqual([state.coins, state.score, state.stats.round.alerts, state.stats.round.missionsDone], [1000 + 40 + 150, 190, 1, 1]);
  assert.deepEqual(payloads(events, 'coins:changed').map(p => p.reason).sort(), ['alert', 'mission']);
  assert.ok(state.log.includes('ALERT · GILO'));
  assert.deepEqual(session.soundAlert(), { ok: false, reason: 'noTarget' }, 'once per track');
  assert.deepEqual(events.at(-1), ['alert:sounded', { inTime: false }]);
  assert.equal(state.coins, 1190);
  state.threats.push(craft({ id: 1, zone: 'open' }));
  session.selectTrack(1);
  assert.deepEqual(session.soundAlert(), { ok: false, reason: 'noTarget' }, 'an open-area track has no one to warn');
  // With the Auto-alert system each populated track is alerted as it is detected.
  const auto = setup();
  auto.session.startCampaign();
  auto.state.upgrades.autoAlert = 1;
  stepUntil(auto.session, () => auto.state.threats[0]?.detected);
  assert.deepEqual(payloads(auto.events, 'alert:sounded'), [{ zone: 'gilo', zoneName: 'Gilo', inTime: true, threatId: 217 }]);
  assert.ok(typesOf(auto.events).indexOf('threat:detected') < typesOf(auto.events).indexOf('alert:sounded'));
  assert.equal(auto.state.coins, 1000 + 40 + 150);
});

test('jamming hides detection, refuses engage, and resetRadar clears it with elapsed', () => {
  // Round 1 as one wave with one jamming (at 6.5 s, as the second rocket spawns) and the clearJam mission.
  const { session, state, events } = setup({ config: withRound1({ waves: 1, jamming: [1, 1], missions: ['clearJam'] }) });
  session.startCampaign();
  assert.deepEqual(session.schedule.hazards, [{ wave: 1, at: 6.5, type: 'jamming' }]);
  stepUntil(session, () => state.jammed);
  assert.deepEqual(payloads(events, 'hazard:jamming'), [{ on: true }]);
  assert.ok(state.log.includes('RADAR JAMMED'));
  const second = state.threats.find(t => t.id === 218);
  stepUntil(session, () => distanceToCity(second.position) <= WORLD.detectionBase);
  for (let i = 0; i < 5; i++) session.update(DT);
  assert.equal(second.detected, false, 'in range but hidden');
  assert.deepEqual(session.engage(), { ok: false, reason: 'jammed' });
  const elapsed = state.jamElapsed;
  assert.equal(session.resetRadar(), true);
  assert.deepEqual(payloads(events, 'hazard:jamming').at(-1), { on: false, elapsed });
  assert.ok(elapsed > 0 && elapsed <= TIMING.clearJamWindow);
  assert.equal(state.log[0], 'RADAR RESET');
  assert.deepEqual(payloads(events, 'mission:complete'), [{ id: 'clearJam', reward: MISSIONS.clearJam.reward }]);
  assert.equal(session.resetRadar(), false, 'nothing to reset');
  session.update(DT);
  assert.equal(second.detected, true);
  // Left alone, a jamming clears after TIMING.jammingDuration ...
  Object.assign(state, { jammed: true, jamElapsed: 0 });
  stepUntil(session, () => !state.jammed);
  const [last] = payloads(events, 'hazard:jamming').slice(-1);
  assert.equal(last.on, false);
  near(last.elapsed, TIMING.jammingDuration, DT + 1e-9);
  // ... and its time keeps running in a breather, so it does not carry into the next wave.
  Object.assign(state, { phase: 'breather', breatherLeft: 2 * TIMING.jammingDuration, jammed: true, jamElapsed: 0 });
  stepUntil(session, () => !state.jammed);
  assert.equal(state.phase, 'breather');
  near(payloads(events, 'hazard:jamming').at(-1).elapsed, TIMING.jammingDuration, DT + 1e-9);
});

test('round 10 victory computes a rating and records endlessStart; startEndless uses it', () => {
  const { session, state, events, persistence } = setup();
  session.startCampaign();
  Object.assign(state, { coins: 50000, ammo: 200, ammoCapacity: 200, lives: 3, maxLives: 7, upgrades: { seekers: 2 } });
  state.stats.total = { ...emptyStats(), impactsPopulated: 5 }; // five earlier populated impacts: a B at best
  session.startRound(10);
  playOut(session);
  assert.equal(state.phase, 'victory');
  assert.equal(state.stats.round.impactsPopulated, 0);
  const [victory] = payloads(events, 'campaign:victory');
  assert.equal(victory.rating, 'B');
  assert.equal(victory.summary.round, 10);
  assert.equal(payloads(events, 'round:end').length, 1);
  const records = persistence.loadRecords();
  assert.deepEqual([records.campaignVictory, records.bestRating], [true, 'B']);
  assert.deepEqual([records.endlessStart.coins, records.endlessStart.ammo, records.endlessStart.upgrades], [state.coins, state.ammo, { seekers: 2 }]);
  assert.equal(session.continueFromSummary(), false, 'no shop after the finale');
  assert.equal(state.lives, 4);
  const [coins, ammo] = [state.coins, state.ammo];
  assert.ok(ammo < 200, 'the finale used interceptors');
  session.startEndless();
  assert.deepEqual([state.mode, state.round, state.phase, state.coins, state.upgrades], ['endless', ROUNDS.length + 1, 'wave', coins, { seekers: 2 }]);
  assert.deepEqual([state.ammo, state.ammoCapacity], [ammo, 200], 'the launcher as the campaign left it');
  assert.deepEqual([state.maxLives, state.lives], [7, 7], 'every life, up to the shelters bought');
  assert.deepEqual([state.score, state.stats.total], [0, emptyStats()]);
  assert.equal(ratingFor({ impactsPopulated: 0, shotsWasted: 0 }), 'S');
  assert.equal(ratingFor({ impactsPopulated: 0, shotsWasted: 4 }), 'A');
  assert.equal(ratingFor({ impactsPopulated: 3, shotsWasted: 20 }), 'A');
  assert.equal(ratingFor({ impactsPopulated: 5 }), 'B');
  assert.equal(ratingFor({ impactsPopulated: 9 }), 'C');
});

// An auto-player for the balance check: it fires at whatever engage() picks and clears jamming at once; between
// rounds it buys a level of Extra launcher tubes when it can, restocks and moves on. With `act` false it does
// nothing but move on. Returns the state it stopped in.
const autoPlay = (seed, act) => {
  const session = createSession({ rng: createRng(seed), persistence: createPersistence(memStorage()), bus: createBus() });
  const { state } = session;
  session.startCampaign();
  for (let tick = 0; tick < 200000 && !['victory', 'gameover'].includes(state.phase); tick++) {
    if (act && state.jammed) session.resetRadar();
    if (act && state.phase === 'wave') session.engage();
    if (state.phase === 'summary') session.continueFromSummary();
    if (state.phase === 'shop') {
      if (act) session.buy('capacity'); // refused once maxed or unaffordable
      session.restock();
      session.leaveShop();
    }
    session.update(DT);
  }
  return state;
};

test('balance: an auto-player that engages every populated track wins the campaign, and doing nothing loses', () => {
  const player = autoPlay(1, true);
  assert.equal(player.phase, 'victory', `stopped in round ${player.round} with ${player.lives} lives and ${player.coins} coins`);
  assert.ok(player.lives > 0);
  const idle = autoPlay(1, false);
  assert.equal(idle.phase, 'gameover');
  assert.ok(idle.round < 4);
});

// Behaviour the brief's tests above leave open.

test('round-end missions are paid before the summary is built, and the summary shows them done', () => {
  const { session, state, events } = setup({ config: withRound1({ missions: ['perfectRound'] }) });
  session.startCampaign();
  const tracker = session.missions;
  const { onEvent } = tracker;
  let roundEnds = 0;
  tracker.onEvent = (type, payload) => { if (type === 'round:end') roundEnds += 1; return onEvent(type, payload); };
  playOut(session);
  assert.equal(roundEnds, 1, 'the missions judge the round once');
  const types = typesOf(events);
  assert.ok(types.indexOf('mission:complete') < types.indexOf('round:end'));
  assert.deepEqual(payloads(events, 'mission:complete'), [{ id: 'perfectRound', reward: 400 }]);
  const [{ summary }] = payloads(events, 'round:end');
  assert.deepEqual(summary.missions.map(m => [m.id, m.done]), [['perfectRound', true]]);
  assert.equal(summary.coinsEarned, 9 * 150 + 350 + 400);
  assert.deepEqual([summary.impactsPopulated, summary.stats.missionsDone, state.score], [0, 1, 9 * 150 + 400]);
});

test('a hazard strikes in its own wave, at its own time', () => {
  const { session, state } = setup({ config: withRound1({ jamming: [1, 1] }) });
  session.startCampaign();
  const [hazard] = session.schedule.hazards;
  assert.deepEqual(hazard, { wave: 2, at: 6.5, type: 'jamming' });
  for (let i = 0; i < 5000 && !state.jammed && state.phase !== 'summary'; i++) {
    if (state.phase === 'wave') session.engage();
    session.update(DT);
  }
  assert.equal(state.wave, 2);
  assert.ok(state.waveElapsed >= hazard.at && state.waveElapsed - DT < hazard.at);
});

test('the open-area wave: its events say so, and HOLD FIRE kept on through it completes holdWave', () => {
  const { session, state, events: all } = setup();
  session.startCampaign();
  const since = all.length; // round 1's events come before
  session.startRound(3); // streak3 and holdWave; with 0.5 draws the open-area wave is wave 3
  const openWave = session.schedule.waves.find(w => w.openOnly).index;
  assert.equal(openWave, 3);
  for (let i = 0; i < 20000 && ['wave', 'breather'].includes(state.phase); i++) {
    const nextWave = state.phase === 'breather' ? state.wave + 1 : state.wave;
    if (state.hold !== (nextWave === openWave)) session.toggleHold(); // on from the breather before it to the one after
    if (state.phase === 'wave') session.engage();
    session.update(DT);
  }
  assert.equal(state.phase, 'summary');
  const events = all.slice(since);
  const waves = [1, 2, 3, 4];
  assert.deepEqual(payloads(events, 'wave:start').map(p => p.openOnly), waves.map(w => w === openWave));
  assert.deepEqual(payloads(events, 'wave:end').map(p => [p.wave, p.openOnly, p.holdAllWave]), waves.map(w => [w, w === openWave, w === openWave]));
  assert.ok(payloads(events, 'mission:complete').some(p => p.id === 'holdWave'));
});

test('tutorial toasts show once each, in their own round, again in a new campaign and never in Endless', () => {
  const { session, state, events } = setup();
  const shown = () => payloads(events, 'tutorial:show').map(p => p.text);
  const round1 = TUTORIAL.filter(entry => entry.round === 1).map(entry => entry.text);
  const round2 = TUTORIAL.filter(entry => entry.round === 2).map(entry => entry.text);
  session.startCampaign();
  playOut(session);
  assert.deepEqual(shown(), round1);
  session.continueFromSummary();
  session.leaveShop();
  stepUntil(session, () => state.threats[0]?.detected);
  assert.deepEqual(shown(), [...round1, ...round2]);
  session.startCampaign();
  stepUntil(session, () => state.threats[0]?.detected);
  assert.deepEqual(shown(), [...round1, ...round2, round1[0]]);
  session.startEndless();
  playOut(session);
  assert.equal(shown().length, round1.length + round2.length + 1);
});

test('selection: only detected inbound tracks; cycleSelection walks them by time to impact', () => {
  const { session, state } = setup();
  session.startCampaign();
  const a = craft({ id: 1, left: 6 });
  const b = craft({ id: 2, zone: 'open', left: 3 });
  const c = craft({ id: 3, left: 9 });
  const hidden = craft({ id: 4, left: 1, detected: false });
  state.threats.push(a, b, c, hidden);
  assert.deepEqual(sortedDetectedThreats(state), [b, a, c]);
  assert.equal(session.selectTrack(4), false);
  assert.equal(session.selectTrack(99), false);
  assert.equal(state.selectedId, null);
  assert.deepEqual([1, 1, 1, 1].map(() => session.cycleSelection()), [2, 1, 3, 2]);
  assert.deepEqual([-1, -1].map(dir => session.cycleSelection(dir)), [3, 1]);
  state.selectedId = null;
  assert.equal(session.cycleSelection(-1), 3, 'backwards from nothing starts at the last');
  session.pause();
  assert.deepEqual([session.selectTrack(1), session.cycleSelection(), state.selectedId], [false, null, 3], 'not while paused');
});

test('decoys count as populated for the most urgent track until the Signature analyzer reveals them', () => {
  const { session, state } = setup();
  session.startCampaign();
  const decoy = craft({ id: 1, type: 'decoy', zone: 'gilo', left: 2 });
  const rocket = craft({ id: 2, zone: 'ramot', left: 5 });
  state.threats.push(decoy, rocket);
  assert.equal(session.revealsDecoys(), false);
  assert.equal(session.mostUrgent(), decoy);
  state.upgrades.analyzer = 1;
  assert.equal(session.revealsDecoys(), true);
  assert.equal(session.mostUrgent(), rocket);
  session.selectTrack(1);
  session.engage();
  assert.deepEqual([state.stats.round.shotsWasted, state.stats.wave.shotsWasted], [1, 1], 'a shot at a decoy is wasted');
});

test('ALERT treats an unrevealed decoy like a rocket: it pays 40 and sounds in time', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  const decoy = craft({ id: 1, type: 'decoy', zone: 'ramot', left: 4 });
  state.threats.push(decoy, craft({ id: 2, zone: 'talpiot', left: 6 }));
  assert.deepEqual(session.soundAlert(), { ok: true }, 'nothing selected: the most urgent track, the decoy');
  assert.deepEqual(events.slice(-2), [
    ['alert:sounded', { zone: 'ramot', zoneName: 'Ramot', inTime: true, threatId: 1 }],
    ['coins:changed', { coins: 1040, delta: 40, reason: 'alert' }],
  ]);
  assert.deepEqual([decoy.alerted, state.stats.round.alerts, state.score, state.log[0]], [true, 1, 40, 'ALERT · RAMOT']);
});

test('ALERT refuses a decoy that the Signature analyzer reveals', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  state.upgrades.analyzer = 1;
  const decoy = craft({ id: 1, type: 'decoy', zone: 'ramot', left: 4 });
  state.threats.push(decoy);
  assert.equal(session.selectTrack(1), true);
  assert.deepEqual(session.soundAlert(), { ok: false, reason: 'noTarget' });
  assert.deepEqual(events.at(-1), ['alert:sounded', { inTime: false }]);
  assert.deepEqual([decoy.alerted, state.coins, state.stats.round.alerts], [false, 1000, 0]);
});

test('Auto-alert alerts an unrevealed decoy on detection, and leaves a revealed one alone', () => {
  for (const analyzer of [0, 1]) {
    const { session, state, events } = setup();
    session.startCampaign();
    Object.assign(state.upgrades, { autoAlert: 1, analyzer });
    const decoy = craft({ id: 1, type: 'decoy', zone: 'ramot', detected: false }); // just launched, out of range
    state.threats.push(decoy);
    stepUntil(session, () => decoy.detected);
    const alerts = payloads(events, 'alert:sounded').filter(p => p.threatId === 1);
    assert.deepEqual(alerts, analyzer ? [] : [{ zone: 'ramot', zoneName: 'Ramot', inTime: true, threatId: 1 }], `analyzer ${analyzer}`);
    assert.equal(decoy.alerted, !analyzer);
  }
});

test('callHQ names the first open mission and reports a UAV on radar', () => {
  const { session, state, events } = setup();
  assert.equal(session.callHQ(), null, 'no line outside play');
  session.startCampaign();
  session.startRound(4); // callUav
  assert.equal(session.callHQ(), `HQ: ${MISSIONS.callUav.text}`);
  assert.deepEqual(payloads(events, 'hq:line'), [{ text: `HQ: ${MISSIONS.callUav.text}`, uavOnRadar: false }]);
  state.threats.push(craft({ id: 1, type: 'uav', detected: false }));
  session.callHQ();
  assert.equal(payloads(events, 'hq:line').at(-1).uavOnRadar, false, 'not on radar yet');
  state.threats[0].detected = true;
  session.callHQ();
  assert.equal(payloads(events, 'hq:line').at(-1).uavOnRadar, true);
  assert.deepEqual(payloads(events, 'mission:complete'), [{ id: 'callUav', reward: 150 }]);
  assert.equal(session.callHQ(), 'HQ: "All quiet, chief. Keep the city covered."');
});

test('pause freezes the game, resume returns to the phase it left; HOLD and RESET work only in play', () => {
  const { session, state, events } = setup();
  assert.equal(session.pause(), false);
  assert.equal(session.toggleHold(), false, 'no HOLD on the title screen');
  session.startCampaign();
  assert.equal(session.toggleHold(), true);
  assert.deepEqual(events.at(-1), ['hold:changed', { on: true }]);
  assert.equal(state.stats.wave.holdAllWave, false, 'off when the wave began');
  assert.equal(session.toggleHold(), false);
  assert.equal(session.pause(), true);
  assert.equal(state.phase, 'paused');
  state.jammed = true;
  const [hour, count] = [state.clockHour, events.length];
  session.update(DT);
  assert.equal(session.toggleHold(), false);
  assert.equal(session.resetRadar(), false);
  assert.deepEqual([state.clockHour, events.length, state.hold, state.jammed], [hour, count, false, true]);
  state.jammed = false;
  assert.equal(session.resume(), true);
  assert.equal(state.phase, 'wave');
  assert.equal(session.resume(), false);
  state.phase = 'breather';
  session.toggleHold();
  session.pause();
  session.resume();
  assert.equal(state.phase, 'breather');
  state.breatherLeft = DT / 2;
  session.update(DT);
  assert.deepEqual([state.phase, state.wave, state.stats.wave.holdAllWave], ['wave', 2, true], 'HOLD set in the breather covers the next wave');
  session.toggleHold();
  assert.equal(state.stats.wave.holdAllWave, false, 'released during the wave');
});

test('a new round or game switches HOLD FIRE and jamming off and says so, without completing clearJam', () => {
  // Round 2 here carries clearJam: a jamming switched off at a round's start or end would complete it if it counted.
  const config = { ...CONFIG, ROUNDS: [ROUNDS[0], { ...ROUNDS[1], missions: ['clearJam'] }, ...ROUNDS.slice(2)] };
  const { session, state, events } = setup({ config });
  const switches = from => events.slice(from).filter(([type]) => type === 'hold:changed' || type === 'hazard:jamming');
  const OFF = [['hold:changed', { on: false }], ['hazard:jamming', { on: false }]];
  session.startCampaign();
  playOut(session);
  session.continueFromSummary();
  Object.assign(state, { hold: true, jammed: true, jamElapsed: 1 }); // HOLD left on in the last breather, a jamming not over
  let from = events.length;
  session.leaveShop();
  assert.deepEqual(switches(from), OFF);
  assert.ok(typesOf(events.slice(from)).indexOf('hazard:jamming') < typesOf(events.slice(from)).indexOf('round:start'));
  assert.deepEqual([state.round, state.hold, state.jammed], [2, false, false]);
  session.toggleHold(); // in round 2, with clearJam
  state.jammed = true;
  from = events.length;
  session.startCampaign();
  assert.deepEqual(switches(from), OFF);
  assert.deepEqual(payloads(events, 'mission:complete'), [], 'no clearJam for a jamming nobody cleared');
  from = events.length;
  session.startCampaign();
  assert.deepEqual(switches(from), [], 'nothing to say when both were off');
});

test('retryRound restores the round-start checkpoint; an Endless or missing checkpoint starts a fresh campaign', () => {
  const { session, state, persistence } = setup();
  session.retryRound();
  assert.deepEqual([state.round, state.coins], [1, 1000], 'no checkpoint yet');
  playOut(session);
  session.continueFromSummary();
  session.buy('radar');
  session.leaveShop();
  const cp = persistence.loadCheckpoint();
  Object.assign(state, { coins: 3, lives: 1, ammo: 0, upgrades: {} });
  session.retryRound();
  assert.deepEqual([state.round, state.wave, state.phase, state.coins, state.lives, state.ammo, state.upgrades], [2, 1, 'wave', cp.coins, cp.lives, cp.ammo, { radar: 1 }]);
  persistence.saveCheckpoint({ ...state, mode: 'endless', round: 14 });
  session.startCampaign({ fromCheckpoint: true });
  assert.deepEqual([state.mode, state.round, state.coins, state.upgrades], ['campaign', 1, 1000, {}]);
});

test('Endless scores time survived, keeps no checkpoint, and game over records the best round and score', () => {
  const { session, state, persistence } = setup();
  session.startEndless();
  assert.deepEqual([state.mode, state.round, state.coins, state.lives], ['endless', 11, 1000, 5], 'no campaign victory yet: a new game');
  assert.equal(persistence.loadCheckpoint(), null);
  const half = 1 / (2 * ECONOMY.endlessScorePerSecond); // half a point's worth of seconds
  for (let i = 0; i < 3; i++) session.update(half);
  assert.equal(state.score, 1, 'whole points only: 1.5 earned so far');
  session.update(half);
  assert.equal(state.score, 2);
  for (let i = 0; i < 20; i++) session.update(DT);
  assert.equal(state.score, 2 + 20 * DT * ECONOMY.endlessScorePerSecond);
  state.lives = 1;
  state.threats.push(craft({ id: 1, left: DT / 2 }));
  session.update(DT);
  assert.equal(state.phase, 'gameover');
  const best = state.score;
  const records = () => { const r = persistence.loadRecords(); return [r.bestEndlessRound, r.bestEndlessScore]; };
  assert.deepEqual(records(), [11, best]);
  session.startEndless();
  state.lives = 1;
  state.threats.push(craft({ id: 2, left: DT / 2 }));
  session.update(DT);
  assert.equal(state.phase, 'gameover');
  assert.ok(state.score < best);
  assert.deepEqual(records(), [11, best], 'the best is kept');
});

test('shop purchases report what they changed; the log keeps the six newest lines', () => {
  const { session, state, events } = setup();
  session.startCampaign();
  playOut(session);
  session.continueFromSummary();
  Object.assign(state, { lives: 3, coins: 5000 });
  const ammo = state.ammo;
  assert.deepEqual(session.restock(), { ok: true, bought: 20 - ammo });
  assert.deepEqual(events.slice(-3).map(([type, p]) => [type, p.itemId ?? p.reason ?? p.ammo]), [['shop:purchased', 'restock'], ['coins:changed', 'shop'], ['ammo:changed', 20]]);
  assert.deepEqual(session.restock(), { ok: false, reason: 'full' });
  assert.deepEqual(session.buy('life'), { ok: true, level: 1 });
  assert.deepEqual(events.at(-1), ['life:gained', { lives: 4 }]);
  assert.deepEqual(session.buy('capacity'), { ok: true, level: 1 });
  assert.deepEqual(events.at(-1), ['ammo:changed', { ammo: 20, capacity: 30 }]);
  assert.equal(state.log.length, 6);
  assert.equal(state.log[0], 'TRK-225 INTERCEPTED ✓', 'newest first');
});
