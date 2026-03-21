'use strict';

const { RateLimitResult } = require('../core/result');

/**
 * Sliding Window Log strategy.
 * Perfect accuracy, O(n) memory. Stores a sorted list of timestamps.
 * Note: O(n) memory usage where n = max requests per window.
 * 
 * @param {string} key         - Rate limit key
 * @param {object} config      - Resolved NextLimiter config
 * @param {object} store       - Store instance
 * @returns {Promise<RateLimitResult>}
 */
async function slidingWindowLog(key, config, store) {
  const now = Date.now();
  let log = await Promise.resolve(store.get(key));
  if (!log || !Array.isArray(log)) {
    log = [];
  }
  
  // Prune old timestamps
  const windowStart = now - config.windowMs;
  log = log.filter(t => t > windowStart);
  
  if (log.length >= config.max) {
    const oldestInWindow = log[0];
    const retryAfterMs = oldestInWindow + config.windowMs - now;
    return new RateLimitResult({
      allowed: false,
      limit: config.max,
      remaining: 0,
      resetAt: oldestInWindow + config.windowMs,
      retryAfter: Math.ceil(retryAfterMs / 1000),
      key,
      strategy: 'sliding-window-log'
    });
  }
  
  log.push(now);
  await Promise.resolve(store.set(key, log, config.windowMs));
  
  return new RateLimitResult({
    allowed: true,
    limit: config.max,
    remaining: config.max - log.length,
    resetAt: (log[0] || now) + config.windowMs,
    retryAfter: 0,
    key,
    strategy: 'sliding-window-log'
  });
}

module.exports = { slidingWindowLog };
