'use strict';

/**
 * RedisStore — Redis-backed storage backend for NextLimiter.
 *
 * Requires ioredis to be installed separately:
 *   npm install ioredis
 *
 * Uses a Lua script for atomic increment so it is safe across multiple servers
 * behind a load balancer — no race conditions, no split-brain issues.
 *
 * Implements the NextLimiter Store interface:
 *   get(key)                  → Promise<value | undefined>
 *   set(key, value, ttlMs)    → Promise<void>
 *   increment(key, ttlMs)     → Promise<number>  (atomic via Lua)
 *   delete(key)               → Promise<void>
 *   keys()                    → []               (SCAN not required by the interface)
 */

/**
 * Lua script for atomic rate-limit increment.
 *
 * KEYS[1]  — the rate limit key
 * ARGV[1]  — the max limit (not used for blocking in this script; handled in JS)
 * ARGV[2]  — TTL in milliseconds (applied only on first request in window)
 *
 * Logic:
 *   1. GET current value (default 0 if nil)
 *   2. INCR the key
 *   3. If new value == 1 (first request), set PEXPIRE to establish the window TTL
 *   4. Return the new count
 *
 * Atomicity guarantee: all steps execute as a single Redis transaction — no
 * other command can interleave between the GET, INCR, and PEXPIRE.
 */
const INCR_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local new = redis.call('INCR', KEYS[1])
if new == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return new
`;

class RedisStore {
  /**
   * @param {import('ioredis').Redis} client — a connected ioredis client instance
   */
  constructor(client) {
    if (!client || typeof client.eval !== 'function') {
      throw new Error(
        '[NextLimiter] RedisStore requires an ioredis client instance. ' +
        'Install it with: npm install ioredis'
      );
    }
    this._client = client;
  }

  // ── Store interface ─────────────────────────────────────────────────────────

  /**
   * Get a stored value by key.
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(key) {
    const raw = await this._client.get(key);
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Set a value with a TTL.
   * @param {string} key
   * @param {any} value
   * @param {number} ttlMs - Time to live in milliseconds
   */
  async set(key, value, ttlMs) {
    await this._client.set(key, JSON.stringify(value), 'PX', ttlMs);
  }

  /**
   * Atomically increment the request counter for a key using a Lua script.
   * Sets the window TTL on first request. Returns the new count.
   *
   * @param {string} key
   * @param {number} ttlMs - Window TTL in milliseconds (set on first request only)
   * @returns {Promise<number>} new count after increment
   */
  async increment(key, ttlMs) {
    const result = await this._client.eval(
      INCR_SCRIPT,
      1,       // number of KEYS
      key,     // KEYS[1]
      ttlMs    // ARGV[1] — TTL in ms
    );
    return Number(result);
  }

  /**
   * Delete a key.
   * @param {string} key
   */
  async delete(key) {
    await this._client.del(key);
  }

  /**
   * Return tracked keys. Redis SCAN is optional per the Store interface,
   * so we return an empty array here. Use Redis SCAN / HSCAN externally
   * if you need to inspect active keys in production.
   * @returns {string[]}
   */
  keys() {
    return [];
  }

  /** No-op — Redis keys expire automatically via PEXPIRE. */
  clear() {}
}

module.exports = { RedisStore };

// ── Usage example ─────────────────────────────────────────────────────────────
//
// const Redis = require('ioredis');
// const { createLimiter, RedisStore } = require('nextlimiter');
//
// const redis = new Redis();   // connects to 127.0.0.1:6379 by default
//
// const limiter = createLimiter({
//   store:    new RedisStore(redis),
//   max:      100,
//   windowMs: 60_000,
//   strategy: 'sliding-window',
//   keyBy:    'ip',
//   logging:  true,
// });
//
// app.use('/api', limiter.middleware());
//
// // Programmatic check (WebSockets, background jobs, etc.)
// const result = await limiter.check(`user:${userId}`);
// if (!result.allowed) throw new Error(`Rate limited. Retry in ${result.retryAfter}s`);
//
// ─────────────────────────────────────────────────────────────────────────────
