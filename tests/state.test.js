import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createInitialState, emptyStats, DEFAULT_SETTINGS, checkpointFrom, applyCheckpoint, createPersistence } from '../js/game/state.js';
import { ECONOMY, DAYNIGHT } from '../js/config.js';
const memStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m }; };
test('initial state matches the spec', () => { const s = createInitialState(); assert.equal(s.coins, 1000); assert.equal(s.ammo, 20); assert.equal(s.lives, 5); assert.equal(s.maxLives, 5); assert.equal(s.clockHour, 10); assert.equal(s.phase, 'title'); assert.deepEqual(s.stats.round, emptyStats()); });
test('checkpoint round-trips through storage', () => { const st = memStorage(); const p = createPersistence(st); const s = createInitialState(); s.round = 4; s.coins = 2500; s.upgrades = { radar: 2 }; s.lives = 3; s.threats = [{ id: 1 }]; p.saveCheckpoint(s); assert.ok(st.map.has('irondome.v1.checkpoint')); const cp = p.loadCheckpoint(); assert.equal(cp.round, 4); assert.deepEqual(cp.upgrades, { radar: 2 }); const t = applyCheckpoint(createInitialState(), cp); assert.equal(t.coins, 2500); assert.equal(t.lives, 3); assert.deepEqual(t.threats, []); p.clearCheckpoint(); assert.equal(p.loadCheckpoint(), null); });
test('settings merge with defaults; records have defaults', () => { const p = createPersistence(memStorage()); assert.deepEqual(p.loadSettings(), DEFAULT_SETTINGS); p.saveSettings({ volume: 0.2 }); assert.deepEqual(p.loadSettings(), { ...DEFAULT_SETTINGS, volume: 0.2 }); assert.equal(p.loadRecords().campaignVictory, false); p.saveRecords({ campaignVictory: true, bestRating: 'A' }); assert.equal(p.loadRecords().bestRating, 'A'); });
test('corrupt JSON and throwing storage fall back safely', () => { const st = memStorage(); st.setItem('irondome.v1.checkpoint', '{not json'); const p = createPersistence(st); assert.equal(p.loadCheckpoint(), null); const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } }; const q = createPersistence(bad); assert.equal(q.loadCheckpoint(), null); assert.deepEqual(q.loadSettings(), DEFAULT_SETTINGS); assert.doesNotThrow(() => q.saveCheckpoint(createInitialState())); assert.doesNotThrow(() => q.saveSettings({})); const none = createPersistence(null); assert.equal(none.loadCheckpoint(), null); });

// Behaviour the plan's tests above leave open.
const ZERO_STATS = { spawned: 0, intercepted: 0, missed: 0, impactsPopulated: 0, impactsOpen: 0, shotsWasted: 0, shots: 0, alerts: 0, coinsEarned: 0, missionsDone: 0 };
const RECORD_DEFAULTS = { campaignVictory: false, bestRating: null, bestEndlessRound: 0, bestEndlessScore: 0, endlessStart: null };
// The state of a new game as the spec lists it, written out in full and fresh on every call.
const initial = () => ({
  mode: 'campaign', phase: 'title', round: 0, wave: 0, waveCount: 0, clockHour: 10,
  coins: 1000, ammo: 20, ammoCapacity: 20, lives: 5, maxLives: 5, score: 0, upgrades: {},
  threats: [], interceptors: [], selectedId: null, hold: false, jammed: false, jamElapsed: 0, fireCooldown: 0,
  missions: [], log: [],
  stats: { round: { ...ZERO_STATS }, total: { ...ZERO_STATS }, wave: { shotsWasted: 0, holdAllWave: true } },
});
// A game some rounds in, and the checkpoint that holds exactly what it carries into the next round.
const midGame = () => {
  const s = createInitialState();
  Object.assign(s, { mode: 'endless', round: 7, coins: 123, ammo: 9, ammoCapacity: 30, lives: 2, maxLives: 6, score: 4500, clockHour: 3.5, upgrades: { radar: 2, cheaper: 1 } });
  s.stats.total = { ...ZERO_STATS, spawned: 40, intercepted: 31, shots: 55 };
  return s;
};
const MID_CHECKPOINT = {
  mode: 'endless', round: 7, coins: 123, ammo: 9, ammoCapacity: 30, lives: 2, maxLives: 6, score: 4500,
  upgrades: { radar: 2, cheaper: 1 }, clockHour: 3.5, totalStats: { ...ZERO_STATS, spawned: 40, intercepted: 31, shots: 55 },
};
// A state in the middle of a wave, with everything that a round in progress leaves behind.
const midWave = () => {
  const s = createInitialState();
  Object.assign(s, {
    phase: 'wave', wave: 2, waveCount: 4, selectedId: 3, hold: true, jammed: true, jamElapsed: 2.5, fireCooldown: 0.7,
    threats: [{ id: 3 }], interceptors: [{ id: 1 }], missions: [{ id: 'streak3' }], log: ['TRK-3 NEW TRACK'],
  });
  s.stats.round = { ...ZERO_STATS, shots: 4 };
  s.stats.wave = { shotsWasted: 2, holdAllWave: false };
  return s;
};
const denied = () => { throw new Error('denied'); };

test('the initial state has exactly the fields of the spec, and its starting values come from the config passed in', () => {
  assert.deepEqual(createInitialState(), initial());
  assert.deepEqual(emptyStats(), ZERO_STATS);
  const config = {
    ECONOMY: { ...ECONOMY, startCoins: 7, ammoCapacity: 3, startLives: 2, maxLives: 4 },
    DAYNIGHT: { ...DAYNIGHT, startHour: 21.5 },
  };
  const s = createInitialState(config);
  assert.deepEqual([s.coins, s.ammo, s.ammoCapacity, s.lives, s.maxLives, s.clockHour], [7, 3, 3, 2, 4, 21.5]);
});

test('every call makes a fresh state: changing one leaves any other state, and emptyStats, as they were', () => {
  const a = createInitialState();
  a.coins = 0;
  a.upgrades.radar = 1;
  a.threats.push({ id: 1 });
  a.interceptors.push({ id: 1 });
  a.missions.push({ id: 'streak3' });
  a.log.push('TRK-1 NEW TRACK');
  a.stats.round.shots = 4;
  a.stats.total.shots = 7;
  a.stats.wave.shotsWasted = 2;
  assert.equal(a.stats.round.shots, 4); // round and total are separate objects
  assert.deepEqual(createInitialState(), initial());
  const stats = emptyStats();
  stats.shots = 9;
  assert.deepEqual(emptyStats(), ZERO_STATS);
  assert.notEqual(emptyStats(), emptyStats());
});

test('checkpointFrom copies the eleven fields as plain data and shares nothing with the state', () => {
  const s = midGame();
  s.stats.round.shots = 5; // the round stats and the round in progress are not part of a checkpoint
  s.threats.push({ id: 1 });
  const cp = checkpointFrom(s);
  assert.deepEqual(cp, MID_CHECKPOINT);
  assert.deepEqual(JSON.parse(JSON.stringify(cp)), cp);
  s.coins = 0;
  s.upgrades.radar = 3;
  s.stats.total.shots = 99;
  assert.deepEqual(cp, MID_CHECKPOINT); // playing on does not change a checkpoint that was already taken
});

test('applyCheckpoint puts the saved round into the state it is given and clears what the round in progress left there', () => {
  const cp = checkpointFrom(midGame());
  const s = midWave();
  assert.equal(applyCheckpoint(s, cp), s);
  assert.deepEqual(checkpointFrom(s), cp); // all eleven fields are back
  assert.deepEqual([s.threats, s.interceptors, s.missions, s.log], [[], [], [], []]);
  assert.deepEqual([s.selectedId, s.hold, s.jammed, s.jamElapsed, s.fireCooldown], [null, false, false, 0, 0]);
  assert.deepEqual(s.stats.round, ZERO_STATS);
  assert.deepEqual(s.stats.wave, { shotsWasted: 0, holdAllWave: true });
  cp.upgrades.radar = 9;
  cp.totalStats.shots = 0;
  assert.equal(s.upgrades.radar, 2); // the state has its own copies
  assert.equal(s.stats.total.shots, 55);
});

test('a checkpoint that lacks fields leaves the state its own values for them; missing stats count from zero', () => {
  const s = createInitialState();
  Object.assign(s, { coins: 400, lives: 3, upgrades: { radar: 1 } });
  s.stats.total.shots = 6;
  assert.doesNotThrow(() => applyCheckpoint(s, { round: 3, coins: 900 }));
  assert.deepEqual([s.round, s.coins], [3, 900]); // what the checkpoint has is taken over
  // Everything else stays as the state had it, except the total stats, which count from zero.
  assert.deepEqual([s.mode, s.ammo, s.ammoCapacity, s.lives, s.maxLives, s.score, s.clockHour], ['campaign', 20, 20, 3, 5, 0, 10]);
  assert.deepEqual(s.upgrades, { radar: 1 });
  assert.deepEqual(s.stats.total, ZERO_STATS);
  applyCheckpoint(s, { totalStats: { shots: 4 } });
  assert.deepEqual(s.stats.total, { ...ZERO_STATS, shots: 4 }); // a partial set of stats is filled in
  applyCheckpoint(s, { score: null, clockHour: null }); // JSON writes a number that is not finite as null
  assert.deepEqual([s.score, s.clockHour], [0, 10]);
  assert.doesNotThrow(() => applyCheckpoint(createInitialState(), {}));
});

test('with no storage, or storage that throws, no method throws and every load gives the default', () => {
  for (const storage of [null, undefined, {}, { getItem: denied, setItem: denied, removeItem: denied }]) {
    const p = createPersistence(storage);
    assert.doesNotThrow(() => {
      p.saveCheckpoint(createInitialState());
      p.saveSettings({ volume: 0.1 });
      p.saveRecords({ campaignVictory: true });
      p.clearCheckpoint();
    });
    assert.equal(p.loadCheckpoint(), null);
    assert.deepEqual(p.loadSettings(), DEFAULT_SETTINGS);
    assert.deepEqual(p.loadRecords(), RECORD_DEFAULTS);
  }
});

test('stored data that is not a JSON object loads as the default, and a value JSON cannot hold is not saved', () => {
  for (const text of ['', '{not json', '{"round": 4', 'null', '5', 'true', '"text"', '[1, 2]']) {
    const st = memStorage();
    for (const key of ['checkpoint', 'settings', 'records']) st.setItem(`irondome.v1.${key}`, text);
    const p = createPersistence(st);
    assert.equal(p.loadCheckpoint(), null, text);
    assert.deepEqual(p.loadSettings(), DEFAULT_SETTINGS, text);
    assert.deepEqual(p.loadRecords(), RECORD_DEFAULTS, text);
  }
  const st = memStorage();
  const loop = {};
  loop.self = loop;
  assert.doesNotThrow(() => createPersistence(st).saveSettings(loop));
  assert.equal(st.map.size, 0);
});

test('each kind of data has its own key, and clearing the checkpoint leaves the settings and records', () => {
  const st = memStorage();
  const p = createPersistence(st);
  p.saveCheckpoint(midGame());
  p.saveSettings({ volume: 0.1, muted: true });
  p.saveRecords({ campaignVictory: true, bestRating: 'S' });
  assert.deepEqual(JSON.parse(st.map.get('irondome.v1.checkpoint')), MID_CHECKPOINT);
  assert.deepEqual(JSON.parse(st.map.get('irondome.v1.settings')), { volume: 0.1, muted: true });
  assert.deepEqual(JSON.parse(st.map.get('irondome.v1.records')), { campaignVictory: true, bestRating: 'S' });
  assert.equal(st.map.size, 3);
  p.clearCheckpoint();
  assert.deepEqual([...st.map.keys()].sort(), ['irondome.v1.records', 'irondome.v1.settings']);
  assert.doesNotThrow(() => p.clearCheckpoint()); // nothing left to clear
});

test('saved settings and records come back merged over the defaults, in objects of their own', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { volume: 0.8, muted: false, reduceMotion: false, shadows: true });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  const p = createPersistence(memStorage());
  p.saveSettings({ muted: true });
  assert.deepEqual(p.loadSettings(), { volume: 0.8, muted: true, reduceMotion: false, shadows: true });
  p.saveRecords({ campaignVictory: true, bestRating: 'A', endlessStart: MID_CHECKPOINT });
  assert.deepEqual(p.loadRecords(), { campaignVictory: true, bestRating: 'A', bestEndlessRound: 0, bestEndlessScore: 0, endlessStart: MID_CHECKPOINT });
  const settings = p.loadSettings();
  settings.volume = 0;
  assert.equal(p.loadSettings().volume, 0.8);
  assert.equal(DEFAULT_SETTINGS.volume, 0.8);
  const fresh = createPersistence(memStorage());
  fresh.loadRecords().bestEndlessRound = 12;
  assert.equal(fresh.loadRecords().bestEndlessRound, 0);
});
