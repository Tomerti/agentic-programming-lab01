// Seedable random numbers for the game logic. Game modules take a generator made here instead of
// the platform's unseedable one, so a test can replay any sequence from its seed.

// mulberry32: a tiny, fast 32-bit PRNG. Returns a function yielding floats in [0, 1).
// The same seed (taken as a 32-bit integer) always gives the same sequence; with no seed it
// starts from crypto entropy.
export function createRng(seed = crypto.getRandomValues(new Uint32Array(1))[0]) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Float in [min, max).
export function rngRange(rng, min, max) {
  return min + rng() * (max - min);
}

// Integer in [min, max], both ends inclusive.
export function rngInt(rng, min, max) {
  return Math.floor(rngRange(rng, min, max + 1));
}

// Uniformly chosen element of a non-empty array.
export function rngPick(rng, array) {
  return array[Math.floor(rng() * array.length)];
}
