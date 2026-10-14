// Director: plans a round as data. For a round number and a random generator it returns the schedule the
// session plays: the round's waves, each with its spawns (when, which threat, aimed at which zone), and the
// radar jamming that strikes during the round. The campaign rows are ROUNDS and the formulas for the
// rounds after them are ENDLESS in config.js (spec §5); the zones are WORLD.neighborhoods. Every random
// choice comes from the generator passed in, so a seeded round replays exactly.
import { ROUNDS, ENDLESS, THREATS, WORLD, MISSIONS } from '../config.js';
import { rngRange, rngInt, rngPick } from '../core/rng.js';
import { startHourFor } from './daynight.js';

// Numbers of the schedule that no config table holds. Times are seconds into the wave; waves count from 1.
const SPAWN_JITTER = [0, 1]; // a regular spawn follows its slot in the wave by a random time in this range
const MIN_DECOY_SPAN = 1; // decoys appear within the span of their wave, which counts as at least this long
const CRUISE_AT = 2; // a cruise missile launches this long into its wave
const HAZARD_AT = [3, 10]; // a hazard strikes a random time in this range into its wave
const FIRST_OPEN_WAVE = 2; // the open-area wave is never wave 1: a round opens with a populated wave
const EARLY_CRUISE_WAVES = [3]; // before round cruiseEveryWaveFrom an endless round has one cruise, in this wave
const EXTRA_TYPES = ['decoy', 'cruise']; // threats that a wave adds to its regular spawns, never among them

// A random integer or float from a [min, max] range, as the config stores them.
const intIn = (rng, [min, max]) => rngInt(rng, min, max);
const floatIn = (rng, [min, max]) => rngRange(rng, min, max);

// The table row that describes `round`: for a campaign round the ROUNDS row itself (shared, so read it
// only), after the campaign a row made from the ENDLESS formulas, with the same fields. For the k-th round
// after the campaign, k = round - ROUNDS.length, that is basePerWave + k threats per wave, a spawn interval
// of intervalStart - k * intervalStep (never below intervalFloor), salvos of salvoSizeBase + floor(k / 2),
// a cruise missile in every wave from round cruiseEveryWaveFrom (one in an early wave before it) and the
// mission that missionCycle holds for the round. Its `types` lists every threat; planRound takes the
// regular spawns from it without the decoy and the cruise missile, which each wave adds on its own.
export function roundSpec(round, config = { ROUNDS, ENDLESS, THREATS }) {
  const { ROUNDS, ENDLESS, THREATS } = config; // shadows the imports, which only serve as the default
  if (round <= ROUNDS.length) return ROUNDS[round - 1];
  const k = round - ROUNDS.length;
  const perWave = ENDLESS.basePerWave + k;
  return {
    round,
    waves: ENDLESS.waves,
    perWave: [perWave, perWave],
    interval: Math.max(ENDLESS.intervalFloor, ENDLESS.intervalStart - k * ENDLESS.intervalStep),
    types: Object.keys(THREATS),
    populatedRatio: ENDLESS.populatedRatio,
    salvoWaves: [...ENDLESS.salvoWaves],
    salvoSize: ENDLESS.salvoSizeBase + Math.floor(k / 2),
    decoysPerWave: [...ENDLESS.decoysPerWave],
    cruiseWaves: round >= ENDLESS.cruiseEveryWaveFrom
      ? Array.from({ length: ENDLESS.waves }, (_, i) => i + 1)
      : [...EARLY_CRUISE_WAVES],
    jamming: [...ENDLESS.jamming],
    missions: [ENDLESS.missionCycle[(k - 1) % ENDLESS.missionCycle.length]],
    tutorial: false,
  };
}

// The helpers below share a `context`: { rng, row, zones, types }, the generator, the round's table row,
// the ids of the neighborhoods and the threat types that regular spawns are picked from.

// The regular spawns of wave `index`, in order. There are perWave of them, or salvoSize in a salvo wave
// when that is more, and the first salvoSize of a salvo wave launch at once. Otherwise spawn i comes at
// i * interval plus a little jitter. A spawn is aimed at open ground with probability 1 - populatedRatio,
// and always in the open-area wave (`openOnly`); every other wave keeps at least one populated spawn.
function regularSpawns({ rng, row, zones, types }, index, openOnly) {
  const salvo = row.salvoWaves.includes(index) ? row.salvoSize : 0;
  const count = Math.max(intIn(rng, row.perWave), salvo);
  const spawns = Array.from({ length: count }, (_, i) => {
    const at = i < salvo ? 0 : i * row.interval + floatIn(rng, SPAWN_JITTER);
    const type = rngPick(rng, types);
    const openGround = openOnly || rng() < 1 - row.populatedRatio;
    return { at, type, zone: openGround ? 'open' : rngPick(rng, zones) };
  });
  if (!openOnly && spawns.every(spawn => spawn.zone === 'open')) spawns[0].zone = rngPick(rng, zones);
  return spawns;
}

// What wave `index` adds to its `count` regular spawns, decoys first: decoysPerWave of them at random times
// within the span of the wave (up to the time of its last regular spawn), then one cruise missile in the
// waves that cruiseWaves lists. Both kinds are aimed at a neighborhood.
function extraSpawns({ rng, row, zones }, index, count) {
  const span = Math.max(MIN_DECOY_SPAN, (count - 1) * row.interval);
  const decoys = row.decoysPerWave ? intIn(rng, row.decoysPerWave) : 0;
  const spawns = Array.from({ length: decoys }, () => (
    { at: rngRange(rng, 0, span), type: 'decoy', zone: rngPick(rng, zones) }
  ));
  if (row.cruiseWaves.includes(index)) spawns.push({ at: CRUISE_AT, type: 'cruise', zone: rngPick(rng, zones) });
  return spawns;
}

// Wave `index`. The open-area wave (`openOnly`) has regular spawns only, every one aimed at open ground.
function planWave(context, index, openOnly) {
  const spawns = regularSpawns(context, index, openOnly);
  if (!openOnly) spawns.push(...extraSpawns(context, index, spawns.length));
  return { index, openOnly, spawns };
}

// The schedule of `round`, every random choice drawn from `rng`:
//   { round, startHour, tutorial, missions: [id, ...],
//     waves: [{ index, openOnly, spawns: [{ at, type, zone }, ...] }, ...],
//     hazards: [{ wave, at, type: 'jamming' }, ...] }
// `at` is the time in seconds from the start of the wave (for a hazard, of its wave) and `zone` the id of a
// neighborhood or 'open'. The session fires a spawn or hazard once its wave has run for `at`. A round with
// the holdWave mission has exactly one open-area wave, never the first. With alertGilo the first threat of
// the round is aimed at Gilo. `config` is the tables to read; tests pass their own.
export function planRound(round, rng, config = { ROUNDS, ENDLESS, THREATS, WORLD, MISSIONS }) {
  const { WORLD } = config; // shadows the import, which only serves as the default
  const row = roundSpec(round, config);
  const context = {
    rng,
    row,
    zones: WORLD.neighborhoods.map(({ id }) => id),
    types: row.types.filter(type => !EXTRA_TYPES.includes(type)),
  };
  const openWave = row.missions.includes('holdWave') ? rngInt(rng, FIRST_OPEN_WAVE, row.waves) : 0;
  const waves = Array.from({ length: row.waves }, (_, i) => planWave(context, i + 1, i + 1 === openWave));
  if (row.missions.includes('alertGilo')) waves[0].spawns[0].zone = 'gilo';
  const hazards = Array.from({ length: intIn(rng, row.jamming) }, () => (
    { wave: rngInt(rng, 1, row.waves), at: floatIn(rng, HAZARD_AT), type: 'jamming' }
  ));
  return { round, startHour: startHourFor(round), tutorial: row.tutorial, missions: [...row.missions], waves, hazards };
}
