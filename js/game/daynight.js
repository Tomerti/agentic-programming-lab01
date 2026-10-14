// Day/night model: pure functions from the game clock (hours, fractional, 0 <= hour < 24) to lighting
// parameters, phase names and clock text. The keyframes and clock rates are DAYNIGHT in config.js.
import { DAYNIGHT } from '../config.js';

const HOURS_PER_DAY = 24;
const SUNRISE = 6; // the sun's azimuth is 0 at 06:00 ...
const SUNSET = 18; // ... and π at 18:00
// The hour each phase begins at. Night begins at 21:00 and runs through midnight until dawn.
const PHASE_START = { dawn: 5, day: 9, dusk: 17, night: 21 };

// Wraps any hour onto the clock face [0, 24).
const wrapHour = hour => ((hour % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;

const pad2 = n => String(n).padStart(2, '0');

// Blends two numbers, or two colours (equal-length arrays) component by component; t = 0 gives a.
const mix = (a, b, t) => (Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t);

// Lighting at `hour`: every field of the two keyframes around it blended linearly, plus the sun's azimuth
// (computed, not stored). The keyframes end at 24 h, a copy of 0 h, so the blend wraps past midnight.
// Colours come back as fresh [r, g, b] arrays that the caller may keep or change.
export function lightingFor(hour, keyframes = DAYNIGHT.keyframes) {
  const h = wrapHour(hour);
  const i = keyframes.findLastIndex(k => k.hour <= h); // h < 24, so a later keyframe always exists
  const from = keyframes[i];
  const to = keyframes[i + 1];
  const t = (h - from.hour) / (to.hour - from.hour);
  const lighting = { sunAzimuth: ((h - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI };
  for (const [field, value] of Object.entries(from)) {
    if (field !== 'hour') lighting[field] = mix(value, to[field], t);
  }
  return lighting;
}

// The clock `dt` seconds later, wrapped past midnight.
export function advanceClock(hour, dt, hoursPerSecond = DAYNIGHT.hoursPerSecond) {
  return wrapHour(hour + dt * hoursPerSecond);
}

// The clock at the start of a round: every round begins hoursPerRound after the one before it.
export function startHourFor(round, { startHour, hoursPerRound } = DAYNIGHT) {
  return wrapHour(startHour + (round - 1) * hoursPerRound);
}

// 'night' | 'dawn' | 'day' | 'dusk'. A phase includes the hour it starts at.
export function phaseName(hour) {
  const h = wrapHour(hour);
  if (h < PHASE_START.dawn || h >= PHASE_START.night) return 'night';
  if (h < PHASE_START.day) return 'dawn';
  if (h < PHASE_START.dusk) return 'day';
  return 'dusk';
}

// 'HH:MM' from the fractional hour (9.5 -> '09:30'); the minutes are floored, as on a clock.
export function formatClock(hour) {
  const minutes = Math.floor(wrapHour(hour) * 60);
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}
