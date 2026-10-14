// Tiny synchronous event bus. Event types are named 'noun:verb' (e.g. 'threat:impact').
// The session emits; views subscribe and change state only through session commands.
export function createBus() {
  // type -> Set of handler functions, in registration order (a function is subscribed once per type)
  const handlers = new Map();

  function off(type, fn) {
    handlers.get(type)?.delete(fn);
  }

  // Returns a function that unsubscribes this handler again.
  function on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => off(type, fn);
  }

  function emit(type, payload) {
    // Walk a copy so a handler can unsubscribe (or subscribe) mid-emit without skipping anyone.
    for (const fn of [...(handlers.get(type) ?? [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`event bus: handler for "${type}" threw`, err);
      }
    }
  }

  return { on, off, emit };
}
