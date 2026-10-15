# agentic-programming lab01: Iron Dome: Jerusalem Battery

A browser game for the Agentic Programming course, done with a partner (Shamir-Ido).
The partner pushes to the same remote: fetch before starting work, and never rewrite
history that has been pushed. `master` is live: GitHub Pages serves the repo root.

## Stack and commands

Plain HTML, CSS and JavaScript modules: no build step and no npm dependencies. Three.js
0.170 loads from jsDelivr through the import map in `index.html`. The tools need
Node.js 22+.

- `npm test`: unit tests (Node's test runner) for `js/core`, `js/game` and the monitors
- `node scripts/check.mjs`: syntax check, and exact-case relative imports (Pages runs on Linux)
- `npm run serve`: http://localhost:8000 (modules don't load from `file://`)
- `node scripts/snap.mjs <url> ...`: headless-Chrome screenshot and console-error
  report; usage in `README.md`

## Layout

- `js/game/`: the game logic, pure JavaScript (no DOM, no Three.js), driven by
  `session.js`. Keep it that way so it stays testable under Node.
- `js/core/`: event bus and seeded RNG. `js/scene/`: the 3D room, the outside,
  projectiles and effects. `js/ui/`: HUD, screens and shop.
- `js/config.js`: every balance number and world constant, frozen. Tune here only.
- `docs/superpowers/`: the design spec and the plan; `config.js` cites spec sections.

Run `npm test` and `node scripts/check.mjs` before committing. `window.__game` is the
debug hook (`__game.debugHour = 21`, `__game.session.startRound(10)`).
