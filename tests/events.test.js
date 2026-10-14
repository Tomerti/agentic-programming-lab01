import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createBus } from '../js/core/events.js';
test('emit calls handlers in order with payload', () => { const bus = createBus(); const seen = []; bus.on('x', p => seen.push('a' + p)); bus.on('x', p => seen.push('b' + p)); bus.emit('x', 1); assert.deepEqual(seen, ['a1', 'b1']); });
test('unsubscribe and off stop delivery', () => { const bus = createBus(); let n = 0; const un = bus.on('x', () => n++); un(); const f = () => n++; bus.on('x', f); bus.off('x', f); bus.emit('x'); assert.equal(n, 0); });
test('a throwing handler does not stop the others', () => { const bus = createBus(); let ok = false; const err = console.error; console.error = () => {}; bus.on('x', () => { throw new Error('boom'); }); bus.on('x', () => { ok = true; }); bus.emit('x'); console.error = err; assert.ok(ok); });
test('handlers may unsubscribe or subscribe during emit without disturbing delivery', () => {
  const bus = createBus(); const seen = [];
  const un = bus.on('x', () => { seen.push('once'); un(); bus.on('x', () => seen.push('late')); });
  bus.on('x', () => seen.push('next'));
  bus.emit('x'); assert.deepEqual(seen, ['once', 'next']);
  seen.length = 0; bus.emit('x'); assert.deepEqual(seen, ['next', 'late']);
});
