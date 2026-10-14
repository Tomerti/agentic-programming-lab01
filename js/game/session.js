// Session: the orchestrator of a game. It owns the one state record (state.js) and changes it in place: it plans
// each round with the director, fires the spawns and the radar jamming of the schedule, flies threats and
// interceptors, settles hits, misses and impacts through the economy, feeds the round's missions and moves through
// the phases: title -> wave <-> breather -> summary -> shop -> the next round, until game over or victory. Views
// read `session.state`, call the commands and listen to the events on the bus, nothing else. Pure logic: the
// generator, the persistence and the bus are injected and time passes only through update(dt). The numbers are
// the tables in config.js (spec §2, §4 to §7).
import * as CONFIG from '../config.js';
import { createInitialState, emptyStats, checkpointFrom, applyCheckpoint } from './state.js';
import { createThreat, advanceThreat, isDetectable, timeToImpact } from './threats.js';
import { createInterceptor, advanceInterceptor } from './interceptors.js';
import { createEconomy } from './economy.js';
import { createMissionTracker } from './missions.js';
import { planRound } from './director.js';
import { advanceClock, phaseName } from './daynight.js';

// Numbers of the session that no config table holds.
const MAX_STEP = 0.1; // update() never moves the game on by more than this many seconds (a hidden tab, a long frame)
const LOG_LINES = 6; // the log keeps this many lines, newest first (spec §2)
const FIRST_TRACK_ID = 217; // threat ids count up from here (spec §4): the radar shows TRK-217, TRK-218, ...
const FIRST_INTERCEPTOR_ID = 1;
// The victory rating from the campaign totals (spec §7), best first: the first row whose limits the totals keep.
const RATINGS = [
  { rating: 'S', impactsPopulated: 0, shotsWasted: 3 },
  { rating: 'A', impactsPopulated: 3, shotsWasted: Infinity },
  { rating: 'B', impactsPopulated: 8, shotsWasted: Infinity },
  { rating: 'C', impactsPopulated: Infinity, shotsWasted: Infinity },
];
const HQ_IDLE = 'HQ: "All quiet, chief. Keep the city covered."'; // the HQ line once every mission is done
const PLAY_PHASES = ['wave', 'breather']; // the phases in which time passes

// 'S' | 'A' | 'B' | 'C' for campaign totals: S with no populated impact and at most 3 wasted shots, A with at
// most 3 populated impacts, B with at most 8, C otherwise. A missing counter counts as 0.
export function ratingFor({ impactsPopulated = 0, shotsWasted = 0 } = {}) {
  return RATINGS.find(row => impactsPopulated <= row.impactsPopulated && shotsWasted <= row.shotsWasted).rating;
}

// The better of two ratings; one that is not a rating (null before the first victory) loses.
const rank = rating => {
  const i = RATINGS.findIndex(row => row.rating === rating);
  return i < 0 ? RATINGS.length : i;
};
const betterRating = (a, b) => (rank(a) <= rank(b) ? a : b);

// The tracks on radar: the detected inbound threats, the one closest to impact first. A fresh array.
export function sortedDetectedThreats(state) {
  return state.threats
    .filter(t => t.detected && t.state === 'inbound')
    .sort((a, b) => timeToImpact(a) - timeToImpact(b));
}

// Removes, in place, the items of `list` that `alive` rejects, so views holding the array keep a live one.
const keep = (list, alive) => {
  let n = 0;
  for (const item of list) if (alive(item)) list[n++] = item;
  list.length = n;
};

// A number from the records, which come from storage and may hold anything; not a number counts as none.
const recorded = value => (Number.isFinite(value) ? value : 0);

// A session over `config` (the tables; tests pass their own). `rng` makes every random choice, `persistence` is
// createPersistence's object and `bus` receives the events. Each command returns what it did; a command used
// outside its phase is ignored and changes nothing.
export function createSession({ config = CONFIG, rng, persistence, bus }) {
  const { WORLD, ECONOMY, TIMING, DAYNIGHT, ROUNDS, TUTORIAL } = config;
  // waveElapsed: seconds into the current wave; breatherLeft: seconds of the breather still to run.
  const freshState = () => ({ ...createInitialState(config), waveElapsed: 0, breatherLeft: 0 });
  const state = freshState();
  const economy = createEconomy(state, config);

  let schedule = null; // the plan of the round being played (director.js)
  let tracker = null; // the missions of that round (missions.js)
  let fired = new Set(); // the spawns and hazards of the round that have fired
  let resumePhase = null; // the phase that pause() left
  let scoreCarry = 0; // the fraction of a point that Endless's score per second has not paid out yet
  const tutorialShown = new Set(); // indices of the TUTORIAL entries shown in this campaign
  let nextThreatId = FIRST_TRACK_ID;
  let nextInterceptorId = FIRST_INTERCEPTOR_ID;

  // --- Events, missions, tutorial ---

  // Sends an event to the bus and to the round's missions (unless `toMissions` is false: the one event that the
  // missions get ahead of the bus, round:end, see endRound); it may also show a tutorial toast.
  function emit(type, payload, { toMissions = true } = {}) {
    bus.emit(type, payload);
    if (toMissions) feedMissions(type, payload);
    showTutorial(type);
  }

  // Offers an event to the missions: state.missions takes their new status, each mission whose progress moved is
  // reported and each one the event completes is paid.
  function feedMissions(type, payload) {
    if (!tracker) return;
    const before = state.missions;
    const completed = tracker.onEvent(type, payload);
    state.missions = tracker.status();
    state.missions.forEach(({ id, progress, goal }, i) => {
      if (progress !== before[i]?.progress) bus.emit('mission:progress', { id, progress, goal });
    });
    for (const { id, reward } of completed) {
      credit(reward);
      count('missionsDone');
      coinsChanged(reward, 'mission');
      bus.emit('mission:complete', { id, reward });
    }
  }

  // The tutorial toasts of the round (only in rounds whose schedule runs them), each once per campaign.
  function showTutorial(type) {
    if (!schedule?.tutorial) return;
    TUTORIAL.forEach((entry, i) => {
      if (entry.round !== state.round || entry.on !== type || tutorialShown.has(i)) return;
      tutorialShown.add(i);
      bus.emit('tutorial:show', { text: entry.text });
    });
  }

  // --- Small helpers ---

  // Adds to a counter of the round and of the whole game (the totals are kept live).
  const count = (field, amount = 1) => {
    state.stats.round[field] += amount;
    state.stats.total[field] += amount;
  };
  // Income: the coins, the coins earned and, unless it is a stipend, the score.
  const credit = (amount, scores = true) => {
    economy.earn(amount);
    count('coinsEarned', amount);
    if (scores) state.score += amount;
  };
  const coinsChanged = (delta, reason) => emit('coins:changed', { coins: state.coins, delta, reason });
  const ammoChanged = () => emit('ammo:changed', { ammo: state.ammo, capacity: state.ammoCapacity });
  const log = line => {
    state.log.unshift(line);
    state.log.length = Math.min(state.log.length, LOG_LINES);
  };
  const zoneName = zone => WORLD.neighborhoods.find(n => n.id === zone)?.name ?? zone;
  const inPlay = () => PLAY_PHASES.includes(state.phase);
  const isTrack = threat => Boolean(threat?.detected) && threat.state === 'inbound';
  const findThreat = id => state.threats.find(t => t.id === id) ?? null;
  const selectedTrack = () => { const threat = findThreat(state.selectedId); return isTrack(threat) ? threat : null; };
  const revealsDecoys = () => economy.itemLevel('analyzer') > 0;
  // Whether a track counts as populated to the player (spec §4): a populated threat, or a decoy that the Signature
  // analyzer has not revealed. Selection, ALERT and Auto-alert all go by this, so nothing gives a decoy away.
  const countsAsPopulated = threat => threat.populated || (threat.decoy && !revealsDecoys());

  // Spec §4: the most urgent track is the detected inbound one closest to impact that counts as populated. Null when
  // there is none.
  const mostUrgent = () => sortedDetectedThreats(state).find(countsAsPopulated) ?? null;

  // Endless pays whole points; the fraction waits in scoreCarry.
  function addScore(points) {
    scoreCarry += points;
    const whole = Math.floor(scoreCarry);
    scoreCarry -= whole;
    state.score += whole;
  }

  // --- Games, rounds, waves ---

  // HOLD FIRE and a jamming end with their round (or game), and the views hear of it when they were on. That end of
  // a jamming carries no `elapsed`: nobody cleared it, so the clearJam mission cannot complete on it.
  function switchOff() {
    if (state.hold) {
      state.hold = false;
      emit('hold:changed', { on: false });
    }
    if (state.jammed) {
      state.jammed = false;
      emit('hazard:jamming', { on: false });
    }
  }

  function newGame(mode) {
    switchOff();
    Object.assign(state, freshState(), { mode });
    schedule = null;
    tracker = null;
    resumePhase = null;
    scoreCarry = 0;
    tutorialShown.clear();
  }

  // A saved checkpoint that a campaign can resume from: a campaign round of the table.
  const resumable = cp => (
    cp?.mode === 'campaign' && Number.isInteger(cp.round) && cp.round >= 1 && cp.round <= ROUNDS.length
  );

  // A new campaign, or with fromCheckpoint the round that the saved checkpoint began (a new campaign when there is
  // no campaign checkpoint).
  function startCampaign({ fromCheckpoint = false } = {}) {
    const cp = fromCheckpoint ? persistence.loadCheckpoint() : null;
    newGame('campaign');
    if (resumable(cp)) {
      applyCheckpoint(state, cp);
      startRound(cp.round);
    } else startRound(1);
  }

  // Endless, from the round after the campaign. After a campaign victory it starts with that victory's coins,
  // interceptors, launcher capacity, shelters and upgrades, and every life.
  function startEndless() {
    const start = persistence.loadRecords().endlessStart;
    newGame('endless');
    if (start && typeof start === 'object') {
      for (const field of ['coins', 'ammo', 'ammoCapacity', 'maxLives']) state[field] = start[field] ?? state[field];
      state.upgrades = { ...start.upgrades };
      state.lives = state.maxLives;
    }
    startRound(ROUNDS.length + 1);
  }

  // Plans round n and starts its first wave. A campaign round first saves the checkpoint that a retry starts from.
  function startRound(n) {
    schedule = planRound(n, rng, config);
    tracker = createMissionTracker(schedule.missions, config);
    fired = new Set();
    Object.assign(state, {
      round: n, wave: 0, waveCount: schedule.waves.length, clockHour: schedule.startHour, missions: tracker.status(),
      threats: [], interceptors: [], selectedId: null, jamElapsed: 0, fireCooldown: 0,
    });
    state.stats.round = emptyStats();
    switchOff(); // after state.missions holds the new tracker's status, which its events are compared with
    if (state.mode === 'campaign') persistence.saveCheckpoint(state);
    const { startHour } = schedule;
    emit('round:start', {
      round: n, mode: state.mode, missions: tracker.status(), startHour, phaseName: phaseName(startHour),
      waveCount: state.waveCount,
    });
    startWave(1);
  }

  function startWave(i) {
    Object.assign(state, { wave: i, waveElapsed: 0, phase: 'wave' });
    state.stats.wave = { shotsWasted: 0, holdAllWave: state.hold };
    emit('wave:start', { wave: i, count: state.waveCount, openOnly: schedule.waves[i - 1].openOnly });
  }

  function endWave() {
    Object.assign(state, { phase: 'breather', breatherLeft: TIMING.breather });
    const { shotsWasted, holdAllWave } = state.stats.wave;
    emit('wave:end', { wave: state.wave, openOnly: schedule.waves[state.wave - 1].openOnly, shotsWasted, holdAllWave });
  }

  // What the summary screens show: the round's stats and the totals, the coins earned in the round, the missions.
  const summaryOf = (livesReplenished = 0) => ({
    round: state.round, mode: state.mode, stats: { ...state.stats.round }, total: { ...state.stats.total },
    impactsPopulated: state.stats.round.impactsPopulated, coinsEarned: state.stats.round.coinsEarned,
    missions: tracker.status(), lives: state.lives, livesReplenished, score: state.score,
  });

  // A life back (up to maxLives) and the stipend, then the missions that judge the whole round are paid before the
  // summary is built, so that it shows them. The last campaign round ends in victory.
  function endRound() {
    const livesReplenished = state.lives < state.maxLives ? 1 : 0;
    if (livesReplenished) {
      state.lives += 1;
      emit('life:gained', { lives: state.lives });
    }
    const stipend = economy.stipend(state.round);
    credit(stipend, false);
    coinsChanged(stipend, 'stipend');
    feedMissions('round:end', { summary: summaryOf(livesReplenished) });
    const summary = summaryOf(livesReplenished);
    const victory = state.mode === 'campaign' && state.round === ROUNDS.length;
    state.phase = victory ? 'victory' : 'summary';
    const rating = victory ? ratingFor(state.stats.total) : null;
    if (victory) {
      const records = persistence.loadRecords();
      persistence.saveRecords({
        ...records,
        campaignVictory: true,
        bestRating: betterRating(records.bestRating, rating),
        endlessStart: checkpointFrom(state),
      });
    }
    emit('round:end', { summary }, { toMissions: false }); // the missions judged the round above, once
    if (victory) emit('campaign:victory', { summary, rating });
  }

  function gameOver() {
    state.phase = 'gameover';
    if (state.mode === 'endless') {
      const records = persistence.loadRecords();
      persistence.saveRecords({
        ...records,
        bestEndlessRound: Math.max(recorded(records.bestEndlessRound), state.round),
        bestEndlessScore: Math.max(recorded(records.bestEndlessScore), state.score),
      });
    }
    emit('game:over', { summary: summaryOf() });
  }

  // --- The frame ---

  // Moves the game on by dt seconds (at most MAX_STEP) in the wave and breather phases; otherwise does nothing.
  function update(dt) {
    if (!inPlay() || !(dt > 0)) return;
    const step = Math.min(dt, MAX_STEP);
    const hour = Math.floor(state.clockHour);
    state.clockHour = advanceClock(state.clockHour, step, DAYNIGHT.hoursPerSecond);
    if (Math.floor(state.clockHour) !== hour) emit('clock:tick', { hour: state.clockHour });
    if (state.mode === 'endless') addScore(ECONOMY.endlessScorePerSecond * step);
    state.fireCooldown = Math.max(0, state.fireCooldown - step);
    if (state.phase === 'breather') {
      tickJamming(step);
      state.breatherLeft -= step;
      if (state.breatherLeft > 0) return;
      if (state.wave < state.waveCount) startWave(state.wave + 1);
      else endRound();
      return;
    }
    state.waveElapsed += step;
    fireDue();
    tickJamming(step);
    if (advanceThreats(step)) return; // the game is over: nothing else moves
    advanceInterceptors(step);
    keep(state.threats, t => t.state === 'inbound');
    keep(state.interceptors, it => it.state === 'flying');
    if (state.selectedId !== null && !findThreat(state.selectedId)) state.selectedId = null;
    const allFired = schedule.waves[state.wave - 1].spawns.every(spawn => fired.has(spawn));
    if (allFired && !state.threats.length && !state.interceptors.length) endWave();
  }

  // Fires every spawn and hazard of the wave that is due and has not fired yet (the schedule is not sorted).
  function fireDue() {
    for (const spawn of schedule.waves[state.wave - 1].spawns) {
      if (spawn.at > state.waveElapsed || fired.has(spawn)) continue;
      fired.add(spawn);
      const { type, zone } = spawn;
      const threat = createThreat({ id: nextThreatId++, type, zone, rng, now: state.waveElapsed });
      state.threats.push(threat);
      count('spawned');
      emit('threat:spawned', { threat });
    }
    for (const hazard of schedule.hazards) {
      if (hazard.wave !== state.wave || hazard.at > state.waveElapsed || fired.has(hazard)) continue;
      fired.add(hazard);
      Object.assign(state, { jammed: true, jamElapsed: 0 });
      log('RADAR JAMMED');
      emit('hazard:jamming', { on: true });
    }
  }

  // A jamming clears by itself after TIMING.jammingDuration.
  function tickJamming(step) {
    if (!state.jammed) return;
    state.jamElapsed += step;
    if (state.jamElapsed >= TIMING.jammingDuration) clearJamming();
  }

  function clearJamming() {
    state.jammed = false;
    log('RADAR RESET');
    emit('hazard:jamming', { on: false, elapsed: state.jamElapsed });
  }

  // Flies the inbound threats on: a threat that lands is resolved, one that comes within range (and the radar is not
  // jammed) is detected. True when an impact ended the game; the threats after it are left as they are.
  function advanceThreats(step) {
    for (const threat of state.threats) {
      if (threat.state !== 'inbound') continue;
      if (advanceThreat(threat, step) === 'impacted') {
        if (resolveImpact(threat)) return true;
      } else if (!threat.detected && !state.jammed && isDetectable(threat, economy.detectionRange())) detect(threat);
    }
    return false;
  }

  function detect(threat) {
    threat.detected = true;
    log(`TRK-${threat.id} NEW TRACK`);
    emit('threat:detected', { threat });
    if (economy.itemLevel('autoAlert') > 0 && countsAsPopulated(threat) && !threat.alerted) alertFor(threat);
  }

  // A decoy burns up, a threat on open ground costs nothing, one on a neighborhood costs a life. True when that
  // was the last life.
  function resolveImpact(threat) {
    const impact = { threat, zone: threat.zone, position: { ...threat.position } };
    if (threat.decoy) {
      log(`TRK-${threat.id} DECOY BURNED UP`);
      emit('threat:impact', { ...impact, populated: false, decoy: true });
      return false;
    }
    if (!threat.populated) {
      count('impactsOpen');
      log('IMPACT · OPEN');
      emit('threat:impact', { ...impact, populated: false, decoy: false });
      return false;
    }
    count('impactsPopulated');
    state.lives -= 1;
    log(`IMPACT · ${zoneName(threat.zone).toUpperCase()}`);
    emit('threat:impact', { ...impact, populated: true, decoy: false });
    emit('life:lost', { lives: state.lives });
    if (state.lives > 0) return false;
    gameOver();
    return true;
  }

  function advanceInterceptors(step) {
    for (const it of state.interceptors) {
      if (it.state !== 'flying') continue;
      const target = findThreat(it.targetId);
      const result = advanceInterceptor(it, target, step, WORLD);
      if (result === 'hit') resolveHit(target, it);
      else if (result === 'missed') resolveMiss(target, it);
      // 'lost': the target is gone; the interceptor is removed without a word.
    }
  }

  // The track is free for another shot once the interceptor that last engaged it is done.
  const release = (threat, it) => { if (threat.engagedBy === it.id) threat.engagedBy = null; };

  // A hit that leaves hits to go only damages the threat; the last one intercepts it and pays its reward.
  function resolveHit(threat, it) {
    threat.hitsRemaining -= 1;
    release(threat, it);
    if (threat.hitsRemaining > 0) {
      log(`TRK-${threat.id} HIT`);
      emit('threat:damaged', { threat, interceptor: it, position: { ...threat.position } });
      return;
    }
    threat.state = 'intercepted';
    const reward = economy.rewardFor(threat.type);
    credit(reward);
    count('intercepted');
    log(`TRK-${threat.id} INTERCEPTED ✓`);
    emit('threat:intercepted', { threat, interceptor: it, position: { ...threat.position }, reward });
    if (reward) coinsChanged(reward, 'intercept');
  }

  function resolveMiss(threat, it) {
    count('missed');
    release(threat, it);
    log(`TRK-${threat.id} MISS`);
    emit('interceptor:missed', { interceptor: it, position: { ...it.position } });
  }

  // --- Commands of the wave ---

  // Selects a track on radar: true, or false (and nothing changes) for an id that is not one.
  function selectTrack(id) {
    if (state.phase !== 'wave' || !isTrack(findThreat(id))) return false;
    state.selectedId = id;
    emit('threat:selected', { id });
    return true;
  }

  // Selects the next track by time to impact (dir < 0: the one before), wrapping around; from no selection the
  // first (the last going back). Returns the selected id, or null when there is no track.
  function cycleSelection(dir = 1) {
    const tracks = sortedDetectedThreats(state);
    if (state.phase !== 'wave' || !tracks.length) return null;
    const at = tracks.findIndex(t => t.id === state.selectedId);
    const next = at < 0 ? (dir < 0 ? tracks.length - 1 : 0) : (at + Math.sign(dir) + tracks.length) % tracks.length;
    selectTrack(tracks[next].id);
    return state.selectedId;
  }

  // Fires one interceptor at the selected track, or with none selected at the most urgent one, which it then selects.
  // { ok: true }, or { ok: false, reason } with the first refusal that holds (spec §6), also emitted; a refusal
  // changes nothing, the selection included.
  function engage() {
    if (state.phase !== 'wave') return { ok: false, reason: 'phase' };
    const refuse = reason => {
      emit('engage:refused', { reason });
      return { ok: false, reason };
    };
    const cost = economy.shotCost();
    if (state.hold) return refuse('hold');
    if (state.jammed) return refuse('jammed');
    if (state.fireCooldown > 0) return refuse('cooldown');
    if (!economy.canAfford(cost)) return refuse('coins');
    if (state.ammo <= 0) return refuse('ammo');
    const target = selectedTrack() ?? mostUrgent();
    if (!target) return refuse('noTarget');
    if (target.engagedBy !== null && target.hitsRemaining <= 1) return refuse('alreadyEngaged');
    if (state.selectedId !== target.id) selectTrack(target.id);
    economy.spend(cost);
    state.ammo -= 1;
    count('shots');
    if (target.zone === 'open' || target.decoy) {
      count('shotsWasted');
      state.stats.wave.shotsWasted += 1;
    }
    state.fireCooldown = economy.fireCooldown();
    const hit = rng() < economy.hitChance(); // rolled now; the flight only plays it out
    const interceptor = createInterceptor({
      id: nextInterceptorId++, from: WORLD.launchPoint, targetId: target.id, hit, speed: WORLD.interceptorSpeed,
    });
    state.interceptors.push(interceptor);
    target.engagedBy = interceptor.id;
    log(`TRK-${target.id} ENGAGED`);
    emit('interceptor:launched', { interceptor, target });
    coinsChanged(-cost, 'shot');
    ammoChanged();
    return { ok: true };
  }

  // Pays the alert for an inbound track that counts as populated, once per track.
  function alertFor(threat) {
    threat.alerted = true;
    credit(ECONOMY.alertReward);
    count('alerts');
    const name = zoneName(threat.zone);
    log(`ALERT · ${name.toUpperCase()}`);
    emit('alert:sounded', { zone: threat.zone, zoneName: name, inTime: true, threatId: threat.id });
    coinsChanged(ECONOMY.alertReward, 'alert');
  }

  // Sounds the alert for the selected track, or with none selected the most urgent one. Refused (alert:sounded with
  // inTime false) when that track does not count as populated or was alerted already. An unrevealed decoy is
  // alerted and paid like a rocket, so ALERT cannot tell them apart.
  function soundAlert() {
    if (state.phase !== 'wave') return { ok: false, reason: 'phase' };
    const target = selectedTrack() ?? mostUrgent();
    if (!target || !countsAsPopulated(target) || target.alerted) {
      emit('alert:sounded', { inTime: false });
      return { ok: false, reason: 'noTarget' };
    }
    alertFor(target);
    return { ok: true };
  }

  // HOLD FIRE, in a wave or a breather. Releasing it during a wave means the wave was not held throughout. Returns
  // whether it is on.
  function toggleHold() {
    if (!inPlay()) return state.hold;
    state.hold = !state.hold;
    if (!state.hold && state.phase === 'wave') state.stats.wave.holdAllWave = false;
    emit('hold:changed', { on: state.hold });
    return state.hold;
  }

  // Clears a jamming: true, or false when there was none to clear.
  function resetRadar() {
    if (!inPlay() || !state.jammed) return false;
    clearJamming();
    return true;
  }

  // HQ's line: a hint at the first mission not done yet, or the all-quiet line. Returns the text, or null outside play.
  function callHQ() {
    if (!inPlay()) return null;
    const open = state.missions.find(m => !m.done);
    const text = open ? `HQ: ${open.text}` : HQ_IDLE;
    emit('hq:line', { text, uavOnRadar: sortedDetectedThreats(state).some(t => t.type === 'uav') });
    return text;
  }

  // --- Between rounds ---

  function continueFromSummary() {
    if (state.phase !== 'summary') return false;
    state.phase = 'shop';
    emit('shop:open', { round: state.round });
    return true;
  }

  // Runs a purchase in the shop and reports what it changed. Returns the economy's result.
  function purchase(itemId, run) {
    if (state.phase !== 'shop') return { ok: false, reason: 'phase' };
    const { coins, ammo, ammoCapacity, lives } = state;
    const result = run();
    if (!result.ok) return result;
    emit('shop:purchased', { itemId, level: result.level ?? result.bought });
    if (state.coins !== coins) coinsChanged(state.coins - coins, 'shop');
    if (state.ammo !== ammo || state.ammoCapacity !== ammoCapacity) ammoChanged();
    if (state.lives !== lives) emit('life:gained', { lives: state.lives });
    return result;
  }

  function leaveShop() {
    if (state.phase !== 'shop') return false;
    startRound(state.round + 1);
    return true;
  }

  // --- Pause ---

  function pause() {
    if (!inPlay()) return false;
    resumePhase = state.phase;
    state.phase = 'paused';
    return true;
  }

  function resume() {
    if (state.phase !== 'paused') return false;
    state.phase = resumePhase;
    return true;
  }

  return {
    state,
    economy,
    get missions() { return tracker; }, // the round's mission tracker; state.missions holds its status
    get schedule() { return schedule; }, // the round's plan from the director
    startCampaign, retryRound: () => startCampaign({ fromCheckpoint: true }), startEndless, startRound, update,
    selectTrack, cycleSelection, mostUrgent, revealsDecoys, engage, soundAlert, toggleHold, resetRadar, callHQ,
    continueFromSummary, leaveShop, pause, resume,
    buy: itemId => purchase(itemId, () => economy.buy(itemId)),
    restock: n => purchase('restock', () => economy.restock(n)),
  };
}
