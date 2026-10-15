// Game state and persistence. createInitialState makes the one state record that the session changes in place
// for the whole game. checkpointFrom and applyCheckpoint turn the progress at the start of a round into plain
// data and back. createPersistence keeps that checkpoint, the settings and the records in a storage handed to
// it, which has the shape of the browser's local storage: the page passes the real one (or null when the
// browser denies access) and tests pass an in-memory object. The starting numbers are ECONOMY and DAYNIGHT in
// config.js.
import { ECONOMY, DAYNIGHT } from '../config.js';

// The counters kept for one round and, added up, for the whole game. A fresh object on every call.
export function emptyStats() {
  return {
    spawned: 0, intercepted: 0, missed: 0, impactsPopulated: 0, impactsOpen: 0,
    shotsWasted: 0, shots: 0, alerts: 0, coinsEarned: 0, missionsDone: 0,
  };
}

// What the missions read of one wave: the interceptors spent on open-area targets, and whether HOLD FIRE was
// on for the whole wave.
const emptyWaveStats = () => ({ shotsWasted: 0, holdAllWave: true });

// The fields of a round that has not begun: nothing in the air, nothing selected, held or jammed, no missions
// and no log lines. A new game starts from this and so does a restored checkpoint. Fresh arrays on every call.
const emptyRound = () => ({
  threats: [], interceptors: [], selectedId: null, hold: false, jammed: false, jamElapsed: 0, fireCooldown: 0,
  missions: [], log: [],
});

// The state of a new game: a fresh, mutable record on every call, nothing in it shared or frozen. `config` is
// the tables to read; tests pass their own.
export function createInitialState(config = { ECONOMY, DAYNIGHT }) {
  const { ECONOMY, DAYNIGHT } = config; // shadows the imports, which only serve as the default
  return {
    mode: 'campaign',
    phase: 'title',
    round: 0,
    wave: 0,
    waveCount: 0,
    clockHour: DAYNIGHT.startHour,
    coins: ECONOMY.startCoins,
    ammo: ECONOMY.ammoCapacity, // the launcher starts full
    ammoCapacity: ECONOMY.ammoCapacity,
    lives: ECONOMY.startLives,
    maxLives: ECONOMY.maxLives,
    score: 0,
    upgrades: {}, // shop item id -> level
    ...emptyRound(),
    stats: { round: emptyStats(), total: emptyStats(), wave: emptyWaveStats() },
  };
}

// The plain fields a checkpoint carries: the mode and these numbers. Its other two, upgrades and totalStats, are
// objects of numbers and are copied.
const NUMBER_FIELDS = ['round', 'coins', 'ammo', 'ammoCapacity', 'lives', 'maxLives', 'score', 'clockHour'];
const CHECKPOINT_FIELDS = ['mode', ...NUMBER_FIELDS];
const MODES = ['campaign', 'endless']; // the values of `mode`

// Whether a value is an object: not null, a number, a string, a boolean or an array, any of which stored JSON may
// hold instead.
export const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The entries of `value` that are finite numbers, in a fresh object; {} when `value` is not an object. Stored data
// may hold anything: an upgrade level or a counter that is not a number must not reach the arithmetic.
export function finiteEntries(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => Number.isFinite(v)));
}

// The progress that a retry or a later session starts a round from, as plain data that can go through JSON and
// shares nothing with the state: playing on does not change a checkpoint that was already taken.
export function checkpointFrom(state) {
  return {
    ...Object.fromEntries(CHECKPOINT_FIELDS.map(field => [field, state[field]])),
    upgrades: { ...state.upgrades },
    totalStats: { ...state.stats.total },
  };
}

// Puts the checkpoint into `state`, in place, and returns the state. The round begins again: nothing of the
// round that was running comes along, and the round and wave stats restart. A checkpoint may lack fields, an
// older save for example, or hold damaged ones: the state keeps its value for a number that is missing or not a
// finite number, for a mode that is not one, and for upgrades that are not an object, whose levels that are not
// numbers are dropped; a counter in the total stats that the checkpoint lacks, or holds as anything but a number,
// counts from zero.
export function applyCheckpoint(state, cp) {
  for (const field of NUMBER_FIELDS) if (Number.isFinite(cp[field])) state[field] = cp[field];
  if (MODES.includes(cp.mode)) state.mode = cp.mode;
  state.upgrades = isPlainObject(cp.upgrades) ? finiteEntries(cp.upgrades) : { ...state.upgrades };
  Object.assign(state, emptyRound());
  state.stats.round = emptyStats();
  state.stats.wave = emptyWaveStats();
  state.stats.total = { ...emptyStats(), ...finiteEntries(cp.totalStats) };
  return state;
}

// Spec §9. The keys of the storage entries. The v1 is the version of the stored format: a change that older
// saves cannot survive takes a new number.
const KEYS = {
  checkpoint: 'irondome.v1.checkpoint',
  settings: 'irondome.v1.settings',
  records: 'irondome.v1.records',
};

// volume is 0..1. reduceMotion turns off the camera shake and the screen flashes; shadows switches the scene's
// shadows on or off.
export const DEFAULT_SETTINGS = Object.freeze({ volume: 0.8, muted: false, reduceMotion: false, shadows: true });

// What is kept across games. campaignVictory unlocks Endless; bestRating is the best rating of a campaign
// victory, 'S', 'A', 'B' or 'C', or null before the first; endlessStart is the checkpoint that Endless starts
// from, or null.
const DEFAULT_RECORDS = {
  campaignVictory: false, bestRating: null, bestEndlessRound: 0, bestEndlessScore: 0, endlessStart: null,
};

// Saves and loads through `storage`: an object with getItem, setItem and removeItem like the browser's local
// storage, or null (undefined too) where there is none. Storage can be missing, full or denied, and what it
// holds can be damaged, and none of that may stop the game: a save that fails is skipped, and a load that
// fails, or finds anything but a JSON object, gives the default (null for the checkpoint; for the settings and
// the records, the defaults with whatever was saved laid over them). Callers hand over complete settings and
// records.
export function createPersistence(storage) {
  // The object stored under `key`, or null when there is none, it is not JSON, or it is JSON of another kind.
  const read = key => {
    try {
      const text = storage?.getItem(key);
      const value = text == null ? null : JSON.parse(text);
      return isPlainObject(value) ? value : null;
    } catch {
      return null;
    }
  };

  const write = (key, value) => {
    try {
      storage?.setItem(key, JSON.stringify(value));
    } catch {
      // Not saved: the game goes on without it.
    }
  };

  const remove = key => {
    try {
      storage?.removeItem(key);
    } catch {
      // Not removed: the game goes on, and the next save replaces the entry anyway.
    }
  };

  return {
    saveCheckpoint: state => write(KEYS.checkpoint, checkpointFrom(state)),
    loadCheckpoint: () => read(KEYS.checkpoint),
    clearCheckpoint: () => remove(KEYS.checkpoint),
    saveSettings: settings => write(KEYS.settings, settings),
    loadSettings: () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings) }),
    saveRecords: records => write(KEYS.records, records),
    loadRecords: () => ({ ...DEFAULT_RECORDS, ...read(KEYS.records) }),
  };
}
