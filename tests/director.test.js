import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createRng } from '../js/core/rng.js';
import { ROUNDS, ENDLESS, THREATS, WORLD, MISSIONS } from '../js/config.js';
import { startHourFor } from '../js/game/daynight.js';
import { roundSpec, planRound } from '../js/game/director.js';
const populatedIn = w => w.spawns.filter(s => s.zone !== 'open' && s.type !== 'decoy');
test('roundSpec returns campaign rows and generates endless rows', () => { assert.equal(roundSpec(1), ROUNDS[0]); const e = roundSpec(14); assert.equal(e.waves, 5); assert.deepEqual(e.perWave, [9, 9]); assert.equal(e.interval, 2); assert.equal(e.salvoSize, 5); assert.deepEqual(e.cruiseWaves, [1, 2, 3, 4, 5]); assert.deepEqual(e.missions, ['cruiseKill']); assert.equal(roundSpec(11).interval, 2.75); });
test('planRound is deterministic for a seed', () => { assert.deepEqual(planRound(3, createRng(9)), planRound(3, createRng(9))); });
test('round 1: 3 waves of 2-3 rockets, all populated, first spawn in Gilo', () => { const p = planRound(1, createRng(1)); assert.equal(p.startHour, 10); assert.equal(p.tutorial, true); assert.equal(p.waves.length, 3); for (const w of p.waves) { assert.ok(w.spawns.length >= 2 && w.spawns.length <= 3); assert.ok(w.spawns.every(s => s.type === 'rocket' && s.zone !== 'open')); } assert.equal(p.waves[0].spawns[0].zone, 'gilo'); assert.deepEqual(p.hazards, []); assert.deepEqual(p.missions, ['alertGilo']); });
test('every wave has a populated threat unless openOnly; holdWave creates one openOnly wave', () => { for (let r = 1; r <= 10; r++) for (let seed = 0; seed < 5; seed++) { const p = planRound(r, createRng(seed)); const open = p.waves.filter(w => w.openOnly); if (p.missions.includes('holdWave')) { assert.equal(open.length, 1); assert.ok(open[0].index >= 2); assert.ok(open[0].spawns.every(s => s.zone === 'open')); } else assert.equal(open.length, 0); for (const w of p.waves) if (!w.openOnly) assert.ok(populatedIn(w).length >= 1, `round ${r} wave ${w.index}`); } });
test('salvos share a start time; decoys and cruise appear where configured', () => { const p3 = planRound(3, createRng(2)); for (const i of [2, 4]) { const w = p3.waves[i - 1]; assert.ok(w.spawns.filter(s => s.at === 0).length >= 3); } const p8 = planRound(8, createRng(2)); assert.equal(p8.waves[2].spawns.filter(s => s.type === 'cruise').length, 1); assert.ok(p8.waves.every(w => w.spawns.filter(s => s.type === 'decoy').length >= 1 || w.openOnly)); assert.ok(p8.hazards.length >= 1 && p8.hazards.every(h => h.type === 'jamming' && h.wave >= 1 && h.wave <= 5 && h.at >= 3)); });
test('types respect firstRound and spawns are time-ordered within interval bounds', () => { for (let r = 1; r <= 12; r++) { const p = planRound(r, createRng(r)); for (const w of p.waves) for (const s of w.spawns) { assert.ok(THREATS[s.type].firstRound <= r); assert.ok(s.at >= 0); } } });

// Behaviour the plan's tests above leave open.
const ZONES = WORLD.neighborhoods.map(n => n.id);
const ALL_WAVES = [1, 2, 3, 4, 5];
const isRegular = s => s.type !== 'decoy' && s.type !== 'cruise';
const seeds = count => Array.from({ length: count }, (_, i) => i);
// A config whose only campaign round is BASE with `overrides`, for rules that the real table never combines.
const BASE = {
  round: 1, waves: 4, perWave: [3, 3], interval: 4, types: ['rocket', 'longrange'], populatedRatio: 0.5, salvoWaves: [], salvoSize: 0,
  decoysPerWave: null, cruiseWaves: [], jamming: [0, 0], missions: [], tutorial: false,
};
const configWith = overrides => ({ ROUNDS: [{ ...BASE, ...overrides }], ENDLESS, THREATS, WORLD, MISSIONS });

test('roundSpec: each campaign round is its table row, endless rows have the same fields and follow the formulas', () => {
  ROUNDS.forEach((row, i) => assert.equal(roundSpec(i + 1), row));
  const rounds = [11, 12, 13, 14, 15, 16, 30];
  const column = field => rounds.map(n => roundSpec(n)[field]);
  for (const n of rounds) assert.deepEqual(Object.keys(roundSpec(n)).sort(), Object.keys(ROUNDS[0]).sort());
  assert.deepEqual(column('round'), rounds);
  assert.deepEqual(column('perWave'), [6, 7, 8, 9, 10, 11, 25].map(n => [n, n]));
  assert.deepEqual(column('interval'), [2.75, 2.5, 2.25, 2, 2, 2, 2]); // 3 - k/4, but never below 2
  assert.deepEqual(column('salvoSize'), [3, 4, 4, 5, 5, 6, 13]); // grows every second round
  assert.deepEqual(column('cruiseWaves'), [[3], [3], ALL_WAVES, ALL_WAVES, ALL_WAVES, ALL_WAVES, ALL_WAVES]);
  assert.deepEqual(column('missions'), [['streak3'], ['perfectRound'], ['clearJam'], ['cruiseKill'], ['streak3'], ['perfectRound'], ['cruiseKill']]);
  assert.deepEqual(roundSpec(12), {
    round: 12, waves: 5, perWave: [7, 7], interval: 2.5, types: Object.keys(THREATS), populatedRatio: 0.7, salvoWaves: [2, 4], salvoSize: 4,
    decoysPerWave: [1, 2], cruiseWaves: [3], jamming: [2, 2], missions: ['perfectRound'], tutorial: false,
  });
});

test('roundSpec reads the tables it is given, and a generated row shares nothing with them', () => {
  const short = { ROUNDS: ROUNDS.slice(0, 2), ENDLESS, THREATS }; // a campaign of two rounds: round 3 is the first endless one
  assert.equal(roundSpec(2, short), ROUNDS[1]);
  assert.deepEqual(roundSpec(3, short), { ...roundSpec(11), round: 3 });
  const tuned = { ROUNDS, ENDLESS: { ...ENDLESS, basePerWave: 1, waves: 2, missionCycle: ['noWaste'] }, THREATS: { rocket: THREATS.rocket, uav: THREATS.uav } };
  const row = roundSpec(13, tuned);
  assert.deepEqual([row.perWave, row.waves, row.cruiseWaves, row.missions, row.types], [[4, 4], 2, [1, 2], ['noWaste'], ['rocket', 'uav']]);
  const tables = JSON.stringify([ENDLESS, ROUNDS]);
  for (const n of [11, 13]) {
    const before = JSON.stringify(roundSpec(n));
    for (const list of Object.values(roundSpec(n)).filter(Array.isArray)) list.push(99);
    assert.equal(JSON.stringify(roundSpec(n)), before, `round ${n}`);
  }
  assert.equal(JSON.stringify([ENDLESS, ROUNDS]), tables);
});

test('a schedule has the documented fields, counts waves from 1, sets openOnly on every wave and copies the missions', () => {
  const tables = JSON.stringify([ROUNDS, ENDLESS]);
  for (let r = 1; r <= 16; r++) for (const seed of seeds(5)) {
    const row = roundSpec(r);
    const p = planRound(r, createRng(seed));
    assert.deepEqual(Object.keys(p).sort(), ['hazards', 'missions', 'round', 'startHour', 'tutorial', 'waves']);
    assert.deepEqual([p.round, p.startHour, p.tutorial, p.missions], [r, startHourFor(r), r <= 2, row.missions]);
    assert.deepEqual(p.waves.map(w => w.index), Array.from({ length: row.waves }, (_, i) => i + 1));
    for (const w of p.waves) {
      assert.deepEqual(Object.keys(w).sort(), ['index', 'openOnly', 'spawns']);
      assert.equal(typeof w.openOnly, 'boolean');
      for (const s of w.spawns) assert.deepEqual(Object.keys(s).sort(), ['at', 'type', 'zone']);
    }
    for (const h of p.hazards) assert.deepEqual(Object.keys(h).sort(), ['at', 'type', 'wave']);
    p.missions.push('changed'); // the schedule has a list of its own: the table row must not notice
  }
  assert.equal(JSON.stringify([ROUNDS, ENDLESS]), tables);
});

test('regular spawns: the row count and types, each at its slot plus under a second, the first salvo members at once, all ahead of decoys and cruise', () => {
  const counts = new Set();
  const jitters = [];
  for (let r = 1; r <= 16; r++) for (const seed of seeds(5)) {
    const row = roundSpec(r);
    for (const w of planRound(r, createRng(seed)).waves) {
      const where = `round ${r} seed ${seed} wave ${w.index}`;
      const regular = w.spawns.filter(isRegular);
      const salvo = row.salvoWaves.includes(w.index) ? row.salvoSize : 0;
      assert.deepEqual(w.spawns.slice(0, regular.length), regular, where);
      assert.ok(regular.length >= Math.max(row.perWave[0], salvo) && regular.length <= Math.max(row.perWave[1], salvo), `${where}: ${regular.length} spawns`);
      regular.forEach((s, i) => {
        if (i < salvo) assert.equal(s.at, 0, `${where} salvo member ${i}`);
        else assert.ok(s.at >= i * row.interval && s.at < i * row.interval + 1, `${where} spawn ${i}: at ${s.at}`);
        if (i >= salvo) jitters.push(s.at - i * row.interval);
      });
      if (r === 2) counts.add(regular.length);
    }
  }
  assert.deepEqual([...counts].sort(), [3, 4]); // round 2 draws both ends of perWave
  assert.ok(Math.min(...jitters) < 0.05 && Math.max(...jitters) > 0.95, `jitter from ${Math.min(...jitters)} to ${Math.max(...jitters)}`);
  // Every regular type of the row gets used (decoys and cruise missiles have their own test, below).
  const typesIn = r => [...new Set(seeds(5).flatMap(seed => planRound(r, createRng(seed)).waves.flatMap(w => w.spawns.filter(isRegular).map(s => s.type))))].sort();
  const regularFour = ['longrange', 'mortar', 'rocket', 'uav'];
  assert.deepEqual([typesIn(1), typesIn(3), typesIn(10), typesIn(14)], [['rocket'], ['longrange', 'rocket'], regularFour, regularFour]);
});

test('zones: open ground for about 1 - populatedRatio of the regular spawns, otherwise any of the neighborhoods', () => {
  for (const [r, ratio] of [[2, 0.6], [12, 0.7]]) {
    const spawns = seeds(100).flatMap(seed => planRound(r, createRng(seed)).waves.flatMap(w => w.spawns.filter(isRegular)));
    const open = spawns.filter(s => s.zone === 'open').length / spawns.length;
    assert.ok(Math.abs(open - (1 - ratio)) < 0.05, `round ${r}: ${open} of ${spawns.length} spawns on open ground`);
    assert.deepEqual([...new Set(spawns.map(s => s.zone))].sort(), [...ZONES, 'open'].sort());
  }
});

test('decoys and cruise missiles: the row counts, aimed at a neighborhood, decoys within the wave span, cruise 2 s in, none in the open-area wave', () => {
  const decoyCounts = new Set();
  for (let r = 1; r <= 16; r++) for (const seed of seeds(5)) {
    const row = roundSpec(r);
    for (const w of planRound(r, createRng(seed)).waves) {
      const where = `round ${r} seed ${seed} wave ${w.index}`;
      const decoys = w.spawns.filter(s => s.type === 'decoy');
      const cruise = w.spawns.filter(s => s.type === 'cruise');
      const span = Math.max(1, (w.spawns.filter(isRegular).length - 1) * row.interval);
      const [min, max] = w.openOnly ? [0, 0] : row.decoysPerWave ?? [0, 0];
      assert.ok(decoys.length >= min && decoys.length <= max, `${where}: ${decoys.length} decoys`);
      assert.equal(cruise.length, row.cruiseWaves.includes(w.index) && !w.openOnly ? 1 : 0, where);
      assert.ok(decoys.every(s => s.at >= 0 && s.at < span), `${where}: decoys at ${decoys.map(s => s.at)}, span ${span}`);
      assert.ok(cruise.every(s => s.at === 2), where);
      assert.ok([...decoys, ...cruise].every(s => ZONES.includes(s.zone)), where);
      if (r >= 6 && !w.openOnly) decoyCounts.add(decoys.length);
    }
  }
  assert.deepEqual([...decoyCounts].sort(), [1, 2]);
  // A wave of one spawn has no time between spawns, yet its decoys spread over a span of 1 s.
  const lone = planRound(1, createRng(0), configWith({ perWave: [1, 1], decoysPerWave: [6, 6] })).waves.flatMap(w => w.spawns.filter(s => s.type === 'decoy'));
  assert.ok(lone.length === 24 && lone.every(s => s.at >= 0 && s.at < 1) && Math.max(...lone.map(s => s.at)) > 0.5);
});

test('jamming hazards: as many as the row allows, each on a wave of the round, 3 to 10 s into it', () => {
  const counts = new Set();
  const waves = new Set();
  const times = [];
  for (let r = 1; r <= 16; r++) for (const seed of seeds(30)) {
    const row = roundSpec(r);
    const { hazards } = planRound(r, createRng(seed));
    assert.ok(hazards.length >= row.jamming[0] && hazards.length <= row.jamming[1], `round ${r}: ${hazards.length} hazards`);
    for (const h of hazards) {
      assert.equal(h.type, 'jamming');
      assert.ok(Number.isInteger(h.wave) && h.wave >= 1 && h.wave <= row.waves, `round ${r}: wave ${h.wave}`);
      assert.ok(h.at >= 3 && h.at < 10, `round ${r}: at ${h.at}`);
      times.push(h.at);
      if (r === 7) waves.add(h.wave);
    }
    if (r === 7) counts.add(hazards.length);
  }
  assert.deepEqual([...counts].sort(), [1, 2]);
  assert.deepEqual([...waves].sort(), ALL_WAVES);
  assert.ok(Math.min(...times) < 3.2 && Math.max(...times) > 9.8, `times from ${Math.min(...times)} to ${Math.max(...times)}`);
});

test('the open-area wave is any wave but the first, holds regular spawns only, and every other wave still gets its decoy and cruise missile', () => {
  const config = configWith({ missions: ['holdWave'], decoysPerWave: [1, 1], cruiseWaves: [1, 2, 3, 4] });
  const openWaves = new Set();
  for (const seed of seeds(40)) {
    const { waves } = planRound(1, createRng(seed), config);
    const open = waves.filter(w => w.openOnly);
    assert.equal(open.length, 1);
    openWaves.add(open[0].index);
    assert.ok(open[0].spawns.length === 3 && open[0].spawns.every(s => s.zone === 'open' && isRegular(s)));
    for (const w of waves.filter(w => !w.openOnly)) assert.deepEqual(w.spawns.slice(3).map(s => s.type), ['decoy', 'cruise']);
  }
  assert.deepEqual([...openWaves].sort(), [2, 3, 4]);
});

test('a wave that drew open ground only gets exactly its first spawn aimed at a neighborhood, whatever decoys it adds', () => {
  const config = { ...configWith({ populatedRatio: 0, decoysPerWave: [2, 2] }), WORLD: { neighborhoods: [{ id: 'solo' }] } }; // the zones come from the WORLD given
  for (const seed of seeds(10)) {
    for (const w of planRound(1, createRng(seed), config).waves) assert.deepEqual(w.spawns.map(s => s.zone), ['solo', 'open', 'open', 'solo', 'solo']);
  }
  const moved = seeds(30).flatMap(seed => planRound(1, createRng(seed), configWith({ populatedRatio: 0 })).waves.map(w => w.spawns[0].zone));
  assert.deepEqual([...new Set(moved)].sort(), [...ZONES].sort()); // the neighborhood is picked at random
});

test('alertGilo aims the first threat of the round at Gilo, whatever else was drawn, and nothing else', () => {
  const later = new Set(); // the first zone of every wave after the first
  const first = new Set(); // the first zone of wave 1 when the round has no alertGilo
  for (const populatedRatio of [0, 0.5, 1]) for (const seed of seeds(20)) {
    const p = planRound(1, createRng(seed), configWith({ populatedRatio, missions: ['alertGilo'] }));
    assert.equal(p.waves[0].spawns[0].zone, 'gilo');
    p.waves.slice(1).forEach(w => later.add(w.spawns[0].zone));
    first.add(planRound(1, createRng(seed), configWith({ populatedRatio })).waves[0].spawns[0].zone);
  }
  assert.ok([...later].some(zone => zone !== 'gilo'));
  assert.ok([...first].some(zone => zone !== 'gilo'));
});

test('a salvo wave is topped up to salvoSize spawns that launch at once, and later spawns keep their own slots', () => {
  const short = planRound(1, createRng(3), configWith({ perWave: [2, 2], salvoWaves: [1], salvoSize: 4 }));
  assert.deepEqual(short.waves[0].spawns.map(s => s.at), [0, 0, 0, 0]);
  assert.equal(short.waves[1].spawns.length, 2);
  const long = planRound(1, createRng(3), configWith({ perWave: [6, 6], salvoWaves: [1], salvoSize: 2 })).waves[0].spawns.map(s => s.at);
  assert.deepEqual(long.slice(0, 2), [0, 0]);
  long.slice(2).forEach((at, j) => assert.ok(at >= (j + 2) * BASE.interval && at < (j + 2) * BASE.interval + 1, `spawn ${j + 2}: ${at}`));
});
