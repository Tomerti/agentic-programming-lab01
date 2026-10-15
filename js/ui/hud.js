// The 2D HUD over the room (spec §8): the resources bar across the top of the view (coins, interceptors, lives,
// round and wave, clock, score), the mission line under it with the selected track, the toasts at the bottom and
// the round and wave banners over the window. It shows the game and never changes it: it reads session.state,
// listens to the bus and calls no session command. update(dt) runs every frame, repaints what changed and runs
// the timers; the events that change a resource repaint at once too, so the bar is right as soon as such an
// event has been handled. It builds its markup in the empty containers of index.html, found inside `root`.
import { ECONOMY, THREATS, WORLD } from '../config.js';
import { formatClock, phaseName } from '../game/daynight.js';
import { formatCoins } from '../game/economy.js';
import { timeToImpact } from '../game/threats.js';

// The low-resource thresholds (spec §8) and the HUD's timings, in seconds.
const HUD = Object.freeze({
  lowCoinShots: 2, // coins are low below the cost of this many shots,
  lowAmmo: 3, // interceptors at or below this many
  lowLives: 2, // and lives at or below this many
  warningEvery: 8, // while anything is low, onLowResource() runs at most once in this many seconds
  pop: 0.3, // a value that changes pops this long
  scorePopMin: 10, // a smaller rise does not pop the score: Endless adds a few points every frame
  toast: 2.5, // how long a toast shows
  tutorialToast: 5, // how long a tutorial toast shows
  maxToasts: 3, // a fourth toast takes the place of the one with the least time left
  roundBanner: 2.2,
  waveBanner: 1.2,
  fadeOut: 0.35, // a toast or a banner fades out over its last this many seconds
});

// What a refused ENGAGE says, by the session's reason (spec §6).
const REFUSALS = Object.freeze({
  hold: 'HOLD FIRE is on',
  jammed: 'RADAR JAMMED: press RESET RADAR',
  cooldown: 'Launcher reloading',
  coins: 'Not enough coins',
  ammo: 'No interceptors left: restock in the shop',
  noTarget: 'No track to engage',
  alreadyEngaged: 'Interceptor already in flight',
});
// What a refused ALERT says, by the session's reason (spec §6).
const ALERT_REFUSALS = Object.freeze({
  noTarget: 'No populated track to alert',
  alreadyAlerted: 'Already alerted',
});

const TOAST_KINDS = ['info', 'warn', 'good'];
const COIN = '◎'; // the coin sign in toasts
const PLAYING = ['wave', 'breather']; // the phases of a running round
// The events after which the bar and the mission line repaint at once; update() catches everything else.
const REPAINT_ON = [
  'coins:changed', 'ammo:changed', 'life:lost', 'life:gained', 'round:start', 'wave:start', 'mission:progress',
  'mission:complete', 'shop:purchased', 'threat:selected',
];

// One shield per life the shelters can ever hold. The lives cell marks each one on (a life), dim (a life lost,
// below maxLives) or slot (above maxLives: Reinforced shelters can add it).
const SHIELD = '<svg class="shield slot" viewBox="0 0 24 28" aria-hidden="true">'
  + '<path d="M12 1.6 21.6 5.2v7.3c0 6.3-4 10.8-9.6 13.6C6.4 23.3 2.4 18.8 2.4 12.5V5.2Z"/></svg>';

// The bar: six cells, each a small label over a large value, which createHud fills in. The clock's label is the
// phase of the day.
const BAR = `
<div class="hud-cell hud-coins" id="hud-coins">
  <span class="hud-label">Coins</span>
  <span class="hud-row">
    <span class="hud-value"><span class="hud-coin" aria-hidden="true"></span><span class="hud-num"></span></span>
  </span>
</div>
<div class="hud-cell hud-ammo" id="hud-ammo">
  <span class="hud-label">Interceptors</span>
  <span class="hud-row">
    <span class="hud-value"><span class="hud-num"></span><span class="hud-of"></span></span>
    <span class="hud-gauge"><span id="hud-ammo-bar"></span></span>
  </span>
</div>
<div class="hud-cell hud-lives" id="hud-lives">
  <span class="hud-label">Lives</span>
  <span class="hud-row"><span class="hud-value">${SHIELD.repeat(ECONOMY.maxLivesCap)}</span></span>
</div>
<div class="hud-cell hud-round" id="hud-round">
  <span class="hud-label">Round</span>
  <span class="hud-row"><span class="hud-value"><span class="hud-num"></span><span class="hud-of"></span></span></span>
</div>
<div class="hud-cell hud-clock" id="hud-clock">
  <span class="hud-label"></span>
  <span class="hud-row">
    <span class="hud-value"><span class="hud-sky" aria-hidden="true"></span><span class="hud-num"></span></span>
  </span>
</div>
<div class="hud-cell hud-score" id="hud-score">
  <span class="hud-label">Score</span>
  <span class="hud-row"><span class="hud-value"><span class="hud-num"></span></span></span>
</div>`;

// The selected track named as the threat screen names it (monitors.js): a decoy that the Signature analyzer
// has not revealed passes for a rocket on a neighborhood here too.
const looksPopulated = (threat, revealDecoys) => threat.populated || (threat.decoy && !revealDecoys);
const typeLabel = (threat, revealDecoys) => {
  if (threat.decoy && revealDecoys) return 'DECOY';
  return (threat.decoy ? THREATS.rocket : THREATS[threat.type]).name.toUpperCase();
};
const zoneLabel = zone => (
  zone === 'open' ? 'OPEN' : (WORLD.neighborhoods.find(n => n.id === zone)?.name ?? zone).toUpperCase()
);

const span = (className, text) => {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
};

// Puts `className` back on `el` so that its animation starts over: the reflow in between restarts it.
function restartClass(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

// createHud({ root, bus, session, settings, onLowResource }): `root` holds the #hud, #mission-line, #toasts and
// #banner containers; settings.reduceMotion (read every frame) calms the pulses and pops; onLowResource() is
// called while a resource is low, at most once every HUD.warningEvery seconds, and only while the bar shows and
// a wave or a breather is being played.
export function createHud({ root, bus, session, settings = {}, onLowResource = () => {} }) {
  const { state, economy } = session;
  const find = selector => root.querySelector(selector);
  const bar = find('#hud');
  const missionLine = find('#mission-line');
  const toastStack = find('#toasts');
  const bannerBox = find('#banner');
  bar.innerHTML = BAR;
  missionLine.innerHTML = '<span class="ml-missions"></span><span class="ml-track"></span>';
  bannerBox.innerHTML = '<div class="banner-title"></div><div class="banner-sub"></div>';
  toastStack.setAttribute('aria-live', 'polite');

  // --- The bar ---

  const shields = [...bar.querySelectorAll('.shield')];
  const ammoBar = find('#hud-ammo-bar');
  // Each cell: `key()` is a text that changes whenever what the cell shows changes, `paint(cell)` shows it,
  // `pops(before, now)` tells whether a change of key pops the value (any change does by default) and `isLow()`
  // whether the resource is low.
  const cells = [
    {
      id: 'coins',
      key: () => String(state.coins),
      paint: ({ num }) => { num.textContent = formatCoins(state.coins); },
      isLow: () => state.coins < HUD.lowCoinShots * economy.shotCost(),
    },
    {
      id: 'ammo',
      key: () => `${state.ammo}/${state.ammoCapacity}`,
      paint: ({ num, of }) => {
        num.textContent = state.ammo;
        of.textContent = `/${state.ammoCapacity}`;
        ammoBar.style.width = `${Math.min(Math.max(state.ammo / state.ammoCapacity, 0), 1) * 100}%`;
      },
      isLow: () => state.ammo <= HUD.lowAmmo,
    },
    {
      id: 'lives',
      key: () => `${state.lives}/${state.maxLives}`,
      paint: () => shields.forEach((shield, i) => {
        const look = i < state.lives ? 'on' : i < state.maxLives ? 'dim' : 'slot';
        shield.setAttribute('class', `shield ${look}`);
      }),
      isLow: () => state.lives <= HUD.lowLives,
    },
    {
      id: 'round',
      key: () => `${state.round} · Wave ${state.wave}/${state.waveCount}`,
      paint: ({ num, of }) => {
        num.textContent = state.round;
        of.textContent = ` · Wave ${state.wave}/${state.waveCount}`;
      },
    },
    {
      id: 'clock',
      key: () => `${phaseName(state.clockHour)} ${formatClock(state.clockHour)}`,
      paint: ({ el, label, sky, num }) => {
        const phase = phaseName(state.clockHour);
        el.classList.toggle('night', phase === 'night');
        label.textContent = phase;
        sky.textContent = phase === 'night' ? '☾' : '☀\uFE0E'; // U+FE0E: the text sun, not the emoji
        num.textContent = formatClock(state.clockHour);
      },
      pops: () => false, // the clock runs on: it would never stop popping
    },
    {
      id: 'score',
      key: () => String(state.score),
      paint: ({ num }) => { num.textContent = state.score; },
      pops: (before, now) => Number(now) - Number(before) >= HUD.scorePopMin,
    },
  ].map(spec => {
    const el = find(`#hud-${spec.id}`);
    const part = name => el.querySelector(`.hud-${name}`);
    return {
      ...spec, el, label: part('label'), num: part('num'), of: part('of'), sky: part('sky'),
      shown: null, // the key on screen
      popLeft: 0, // seconds the pop still runs
      low: false,
    };
  });
  let anyLow = false;

  function popCell(cell) {
    restartClass(cell.el, 'pop');
    cell.popLeft = HUD.pop;
  }

  function paintBar() {
    anyLow = false;
    for (const cell of cells) {
      const key = cell.key();
      if (key !== cell.shown) {
        const before = cell.shown;
        cell.shown = key;
        cell.paint(cell);
        if (before !== null && (cell.pops?.(before, key) ?? true)) popCell(cell);
      }
      const low = Boolean(cell.isLow?.());
      if (low !== cell.low) {
        cell.low = low;
        cell.el.classList.toggle('low', low);
      }
      anyLow ||= low;
    }
  }

  // --- The mission line ---

  const missionsBox = missionLine.querySelector('.ml-missions');
  const trackBox = missionLine.querySelector('.ml-track');
  let missionsShown = null;
  let trackShown = null;

  // The selected track, or null: none is selected, it is gone, or the radar is jammed (which shows no track).
  function selectedTrack() {
    if (state.jammed || state.selectedId === null) return null;
    const threat = state.threats.find(t => t.id === state.selectedId);
    return threat?.detected && threat.state === 'inbound' ? threat : null;
  }

  // Each mission as "text · progress/goal" (✓ when done), the missions apart by " · ", then " — " and the
  // selected track as "TRK-217 · ROCKET → GILO · 6.4 s", its time to impact counting down.
  function paintMissionLine() {
    const { missions } = state;
    const missionsKey = missions.map(m => `${m.text}|${m.progress}|${m.goal}|${m.done}`).join('\n');
    if (missionsKey !== missionsShown) {
      missionsShown = missionsKey;
      missionsBox.replaceChildren(...missions.flatMap((m, i) => {
        const mission = span(m.done ? 'ml-mission done' : 'ml-mission', `${m.text} · `);
        mission.append(span('ml-progress', m.done ? '✓' : `${m.progress}/${m.goal}`));
        return i ? [span('ml-sep', ' · '), mission] : [mission];
      }));
    }
    const track = selectedTrack();
    let trackKey = '';
    if (track) {
      const reveal = session.revealsDecoys();
      const parts = {
        lead: missions.length ? ' — ' : '',
        id: `TRK-${track.id}`,
        type: typeLabel(track, reveal),
        zone: zoneLabel(track.zone),
        hostile: looksPopulated(track, reveal),
        time: `${timeToImpact(track).toFixed(1)} s`,
      };
      trackKey = Object.values(parts).join('|');
      if (trackKey !== trackShown) {
        trackBox.replaceChildren(parts.lead, span('ml-id', parts.id), ` · ${parts.type} → `,
          span(parts.hostile ? 'ml-zone hostile' : 'ml-zone', parts.zone), ' · ', span('ml-time', parts.time));
      }
    } else if (trackShown) trackBox.replaceChildren();
    trackShown = trackKey;
    missionLine.classList.toggle('empty', !missionsKey && !trackKey);
  }

  function refresh() {
    paintBar();
    paintMissionLine();
  }

  // --- Toasts ---

  const toasts = []; // on screen, oldest first: { el, text, left } with `left` the seconds still to show

  function dropToast(item) {
    item.el.remove();
    toasts.splice(toasts.indexOf(item), 1);
  }

  // Shows `text` at the bottom for `seconds`. A text already on screen is not stacked again: that toast nudges
  // and its time starts over.
  function toast(text, kind = 'info', seconds = HUD.toast) {
    const message = String(text);
    const same = toasts.find(item => item.text === message);
    if (same) {
      same.left = Math.max(same.left, seconds);
      same.el.classList.remove('leaving');
      restartClass(same.el, 'bump');
      return;
    }
    if (toasts.length >= HUD.maxToasts) dropToast(toasts.reduce((a, b) => (b.left < a.left ? b : a)));
    const el = document.createElement('div');
    el.className = `toast toast-${TOAST_KINDS.includes(kind) ? kind : 'info'}`;
    el.textContent = message;
    toastStack.append(el);
    toasts.push({ el, text: message, left: seconds });
  }

  function tickToasts(step) {
    for (const item of [...toasts]) {
      item.left -= step;
      if (item.left <= 0) dropToast(item);
      else item.el.classList.toggle('leaving', item.left <= HUD.fadeOut);
    }
  }

  function clearToasts() {
    for (const item of [...toasts]) dropToast(item);
  }

  // --- Banners ---

  const bannerTitle = bannerBox.querySelector('.banner-title');
  const bannerSub = bannerBox.querySelector('.banner-sub');
  let bannerLeft = 0; // seconds the banner on screen still shows
  let nextBanner = null; // a wave banner waiting for the banner on screen to end

  function showBanner({ title, subtitle = '', small = false, seconds }) {
    bannerTitle.textContent = title;
    bannerSub.textContent = subtitle;
    bannerSub.hidden = !subtitle;
    bannerBox.classList.toggle('small', small);
    bannerBox.classList.remove('leaving');
    bannerBox.hidden = false;
    restartClass(bannerBox, 'on');
    bannerLeft = seconds;
  }

  function clearBanner() {
    bannerLeft = 0;
    bannerBox.hidden = true;
    bannerBox.classList.remove('on', 'leaving');
  }

  // A large banner over the window for HUD.roundBanner seconds, at once.
  function banner(title, subtitle = '') {
    nextBanner = null;
    showBanner({ title, subtitle, seconds: HUD.roundBanner });
  }

  // The small wave banner, which names a wave whose threats all fall on open ground (the wave that the holdWave
  // mission asks HOLD FIRE for). It waits for a banner on screen: a round's first wave starts under the round banner.
  function waveBanner(wave, count, openOnly = false) {
    const title = `WAVE ${wave} / ${count}${openOnly ? ' · OPEN GROUND' : ''}`;
    const next = { title, small: true, seconds: HUD.waveBanner };
    if (bannerLeft > 0) nextBanner = next;
    else showBanner(next);
  }

  function tickBanner(step) {
    if (bannerLeft <= 0) return;
    bannerLeft -= step;
    if (bannerLeft > 0) {
      bannerBox.classList.toggle('leaving', bannerLeft <= HUD.fadeOut);
      return;
    }
    clearBanner();
    if (nextBanner) {
      const next = nextBanner;
      nextBanner = null;
      showBanner(next);
    }
  }

  // --- Showing, motion, the frame ---

  let shown = false;
  function show() {
    shown = true;
    bar.hidden = false;
    missionLine.hidden = false;
    refresh();
  }

  // Hides the bar and the mission line and clears the banners and the toasts, so that none lingers under the screen
  // that hid the HUD (the title, a summary, the shop): what they said belongs to the round.
  function hide() {
    shown = false;
    bar.hidden = true;
    missionLine.hidden = true;
    nextBanner = null;
    clearBanner();
    clearToasts();
  }

  let reduced = null; // whether the reduce-motion class is on
  function syncMotion() {
    const on = Boolean(settings.reduceMotion);
    if (on === reduced) return;
    reduced = on;
    root.classList.toggle('reduce-motion', on);
  }

  let sinceWarning = Infinity; // seconds since onLowResource() last ran
  function update(dt) {
    const step = dt > 0 ? dt : 0;
    syncMotion();
    for (const cell of cells) {
      if (cell.popLeft > 0 && (cell.popLeft -= step) <= 0) cell.el.classList.remove('pop');
    }
    tickToasts(step);
    tickBanner(step);
    refresh();
    sinceWarning += step;
    if (shown && anyLow && PLAYING.includes(state.phase) && sinceWarning >= HUD.warningEvery) {
      sinceWarning = 0;
      onLowResource();
    }
  }

  // What the session's events show besides the values: banners, toasts, and the bar's coming and going.
  const reactions = {
    'round:start': ({ round, phaseName: phase, waveCount }) => {
      show();
      const phaseNow = (phase ?? phaseName(state.clockHour)).toUpperCase();
      banner(`ROUND ${round}`, `${phaseNow} · ${waveCount ?? state.waveCount} waves`);
    },
    'wave:start': ({ wave, count, openOnly }) => waveBanner(wave, count, openOnly),
    'engage:refused': ({ reason }) => {
      if (Object.hasOwn(REFUSALS, reason)) toast(REFUSALS[reason], 'warn');
    },
    'alert:sounded': ({ inTime, zoneName, reason }) => {
      if (inTime) toast(`Alert sounded in ${zoneName} · +${formatCoins(ECONOMY.alertReward)}${COIN}`, 'good');
      else toast(Object.hasOwn(ALERT_REFUSALS, reason) ? ALERT_REFUSALS[reason] : ALERT_REFUSALS.noTarget, 'warn');
    },
    'hq:line': ({ text }) => toast(text, 'info'),
    'hazard:jamming': ({ on }) => {
      if (on) toast(REFUSALS.jammed, 'warn');
    },
    // Named, so that two missions completing at once give two toasts, not one merged one.
    'mission:complete': ({ id, reward }) => {
      const mission = state.missions.find(m => m.id === id);
      toast(`Mission complete: ${mission ? `${mission.text} · ` : ''}+${formatCoins(reward)}${COIN}`, 'good');
    },
    'tutorial:show': ({ text }) => toast(text, 'info', HUD.tutorialToast),
    'game:over': hide,
    'campaign:victory': hide,
  };
  for (const [type, react] of Object.entries(reactions)) bus.on(type, react);
  for (const type of REPAINT_ON) bus.on(type, refresh);

  syncMotion();
  refresh();
  if (PLAYING.includes(state.phase)) show();

  return { update, toast, banner, show, hide };
}
