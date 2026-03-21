'use strict';

/**
 * MemoryStore — default storage backend.
 *
 * Uses a plain Map with periodic cleanup of expired entries.
 * For multi-process / distributed deployments, swap this for RedisStore.
 *
 * Implements the NexLimit Store interface:
 *   get(key)          → value | undefined
 *   set(key, value, ttlMs)
 *   increment(key, ttlMs) → number  (atomic increment, returns new value)
 *   delete(key)
 *   keys()            → string[]
 *   clear()
 */
class MemoryStore {
  constructor() {
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this._data = new Map();

    // Clean up expired entries every 5 minutes to prevent memory leaks
    this._cleanupInterval = setInterval(() => this._cleanup(), 5 * 60_000);

    // Don't let this timer prevent process exit
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  /**
   * Get a stored value by key. Returns undefined if missing or expired.
   * @param {string} key
   */
  get(key) {
    const entry = this._data.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a value with TTL.
   * @param {string} key
   * @param {any} value
   * @param {number} ttlMs - Time to live in milliseconds
   */
  set(key, value, ttlMs) {
    this._data.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Atomic increment. Creates key with value 1 if it doesn't exist.
   * Returns the new value after increment.
   * @param {string} key
   * @param {number} ttlMs - TTL applied only on first creation
   * @returns {number}
   */
  increment(key, ttlMs) {
    const entry = this._data.get(key);
    const now = Date.now();

    if (!entry || now > entry.expiresAt) {
      this._data.set(key, { value: 1, expiresAt: now + ttlMs });
      return 1;
    }

    entry.value += 1;
    return entry.value;
  }

  /**
   * Delete a key immediately.
   * @param {string} key
   */
  delete(key) {
    this._data.delete(key);
  }

  /**
   * Return all non-expired keys.
   * @returns {string[]}
   */
  keys() {
    const now = Date.now();
    const result = [];
    for (const [key, entry] of this._data) {
      if (now <= entry.expiresAt) result.push(key);
    }
    return result;
  }

  /** Remove all entries. */
  clear() {
    this._data.clear();
  }

  /** Remove expired entries to prevent unbounded memory growth. */
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._data) {
      if (now > entry.expiresAt) this._data.delete(key);
    }
  }

  /** Stop the cleanup timer. Call when tearing down the store. */
  destroy() {
    clearInterval(this._cleanupInterval);
    this._data.clear();
  }

  /** Current number of tracked keys (includes expired until next cleanup). */
  get size() {
    return this._data.size;
  }
}

module.exports = { MemoryStore };
