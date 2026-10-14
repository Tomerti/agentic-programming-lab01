// Threats: how one is created, where it flies and when the radar sees it. Pure functions over plain
// { x, y, z } points and the threat record. The numbers are WORLD and THREATS in config.js, and every
// random choice comes from the generator passed in, so a seeded run replays exactly.
import { WORLD, THREATS } from '../config.js';
import { rngRange, rngPick } from '../core/rng.js';

const TAU = 2 * Math.PI;
const WEAVE_CYCLES = 2; // a weaving threat sways through this many full cycles between spawn and impact
const FLANKS = [-1, 1]; // arcing and low threats come in from the left (-x) or the right (+x)

// A random float from a [min, max] range, as the config stores them.
const randomIn = (rng, [min, max]) => rngRange(rng, min, max);

// A uniformly random impact point at impact height: inside a neighborhood's circle for its id, or inside
// one of the open-area rectangles for 'open'. `world` is the table to read; tests pass their own.
export function pickImpactPoint(zone, rng, world = WORLD) {
  if (zone === 'open') {
    const area = rngPick(rng, world.openAreas);
    return { x: randomIn(rng, area.x), y: world.impactY, z: randomIn(rng, area.z) };
  }
  const { x, z, r } = world.neighborhoods.find(n => n.id === zone);
  const radius = r * Math.sqrt(rng()); // the root spreads points evenly over the disc, not towards its centre
  const angle = rng() * TAU;
  return { x: x + radius * Math.cos(angle), y: world.impactY, z: z + radius * Math.sin(angle) };
}

// Where a threat of this type starts. A mortar starts a short hop from its impact point, on the side away
// from x = 0 (the right side when the impact is at x = 0). Every other type comes in from a random flank:
// the low flyers close to the ground, the arcing types high up.
export function pickSpawnPoint(type, impact, rng, world = WORLD, threats = THREATS) {
  if (type === 'mortar') {
    const side = impact.x < 0 ? -1 : 1;
    const distance = randomIn(rng, world.mortarSpawn.distance);
    return { x: impact.x + side * distance, y: world.mortarSpawn.y, z: impact.z };
  }
  const flank = rngPick(rng, FLANKS);
  return {
    x: flank * randomIn(rng, world.spawn.x),
    y: randomIn(rng, threats[type].low ? world.lowSpawnY : world.spawn.y),
    z: randomIn(rng, world.spawn.z),
  };
}

// A new inbound threat. Its flight path is the quadratic Bézier p0 (spawn) -> p1 -> p2 (impact), with the
// control point p1 `arc` above the midpoint of p0 and p2, so the curve itself rises half that far. `now` is
// the session clock at the spawn.
export function createThreat({ id, type, zone, rng, now = 0 }) {
  const spec = THREATS[type];
  const p2 = pickImpactPoint(zone, rng);
  const p0 = pickSpawnPoint(type, p2, rng);
  return {
    id,
    type,
    zone,
    populated: zone !== 'open' && !spec.decoy, // whether its impact would hit a neighborhood
    decoy: Boolean(spec.decoy),
    p0,
    p1: { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 + spec.arc, z: (p0.z + p2.z) / 2 },
    p2,
    t: 0, // flight fraction: 0 at spawn, 1 at impact
    dur: randomIn(rng, spec.dur), // seconds from spawn to impact
    hitsRemaining: spec.hits,
    state: 'inbound', // 'inbound' | 'intercepted' | 'impacted'
    detected: false,
    alerted: false,
    engagedBy: null,
    spawnedAt: now,
    position: { ...p0 },
  };
}

// The threat's position at flight fraction t, written into `out` (a fresh point unless given) and returned,
// so a caller can update a position in place. A weaving threat also sways sideways along the horizontal
// normal (-chord.z, 0, chord.x) of the chord p0 -> p2; the sway is zero at both ends of the flight.
export function threatPosition(threat, t, out = { x: 0, y: 0, z: 0 }) {
  const { p0, p1, p2 } = threat;
  const s = 1 - t;
  const w0 = s * s; // the Bézier weights of p0, p1 and p2
  const w1 = 2 * s * t;
  const w2 = t * t;
  out.x = w0 * p0.x + w1 * p1.x + w2 * p2.x;
  out.y = w0 * p0.y + w1 * p1.y + w2 * p2.y;
  out.z = w0 * p0.z + w1 * p1.z + w2 * p2.z;
  const { weave } = THREATS[threat.type];
  if (weave) {
    const chordX = p2.x - p0.x;
    const chordZ = p2.z - p0.z;
    // Dividing by the chord's length turns (-chordZ, chordX) into a unit vector: the sway is `weave` at most.
    const sway = (weave * Math.sin(t * WEAVE_CYCLES * TAU)) / Math.hypot(chordX, chordZ);
    out.x -= chordZ * sway;
    out.z += chordX * sway;
  }
  return out;
}

// Unit vector of the flight direction at t: the Bézier's derivative 2((1 - t)(p1 - p0) + t(p2 - p1)), the
// factor 2 dropped by the normalising, and without the sway of a weaving threat.
export function threatTangent(threat, t) {
  const { p0, p1, p2 } = threat;
  const s = 1 - t;
  const x = s * (p1.x - p0.x) + t * (p2.x - p1.x);
  const y = s * (p1.y - p0.y) + t * (p2.y - p1.y);
  const z = s * (p1.z - p0.z) + t * (p2.z - p1.z);
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

// Seconds until the threat reaches its impact point.
export function timeToImpact(threat) {
  return (1 - threat.t) * threat.dur;
}

// Distance in the ground plane (x and z; the height does not count) from a point to the city centre.
export function distanceToCity(pos, world = WORLD) {
  return Math.hypot(pos.x - world.cityCenter.x, pos.z - world.cityCenter.z);
}

// Whether the radar shows the threat at this detection range. Mortars are too close to hide: always.
export function isDetectable(threat, detectionRange) {
  return threat.type === 'mortar' || distanceToCity(threat.position) <= detectionRange;
}

// Flies the threat dt seconds on: t grows by dt / dur, at most to 1, and position follows in place.
// Reaching t = 1 makes the threat 'impacted'. Returns its state, 'inbound' | 'impacted'; a threat that
// has already impacted is left as it is.
export function advanceThreat(threat, dt) {
  if (threat.state === 'impacted') return 'impacted';
  threat.t = Math.min(1, threat.t + dt / threat.dur);
  threatPosition(threat, threat.t, threat.position);
  if (threat.t < 1) return 'inbound';
  threat.state = 'impacted';
  return 'impacted';
}
