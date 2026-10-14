// tests/monitors.test.js
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { radarProject, radarBlipAt, threatRowAt } from '../js/scene/monitors.js';
const view = { width: 512, height: 280, zoom: 1 };
test('city centre projects to the scope centre and 16 units to the ring edge', () => { const c = radarProject({ x: 0, z: -11 }, view); assert.deepEqual(c, { x: 256, y: 150 }); const e = radarProject({ x: 16, z: -11 }, view); assert.ok(Math.abs(e.x - (256 + 118)) < 1e-9); assert.equal(radarProject({ x: 8, z: -11 }, { ...view, zoom: 2 }).x, 256 + 118); });
test('blip hit-testing picks the nearest within 18 px', () => { const threats = [{ id: 1, position: { x: 0, z: -11 } }, { id: 2, position: { x: 4, z: -11 } }]; assert.equal(radarBlipAt(threats, view, 258, 152), 1); assert.equal(radarBlipAt(threats, view, 256 + 29.5 + 5, 150), 2); assert.equal(radarBlipAt(threats, view, 400, 20), null); });
test('threat rows map y to the threat in that row', () => { const threats = [{ id: 7 }, { id: 8 }, { id: 9 }]; assert.equal(threatRowAt(threats, 56), 7); assert.equal(threatRowAt(threats, 100), 8); assert.equal(threatRowAt(threats, 300), null); assert.equal(threatRowAt([], 56), null); });

// Beyond the brief: the radar only answers for blips inside its ring, and the limits of both hit tests.
test('a track whose blip falls outside the scope ring is not picked on the radar', () => {
  const zoomed = { ...view, zoom: 2 }; // the ring covers 8 units
  const far = { id: 3, position: { x: 12, z: -11 } };
  const p = radarProject(far.position, zoomed);
  assert.equal(radarBlipAt([far], zoomed, p.x, p.y), null);
  const beyond = { id: 4, position: { x: 17, z: -11 } }; // past the 16-unit ring at 1×
  const q = radarProject(beyond.position, view);
  assert.equal(radarBlipAt([beyond], view, q.x, q.y), null);
  const inside = { id: 5, position: { x: 6, z: -11 } };
  const r = radarProject(inside.position, zoomed);
  assert.equal(radarBlipAt([inside], zoomed, r.x, r.y), 5);
  assert.equal(radarBlipAt([{ id: 6, position: { x: 16, z: -11 } }], view, 374, 150), 6); // on the ring itself
});
test('blip hit-testing includes maxDist itself', () => {
  const threats = [{ id: 1, position: { x: 0, z: -11 } }];
  assert.equal(radarBlipAt(threats, view, 256 + 18, 150), 1);
  assert.equal(radarBlipAt(threats, view, 256 + 18.01, 150), null);
  assert.equal(radarBlipAt(threats, view, 256 + 10, 150, 9), null);
});
test('row bands include both edges, rows have gaps between them and the list stops at five rows', () => {
  const threats = [7, 8, 9, 10, 11, 12].map(id => ({ id }));
  assert.equal(threatRowAt(threats, 56 - 18), 7);
  assert.equal(threatRowAt(threats, 56 + 12), 7);
  assert.equal(threatRowAt(threats, 56 - 18.1), null);
  assert.equal(threatRowAt(threats, 72), null); // between the first row (to 68) and the second (from 76)
  assert.equal(threatRowAt(threats, 56 + 38 * 4), 11);
  assert.equal(threatRowAt(threats, 56 + 38 * 5), null); // a sixth row is never listed
});
