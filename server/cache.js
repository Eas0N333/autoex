/**
 * Bounded LRU + TTL cache for completed answers.
 * A TTL of 0 (or a non-positive value) means entries never expire on their own;
 * the LRU bound still keeps memory finite.
 */

export function createCache({ maxEntries = 200, ttlMs = 0 } = {}) {
  const limit = Number.isFinite(maxEntries) && maxEntries >= 1 ? Math.floor(maxEntries) : 200;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 0;

  const store = new Map();

  function expired(entry) {
    return entry.expiresAt !== 0 && entry.expiresAt <= Date.now();
  }

  function prune() {
    for (const [key, entry] of store) {
      if (expired(entry)) store.delete(key);
    }
  }

  function get(key) {
    if (typeof key !== 'string' || key.length === 0) return undefined;
    const entry = store.get(key);
    if (!entry) return undefined;
    if (expired(entry)) {
      store.delete(key);
      return undefined;
    }
    // Re-insert so Map iteration order stays least-recently-used first.
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    if (typeof key !== 'string' || key.length === 0) return;
    store.delete(key);
    store.set(key, { value, expiresAt: ttl === 0 ? 0 : Date.now() + ttl });
    while (store.size > limit) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }

  return {
    get,
    set,
    get size() {
      prune();
      return store.size;
    },
  };
}
