import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createRng, rngRange, rngInt, rngPick } from '../js/core/rng.js';
test('same seed gives same sequence', () => { const a = createRng(42), b = createRng(42); assert.equal(a(), b()); assert.equal(a(), b()); });
test('values are in [0,1) and vary', () => { const r = createRng(7); const xs = Array.from({ length: 1000 }, r); assert.ok(xs.every(x => x >= 0 && x < 1)); assert.ok(new Set(xs).size > 900); });
test('rngInt is inclusive of both ends', () => { const r = createRng(3); const seen = new Set(Array.from({ length: 500 }, () => rngInt(r, 2, 4))); assert.deepEqual([...seen].sort(), [2, 3, 4]); });
test('rngRange and rngPick', () => { const r = createRng(1); const v = rngRange(r, 10, 12); assert.ok(v >= 10 && v < 12); assert.ok(['a', 'b'].includes(rngPick(r, ['a', 'b']))); });
test('different seeds give different sequences', () => { assert.notEqual(createRng(1)(), createRng(2)()); });
test('rngPick can return every element', () => { const r = createRng(9); const seen = new Set(Array.from({ length: 200 }, () => rngPick(r, ['a', 'b', 'c']))); assert.deepEqual([...seen].sort(), ['a', 'b', 'c']); });
test('createRng without a seed still yields values in [0,1)', () => { const r = createRng(); assert.ok(Array.from({ length: 100 }, r).every(x => x >= 0 && x < 1)); });
