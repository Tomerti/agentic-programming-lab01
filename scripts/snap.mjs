#!/usr/bin/env node
// Headless-Chrome harness for visual checks, with no dependencies (Node ≥ 22).
//
//   node scripts/snap.mjs <url> [--out shot.png] [--wait 4000] [--width 1440] [--height 900]
//                         [--ready "<js expression>"] [--eval "<js expression>"]... [--click "<css selector>"]...
//
// Loads the page in headless Chrome over the DevTools protocol, collects console
// messages and uncaught exceptions, runs the optional --click / --eval actions in order
// after the page has loaded, waits, captures a screenshot and prints a JSON report:
//   { url, errors: [...], console: [...], evals: [...], screenshot }
// Exit code is 1 when any error was logged or an exception was thrown, so it can gate
// a verification step. Every run uses a fresh Chrome profile, removed afterwards, with the
// HTTP cache disabled, so the page always loads the files as they are on disk.
//
// Timing. Without --ready, the actions run 1.5 s after navigation (or --wait ms, if less)
// and the screenshot is taken --wait ms after navigation plus the time the actions took
// (each action is followed by a 300 ms pause). With --ready, --wait is one budget, counted
// from navigation: the expression is polled every 250 ms (an exception, e.g. while the page
// is still loading, counts as not ready) until it is truthy or the budget is spent; then
// the actions run, and the screenshot is taken when the rest of the budget has passed, at
// once if the actions outlasted it. --ready takes a synchronous boolean expression: it is
// read as !!(expression), so any truthy value counts, an object too, and a Promise is not
// awaited (it counts as truthy at once). The report then also holds
//   ready: { expression, met, ms }   (whether it became truthy, and when, in ms after navigation)
// An --eval may return a Promise, which is awaited: one that settles on a page event, with
// a short --wait, takes the screenshot right after that event.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
if (!url) { console.error('usage: node scripts/snap.mjs <url> [--out f.png] [--wait ms] [--ready js] [--eval js]... [--click sel]...'); process.exit(2); }
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const many = name => args.flatMap((a, i) => a === '--' + name ? [args[i + 1]] : []);
const out = opt('out', 'snap.png');
const wait = Number(opt('wait', 4000));
const ready = opt('ready', null);
const READY_POLL = 250; // ms between two checks of the --ready expression
const width = Number(opt('width', 1440)), height = Number(opt('height', 900));
const actions = args.flatMap((a, i) => (a === '--eval' || a === '--click') ? [{ kind: a.slice(2), value: args[i + 1] }] : []);

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = CANDIDATES.find(p => existsSync(p));
if (!chrome) { console.error('No Chrome/Edge found; set CHROME_PATH'); process.exit(2); }

const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'snap-'));
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });
const cleanup = () => {
  try { proc.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

// Kills Chrome and removes its profile. Chrome's helper processes keep the profile open for a moment
// after the browser process dies (removing it at once fails with EPERM on Windows), so the removal is
// retried for up to 5 s.
async function shutdown() {
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise(resolve => proc.once('exit', resolve));
    try { proc.kill('SIGKILL'); } catch {}
    await Promise.race([exited, sleep(3000)]);
  }
  for (let attempt = 0; attempt < 20 && existsSync(profile); attempt++) {
    try { rmSync(profile, { recursive: true, force: true }); } catch { await sleep(250); }
  }
}

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('Chrome did not start');
}

const report = { url, errors: [], console: [], evals: [], screenshot: out };
let id = 0; const pending = new Map();
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws); ws.onerror = e => reject(e);
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
        report.console.push(`[${msg.params.type}] ${text}`);
        if (msg.params.type === 'error') report.errors.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        report.errors.push(`Uncaught: ${d.exception?.description || d.text}`);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        if (!/favicon\.ico/.test(msg.params.entry.url || '')) report.errors.push(`[log] ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
      }
    };
  });
}
let ws;
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

// Polls the --ready expression until it is truthy (true) or `deadline` (a Date.now() time) passes (false).
// An exception, or a page between two documents, counts as not ready yet.
async function waitUntilReady(expression, deadline) {
  for (;;) {
    try {
      const r = await send('Runtime.evaluate', { expression: `!!(${expression}\n)`, returnByValue: true });
      if (!r.exceptionDetails && r.result.value) return true;
    } catch {}
    if (Date.now() + READY_POLL > deadline) return false;
    await sleep(READY_POLL);
  }
}

try {
  await waitForDevtools();
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  const navigated = Date.now();
  if (ready !== null) {
    const met = await waitUntilReady(ready, navigated + wait);
    report.ready = { expression: ready, met, ms: Date.now() - navigated };
  } else await sleep(Math.min(wait, 1500));
  for (const a of actions) {
    const expr = a.kind === 'click'
      ? `(() => { const el = document.querySelector(${JSON.stringify(a.value)}); if (!el) return 'NOT FOUND: ' + ${JSON.stringify(a.value)}; el.click(); return 'clicked ' + ${JSON.stringify(a.value)}; })()`
      : a.value;
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    report.evals.push({ [a.kind]: a.value, result: r.exceptionDetails ? 'EXCEPTION: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result.value });
    if (r.exceptionDetails) report.errors.push(`eval failed: ${a.value}`);
    await sleep(300);
  }
  await sleep(Math.max(0, ready !== null ? navigated + wait - Date.now() : wait - 1500));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
} catch (e) {
  report.errors.push('harness: ' + e.message);
} finally {
  try { ws?.close(); } catch {}
  await shutdown();
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.errors.length ? 1 : 0);
