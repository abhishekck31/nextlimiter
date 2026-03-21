'use strict';

const { RateLimitResult } = require('../core/result');

/**
 * Leaky Bucket strategy.
 * Constant output rate, queues overflow.
 * Key difference from token bucket: drains at constant rate (output is smooth, no bursts).
 * 
 * @param {string} key         - Rate limit key
 * @param {object} config      - Resolved NextLimiter config
 * @param {object} store       - Store instance
 * @returns {Promise<RateLimitResult>}
 */
async function leakyBucket(key, config, store) {
  const drainRateMs = config.drainRateMs || (config.windowMs / config.max);
  const capacity = config.capacity || config.max;

  let state = await Promise.resolve(store.get(key));
  if (!state || typeof state.queue !== 'number') {
    state = { queue: 0, lastDrain: Date.now() };
  }

  const now = Date.now();
  const elapsed = now - state.lastDrain;

  // Drain: reduce queue by elapsed time / drain rate
  const drained = elapsed / drainRateMs;
  state.queue = Math.max(0, state.queue - drained);
  state.lastDrain = now;

  if (state.queue >= capacity) {
    // Bucket full — DROP
    const msUntilSpace = (state.queue - capacity + 1) * drainRateMs;
    const retryAfter = Math.ceil(msUntilSpace / 1000);
    return new RateLimitResult({
      allowed: false,
      limit: capacity,
      remaining: 0,
      resetAt: now + msUntilSpace,
      retryAfter,
      key,
      strategy: 'leaky-bucket'
    });
  }

  state.queue += 1;
  const ttl = config.windowMs * 2;
  await Promise.resolve(store.set(key, state, ttl));

  return new RateLimitResult({
    allowed: true,
    limit: capacity,
    remaining: Math.floor(capacity - state.queue),
    resetAt: now + drainRateMs,
    retryAfter: 0,
    key,
    strategy: 'leaky-bucket'
  });
}

module.exports = { leakyBucket };
