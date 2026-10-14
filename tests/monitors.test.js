// tests/monitors.test.js
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { radarProject, radarBlipAt, threatRowAt } from '../js/scene/monitors.js';
const view = { width: 512, height: 280, zoom: 1 };
test('city centre projects to the scope centre and 16 units to the ring edge', () => { const c = radarProject({ x: 0, z: -11 }, view); assert.deepEqual(c, { x: 256, y: 150 }); const e = radarProject({ x: 16, z: -11 }, view); assert.ok(Math.abs(e.x - (256 + 118)) < 1e-9); assert.equal(radarProject({ x: 8, z: -11 }, { ...view, zoom: 2 }).x, 256 + 118); });
test('blip hit-testing picks the nearest within 18 px', () => { const threats = [{ id: 1, position: { x: 0, z: -11 } }, { id: 2, position: { x: 4, z: -11 } }]; assert.equal(radarBlipAt(threats, view, 258, 152), 1); assert.equal(radarBlipAt(threats, view, 256 + 29.5 + 5, 150), 2); assert.equal(radarBlipAt(threats, view, 400, 20), null); });
test('threat rows map y to the threat in that row', () => { const threats = [{ id: 7 }, { id: 8 }, { id: 9 }]; assert.equal(threatRowAt(threats, 56), 7); assert.equal(threatRowAt(threats, 100), 8); assert.equal(threatRowAt(threats, 300), null); assert.equal(threatRowAt([], 56), null); });
