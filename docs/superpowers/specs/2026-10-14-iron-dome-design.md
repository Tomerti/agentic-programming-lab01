# Iron Dome: Jerusalem Battery — design spec

Date: 2026-10-14 · Course: agentic-programming, lab01 · Status: approved design, pre-plan

## 1. Overview

A browser game in which the player is the chief of an Iron Dome battery defending
Jerusalem. The player sits in a 3D control room (fixed seat, low-poly "Surgeon
Simulator 2" art style) with physical buttons, switches and monitors on a console, and a
wide window onto the city. Rockets arc in over the city; the player selects tracks on the
radar and engages them with interceptors that launch from a launcher visible outside the
window. Interceptions cost coins; rockets that hit populated areas cost lives; coins buy
upgrades in a shop between rounds. A 10-round campaign introduces new threats and ends
in a victory rating, then unlocks an Endless mode.

### Hard constraints

- Runs entirely in the browser: plain HTML, CSS and JavaScript. No server, backend,
  database, API keys or build step. GitHub Pages serves the repo root.
- Desktop/laptop first (mouse + keyboard, ≥1280 px). Phones load it but are not optimised.
- English UI.

### Technical approach (decided)

Vanilla ES modules + Three.js `0.170.0` loaded from jsDelivr through an `importmap`:

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
} }
</script>
```

Addons used: `RoundedBoxGeometry` (chunky shapes). No other dependencies. Sound is
synthesized with the Web Audio API (no asset files). ES modules require an HTTP origin,
so local play uses any static server (`python -m http.server`), not `file://`.

## 2. Architecture

Strict split between **game logic** (pure JS: no DOM, no Three, no timers, injectable
RNG and storage; unit-tested with Node's built-in `node --test`) and **presentation**
(Three.js scene, 2D HUD, audio), connected by a tiny event bus. The session is the
single source of truth; scene, HUD and audio are views that react to its events and
read its state.

```
index.html                 page shell, importmap, HUD/overlay containers
css/style.css              HUD, overlays, screens
js/main.js                 bootstrap: create session, scene, HUD, audio; run the loop
js/config.js               all balance tables and world constants (data only)
js/core/events.js          createBus(): on/off/emit
js/core/rng.js             seedable RNG (mulberry32) for deterministic tests
js/game/session.js         orchestrator: state, commands, update(dt), emits events
js/game/threats.js         threat creation, flight paths, detection, impact zones
js/game/interceptors.js    interceptor flight, hit/miss resolution
js/game/director.js        round/wave schedules (campaign table + endless formula)
js/game/economy.js         coins, costs, rewards, shop purchases, upgrade levels
js/game/missions.js        mission definitions, progress tracking
js/game/daynight.js        clock → lighting parameters
js/game/state.js           initial state, checkpoint/settings/records persistence
js/scene/scene.js          renderer, camera (fixed seat + mouse-look), lights, loop hooks
js/scene/room.js           console, monitors, props, siren beacon, life lamps
js/scene/controls.js       physical controls, raycasting, hover/press, monitor clicks
js/scene/outside.js        sky, sun/moon, stars, hills, city, launcher; applyLighting()
js/scene/projectiles.js    rocket/interceptor meshes synced to session state
js/scene/effects.js        explosions, flashes, camera/console shake
js/scene/monitors.js       canvas screens: radar, resources, threats+mission
js/ui/hud.js               resources bar, mission line, toasts, banners, warnings
js/ui/shop.js              between-round shop overlay
js/ui/screens.js           title, how-to-play, pause, settings, round summary, game over, victory
js/audio.js                Web Audio synthesized SFX + ambience, volume/mute
tests/*.test.js            unit tests for js/core and js/game
.nojekyll, README.md
```

### Event bus

`createBus()` returns `{ on(type, fn), off(type, fn), emit(type, payload) }`. Events are
named `noun:verb`. The session emits; views subscribe. Views never mutate session state
except through session commands.

Session events: `round:start {round, mode, missions}`, `round:end {summary}`,
`wave:start {wave, count}`, `wave:end`, `threat:spawned {threat}`,
`threat:detected {threat}`, `threat:selected {id}`, `threat:impact {threat, populated,
position}`, `threat:intercepted {threat, interceptor, position}`,
`interceptor:launched {interceptor}`, `interceptor:missed {interceptor, position}`,
`engage:refused {reason}`, `alert:sounded {neighborhood, inTime}`, `hold:changed {on}`,
`life:lost {lives}`, `life:gained {lives}`, `coins:changed {coins, delta, reason}`,
`ammo:changed {ammo, capacity}`, `mission:progress {id, progress, goal}`,
`mission:complete {id, reward}`, `hazard:jamming {on}`, `clock:tick {hour}`,
`shop:open`, `shop:purchased {itemId, level}`, `game:over {summary}`,
`campaign:victory {summary, rating}`, `hq:line {text}`.

### Session (`js/game/session.js`)

`createSession({ config, rng, storage, bus })` returns:

- `state` (read-only for views): `mode` ('campaign' | 'endless'), `phase` ('title' |
  'briefing' | 'wave' | 'breather' | 'summary' | 'shop' | 'gameover' | 'victory' |
  'paused'), `round`, `wave`, `waveCount`, `clockHour` (0–24, fractional), `coins`,
  `ammo`, `ammoCapacity`, `lives`, `maxLives`, `score`, `upgrades` (levels by item id),
  `threats[]`, `interceptors[]`, `selectedId`, `hold`, `jammed`, `fireCooldown`,
  `missions[]`, `log[]` (last 6 lines), `stats` (per round and total: spawned,
  intercepted, missed, impactsPopulated, impactsOpen, shotsWasted, coinsEarned).
- Commands: `startCampaign(fromCheckpoint)`, `startEndless()`, `selectTrack(id)`,
  `cycleSelection(dir)`, `engage()`, `soundAlert()`, `toggleHold()`, `resetRadar()`,
  `callHQ()`, `continueFromSummary()`, `buy(itemId)`, `restock(n)`, `leaveShop()`,
  `pause()`, `resume()`, `update(dt)`.

`update(dt)` advances the clock, the director (spawns), threats, interceptors, cooldowns
and hazards, resolves impacts/interceptions, checks missions, and transitions phases.
Views call it once per frame; tests call it with fixed steps.

## 3. World model and coordinates

Scene units are metres of the room; the outside world is scaled down so the whole city
fits the window. All game logic uses these same units ("world units") so that no
conversion exists between logic and scene.

- The console sits at z ∈ [−0.25, 0.6]; the seat/camera at (0, 1.38, 1.55); the window is
  in the front wall at z = −2.6, x ∈ [−2.1, 2.1], y ∈ [0.95, 2.35]. The outside group is
  offset by y = −2.2 (the room is on a hill).
- City centre `WORLD.cityCenter = {x: 0, z: −11}` (outside coordinates). Radar scope
  radius `WORLD.radarRadius = 16`.
- Neighborhoods (populated impact zones, circles in outside coordinates):
  Gilo (−4, −9, r 2.2), Old City (−1.5, −11, r 2.5), Talpiot (1.4, −10.9, r 1.8),
  Pisgat Ze'ev (4, −13, r 2.2), Ramot (−5, −13.5, r 2.2). Open areas: rectangles at
  x ∈ [−12, −8] and x ∈ [8, 12], z ∈ [−15, −9].
- Threat spawn points: `{x: ±(14..16), y: 7..9, z: −20..−16}` for arcing types (low enough
  that the arc's apex is visible through the window); UAVs and cruise missiles spawn at the
  same x/z but y 2..3 and fly a flatter path.
- Interceptors launch from `WORLD.launchPoint = (3.8, 3.1, −7.0)`, the top of the launcher's
  tube block (the launcher body sits at (3.8, 1.5, −7.2) on a low berm so it shows above the window sill).
- The window's horizontal field of view covers outside x ∈ ≈[−6, 6] at z = −11. The
  director weights populated zones so ≥70 % of populated impacts (and therefore most
  interceptions) occur inside that range; the rest are still visible as flashes and on
  the radar.
- The launcher sits on a berm at outside (3.8, 1.5, −7.2), inside the window's field of view; interceptors launch from its tube block.

Flight paths are quadratic Béziers: `p0` spawn, `p2` impact, `p1 = lerp(p0, p2, 0.5) +
(0, arcHeight, 0)`. `t` runs 0→1 over `dur` seconds. Position and tangent are pure
functions of `(threat, t)`. Mortars use the same shape with a short, close path.

## 4. Threats

| id | name | dur (s) | arc | reward | hits | first round | notes |
|---|---|---|---|---|---|---|---|
| rocket | Rocket | 10–12 | 7 | 150 | 1 | 1 | the baseline |
| longrange | Long-range rocket | 7–8 | 10 | 200 | 1 | 3 | faster, steeper |
| uav | UAV | 22–26 | 1.5 | 120 | 1 | 4 | slow, low, long window |
| mortar | Mortar | 4–5 | 4 | 100 | 1 | 5 | spawns close; little warning |
| decoy | Decoy | 10–12 | 7 | 0 | 1 | 6 | looks like a rocket; harmless; wastes a shot |
| cruise | Cruise missile | 14–16 | 2 | 400 | 2 | 8 | low, weaving; needs two hits |

Threat record: `{ id (number, increasing from 217), type, p0, p1, p2, t, dur, zone
(neighborhood id | 'open'), populated, detected, decoy, hitsRemaining, state
('inbound' | 'intercepted' | 'impacted'), engagedBy (interceptor id | null) }`.

- **Detection.** A threat is shown on radar/threat list once its distance to the city
  centre ≤ detection range: base 14 units; the Radar Range upgrade adds 2 per level
  (max 3 levels → 20, i.e. visible from spawn). Mortars are always detected at spawn
  (they are too close) but have only 4–5 s to impact.
- **Paths by type.** Rockets, long-range rockets and decoys use the spawn points of §3.
  Mortars spawn 6–8 units from their impact point at y = 5 (same side as the nearest
  spawn point). UAVs follow the Bézier with arc 1.5. Cruise missiles add a lateral
  weave to the Bézier: an offset perpendicular to the path of `sin(t · 4π) × 1.0` units.
- **Decoys** display exactly like rockets. With the Signature Analyzer upgrade the radar
  draws them as hollow blips labelled DECOY and the threat list says DECOY; without it,
  engaging one spends ammo and coins for 0 reward and counts as a wasted shot. A decoy
  reaching its impact point burns up: no life lost, no shake, log line "DECOY BURNED UP".
- **Jamming (hazard, round ≥ 7):** the radar shows static and the threat list shows
  "SIGNAL LOST" until the player presses RESET RADAR or 8 s elapse. Threats keep flying,
  new detections are hidden, and ENGAGE is refused with "RADAR JAMMED" while jammed.
  Scheduled by the director 1–2 times per round from round 7.
- **Most urgent track** (used by auto-selection and Auto-Alert): the detected, inbound,
  populated, non-decoy track with the smallest time-to-impact; with the Signature
  Analyzer, revealed decoys are excluded; without it, decoys count as populated.

## 5. Rounds and the director

`planRound(round, mode, rng)` returns a deterministic schedule for a seeded RNG:

```
{ round, startHour, waves: [ { spawns: [ { at, type, zone } ], breatherAfter } ],
  missions: [missionId...], hazards: [ { at, type: 'jamming' } ] }
```

`at` is seconds from the wave start. A wave ends when every threat it spawned is
resolved (intercepted, impacted, burned up) and all its spawns have fired; then a 5 s
breather; the round ends after the last wave with a summary screen.

Campaign table (`config.ROUNDS`), 10 rounds:

| round | waves | threats/wave | mix | special |
|---|---|---|---|---|
| 1 | 3 | 2–3 | rockets, all populated | tutorial toasts |
| 2 | 3 | 3–4 | rockets, 60/40 populated/open | "let open-area rockets fall" toast |
| 3 | 4 | 3–4 | + long-range; salvo of 3 in waves 2 and 4 | |
| 4 | 4 | 4 | + UAV | |
| 5 | 4 | 4–5 | + mortar | |
| 6 | 4 | 4–5 | + decoy (1–2 per wave) | |
| 7 | 5 | 4–5 | all above | jamming ×1–2 |
| 8 | 5 | 4–5 | + cruise missile (1 in wave 3) | jamming |
| 9 | 5 | 5–6 | everything, 2 salvos | jamming |
| 10 | 5 | 6–7 | everything, salvos of 4, cruise in waves 2 and 5 | finale |

Endless (round n > 10): 5 waves; threats/wave = 5 + (n − 10); salvo size grows every
2 rounds; spawn interval shrinks to a floor of 2 s; two jammings; one cruise per wave
from n = 13. Score keeps counting; the best endless round and score are recorded.

Spawn timing within a wave: threats spaced by the round's interval (6 s in R1 down to
3 s by R9), salvos spawn simultaneously. The director guarantees at least one populated
threat per wave, except in a wave flagged `openOnly`: when the `holdWave` mission is
assigned (never in round 1, at most one such wave per round) one wave contains only
open-area threats, and the mission refers to that wave.

Tutorial toasts (rounds 1–2, each shown once, in order, triggered by the matching
event): R1 "Rockets inbound: click a blip on the radar, then press ENGAGE (Space)",
"Every shot costs coins and one interceptor: watch the top bar", "ALERT (A) warns the
neighborhood under the selected track for bonus coins"; R2 "Grey tracks land on open
ground: let them fall and save your interceptors".

### Clock and day/night

`state.clockHour` starts at 10:00 in round 1 and advances continuously during waves and
breathers at 6 game-hours per round (so rounds rotate day → dusk → night → dawn; the
finale ends at night with the city lit). The clock pauses in menus/shop.
`lightingFor(hour)` interpolates keyframes (0, 5, 7, 12, 17, 19, 21, 24 h) and returns
`{ skyTop, skyHorizon, sunAltitude, sunAzimuth, sunColor, sunIntensity, hemiSky,
hemiGround, starAlpha, windowsOn, roomLight }` with colours as `[r, g, b]` 0–1. The
scene applies it every frame: sky gradient texture, sun/moon positions, directional
light colour/intensity, hemisphere light, star opacity, city window emissive intensity,
and the ceiling lights (room light never drops below a playable level).

## 6. Player actions and resolution

- **Select** a track by clicking its radar blip (nearest blip within 18 canvas px), its
  threat-list row, `Tab`/`Shift+Tab` to cycle, or `1`–`5` for list rows. The selected
  track is highlighted on the radar, in the list and on the HUD mission line.
- **ENGAGE** (red mushroom button, `Space`). Refused with a toast and a buzz when:
  HOLD FIRE is on; cooldown active; `coins < shotCost`; `ammo = 0`; no track (if none is
  selected, the most urgent populated detected track is auto-selected; if none exists,
  refused); the target already has an interceptor in flight and needs only one more hit.
  Otherwise: spend `shotCost` and 1 ammo, create an interceptor at the launcher aimed at
  the target, start the cooldown (1.2 s; 0.6 s with Rapid Reload).
- **Interceptor flight.** Speed 16 units/s, homing on the target's current position each
  update. Hit/miss is rolled at launch: `rng() < hitChance` (base 0.85 + 0.05 per Better
  Seekers level, max 1.0). On reaching the target (distance < 0.4): hit → threat
  `hitsRemaining−1`; at 0 the threat is intercepted, reward paid, score added. Miss →
  the interceptor detonates 1.5 units past the target, `interceptor:missed`, the target
  can be re-engaged. If the target impacts first, the interceptor self-destructs.
- **Impact.** Populated zone: `life:lost`, big shake, red flash, siren, stats. Open area:
  small shake, no life lost. Decoy: burns up.
- **ALERT** (amber button, `A`): sounds the alert for the selected track's neighborhood
  (or the most urgent populated track). If that track is populated and still inbound:
  +40 coins and `alert:sounded {inTime: true}`; a neighborhood can be alerted once per
  track. Otherwise `alert:sounded {inTime: false, reason}` and a toast: "Already alerted"
  when the track was alerted before (`alreadyAlerted`), "No populated track to alert"
  otherwise (`noTarget`). The siren beacon spins for 4 s either way. The Auto-Alert
  upgrade sounds it automatically on detection of each populated track (paying the +40).
- **HOLD FIRE** (blue latching button with lamp, `H`): blocks ENGAGE while on. Exists for
  missions and to make accidental shots impossible during open-area waves.
- **RESET RADAR** (square button with lamp): clears jamming.
- **HQ phone**: `callHQ()` emits `hq:line` with a context line (mission hint, flavour);
  one mission requires calling HQ when a UAV is on radar.
- Other console controls (toggles, system buttons, power lever, radar range dial, mug,
  clipboard) are animated and make sounds but have no game effect, except the dial which
  cycles radar zoom (1×, 2×).

## 7. Economy, lives, shop, missions

Starting balance (all in `config.ECONOMY`, tuned during playtesting):

- Coins start 1,000. Shot cost 80 minus 10 per Cheaper Shots level. Rewards per table
  in §4; alert +40; missions +150…+400; end-of-round stipend `300 + 50 × round`.
- Ammo: capacity 20, start full. Restock costs 40 per interceptor, bought in the shop
  (button "Restock all" shows the total). Ammo is not refilled for free.
- Lives: start 5, `maxLives` 5. Populated impact −1. After each round +1 (capped at
  `maxLives`). At 0 → `game:over` immediately (the wave stops).
- Score: the sum of all rewards (interceptions, alerts, missions; not stipends), plus
  10 per second survived in Endless; shown on summaries and records.
- Victory rating, from campaign totals: **S** = 0 populated impacts and ≤ 3 wasted
  shots; **A** = ≤ 3 populated impacts; **B** = ≤ 8; **C** otherwise.

Shop (`config.SHOP`), open between rounds; each item has `cost`, `maxLevel`, `effect`:

| id | name | cost | levels | effect |
|---|---|---|---|---|
| maxLives | Reinforced shelters | 600 | 3 | maxLives +1 (5 → 8) |
| life | Emergency crews | 350 | ∞ | lives +1 (not above maxLives) |
| restock | Restock interceptors | 40 each | — | ammo up to capacity |
| capacity | Extra launcher tubes | 400 | 2 | capacity +10 |
| cheaper | Supply contract | 500 | 3 | shot cost −10 |
| seekers | Better seekers | 450 | 3 | hit chance +5 % |
| radar | Radar range | 350 | 3 | detection +2 units |
| analyzer | Signature analyzer | 500 | 1 | reveals decoys |
| autoAlert | Auto-alert system | 700 | 1 | alerts automatically |
| rapid | Rapid reload | 400 | 1 | fire cooldown 0.6 s |

`buy(itemId)` validates level caps and funds, deducts coins, applies the effect, emits
`shop:purchased` and returns `{ ok, reason }`. The shop UI shows current balance,
each item's level, and disables what can't be bought with the reason.

Missions (`config.MISSIONS`), 1–2 per round chosen by the director to match available
threats; progress is driven by session events:

| id | text | reward | check |
|---|---|---|---|
| alertGilo | Sound the alert in Gilo before impact | 150 | `alert:sounded` inTime for zone gilo |
| streak3 | Intercept 3 rockets in a row | 200 | 3 consecutive `threat:intercepted` with no miss/impact between |
| noWaste | Finish a wave without wasting a shot on an open-area rocket | 200 | wave ends with 0 wasted shots |
| holdWave | Keep HOLD FIRE on through one open-area-only wave | 150 | hold on for the whole flagged wave |
| callUav | Call HQ while a UAV is on radar | 150 | `hq:line` with a UAV detected |
| clearJam | Clear the jamming within 5 s | 250 | `hazard:jamming off` within 5 s of on |
| perfectRound | No populated impacts this round | 400 | round ends with impactsPopulated 0 |
| cruiseKill | Down the cruise missile | 300 | cruise intercepted |

A mission completes once; the reward is paid immediately with a stinger and a toast.

## 8. Presentation

### Room and console

The mockup's composition, polished: chunky `RoundedBoxGeometry` shapes, saturated
palette (console navy `#2d3d4f`/`#46607a`, yellow edge stripe, red/amber/blue buttons,
teal lamp, red phone), soft shadows from one directional light, warm ceiling lights,
monitor glow. Fixed seat with subtle mouse-look (yaw ±0.42 rad, pitch ±0.18 rad,
eased). Three monitors: **RESOURCES** (left; coins, ammo bar, lives lamps, round/wave,
clock), **RADAR** (centre, large; rings, sweep, blips coloured red = populated, grey =
open, hollow = decoy, cyan = interceptor with a line to its target, selected blip ringed,
jamming static), **THREATS + MISSION** (right; rows with id, type, zone, time-to-impact;
lower area, missions on the left and the last up to 6 log lines on the right). A lamp strip on the
console shows lives: one lamp per `maxLives`, lit per life; a lost life flashes red. The
siren beacon on the front wall spins on alerts and populated impacts. A sign on the wall band left of the window reads
"IRON DOME · JERUSALEM BATTERY".

### Window and outside

Low-poly sandstone city with lit windows, a golden-dome landmark, minaret, hills, sun or
moon and stars by time of day, the launcher on the slope with its tube block. Rockets:
white body, red nose and fins, orange flame trail, point light. Interceptors: white with
teal nose and cyan trail. Explosions: expanding translucent sphere + light flash (white
for interceptions, red for populated impacts, orange for open-area, faint for decoys).

### 2D HUD (always visible during play)

A top bar of six cells with large tabular numbers: COINS (gold), INTERCEPTORS `n/cap`
with a bar (teal), LIVES as shield icons (red; dim for missing, outlined for slots above
current max), ROUND · WAVE, CLOCK (hh:mm with a sun/moon glyph), SCORE. A number that
changes pops briefly. Low state (coins < 2 × shotCost, or ammo ≤ 3, or lives ≤ 2) pulses
red and plays a warning beep (rate-limited to once per 8 s). Below the bar: the mission
line with progress and the selected track's summary. Toasts bottom-centre; round banners
("ROUND 3 · DUSK") centre on `round:start`, and a small wave banner on `wave:start`
("WAVE 3 / 4 · OPEN GROUND" for a wave that falls only on open ground, the one the
holdWave mission means); a tutorial toast queue in rounds 1–2.

### Shake and flashes

`effects.shake(strength)`: a decaying noise offset on the camera (0.6 s) and a jitter on
console props; populated impact 1.0, open-area 0.35, interception closer than 10 units
to the window 0.15. A red screen-edge flash on `life:lost`. Settings → "Reduce motion"
disables shake and flashes.

### Audio (`js/audio.js`, Web Audio)

All sounds synthesized at runtime; master gain, mute (`M`) and volume persisted. The
AudioContext is created on the title screen's "Start shift" click. Sounds: UI click
(noise tick + 1.2 kHz sine 40 ms), switch clack (200 Hz square 30 ms), launch whoosh
(band-passed noise sweep 400→2000 Hz, 0.6 s), interception blast (low-passed noise
0.5 s + 60 Hz thump), ground impact (low-passed noise 1.2 s + 40 Hz sine; louder and
longer when populated), alert siren (sawtooth alternating 600/800 Hz, 4 s), life lost
(descending tone), radar ping on detection (1.5 kHz sine 80 ms), low-resource beeps
(880 Hz ×2), round-start stinger (triangle arpeggio), round-end/victory stinger, game
over (descending minor), mission complete chime, HQ phone ring, room hum (filtered brown
noise, quiet). Explosion loudness scales with distance from the window.

### Screens (`js/ui/screens.js`)

Title (Start shift / Continue from round N / Endless, locked until a campaign victory /
How to play / Settings), How to play (controls, the open-area rule, resources), Pause
(`Esc`), Settings (volume, mute, reduce motion, shadows on/off, reset save), Round
summary (stats, coins earned, lives replenished, missions), Game over (stats, Retry round
N / Restart campaign), Victory (rating S/A/B/C from lives left, populated impacts and
wasted shots; unlocks Endless). All overlays are DOM, styled to match the room palette.

## 9. Persistence (`js/game/state.js`)

`localStorage` keys: `irondome.v1.checkpoint` (mode, round, coins, lives, maxLives,
ammo, capacity, upgrades, score, clockHour, campaign stats; written when a round starts,
i.e. after the shop, so purchases are kept; "Continue" and "Retry round N" both restore
the state at the start of that round, so a retry keeps upgrades and the lives you had),
`irondome.v1.settings` (volume, muted, reduceMotion, shadows), `irondome.v1.records`
(campaign victory + best rating, best endless round and score). `storage` is injected so
tests use an in-memory object; a missing/corrupt entry falls back to defaults. "Retry
round N" for N > 1 restores that state into the shop before round N, so a player whose
loadout could not hold the round can requisition supplies first, and leaving the shop
starts round N (saving a new checkpoint); "Continue" and a retry of round 1 go straight
into the round.

## 10. Testing

- `node --test tests/` with zero dependencies; every `js/core` and `js/game` module has a
  test file. Deterministic via the seeded RNG. Key cases: Bézier position/tangent and
  time-to-impact; detection by range and upgrade level; interceptor hit/miss, arrival and
  self-destruct; economy affordability, caps and all shop effects; director schedules per
  round (counts, mix, salvos, hazards, ≥1 populated per wave, endless growth); missions;
  day/night continuity and 24 h wrap; checkpoint round-trip with corrupt data; a session
  integration test driving a scripted wave through `update(dt)` and asserting the event
  sequence, lives, coins, game over and victory.
- `node --check` on every JS file; a script resolving all local `import` paths.
- Manual playtest checklist in the README for scene, audio, HUD and shop; the user
  playtests on the deployed page.

## 11. Deployment

GitHub Pages, deploy from branch, folder `/` (root); `.nojekyll` committed. The game
lives on branch `iron-dome` until merged into `master`; the published URL will be
`https://tomerti.github.io/agentic-programming-lab01/`. README documents local run
(`python -m http.server 8000` then `http://localhost:8000`), controls and the playtest
checklist.

## 12. Out of scope

Mobile layout, localisation/Hebrew, multiplayer, real geography or real unit data, audio
or 3D asset files, a build step, analytics, accounts.
