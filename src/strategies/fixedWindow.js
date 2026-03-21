'use strict';

const { RateLimitResult } = require('../core/result');

/**
 * Fixed Window strategy.
 *
 * Divides time into fixed intervals. Counts requests per interval.
 * Simple, low memory usage, but susceptible to boundary burst attacks
 * (a client can send 2× the limit in a short period by straddling a window edge).
 *
 * Redis key format: `<prefix><key>:<windowStart>`
 * The window timestamp in the key means entries auto-expire naturally.
 *
 * @param {string} key         - Rate limit key (e.g. "nextlimiter:ip:1.2.3.4")
 * @param {object} config      - Resolved NextLimiter config
 * @param {object} store       - Store instance
 * @returns {RateLimitResult}
 */
function fixedWindowCheck(key, config, store) {
  const now = Date.now();
  const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
  const windowEnd   = windowStart + config.windowMs;
  const storeKey    = `${key}:fw:${windowStart}`;

  const count = store.increment(storeKey, config.windowMs);
  const allowed = count <= config.max;

  return new RateLimitResult({
    allowed,
    limit:    config.max,
    remaining: config.max - count,
    resetAt:  windowEnd,
    retryAfter: allowed ? 0 : Math.ceil((windowEnd - now) / 1000),
    key,
    strategy: 'fixed-window',
  });
}

module.exports = { fixedWindowCheck };
