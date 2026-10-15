# Iron Dome: Jerusalem Battery

You are the chief of an Iron Dome battery on a hill over Jerusalem. From a low-poly 3D control room you watch
rockets arc in over the city through a wide window, pick the tracks on the radar and fire interceptors from the
launcher outside. Each shot costs coins and an interceptor, each rocket that lands on a neighborhood costs a
life, and rockets bound for open ground are better left alone. Between rounds the coins buy supplies and
upgrades. A ten-round campaign brings new threats from day to night, ends with a rating, and unlocks an
endless mode.

**Play:** https://tomerti.github.io/agentic-programming-lab01/

Runs entirely in the browser: no server, backend, database or API keys. It is plain HTML, CSS and JavaScript
modules with no build step; Three.js and the fonts load from public CDNs, and every sound is synthesized in the
browser. Progress and settings are kept in the browser's local storage. Made for desktop browsers with a mouse
and keyboard (Chrome, Firefox or Edge with WebGL).

## Run it locally

Browsers load JavaScript modules only from an HTTP origin, not from `file://`, so serve the folder:

```
python -m http.server 8000
```

then open http://localhost:8000 (`npm run serve` runs the same command).

## Controls

| Action | Mouse | Keyboard |
|---|---|---|
| Look around | Move the pointer: the view turns a little | |
| Select a track | Click its blip on the radar or its row in the threat list | Tab / Shift+Tab step through the tracks; 1–5 pick a row |
| ENGAGE: fire at the selected track (or the most urgent one) | Red button | Space |
| ALERT: warn the neighborhood under the track (+40 coins) | Amber button | A |
| HOLD FIRE: lock ENGAGE while its lamp is lit | Blue button | H |
| RESET RADAR: clear a jammed radar | Square grey button | R |
| Radar zoom 1× / 2× | Range dial, left of the console | Z |
| Call HQ for a hint about the open mission | Red phone | |
| Sound off / on | Settings | M |
| Pause / resume | Resume button | Esc |

The toggles, the lever, the system buttons, the mug and the clipboard move and make sounds but do nothing else.
Keys act only while no screen is shown; on the pause screen Esc resumes.

## How it plays

**Rounds.** The campaign has 10 rounds of 3 to 5 waves, with a 5-second breather between waves. The clock moves
six hours from one round to the next, so the rounds pass through day, dusk, night and dawn. New threats join as
it goes on: long-range rockets (round 3), UAVs (4), mortars (5), decoys that look like rockets (6), radar
jamming (7) and cruise missiles that take two hits (8). Each round offers one or two missions for bonus coins.
After round 10 you get a rating, S, A, B or C, from the impacts on neighborhoods and the shots wasted, and
Endless unlocks: rounds that keep getting harder, with your best round and score recorded.

**Economy.** You start with 1,000 coins and 20 interceptors. Every shot costs 80 coins and one interceptor, and
interceptors do not come back by themselves: restock them in the shop. An interception pays 100 to 400 coins
depending on the threat (a decoy pays nothing), an alert in time 40 and a mission 150 to 400, and every round
ends with a stipend of 300 + 50 × the round number. The score adds up the rewards (not the stipends), plus
10 points a second in Endless.

**Lives.** You start with 5. Red tracks are headed for a neighborhood, and each one that lands costs a life.
Grey tracks land on open ground and cost nothing: let them fall, since a shot at one is wasted. Each round you
finish gives a life back, up to the maximum. Lose them all and the city falls: retry the round with the coins,
interceptors, lives and upgrades you had when it began, or restart the campaign. The game saves at the start of
every round, so Continue on the title picks up where you left off.

## Shop

Between rounds, after the summary:

| Item | Price | Levels | Effect |
|---|---|---|---|
| Restock interceptors | 40 each | | Fills the launcher, or buys as many as the coins cover |
| Reinforced shelters | 600 | 3 | Maximum lives +1 (5 up to 8) |
| Emergency crews | 350 | no limit | Restores one life, up to the maximum |
| Extra launcher tubes | 400 | 2 | Launcher capacity +10 |
| Supply contract | 500 | 3 | Shot cost −10 |
| Better seekers | 450 | 3 | Hit chance +5% (from 85%) |
| Radar range | 350 | 3 | Detects threats earlier |
| Signature analyzer | 500 | 1 | Shows decoys for what they are |
| Auto-alert system | 700 | 1 | Sounds the alert for every red track as it is detected, paid like your own |
| Rapid reload | 400 | 1 | 0.6 s between shots instead of 1.2 s |

## Development

Requires Node.js 22 or newer for the tools; the game itself has no dependencies.

- `npm test` runs the unit tests of the game logic (`js/core`, `js/game`) and of the monitors' radar and list
  mapping, with Node's built-in test runner.
- `node scripts/check.mjs` syntax-checks every script and verifies that each relative import points at an
  existing file, spelled with the exact case (GitHub Pages runs on Linux, where case matters).
- `node scripts/snap.mjs <url> [--out shot.png] [--wait ms] [--ready "<js>"] [--click "<css>"]... [--eval "<js>"]...`
  loads the page in headless Chrome or Edge, waits until the `--ready` expression is true (within the `--wait`
  budget, in ms), then runs the clicks and expressions in order (an expression may return a Promise, which is
  awaited), saves a screenshot once the budget is spent and prints a JSON report with the page's console errors.
  It exits with 1 when there was one. Headless Chrome draws only a few frames a second, so game time runs slowly
  there: give such checks a long budget. To start a shift and look at it a minute later:

  ```
  node scripts/snap.mjs http://127.0.0.1:8000/ --out play.png --wait 60000 --ready "!!window.__game.screens" --click "#btn-start"
  ```

`window.__game` is a debug hook: it holds the session, the scene, the screens and the rest. Set
`__game.debugHour = 21` in the console to light the scene for 21:00, or call `__game.session.startRound(10)`
during a campaign to jump to its last round.

The game logic in `js/game` is pure JavaScript (no DOM, no Three.js), driven by `js/game/session.js`; the 3D scene
is in `js/scene`, the HUD and screens in `js/ui`, and every balance number in `js/config.js`. The design spec and
the implementation plan are in `docs/superpowers`.

## Manual playtest checklist

- [ ] **Title:** the room shows behind IRON DOME; Start shift, Endless (locked), How to play and Settings work;
  no sound before Start shift.
- [ ] **Start:** Start shift brings the ROUND 1 banner, the HUD, the room's hum and the round-start call.
- [ ] **Engage:** select a red track (click its blip, or Tab) and press ENGAGE or Space: the button dips and clicks,
  an interceptor leaves the launcher, coins −80 and interceptors −1; a hit bursts white in the sky.
- [ ] **Alert:** with a red track selected, ALERT or A: the siren sounds, the beacon spins, +40 coins and a toast.
- [ ] **Impact shake:** let a red track land: the view shakes, the screen's edges flash red, a life lamp and a
  shield go out. A grey track's impact shakes less and costs nothing.
- [ ] **Summary:** after the last wave, the round summary lists the stats, the coins earned, the life back and
  the missions.
- [ ] **Shop:** Requisition supplies opens the shop; Restock all fills the launcher; buying an upgrade raises its
  level and lowers the balance, and a maxed item says so.
- [ ] **Round 2:** Start round 2 moves the clock six hours on, to 16:00, and evening falls during the round; grey
  tracks appear and are worth letting fall.
- [ ] **Pause:** Esc pauses the round under a dimmed screen; Esc or Resume continues it.
- [ ] **Settings:** volume and mute act at once, Reduce motion stops the shake and the flash, Shadows off removes
  the shadows, and all of them survive a reload; M mutes during play with a toast.
- [ ] **Game over:** lose every life: "The city has fallen" with the totals. Holding Space as it opens does not
  press Retry.
- [ ] **Retry:** Retry round N starts the round again with what you had when it began; after a reload, Continue
  from round N does the same.
- [ ] **Victory:** finish round 10 (`__game.session.startRound(10)` gets there sooner): the rating and the totals;
  Endless is unlocked on the title.
- [ ] **Endless:** Play Endless: round 11 and on, harder each time; after it ends, the best Endless round and
  score show on the title.

## Deployment

GitHub Pages serves the repository root from the `master` branch (Settings → Pages → Deploy from a branch,
folder `/`). The empty `.nojekyll` file keeps Pages from running Jekyll over the files.

## Credits

Built with Three.js 0.170 (from jsDelivr). Fonts: Chakra Petch and Inter (Google Fonts). Sounds are synthesized
at runtime with the Web Audio API.
