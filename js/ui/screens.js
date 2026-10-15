// The screens over the room (spec §8): the title, how to play, pause, settings, the round summary, game over and
// victory. show(name, data) builds a screen afresh and puts it in the overlay container (#overlay) in place of
// whatever was there, so one screen shows at a time; the shop (shop.js) takes the same container, built with the
// helpers exported here. A screen is an element with the classes `screen screen-<name>` and data-screen="<name>"
// that covers the view, dims the room and holds the screen's panel; `current` names the one shown. The screens
// change the game only through the session's commands. main.js shows them on the session's events and keeps the
// pointer away from the room while one is up. `settings` is the object that the scene, the effects and the HUD
// read: the settings screen changes it in place, saves it and reports the change.
import { ECONOMY, ROUNDS } from '../config.js';
import { formatCoins } from '../game/economy.js';

// The screens that hide the HUD. The pause screen dims the round with its HUD, and settings and how to play leave
// the HUD as the screen that opened them had it.
const HIDES_HUD = new Set(['title', 'summary', 'gameover', 'victory']);
// The screens that another screen opens; their Back button returns to it.
const SUBSCREENS = new Set(['settings', 'howto']);
const RATINGS = ['S', 'A', 'B', 'C'];

// --- Markup, shared with the shop ---

// A DOM element: h('button', { id: 'btn-x', class: 'btn', onclick }, 'Label', child). An attribute that is false,
// null or undefined is left out and true sets it empty; an `on…` attribute adds that event's listener. Children are
// nodes, strings or numbers, in arrays or not; null, undefined and false are skipped. Text stays text: nothing is
// parsed as HTML.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  el.append(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
  return el;
}

// The HUD's coin, and an amount of coins: the coin, then the number with an optional sign, written as the HUD writes
// the coins (formatCoins).
export const coin = () => h('span', { class: 'coin', 'aria-hidden': 'true' });
export const amount = (value, sign = '') => h('span', { class: 'amount' }, coin(), `${sign}${formatCoins(value)}`);

// A button: `kind` 'primary' (the screen's main action), 'danger' or none; `note` a second, smaller text in it,
// such as why it is disabled.
export function button(id, label, onclick, { kind = null, note = null, disabled = false } = {}) {
  return h('button', { type: 'button', id, class: kind ? `btn ${kind}` : 'btn', disabled, onclick },
    h('span', { class: 'btn-label' }, label), note && h('span', { class: 'btn-note' }, note));
}

// A screen's root, which covers the view: the classes and data-screen that name it, and its content.
export function screenElement(name, label, ...content) {
  return h('div', {
    class: `screen screen-${name}`, 'data-screen': name, role: 'dialog', 'aria-modal': 'true', 'aria-label': label,
  }, ...content);
}

// Gives the keyboard to the screen's main button, or else to its first control.
export function focusIn(screen) {
  const target = screen.querySelector('.btn.primary:not(:disabled)')
    ?? screen.querySelector('button:not(:disabled), input');
  target?.focus({ preventScroll: true });
}

// A screen whose content is a glass panel: the title (with a badge before it, if any) and a line under it, the
// body, the actions (`stack`: one under the other) and a note at the foot. `tone` 'alarm' marks the panel red.
function panelScreen(name, title, {
  sub = null, badge = null, body = [], actions = [], stack = false, note = null, tone = null,
}) {
  return screenElement(name, title,
    h('section', { class: tone ? `panel ${tone}` : 'panel' },
      h('header', { class: 'panel-head' },
        badge,
        h('div', { class: 'panel-heading' },
          h('h1', { class: 'panel-title' }, title), sub && h('p', { class: 'panel-sub' }, sub))),
      body,
      h('div', { class: stack ? 'actions stack' : 'actions' }, actions),
      note && h('p', { class: 'panel-note' }, note)));
}

// A row of figures like the HUD's cells, a small label over a large value, apart by thin rules. Each row is
// [label, value, tone], where the tone 'good', 'bad', 'warn', 'gold' or 'lives' colours the value.
function figures(rows, kind = null) {
  return h('dl', { class: kind ? `figures ${kind}` : 'figures' },
    rows.map(([label, value, tone]) => h('div', { class: tone ? `figure ${tone}` : 'figure' },
      h('dt', {}, label), h('dd', {}, value))));
}

// A count's tone: `tone` when the count is above zero, none at zero.
const ifAny = (count, tone) => (count > 0 ? tone : null);
const modeName = mode => (mode === 'endless' ? 'Endless' : 'Campaign');

// The game's totals that game over and victory show: the battle's figures (and `extra` ones after them), then the
// coins and the score in larger type.
const totals = (total, score, extra = []) => [
  figures([
    ['Intercepted', total.intercepted ?? 0, 'good'],
    ['Populated impacts', total.impactsPopulated ?? 0, ifAny(total.impactsPopulated, 'bad')],
    ['Wasted shots', total.shotsWasted ?? 0, ifAny(total.shotsWasted, 'warn')],
    ['Missions done', total.missionsDone ?? 0],
    ...extra,
  ]),
  figures([['Coins earned', amount(total.coinsEarned ?? 0), 'gold'], ['Score', score ?? 0]], 'major'),
];

// createScreens({ root, session, persistence, settings, audio, onSettingsChange, hud }) → { show(name, data), hide(),
// current }. `root` is the overlay container or its selector, `persistence` createPersistence's object, `settings`
// the loaded settings object (changed in place), `audio` the sound (it may be null: every call to it is guarded),
// onSettingsChange(settings) runs after each change of a setting, and `hud` is hidden by the screens that cover
// the game. show(name, data): 'title', 'howto', 'pause', 'settings', 'summary' (data: the round:end summary),
// 'gameover' (the game:over summary) or 'victory' (campaign:victory's { summary, rating }). hide() empties the
// container, so that the pointer reaches the room again. current: the name of the screen shown, the shop's
// ('shop') included, or null.
export function createScreens({
  root, session, persistence, settings, audio = null, onSettingsChange = () => {}, hud = null,
}) {
  const host = typeof root === 'string' ? document.querySelector(root) : root;
  const { state } = session;
  let backTo = null; // the screen that settings and how to play return to; null returns to the round

  const current = () => host.firstElementChild?.dataset.screen ?? null;

  function show(name, data) {
    const build = builders[name];
    if (!build) throw new Error(`unknown screen "${name}"`);
    const from = current();
    if (SUBSCREENS.has(name) && !SUBSCREENS.has(from)) backTo = from;
    if (HIDES_HUD.has(name)) hud?.hide();
    const screen = build(data);
    if (!host.firstElementChild) screen.classList.add('entering'); // over the game, not over another screen
    host.replaceChildren(screen);
    focusIn(screen);
  }

  function hide() {
    host.replaceChildren();
  }

  const back = () => (backTo ? show(backTo) : hide());
  const toTitle = () => show('title');

  // Starts play from a button. The sound unlocks first, within the click (browsers let a page start its audio only
  // on a gesture), then the session's command runs. The audio may be missing or refuse: the game plays on.
  function play(command) {
    try {
      Promise.resolve(audio?.unlock?.()).catch(() => {});
    } catch {
      // No sound: the game plays on without it.
    }
    command();
  }

  // The round that a campaign resumes from the saved checkpoint, or null when there is none to resume:
  // session.startCampaign({ fromCheckpoint }) resumes only a campaign round of the table, and starts afresh otherwise.
  function checkpointRound() {
    const checkpoint = persistence.loadCheckpoint();
    const { mode, round } = checkpoint ?? {};
    return mode === 'campaign' && Number.isInteger(round) && round >= 1 && round <= ROUNDS.length ? round : null;
  }

  // Asks before an action that cannot be undone, in place of `slot`'s content: the question, the action's button
  // (#btn-confirm) and Cancel (#btn-cancel), which puts the content back and the keyboard on `back`. A panel in the
  // page, never the browser's confirm(): the game keeps the screen (and an automated check could not answer it).
  function ask(slot, { text, action, onConfirm, back: backFocus = null }) {
    const content = [...slot.childNodes];
    const cancel = () => {
      slot.replaceChildren(...content);
      backFocus?.focus({ preventScroll: true });
    };
    const box = h('div', { class: 'confirm', role: 'alertdialog', 'aria-label': text },
      h('p', { class: 'confirm-text' }, text),
      h('div', { class: 'confirm-actions' },
        button('btn-confirm', action, onConfirm, { kind: 'danger' }),
        button('btn-cancel', 'Cancel', cancel)));
    slot.replaceChildren(box);
    box.querySelector('#btn-cancel').focus({ preventScroll: true });
  }

  // --- The screens ---

  function title() {
    const records = persistence.loadRecords();
    const round = checkpointRound();
    const newCampaign = () => play(() => session.startCampaign());
    const start = button('btn-start', 'Start shift', () => {
      if (round === null) newCampaign();
      else {
        ask(menu, {
          text: `Start a new campaign? It replaces your checkpoint at round ${round}.`,
          action: 'Start new campaign', onConfirm: newCampaign, back: start,
        });
      }
    }, { kind: round === null ? 'primary' : null });
    const unlocked = records.campaignVictory === true;
    const menu = h('div', { class: 'menu' },
      round !== null && button('btn-continue', `Continue from round ${round}`,
        () => play(() => session.startCampaign({ fromCheckpoint: true })), { kind: 'primary' }),
      start,
      button('btn-endless', 'Endless', () => play(() => session.startEndless()),
        { disabled: !unlocked, note: unlocked ? null : 'Finish the campaign to unlock' }),
      button('btn-howto', 'How to play', () => show('howto')),
      button('btn-settings', 'Settings', () => show('settings')));
    const best = [
      typeof records.bestRating === 'string' && h('span', {}, 'Best rating: ', h('b', {}, records.bestRating)),
      records.bestEndlessRound > 0 && h('span', {},
        'Best endless: ', h('b', {}, `round ${records.bestEndlessRound} · score ${records.bestEndlessScore}`)),
    ].filter(Boolean);
    return screenElement('title', 'Iron Dome: Jerusalem Battery',
      h('div', { class: 'title-block' },
        h('h1', { class: 'logo' }, h('span', {}, 'IRON'), ' ', h('span', {}, 'DOME')),
        h('p', { class: 'logo-sub' }, 'JERUSALEM BATTERY'),
        h('p', { class: 'tagline' }, 'You are the battery chief. Keep the city covered.'),
        menu,
        best.length > 0 && h('p', { class: 'records' }, best)));
  }

  // The console's controls as their label plates read, with the colour of their caps, then the other inputs.
  function controlsTable() {
    const rows = [
      ['Select a track', null, ['Tab', '1–5'],
        'Click its blip on the radar or its row in the threat list. Tab steps through the tracks, 1–5 pick a row.'],
      ['ENGAGE', 'red', ['Space'], 'Fire an interceptor at the selected track, or at the most urgent one'],
      ['ALERT', 'amber', ['A'], ['Warn the neighborhood under the track: ', amount(ECONOMY.alertReward, '+')]],
      ['HOLD FIRE', 'blue', ['H'], 'Lock ENGAGE while its lamp is lit'],
      ['RESET RADAR', 'grey', ['R'], 'Clear a jammed radar'],
      ['Radar zoom', null, ['Z'], 'Switch the radar between 1× and 2×, as the dial does'],
      ['Sound', null, ['M'], 'Mute or unmute'],
      ['Pause', null, ['Esc'], 'Pause the round'],
    ];
    return h('table', { class: 'controls' }, h('tbody', {}, rows.map(([name, cap, keys, does]) => h('tr', {},
      h('th', { scope: 'row', class: cap ? 'plate' : null },
        cap && h('span', { class: `cap cap-${cap}`, 'aria-hidden': 'true' }), name),
      h('td', { class: 'keys' }, keys.map(key => h('kbd', {}, key))),
      h('td', {}, does)))));
  }

  function howto() {
    return panelScreen('howto', 'How to play', {
      body: [
        h('section', { class: 'howto-block' }, h('h2', { class: 'section-title' }, 'Controls'), controlsTable()),
        h('div', { class: 'howto-columns' },
          h('section', { class: 'howto-block' },
            h('h2', { class: 'section-title' }, 'Open ground'),
            h('p', { class: 'rule' }, h('span', { class: 'blip red', 'aria-hidden': 'true' }),
              'Red tracks fall on a neighborhood: an impact there costs a life.'),
            h('p', { class: 'rule' }, h('span', { class: 'blip grey', 'aria-hidden': 'true' }),
              'Grey tracks land on open ground: let them fall and save interceptors.')),
          h('section', { class: 'howto-block' },
            h('h2', { class: 'section-title' }, 'Resources'),
            h('dl', { class: 'resources' },
              h('dt', { class: 'coins' }, 'Coins'),
              h('dd', {}, 'Every shot costs ', amount(ECONOMY.shotCost),
                '. Interceptions, alerts and missions pay, and each round ends with a stipend.'),
              h('dt', { class: 'ammo' }, 'Interceptors'),
              h('dd', {}, 'One per shot, and they do not come back by themselves: restock in the shop between rounds, ',
                amount(ECONOMY.restockCost), ' each.'),
              h('dt', { class: 'lives' }, 'Lives'),
              h('dd', {}, 'An impact on a neighborhood costs one, and every round you finish gives one back. '
                + 'Lose them all and the city falls.')))),
      ],
      actions: [button('btn-back', 'Back', back)],
    });
  }

  function pause() {
    const { mode, round, wave, waveCount } = state;
    return panelScreen('pause', 'Paused', {
      sub: `${modeName(mode)} · round ${round} · wave ${wave}/${waveCount}`,
      actions: [
        button('btn-resume', 'Resume', () => {
          session.resume();
          hide();
        }, { kind: 'primary' }),
        button('btn-settings', 'Settings', () => show('settings')),
        button('btn-quit', 'Quit to title', toTitle),
      ],
      stack: true,
      note: 'Esc resumes the round.',
    });
  }

  function settingsScreen() {
    // A change is made in the settings object itself, which the scene, the effects and the HUD read, then saved.
    const changed = () => {
      persistence.saveSettings(settings);
      onSettingsChange(settings);
    };
    const percent = value => `${Math.round(value * 100)}%`;
    const startVolume = Math.min(Math.max(Number(settings.volume) || 0, 0), 1);
    const volumeText = h('output', { class: 'setting-value', for: 'set-volume' }, percent(startVolume));
    // --fill: how much of the slider's track is lit.
    const volume = h('input', {
      type: 'range', id: 'set-volume', min: 0, max: 100, step: 5, value: Math.round(startVolume * 100),
      style: `--fill: ${percent(startVolume)}`,
      oninput: () => {
        settings.volume = Number(volume.value) / 100;
        volumeText.textContent = percent(settings.volume);
        volume.style.setProperty('--fill', percent(settings.volume));
        audio?.setVolume?.(settings.volume);
        changed();
      },
    });
    const toggle = (id, key, label, hint, apply = null) => {
      const input = h('input', {
        type: 'checkbox', id, class: 'switch', checked: Boolean(settings[key]),
        onchange: () => {
          settings[key] = input.checked;
          apply?.(input.checked);
          changed();
        },
      });
      return h('div', { class: 'setting' },
        h('label', { class: 'setting-name', for: id }, label, hint && h('span', { class: 'setting-hint' }, hint)),
        input);
    };
    // Erasing the save forgets the checkpoint and the records (stored records of {} load as the defaults); the
    // settings stay. The question takes the whole row while it is asked.
    const resetName = h('p', { class: 'setting-name' }, 'Saved progress',
      h('span', { class: 'setting-hint' }, 'Your campaign checkpoint and records'));
    const erase = () => {
      persistence.clearCheckpoint();
      persistence.saveRecords({});
      resetRow.replaceChildren(resetName, h('p', { class: 'setting-done', role: 'status' }, 'Save erased'));
      resetRow.closest('.screen')?.querySelector('#btn-back')?.focus({ preventScroll: true });
    };
    const reset = button('btn-reset-save', 'Reset save', () => ask(resetRow, {
      text: 'Erase the campaign checkpoint, the best rating and the Endless records? Settings stay as they are.',
      action: 'Erase save', onConfirm: erase, back: reset,
    }), { kind: 'danger' });
    const resetRow = h('div', { class: 'setting reset' }, resetName, reset);
    return panelScreen('settings', 'Settings', {
      body: [h('div', { class: 'settings-list' },
        h('div', { class: 'setting' },
          h('label', { class: 'setting-name', for: 'set-volume' }, 'Volume'),
          h('div', { class: 'setting-control' }, volume, volumeText)),
        toggle('set-muted', 'muted', 'Mute sound', null, muted => audio?.setMuted?.(muted)),
        toggle('set-motion', 'reduceMotion', 'Reduce motion', 'No camera shake or red flashes'),
        toggle('set-shadows', 'shadows', 'Shadows', 'Turn them off if the game runs slowly'),
        resetRow)],
      actions: [button('btn-back', 'Back', back)],
    });
  }

  // The missions of a round, each done (✓, with its reward) or not (✗, with how far it got).
  function missionList(missions) {
    if (!missions.length) return null;
    return h('section', { class: 'missions' },
      h('h2', { class: 'section-title' }, 'Missions'),
      h('ul', {}, missions.map(m => h('li', { class: m.done ? 'mission done' : 'mission' },
        h('span', { class: 'mission-mark', 'aria-label': m.done ? 'Done' : 'Not done' }, m.done ? '✓' : '✗'),
        h('span', { class: 'mission-text' }, m.text),
        m.done ? amount(m.reward, '+') : h('span', { class: 'mission-progress' }, `${m.progress}/${m.goal}`)))));
  }

  function summary(data = {}) {
    const { round, mode, stats = {}, coinsEarned = 0, missions = [], lives, livesReplenished = 0, score = 0 } = data;
    return panelScreen('summary', `Round ${round} complete`, {
      sub: mode === 'endless' ? `Endless · round ${round}` : `Campaign · round ${round} of ${ROUNDS.length}`,
      body: [
        figures([
          ['Threats', stats.spawned ?? 0],
          ['Intercepted', stats.intercepted ?? 0, 'good'],
          ['Misses', stats.missed ?? 0, ifAny(stats.missed, 'warn')],
          ['Populated impacts', stats.impactsPopulated ?? 0, ifAny(stats.impactsPopulated, 'bad')],
          ['Open‑area impacts', stats.impactsOpen ?? 0], // a non-breaking hyphen: OPEN-AREA stays whole
          ['Wasted shots', stats.shotsWasted ?? 0, ifAny(stats.shotsWasted, 'warn')],
          ['Alerts', stats.alerts ?? 0],
        ]),
        figures([
          ['Coins earned', amount(coinsEarned, '+'), 'gold'],
          ['Lives', livesReplenished > 0 ? `+${livesReplenished} → ${lives}` : `${lives}/${state.maxLives}`, 'lives'],
          ['Score', score],
        ], 'major'),
        missionList(missions),
      ],
      actions: [
        button('btn-requisition', 'Requisition supplies', () => session.continueFromSummary(), { kind: 'primary' }),
      ],
    });
  }

  function gameover(data = {}) {
    const { round, mode, total = {}, score } = data;
    const endless = mode === 'endless';
    const retryRound = endless ? null : checkpointRound();
    let text = null;
    if (endless) {
      const records = persistence.loadRecords();
      text = `Best endless: round ${records.bestEndlessRound} · score ${records.bestEndlessScore}`;
    } else if (retryRound === 1) {
      text = 'Retry starts round 1 again with the coins, interceptors and lives you began with.';
    } else if (retryRound !== null) {
      text = `Retry takes you back to the shop before round ${retryRound}, with the coins, interceptors, lives and `
        + 'upgrades you had when it began: requisition supplies, then try the round again.';
    }
    return panelScreen('gameover', 'The city has fallen', {
      tone: 'alarm',
      sub: endless ? `Endless · reached round ${round}` : `Campaign · fell in round ${round} of ${ROUNDS.length}`,
      body: [totals(total, score), text && h('p', { class: 'panel-text' }, text)],
      actions: endless ? [
        button('btn-retry', 'Play Endless again', () => play(() => session.startEndless()), { kind: 'primary' }),
        button('btn-title', 'Title', toTitle),
      ] : [
        retryRound !== null && button('btn-retry', `Retry round ${retryRound}`, () => play(() => session.retryRound()),
          { kind: 'primary' }),
        button('btn-restart', 'Restart campaign', () => play(() => session.startCampaign()),
          { kind: retryRound === null ? 'primary' : null }),
        button('btn-title', 'Title', toTitle),
      ],
    });
  }

  function victory({ summary: data = {}, rating = null } = {}) {
    const { total = {}, lives = 0, score } = data;
    const known = RATINGS.includes(rating);
    const letter = known ? rating : '?';
    const records = persistence.loadRecords();
    return panelScreen('victory', 'Campaign complete', {
      badge: h('div', {
        class: `rating rating-${known ? rating : 'none'}`, role: 'img', 'aria-label': `Rating ${letter}`,
      }, letter),
      sub: `Jerusalem held through all ${ROUNDS.length} rounds`,
      body: [
        h('p', { class: 'panel-text' },
          'The rating counts the impacts on neighborhoods and the shots wasted on open ground.',
          typeof records.bestRating === 'string' ? ` Best rating: ${records.bestRating}.` : ''),
        totals(total, score, [['Lives left', lives, 'lives']]),
        h('p', { class: 'panel-text' }, 'Endless is unlocked: the rounds keep coming, harder each time.'),
      ],
      actions: [
        button('btn-play-endless', 'Play Endless', () => play(() => session.startEndless()), { kind: 'primary' }),
        button('btn-title', 'Title', toTitle),
      ],
    });
  }

  const builders = { title, howto, pause, settings: settingsScreen, summary, gameover, victory };

  return {
    show,
    hide,
    get current() { return current(); },
  };
}
