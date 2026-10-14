import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createEconomy } from '../js/game/economy.js';
import { ECONOMY, SHOP, THREATS, WORLD } from '../js/config.js';
const fresh = () => ({ coins: 1000, ammo: 20, ammoCapacity: 20, lives: 5, maxLives: 5, upgrades: {} });
test('derived values follow upgrade levels', () => { const s = fresh(); const e = createEconomy(s); assert.equal(e.shotCost(), 80); assert.equal(e.hitChance(), 0.85); assert.equal(e.detectionRange(), 14); assert.equal(e.fireCooldown(), 1.2); s.upgrades = { cheaper: 3, seekers: 3, radar: 3, rapid: 1 }; assert.equal(e.shotCost(), 50); assert.ok(Math.abs(e.hitChance() - 1.0) < 1e-9); assert.equal(e.detectionRange(), 20); assert.equal(e.fireCooldown(), 0.6); });
test('spend refuses when unaffordable', () => { const s = fresh(); s.coins = 50; const e = createEconomy(s); assert.equal(e.spend(80), false); assert.equal(s.coins, 50); assert.equal(e.spend(50), true); assert.equal(s.coins, 0); assert.equal(e.earn(150), 150); });
test('rewards and stipend', () => { const e = createEconomy(fresh()); assert.equal(e.rewardFor('cruise'), 400); assert.equal(e.rewardFor('decoy'), 0); assert.equal(e.stipend(3), 450); });
test('restock buys only what is missing and affordable', () => { const s = fresh(); s.ammo = 15; const e = createEconomy(s); assert.equal(e.restockCost(5), 200); assert.deepEqual(e.restock(), { ok: true, bought: 5 }); assert.equal(s.ammo, 20); assert.equal(s.coins, 800); assert.equal(e.restock().reason, 'full'); s.ammo = 0; s.coins = 100; assert.equal(e.restock().reason, 'coins'); });
test('buy applies effects, caps and funds', () => { const s = fresh(); s.coins = 10000; const e = createEconomy(s); assert.deepEqual(e.buy('maxLives'), { ok: true, level: 1 }); assert.equal(s.maxLives, 6); e.buy('maxLives'); e.buy('maxLives'); assert.equal(s.maxLives, 8); assert.equal(e.buy('maxLives').reason, 'maxed'); s.lives = 8; assert.equal(e.buy('life').reason, 'livesFull'); s.lives = 3; assert.equal(e.buy('life').ok, true); assert.equal(s.lives, 4); assert.equal(e.buy('capacity').ok, true); assert.equal(s.ammoCapacity, 30); assert.equal(e.buy('analyzer').ok, true); assert.equal(e.buy('analyzer').reason, 'maxed'); assert.equal(e.itemLevel('analyzer'), 1); s.coins = 100; assert.equal(e.buy('seekers').reason, 'coins'); assert.equal(e.canBuy('seekers').reason, 'coins'); });

// Behaviour the plan's tests above leave open.
const near = (a, b) => Math.abs(a - b) < 1e-9;
// A fresh state with `overrides` applied, and the economy over it (over `config`, or the real tables).
const setup = (overrides = {}, config) => { const s = { ...fresh(), ...overrides }; return { s, e: createEconomy(s, config) }; };
// The real tables, with some rows changed.
const tables = ({ economy = {}, shop = row => row, threats = {}, world = {} } = {}) => ({
  ECONOMY: { ...ECONOMY, ...economy }, SHOP: SHOP.map(shop), THREATS: { ...THREATS, ...threats }, WORLD: { ...WORLD, ...world },
});

test('the tables passed in decide the derived values, rewards, stipend and restock price', () => {
  const config = tables({
    economy: {
      shotCost: 100, shotDiscountPerLevel: 7, hitChance: 0.5, hitChancePerLevel: 0.1, fireCooldown: 2, rapidCooldown: 0.25,
      stipendBase: 10, stipendPerRound: 3, restockCost: 9,
    },
    threats: { rocket: { ...THREATS.rocket, reward: 77 } },
    world: { detectionBase: 5, detectionPerLevel: 3 },
  });
  const { s, e } = setup({ upgrades: { cheaper: 2, seekers: 1, radar: 3, rapid: 1 } }, config); // all different
  assert.equal(e.shotCost(), 86);
  assert.ok(near(e.hitChance(), 0.6));
  assert.equal(e.detectionRange(), 14);
  assert.equal(e.fireCooldown(), 0.25);
  assert.equal(e.rewardFor('rocket'), 77);
  assert.equal(e.stipend(4), 22);
  assert.equal(e.restockCost(3), 27);
  s.upgrades = {};
  assert.equal(e.fireCooldown(), 2);
});

test('hit chance stops at 1 however many seeker levels there are', () => {
  assert.equal(setup({ upgrades: { seekers: 10 } }).e.hitChance(), 1);
});

test('a cost the coins exactly cover is affordable; earn adds to the balance and returns it', () => {
  const { s, e } = setup({ coins: 80 });
  assert.equal(e.canAfford(80), true);
  assert.equal(e.canAfford(81), false);
  assert.equal(e.spend(80), true);
  assert.equal(s.coins, 0);
  assert.equal(e.earn(40), 40);
  assert.equal(e.earn(40), 80);
  assert.equal(s.coins, 80);
});

test('itemCost is the shop price at every level; restock costs what filling the launcher costs', () => {
  const dearRadar = tables({ shop: row => (row.id === 'radar' ? { ...row, cost: 123 } : row) });
  const { s, e } = setup({ coins: 5000 }, dearRadar);
  assert.equal(e.itemCost('radar'), 123);
  e.buy('radar');
  assert.equal(e.itemCost('radar'), 123);
  const others = SHOP.filter(({ id }) => id !== 'radar' && id !== 'restock');
  for (const item of others) assert.equal(e.itemCost(item.id), item.cost, item.id);
  assert.equal(e.itemCost('restock'), 0); // nothing is missing
  s.ammo = 12;
  assert.equal(e.itemCost('restock'), 320); // 8 missing, 40 each
  assert.equal(e.itemCost('missiles'), null);
});

test('an id the shop does not sell is unknown, for inherited property names too', () => {
  const { s, e } = setup();
  for (const id of ['missiles', 'constructor']) {
    assert.deepEqual(e.canBuy(id), { ok: false, reason: 'unknown' }, id);
    assert.deepEqual(e.buy(id), { ok: false, reason: 'unknown' }, id);
    assert.equal(e.itemCost(id), null, id);
  }
  assert.equal(e.itemLevel('missiles'), 0);
  assert.deepEqual(s, fresh());
});

test('canBuy answers ok without buying; a limit of the item is reported before the coins', () => {
  const { s, e } = setup({ coins: 0, upgrades: { analyzer: 1 } });
  assert.deepEqual(e.canBuy('radar'), { ok: false, reason: 'coins' });
  assert.deepEqual(e.canBuy('analyzer'), { ok: false, reason: 'maxed' }); // it is out of coins too
  assert.deepEqual(e.canBuy('life'), { ok: false, reason: 'livesFull' }); // so is this one
  s.ammo = 19; // one interceptor missing: 40 coins
  assert.deepEqual(e.canBuy('restock'), { ok: false, reason: 'coins' });
  s.coins = 5000; s.lives = 2;
  assert.deepEqual(e.canBuy('life'), { ok: true });
  assert.deepEqual(e.canBuy('restock'), { ok: true });
  assert.deepEqual(s, { coins: 5000, ammo: 19, ammoCapacity: 20, lives: 2, maxLives: 5, upgrades: { analyzer: 1 } });
});

test('a refused buy changes nothing', () => {
  const refusals = [
    ['radar', { coins: 100 }, 'coins'],
    ['analyzer', { upgrades: { analyzer: 1 } }, 'maxed'],
    ['life', {}, 'livesFull'],
    ['restock', {}, 'full'],
    ['restock', { ammo: 0, coins: 100 }, 'coins'],
    ['missiles', {}, 'unknown'],
  ];
  for (const [id, overrides, reason] of refusals) {
    const { s, e } = setup(overrides);
    const before = structuredClone(s);
    assert.deepEqual(e.buy(id), { ok: false, reason }, `${id}: ${reason}`);
    assert.deepEqual(s, before, `${id}: ${reason}`);
  }
});

test('each plain upgrade costs its price per level and can be bought up to its maxLevel, no further', () => {
  const { s, e } = setup({ coins: 100000 });
  const plainIds = ['cheaper', 'seekers', 'radar', 'analyzer', 'autoAlert', 'rapid'];
  const plain = SHOP.filter(({ id }) => plainIds.includes(id));
  assert.equal(plain.length, 6);
  let spent = 0;
  for (const item of plain) {
    for (let level = 1; level <= item.maxLevel; level++) {
      assert.deepEqual(e.buy(item.id), { ok: true, level }, item.id);
      spent += item.cost;
    }
    assert.deepEqual(e.buy(item.id), { ok: false, reason: 'maxed' }, item.id);
    assert.equal(e.itemLevel(item.id), item.maxLevel, item.id);
  }
  assert.equal(s.coins, 100000 - spent);
  assert.deepEqual([s.lives, s.maxLives, s.ammo, s.ammoCapacity], [5, 5, 20, 20]); // they only gain levels
  assert.equal(e.shotCost(), 50);
  assert.equal(e.detectionRange(), 20);
  assert.equal(e.fireCooldown(), 0.6);
});

test('Reinforced shelters raise the maximum, not the lives, and stop at maxLivesCap as well as at maxLevel', () => {
  const { s, e } = setup({ coins: 5000, lives: 2 });
  e.buy('maxLives');
  assert.deepEqual([s.maxLives, s.lives], [6, 2]);
  // The cap is ECONOMY.maxLivesCap: at 6 the second level is out of reach, though only 1 of 3 levels is bought.
  const lowCap = setup({ coins: 5000 }, tables({ economy: { maxLivesCap: 6 } }));
  assert.equal(lowCap.e.buy('maxLives').ok, true);
  assert.deepEqual(lowCap.e.buy('maxLives'), { ok: false, reason: 'maxed' });
  assert.equal(lowCap.s.maxLives, 6);
  // The levels are SHOP's maxLevel: at 1 the second purchase is out of reach, though the maximum is 6 of 8.
  const oneLevelOnly = tables({ shop: row => (row.id === 'maxLives' ? { ...row, maxLevel: 1 } : row) });
  const oneLevel = setup({ coins: 5000 }, oneLevelOnly);
  assert.equal(oneLevel.e.buy('maxLives').ok, true);
  assert.deepEqual(oneLevel.e.buy('maxLives'), { ok: false, reason: 'maxed' });
  assert.equal(oneLevel.s.maxLives, 6);
  // A maximum already at the cap is maxed out with no level bought, and said so before the coins.
  assert.deepEqual(setup({ coins: 0, maxLives: 8 }).e.canBuy('maxLives'), { ok: false, reason: 'maxed' });
});

test('Emergency crews restore one life per purchase, with no level cap, until the lives are full', () => {
  const { s, e } = setup({ coins: 5000, lives: 1 });
  for (let n = 1; n <= 4; n++) {
    assert.deepEqual(e.buy('life'), { ok: true, level: n });
    assert.equal(s.lives, 1 + n);
  }
  assert.equal(s.coins, 5000 - 4 * 350);
  assert.deepEqual(e.buy('life'), { ok: false, reason: 'livesFull' });
  assert.equal(s.lives, 5);
});

test('Extra launcher tubes add 10 to the capacity but no ammo, twice at most', () => {
  const { s, e } = setup({ coins: 5000 });
  assert.equal(e.buy('capacity').ok, true);
  assert.deepEqual([s.ammoCapacity, s.ammo, e.missingAmmo()], [30, 20, 10]);
  assert.equal(e.itemCost('restock'), 400);
  assert.equal(e.buy('capacity').ok, true);
  assert.equal(s.ammoCapacity, 40);
  assert.deepEqual(e.buy('capacity'), { ok: false, reason: 'maxed' });
});

test('restock buys what is asked for, never more than is missing, and all or nothing', () => {
  const { s, e } = setup({ ammo: 10 });
  assert.deepEqual(e.restock(3), { ok: true, bought: 3 });
  assert.deepEqual([s.ammo, s.coins], [13, 880]);
  assert.deepEqual(e.restock(100), { ok: true, bought: 7 }); // only 7 are missing
  assert.deepEqual([s.ammo, s.coins], [20, 600]);
  assert.deepEqual(e.restock(5), { ok: false, reason: 'full' });
  s.ammo = 0; s.coins = 790; // filling the launcher costs 800
  assert.deepEqual(e.restock(), { ok: false, reason: 'coins' });
  assert.deepEqual([s.ammo, s.coins], [0, 790]); // not even the 19 that 790 coins would cover
  assert.deepEqual(e.restock(19), { ok: true, bought: 19 });
  assert.deepEqual([s.ammo, s.coins], [19, 30]);
});

test('buying restock fills the launcher and reports the number of interceptors as the level', () => {
  const { s, e } = setup({ ammo: 8 });
  assert.deepEqual(e.buy('restock'), { ok: true, level: 12 });
  assert.deepEqual([s.ammo, s.coins], [20, 520]);
  assert.deepEqual(e.buy('restock'), { ok: false, reason: 'full' });
  s.ammo = 0; s.coins = 799; // filling the launcher costs 800
  assert.deepEqual(e.buy('restock'), { ok: false, reason: 'coins' });
  assert.deepEqual([s.ammo, s.coins], [0, 799]);
});

test('only the economy fields of the state are touched', () => {
  const others = { score: 50, round: 3, phase: 'shop', threats: [], hold: true };
  const s = { ...fresh(), coins: 100000, ammo: 5, lives: 2, ...others };
  const e = createEconomy(s);
  for (const item of SHOP) e.buy(item.id);
  e.restock(); e.spend(10); e.earn(10); e.rewardFor('rocket'); e.stipend(2);
  assert.deepEqual(Object.keys(s).sort(), [...Object.keys(fresh()), ...Object.keys(others)].sort());
  for (const key of Object.keys(others)) assert.deepEqual(s[key], others[key], key);
});
