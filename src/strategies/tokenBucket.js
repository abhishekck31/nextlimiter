'use strict';

const { RateLimitResult } = require('../core/result');

/**
 * Token Bucket strategy.
 *
 * Tokens refill continuously at a steady rate. Each request consumes one
 * token. Allows controlled bursts up to `capacity` tokens while enforcing
 * a long-term average rate of `max` requests per `windowMs`.
 *
 * State per key: { tokens: float, lastRefill: timestamp }
 *
 * Refill rate = config.max / config.windowMs  (tokens per millisecond)
 * Capacity    = config.max  (maximum accumulated tokens)
 *
 * This is the algorithm used by Stripe for their API rate limiting.
 * It feels more "fair" to clients than window-based approaches because
 * occasional bursts are explicitly allowed.
 *
 * @param {string} key      - Rate limit key
 * @param {object} config   - Resolved NexLimit config
 * @param {object} store    - Store instance
 * @returns {RateLimitResult}
 */
function tokenBucketCheck(key, config, store) {
  const now        = Date.now();
  const capacity   = config.max;
  const refillRate = config.max / config.windowMs; // tokens per ms
  const storeKey   = `${key}:tb`;

  let bucket = store.get(storeKey);

  if (!bucket) {
    // First request: full bucket, consume one token
    bucket = { tokens: capacity - 1, lastRefill: now };
    store.set(storeKey, bucket, config.windowMs * 2);
    return new RateLimitResult({
      allowed:   true,
      limit:     capacity,
      remaining: Math.floor(bucket.tokens),
      resetAt:   now + config.windowMs,
      retryAfter: 0,
      key,
      strategy: 'token-bucket',
    });
  }

  // Refill tokens proportional to elapsed time
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    // Not enough tokens: calculate when one token will be available
    const msUntilToken = Math.ceil((1 - bucket.tokens) / refillRate);
    store.set(storeKey, bucket, config.windowMs * 2);

    return new RateLimitResult({
      allowed:   false,
      limit:     capacity,
      remaining: 0,
      resetAt:   now + msUntilToken,
      retryAfter: Math.ceil(msUntilToken / 1000),
      key,
      strategy: 'token-bucket',
    });
  }

  // Consume one token
  bucket.tokens -= 1;
  store.set(storeKey, bucket, config.windowMs * 2);

  return new RateLimitResult({
    allowed:   true,
    limit:     capacity,
    remaining: Math.floor(bucket.tokens),
    resetAt:   now + Math.ceil((capacity - bucket.tokens) / refillRate),
    retryAfter: 0,
    key,
    strategy: 'token-bucket',
  });
}

module.exports = { tokenBucketCheck };
