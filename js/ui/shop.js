// The shop between rounds (spec §7), and before a retried round (spec §9): a glass panel (.shop) over the dimmed
// room, shown as the screen 'shop' in the overlay container that the screens use (screens.js). It shows the
// balance (#shop-balance), the restock row (#btn-restock), a card for each upgrade with its level, its price and a
// Buy button ([data-buy="<id>"]), disabled with the reason when the economy says it cannot be bought, and
// #btn-next-round, which starts the next round. Every rule is the economy's (prices, levels, what can be bought)
// and every purchase is a session command. The panel is drawn again after each purchase, and render() draws it
// again when something else changed the coins.
import { SHOP } from '../config.js';
import { formatCoins } from '../game/economy.js';
import { amount, button, coin, focusIn, h, screenElement } from './screens.js';

// What a button says when it cannot be pressed, by the economy's reason.
const REASONS = { maxed: 'Maxed', coins: 'Not enough coins', livesFull: 'Lives full', full: 'Full' };
const reasonText = reason => REASONS[reason] ?? 'Unavailable';
const ITEMS = SHOP.filter(item => item.id !== 'restock'); // restock has its own row above the cards

// createShop({ root, session, economy }) → { open(), close(), render() }. `root` is the overlay container or its
// selector and `economy` the session's (session.economy). open() puts the shop in the container in place of what
// was there, close() takes it out (round:start does, and screens.hide() empties the container anyway), render()
// draws it again and does nothing while it is closed.
export function createShop({ root, session, economy = session.economy }) {
  const host = typeof root === 'string' ? document.querySelector(root) : root;
  const { state } = session;
  const panel = h('section', { class: 'panel shop', tabindex: -1 }); // focusable: it takes the focus after a purchase
  const screen = screenElement('shop', 'Supply requisition', panel);
  const isOpen = () => screen.parentNode === host;

  // Runs a purchase and draws the panel again; the row or card that sold something lights up for a moment.
  function purchase(id, run) {
    const result = run();
    render();
    if (result.ok) panel.querySelector(`[data-item="${id}"]`)?.classList.add('bought');
  }

  // The title names the round that comes next: the shop opens after a round's summary, and before a round that a
  // retry plays again (state.round is then the round before it).
  function header() {
    return h('header', { class: 'panel-head shop-head' },
      h('div', { class: 'panel-heading' },
        h('h1', { class: 'panel-title' }, 'Supply requisition',
          h('span', { class: 'title-round' }, ` · Before round ${state.round + 1}`))),
      h('div', { class: 'balance' },
        h('span', { class: 'balance-label' }, 'Balance'),
        h('span', { id: 'shop-balance' }, coin(), formatCoins(state.coins))));
  }

  // Interceptors are bought to fill the launcher. When the coins do not cover all that are missing, the button
  // buys as many as they do; it is disabled only when the launcher is full or not even one is affordable.
  function restockRow() {
    const missing = Math.max(0, economy.missingAmmo());
    const check = economy.canBuy('restock');
    let reason = check.ok ? null : check.reason;
    let count = missing;
    if (reason === 'coins') {
      count = Math.floor(state.coins / economy.restockCost(1));
      if (count > 0) reason = null;
    }
    const label = count < missing ? `Buy ${count} of ${missing}` : 'Restock all';
    const fill = state.ammoCapacity > 0 ? Math.min(Math.max(state.ammo / state.ammoCapacity, 0), 1) : 0;
    return h('div', { class: 'restock', 'data-item': 'restock' },
      h('div', { class: 'restock-text' },
        h('h2', { class: 'item-name' }, 'Restock interceptors'),
        h('p', { class: 'item-desc' },
          missing > 0 ? [`${missing} missing · `, amount(economy.restockCost(missing))] : 'The launcher is full')),
      h('div', { class: 'restock-gauge' },
        h('span', { class: 'gauge-count' }, String(state.ammo),
          h('span', { class: 'gauge-of' }, `/${state.ammoCapacity}`)),
        h('span', { class: 'gauge', 'aria-hidden': 'true' },
          h('span', { class: 'gauge-fill', style: `width: ${(fill * 100).toFixed(1)}%` }))),
      button('btn-restock', reason ? reasonText(reason) : label,
        () => purchase('restock', () => session.restock(count)), { disabled: Boolean(reason) }));
  }

  function itemCard(item) {
    const level = economy.itemLevel(item.id);
    const check = economy.canBuy(item.id);
    const maxed = check.reason === 'maxed';
    return h('article', { class: maxed ? 'shop-item maxed' : 'shop-item', 'data-item': item.id },
      h('div', { class: 'item-top' },
        h('h2', { class: 'item-name' }, item.name),
        h('span', { class: 'item-level' }, h('span', { class: 'item-level-label' }, 'Level '),
          Number.isFinite(item.maxLevel) ? `${level}/${item.maxLevel}` : '—')),
      h('p', { class: 'item-desc' }, item.desc,
        item.id === 'life' && h('span', { class: 'item-status' }, ` · lives ${state.lives}/${state.maxLives}`)),
      h('div', { class: 'item-foot' },
        maxed ? h('span', { class: 'item-cost' }) : amount(economy.itemCost(item.id)),
        h('button', {
          type: 'button', class: 'btn buy', 'data-buy': item.id, disabled: !check.ok,
          onclick: () => purchase(item.id, () => session.buy(item.id)),
        }, check.ok ? 'Buy' : reasonText(check.reason))));
  }

  function footer() {
    return h('footer', { class: 'shop-foot' },
      button('btn-next-round', `Start round ${state.round + 1}`, () => session.leaveShop(), { kind: 'primary' }));
  }

  // The selector that finds the panel's focused button again once the panel is drawn anew, or null.
  function focusedKey() {
    const el = document.activeElement;
    if (!el || !panel.contains(el)) return null;
    if (el.dataset.buy) return `[data-buy="${el.dataset.buy}"]`;
    return el.id ? `#${el.id}` : null;
  }

  // Draws the panel anew and puts the focus back on the button that had it. A button that a purchase disabled hands
  // it to the panel, never to another button: a second press of the key that bought (a double tap, a held Enter)
  // would buy that one too, or start the round. Tab moves on from the panel.
  function render() {
    if (!isOpen()) return;
    const key = focusedKey();
    panel.replaceChildren(header(), restockRow(), h('div', { class: 'shop-grid' }, ITEMS.map(itemCard)), footer());
    if (!key) return;
    const again = panel.querySelector(key);
    (again && !again.disabled ? again : panel).focus({ preventScroll: true });
  }

  function open() {
    screen.classList.toggle('entering', !host.firstElementChild); // over the game, not over the summary
    host.replaceChildren(screen);
    render();
    const restock = panel.querySelector('#btn-restock');
    if (restock.disabled) focusIn(screen);
    else restock.focus({ preventScroll: true });
  }

  function close() {
    if (isOpen()) screen.remove();
  }

  return { open, close, render };
}
