'use strict';

const { RateLimitResult } = require('../core/result');

/**
 * Sliding Window strategy using a weighted two-window approximation.
 *
 * This is the algorithm used by Cloudflare and Nginx's limit_req_zone.
 * It avoids the boundary-burst problem of fixed window without the memory
 * cost of a full sliding-window log.
 *
 * How it works:
 *   count ≈ (prevWindowCount × prevWindowWeight) + currentWindowCount
 *
 * Where prevWindowWeight = fraction of previous window still "in view"
 * based on how far into the current window we are.
 *
 * Example: windowMs = 60s, we are 15s into the current window.
 *   prevWindowWeight = (60-15)/60 = 0.75
 *   Effective count = (prevCount × 0.75) + currentCount
 *
 * This is O(1) memory per key — same as fixed window — but much more
 * accurate. The approximation error is at most 1/(2 × windowMs).
 *
 * @param {string} key         - Rate limit key
 * @param {object} config      - Resolved NexLimit config
 * @param {object} store       - Store instance
 * @returns {RateLimitResult}
 */
function slidingWindowCheck(key, config, store) {
  const now         = Date.now();
  const windowMs    = config.windowMs;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const prevStart   = windowStart - windowMs;

  const currentKey = `${key}:sw:${windowStart}`;
  const prevKey    = `${key}:sw:${prevStart}`;

  // How far into the current window are we? (0.0 → 1.0)
  const positionInWindow = (now - windowStart) / windowMs;

  // Weight of the previous window (complement of current position)
  const prevWeight = 1 - positionInWindow;

  // Get counts from both windows
  const currentCount = store.get(currentKey) || 0;
  const prevCount    = store.get(prevKey)     || 0;

  // Weighted approximation
  const effectiveCount = Math.floor(prevCount * prevWeight) + currentCount;

  if (effectiveCount >= config.max) {
    return new RateLimitResult({
      allowed:   false,
      limit:     config.max,
      remaining: 0,
      resetAt:   windowStart + windowMs,
      retryAfter: Math.ceil((windowStart + windowMs - now) / 1000),
      key,
      strategy: 'sliding-window',
    });
  }

  // Increment current window. TTL = 2 full windows to keep prev window alive.
  store.increment(currentKey, windowMs * 2);

  return new RateLimitResult({
    allowed:   true,
    limit:     config.max,
    remaining: config.max - effectiveCount - 1,
    resetAt:   windowStart + windowMs,
    retryAfter: 0,
    key,
    strategy: 'sliding-window',
  });
}

module.exports = { slidingWindowCheck };
