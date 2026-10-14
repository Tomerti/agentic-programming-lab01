// Economy: what things cost, what they pay and what the shop sells. It works on the session's state record and
// touches only coins, ammo, ammoCapacity, lives, maxLives and upgrades (an object from item id to level; an id
// that is missing is level 0). It emits nothing: the session reports changes from the results. The numbers are
// ECONOMY, SHOP, THREATS and WORLD in config.js.
import { ECONOMY, SHOP, THREATS, WORLD } from '../config.js';

// An economy over `state`. The state is read on every call and never copied, so the session may change it
// between calls, even swap in a new upgrades object. `config` is the tables to read; tests pass their own.
export function createEconomy(state, config = { ECONOMY, SHOP, THREATS, WORLD }) {
  const { ECONOMY, SHOP, THREATS, WORLD } = config; // shadows the imports, which only serve as the default

  // The level of an item: how often it was bought, 0 if never. Restock is not counted (see buy). Only the
  // upgrades' own keys count, so an id such as 'constructor' is level 0.
  const itemLevel = id => (Object.hasOwn(state.upgrades, id) ? state.upgrades[id] : 0);

  // Values the upgrades change.
  const shotCost = () => ECONOMY.shotCost - ECONOMY.shotDiscountPerLevel * itemLevel('cheaper');
  const hitChance = () => Math.min(1, ECONOMY.hitChance + ECONOMY.hitChancePerLevel * itemLevel('seekers'));
  const detectionRange = () => WORLD.detectionBase + WORLD.detectionPerLevel * itemLevel('radar');
  const fireCooldown = () => (itemLevel('rapid') ? ECONOMY.rapidCooldown : ECONOMY.fireCooldown);

  const canAfford = cost => state.coins >= cost;

  // Pays `cost` if the coins cover it; otherwise false, and the coins stay as they are.
  const spend = cost => {
    if (!canAfford(cost)) return false;
    state.coins -= cost;
    return true;
  };

  // Adds `amount` to the coins and returns the new balance.
  const earn = amount => {
    state.coins += amount;
    return state.coins;
  };

  const rewardFor = typeId => THREATS[typeId].reward;
  const stipend = round => ECONOMY.stipendBase + ECONOMY.stipendPerRound * round;

  const restockCost = n => n * ECONOMY.restockCost;
  const missingAmmo = () => state.ammoCapacity - state.ammo;

  // Buys min(n, missing) interceptors, none for n <= 0: { ok: true, bought }, or { ok: false, reason } where
  // 'full' means none is missing and 'coins' that the coins do not cover the whole order, in which case
  // nothing is bought. Ammo is never sold back: the amount is never below 0, and a surplus counts as full.
  const restock = (n = missingAmmo()) => {
    const missing = missingAmmo();
    if (missing <= 0) return { ok: false, reason: 'full' };
    const bought = Math.max(0, Math.min(n, missing));
    if (!spend(restockCost(bought))) return { ok: false, reason: 'coins' };
    state.ammo += bought;
    return { ok: true, bought };
  };

  // Most shop items cost their SHOP price and gain a level, up to their maxLevel. These two tables hold what
  // sets the others apart. limits: the reason an item cannot be bought besides its level cap, or false.
  // effects: what buying it does to the state, besides gaining a level.
  const limits = {
    maxLives: () => state.maxLives >= ECONOMY.maxLivesCap && 'maxed',
    life: () => state.lives >= state.maxLives && 'livesFull',
    restock: () => missingAmmo() <= 0 && 'full',
  };
  const effects = {
    maxLives: () => { state.maxLives += 1; },
    life: () => { state.lives += 1; },
    capacity: () => { state.ammoCapacity += ECONOMY.capacityPerLevel; },
  };

  const findItem = id => SHOP.find(row => row.id === id);

  // The price of one purchase, or null for an id the shop does not sell. Restock is priced per interceptor, so
  // its price is that of filling the launcher.
  const itemCost = id => {
    const item = findItem(id);
    if (!item) return null;
    return id === 'restock' ? restockCost(missingAmmo()) : item.cost;
  };

  // { ok: true }, or { ok: false, reason } with the first reason that holds: 'unknown' (not a shop id), 'maxed'
  // (all levels bought), 'livesFull', 'full' (nothing to restock), 'coins'.
  const canBuy = id => {
    const item = findItem(id);
    if (!item) return { ok: false, reason: 'unknown' };
    if (itemLevel(id) >= item.maxLevel) return { ok: false, reason: 'maxed' };
    const limit = limits[id]?.();
    if (limit) return { ok: false, reason: limit };
    if (!canAfford(itemCost(id))) return { ok: false, reason: 'coins' };
    return { ok: true };
  };

  // Buys one level of the item and returns { ok: true, level } with the new level, or the refusal from canBuy,
  // in which case nothing changes. Restock fills the launcher instead and reports the number bought as level.
  const buy = id => {
    const check = canBuy(id);
    if (!check.ok) return check;
    if (id === 'restock') return { ok: true, level: restock().bought };
    spend(itemCost(id));
    effects[id]?.();
    state.upgrades[id] = itemLevel(id) + 1;
    return { ok: true, level: state.upgrades[id] };
  };

  return {
    shotCost, hitChance, detectionRange, fireCooldown,
    canAfford, spend, earn, rewardFor, stipend,
    restockCost, missingAmmo, restock,
    itemLevel, itemCost, canBuy, buy,
  };
}
