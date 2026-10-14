// Every balance table and world constant the game uses: data only. Logic modules read these, so
// tuning happens here and nowhere else. The numbers come from the design spec,
// docs/superpowers/specs/2026-10-14-iron-dome-design.md.
//
// Units: distances are world units (the outside scene's metres), durations are seconds, [a, b] is a
// [min, max] range and a colour is [r, g, b] with each channel 0..1.
//
// Each export is frozen together with the rows directly inside it, so an accidental write to a shared
// table throws. Arrays nested deeper (a row's perWave, types, colour triples, ...) are not frozen.

// Freezes a table and the rows directly inside it.
const freezeRows = table => {
  Object.values(table).forEach(Object.freeze);
  return Object.freeze(table);
};

// Spec §3, §4, §6, §8. Outside coordinates: x to the right, y up, the city lies towards -z.
export const WORLD = freezeRows({
  cityCenter: { x: 0, z: -11 },
  radarRadius: 16,
  windowXRange: [-6, 6], // the outside x range the room's window shows, at the city's z
  launchPoint: { x: 5.2, y: 1.6, z: -7.0 }, // where interceptors start (the launcher's tube block)
  // Populated impact zones: circles of radius r around (x, z).
  neighborhoods: freezeRows([
    { id: 'gilo', name: 'Gilo', x: -4, z: -9, r: 2.2 },
    { id: 'oldcity', name: 'Old City', x: -1.5, z: -11, r: 2.5 },
    { id: 'talpiot', name: 'Talpiot', x: 2.5, z: -9.5, r: 2.0 },
    { id: 'pisgat', name: "Pisgat Ze'ev", x: 4, z: -13, r: 2.2 },
    { id: 'ramot', name: 'Ramot', x: -5, z: -13.5, r: 2.2 },
  ]),
  // Unpopulated impact zones: rectangles, as an x range and a z range.
  openAreas: freezeRows([
    { x: [-12, -8], z: [-15, -9] },
    { x: [8, 12], z: [-15, -9] },
  ]),
  spawn: { x: [14, 16], y: [7, 9], z: [-20, -16] }, // arcing threats; x is a distance, they spawn at +x or -x
  lowSpawnY: [2, 3], // spawn height of the low flyers (THREATS entries with low: true)
  mortarSpawn: { distance: [6, 8], y: 5 }, // mortars start this far from their impact point
  impactY: 0.4, // height at which a threat lands
  detectionBase: 14, // a threat shows on radar within this distance of the city centre ...
  detectionPerLevel: 2, // ... plus this much per Radar range level
  interceptorSpeed: 16, // units per second
  interceptorHitDistance: 0.4, // an interceptor hits when it gets this close to its target
  interceptorMissOvershoot: 1.5, // a missing interceptor detonates this far past its target
  shakeNearDistance: 10, // an interception closer than this to the window shakes the view
});

// Spec §4. dur: seconds from spawn to impact; arc: how high the flight path's middle control point sits
// above the straight line to the impact (the curve itself rises half as far); reward: coins and score for
// downing it; hits: interceptor hits needed; firstRound: the first campaign round it can appear in;
// low: spawns at lowSpawnY and flies flat.
export const THREATS = freezeRows({
  rocket: { name: 'Rocket', dur: [10, 12], arc: 7, reward: 150, hits: 1, firstRound: 1, low: false },
  longrange: { name: 'Long-range rocket', dur: [7, 8], arc: 10, reward: 200, hits: 1, firstRound: 3, low: false },
  uav: { name: 'UAV', dur: [22, 26], arc: 1.5, reward: 120, hits: 1, firstRound: 4, low: true },
  mortar: { name: 'Mortar', dur: [4, 5], arc: 4, reward: 100, hits: 1, firstRound: 5, low: false },
  // Looks like a rocket, is harmless and pays nothing.
  decoy: { name: 'Decoy', dur: [10, 12], arc: 7, reward: 0, hits: 1, firstRound: 6, low: false, decoy: true },
  // weave: amplitude of its sideways sway.
  cruise: { name: 'Cruise missile', dur: [14, 16], arc: 2, reward: 400, hits: 2, firstRound: 8, low: true, weave: 1.0 },
});

// Spec §6, §7.
export const ECONOMY = Object.freeze({
  startCoins: 1000,
  shotCost: 80,
  shotDiscountPerLevel: 10, // off shotCost per Supply contract level
  alertReward: 40, // coins for an alert sounded in time
  stipendBase: 300, // the end-of-round stipend is stipendBase + stipendPerRound * round
  stipendPerRound: 50,
  restockCost: 40, // per interceptor
  ammoCapacity: 20,
  startLives: 5,
  maxLives: 5,
  maxLivesCap: 8, // Reinforced shelters raise maxLives up to this
  fireCooldown: 1.2, // seconds between shots ...
  rapidCooldown: 0.6, // ... with Rapid reload
  hitChance: 0.85,
  hitChancePerLevel: 0.05, // per Better seekers level
  endlessScorePerSecond: 10,
});

// Spec §7. cost: coins per level (per interceptor for restock); maxLevel: how often it can be bought.
export const SHOP = freezeRows([
  { id: 'maxLives', name: 'Reinforced shelters', desc: 'Max lives +1', cost: 600, maxLevel: 3 },
  { id: 'life', name: 'Emergency crews', desc: 'Restore one life', cost: 350, maxLevel: Infinity },
  { id: 'restock', name: 'Restock interceptors', desc: '40 coins each', cost: 40, maxLevel: Infinity },
  { id: 'capacity', name: 'Extra launcher tubes', desc: 'Capacity +10', cost: 400, maxLevel: 2 },
  { id: 'cheaper', name: 'Supply contract', desc: 'Shot cost −10', cost: 500, maxLevel: 3 },
  { id: 'seekers', name: 'Better seekers', desc: 'Hit chance +5%', cost: 450, maxLevel: 3 },
  { id: 'radar', name: 'Radar range', desc: 'Detect threats earlier', cost: 350, maxLevel: 3 },
  { id: 'analyzer', name: 'Signature analyzer', desc: 'Reveals decoys', cost: 500, maxLevel: 1 },
  { id: 'autoAlert', name: 'Auto-alert system', desc: 'Alerts neighborhoods automatically', cost: 700, maxLevel: 1 },
  { id: 'rapid', name: 'Rapid reload', desc: 'Fire cooldown 0.6 s', cost: 400, maxLevel: 1 },
]);

// Spec §5, the campaign. One row per round:
//   perWave          [min, max] regular threats per wave
//   interval         seconds between the spawns of a wave
//   types            the regular threat types; decoys and cruise missiles come from the fields below
//   populatedRatio   share of spawns aimed at a neighborhood, the rest land in open areas
//   salvoWaves       1-based waves whose first salvoSize spawns launch at the same moment
//   decoysPerWave    [min, max] decoys added to every wave, or null
//   cruiseWaves      1-based waves that each get one cruise missile
//   jamming          [min, max] radar jamming events in the round
//   missions         ids from MISSIONS offered in the round
//   tutorial         whether the TUTORIAL toasts run
export const ROUNDS = freezeRows([
  { round: 1, waves: 3, perWave: [2, 3], interval: 6, types: ['rocket'], populatedRatio: 1.0,
    salvoWaves: [], salvoSize: 0, decoysPerWave: null, cruiseWaves: [], jamming: [0, 0],
    missions: ['alertGilo'], tutorial: true },
  { round: 2, waves: 3, perWave: [3, 4], interval: 5.5, types: ['rocket'], populatedRatio: 0.6,
    salvoWaves: [], salvoSize: 0, decoysPerWave: null, cruiseWaves: [], jamming: [0, 0],
    missions: ['noWaste'], tutorial: true },
  { round: 3, waves: 4, perWave: [3, 4], interval: 5, types: ['rocket', 'longrange'], populatedRatio: 0.65,
    salvoWaves: [2, 4], salvoSize: 3, decoysPerWave: null, cruiseWaves: [], jamming: [0, 0],
    missions: ['streak3', 'holdWave'], tutorial: false },
  { round: 4, waves: 4, perWave: [4, 4], interval: 5, types: ['rocket', 'longrange', 'uav'], populatedRatio: 0.65,
    salvoWaves: [], salvoSize: 0, decoysPerWave: null, cruiseWaves: [], jamming: [0, 0],
    missions: ['callUav'], tutorial: false },
  { round: 5, waves: 4, perWave: [4, 5], interval: 4.5, types: ['rocket', 'longrange', 'uav', 'mortar'], populatedRatio: 0.65,
    salvoWaves: [], salvoSize: 0, decoysPerWave: null, cruiseWaves: [], jamming: [0, 0],
    missions: ['perfectRound'], tutorial: false },
  { round: 6, waves: 4, perWave: [4, 5], interval: 4.5, types: ['rocket', 'longrange', 'uav', 'mortar'], populatedRatio: 0.65,
    salvoWaves: [], salvoSize: 0, decoysPerWave: [1, 2], cruiseWaves: [], jamming: [0, 0],
    missions: ['noWaste', 'streak3'], tutorial: false },
  { round: 7, waves: 5, perWave: [4, 5], interval: 4, types: ['rocket', 'longrange', 'uav', 'mortar'], populatedRatio: 0.65,
    salvoWaves: [], salvoSize: 0, decoysPerWave: [1, 2], cruiseWaves: [], jamming: [1, 2],
    missions: ['clearJam'], tutorial: false },
  { round: 8, waves: 5, perWave: [4, 5], interval: 3.5, types: ['rocket', 'longrange', 'uav', 'mortar'], populatedRatio: 0.65,
    salvoWaves: [], salvoSize: 0, decoysPerWave: [1, 2], cruiseWaves: [3], jamming: [1, 2],
    missions: ['cruiseKill', 'clearJam'], tutorial: false },
  { round: 9, waves: 5, perWave: [5, 6], interval: 3, types: ['rocket', 'longrange', 'uav', 'mortar'], populatedRatio: 0.65,
    salvoWaves: [2, 4], salvoSize: 3, decoysPerWave: [1, 2], cruiseWaves: [], jamming: [1, 2],
    missions: ['perfectRound', 'holdWave'], tutorial: false },
  { round: 10, waves: 5, perWave: [6, 7], interval: 3, types: ['rocket', 'longrange', 'uav', 'mortar'], populatedRatio: 0.65,
    salvoWaves: [1, 3], salvoSize: 4, decoysPerWave: [1, 2], cruiseWaves: [2, 5], jamming: [1, 2],
    missions: ['cruiseKill', 'perfectRound'], tutorial: false },
]);

// Spec §5, Endless (rounds after the 10th). For round n, with k = n - 10, the director builds a round
// from these: basePerWave + k threats per wave, a spawn interval of intervalStart - k * intervalStep
// (never below intervalFloor), salvos of salvoSizeBase + floor(k / 2), a cruise missile in every wave
// from round cruiseEveryWaveFrom, and one mission from missionCycle.
export const ENDLESS = freezeRows({
  waves: 5,
  basePerWave: 5,
  intervalStart: 3,
  intervalStep: 0.25,
  intervalFloor: 2,
  populatedRatio: 0.7,
  salvoWaves: [2, 4],
  salvoSizeBase: 3,
  decoysPerWave: [1, 2],
  cruiseEveryWaveFrom: 13,
  jamming: [2, 2],
  missionCycle: ['streak3', 'perfectRound', 'clearJam', 'cruiseKill'],
});

// Spec §7. goal: the progress to reach; reward: coins and score, paid once when it completes.
export const MISSIONS = freezeRows({
  alertGilo: { text: 'Sound the alert in Gilo before impact', reward: 150, goal: 1 },
  streak3: { text: 'Intercept 3 rockets in a row', reward: 200, goal: 3 },
  noWaste: { text: 'Finish a wave without wasting a shot on an open-area rocket', reward: 200, goal: 1 },
  holdWave: { text: 'Keep HOLD FIRE on through the open-area wave', reward: 150, goal: 1 },
  callUav: { text: 'Call HQ while a UAV is on radar', reward: 150, goal: 1 },
  clearJam: { text: 'Clear the jamming within 5 seconds', reward: 250, goal: 1 },
  perfectRound: { text: 'No populated impacts this round', reward: 400, goal: 1 },
  cruiseKill: { text: 'Down the cruise missile', reward: 300, goal: 1 },
});

// Spec §5. The clock hours are 0..24. startHour: the clock in round 1; hoursPerRound: how far the clock
// moves from one round's start to the next; hoursPerSecond: how fast it runs. keyframes: the lighting at
// those hours, blended in between (see game/daynight.js); the 24 h keyframe repeats 0 h so the day wraps.
//   skyTop, skyHorizon      sky gradient colours
//   sunAltitude             sun elevation above the horizon in radians (negative: below it)
//   sunColor, sunIntensity  colour and strength of the directional light
//   hemiSky, hemiGround     hemisphere light colours
//   starAlpha               star opacity
//   windowsOn               city window glow
//   roomLight               ceiling light level
export const DAYNIGHT = freezeRows({
  startHour: 10,
  hoursPerRound: 6,
  hoursPerSecond: 0.04,
  keyframes: freezeRows([
    {
      hour: 0,
      skyTop: [0.02, 0.03, 0.09], skyHorizon: [0.08, 0.11, 0.23],
      sunAltitude: -0.8, sunColor: [0.6, 0.7, 1.0], sunIntensity: 0.8,
      hemiSky: [0.25, 0.32, 0.55], hemiGround: [0.12, 0.10, 0.12],
      starAlpha: 1, windowsOn: 1, roomLight: 0.75,
    },
    {
      hour: 5,
      skyTop: [0.05, 0.06, 0.19], skyHorizon: [0.29, 0.16, 0.29],
      sunAltitude: -0.2, sunColor: [0.7, 0.7, 0.9], sunIntensity: 0.5,
      hemiSky: [0.3, 0.32, 0.5], hemiGround: [0.15, 0.12, 0.12],
      starAlpha: 0.8, windowsOn: 0.9, roomLight: 0.8,
    },
    {
      hour: 7,
      skyTop: [0.23, 0.37, 0.62], skyHorizon: [1.0, 0.70, 0.48],
      sunAltitude: 0.15, sunColor: [1.0, 0.75, 0.5], sunIntensity: 1.6,
      hemiSky: [0.5, 0.6, 0.85], hemiGround: [0.4, 0.33, 0.25],
      starAlpha: 0, windowsOn: 0.3, roomLight: 1.0,
    },
    {
      hour: 12,
      skyTop: [0.25, 0.56, 0.94], skyHorizon: [0.75, 0.88, 1.0],
      sunAltitude: 1.2, sunColor: [1, 0.97, 0.9], sunIntensity: 2.4,
      hemiSky: [0.6, 0.75, 1.0], hemiGround: [0.5, 0.42, 0.3],
      starAlpha: 0, windowsOn: 0, roomLight: 1.0,
    },
    {
      hour: 17,
      skyTop: [0.23, 0.48, 0.85], skyHorizon: [1.0, 0.84, 0.6],
      sunAltitude: 0.35, sunColor: [1, 0.85, 0.6], sunIntensity: 1.8,
      hemiSky: [0.55, 0.65, 0.9], hemiGround: [0.45, 0.38, 0.28],
      starAlpha: 0, windowsOn: 0.1, roomLight: 1.0,
    },
    {
      hour: 19,
      skyTop: [0.10, 0.15, 0.31], skyHorizon: [1.0, 0.48, 0.29],
      sunAltitude: -0.05, sunColor: [1, 0.55, 0.35], sunIntensity: 0.9,
      hemiSky: [0.35, 0.35, 0.6], hemiGround: [0.25, 0.18, 0.15],
      starAlpha: 0.3, windowsOn: 0.6, roomLight: 0.9,
    },
    {
      hour: 21,
      skyTop: [0.02, 0.03, 0.09], skyHorizon: [0.08, 0.11, 0.23],
      sunAltitude: -0.8, sunColor: [0.6, 0.7, 1.0], sunIntensity: 0.8,
      hemiSky: [0.25, 0.32, 0.55], hemiGround: [0.12, 0.10, 0.12],
      starAlpha: 0.9, windowsOn: 1, roomLight: 0.75,
    },
    {
      hour: 24,
      skyTop: [0.02, 0.03, 0.09], skyHorizon: [0.08, 0.11, 0.23],
      sunAltitude: -0.8, sunColor: [0.6, 0.7, 1.0], sunIntensity: 0.8,
      hemiSky: [0.25, 0.32, 0.55], hemiGround: [0.12, 0.10, 0.12],
      starAlpha: 1, windowsOn: 1, roomLight: 0.75,
    },
  ]),
});

// Spec §4 to §7. breather: pause between waves; jammingDuration: a jamming clears by itself after this
// long; alertSiren: how long the siren beacon spins; clearJamWindow: the clearJam mission's time limit.
export const TIMING = Object.freeze({ breather: 5, jammingDuration: 8, alertSiren: 4, clearJamWindow: 5 });

// Spec §5. Tutorial toasts, shown once each in this order, when the session event `on` fires in `round`.
export const TUTORIAL = freezeRows([
  { round: 1, on: 'threat:detected', text: 'Rockets inbound: click a blip on the radar, then press ENGAGE (Space)' },
  { round: 1, on: 'interceptor:launched', text: 'Every shot costs coins and one interceptor: watch the top bar' },
  { round: 1, on: 'threat:intercepted', text: 'ALERT (A) warns the neighborhood under the selected track for bonus coins' },
  { round: 2, on: 'threat:detected', text: 'Grey tracks land on open ground: let them fall and save your interceptors' },
]);
