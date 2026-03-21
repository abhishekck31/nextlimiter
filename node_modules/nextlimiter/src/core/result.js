'use strict';

/**
 * Immutable result object returned by every strategy check.
 * Passed to middleware for header generation and response decisions.
 */
class RateLimitResult {
  /**
   * @param {object} params
   * @param {boolean} params.allowed      - Whether the request should proceed
   * @param {number}  params.limit        - Max requests allowed in window
   * @param {number}  params.remaining    - Remaining requests in current window
   * @param {number}  params.resetAt      - Unix timestamp (ms) when window resets
   * @param {number}  params.retryAfter   - Seconds until next request allowed (0 if allowed)
   * @param {string}  params.key          - The resolved rate limit key
   * @param {string}  params.strategy     - Strategy name used
   * @param {boolean} params.smartBlocked - True if blocked by smart limiting
   */
  constructor({ allowed, limit, remaining, resetAt, retryAfter = 0, key, strategy, smartBlocked = false }) {
    this.allowed      = allowed;
    this.limit        = limit;
    this.remaining    = Math.max(0, remaining);
    this.resetAt      = resetAt;
    this.retryAfter   = retryAfter;
    this.key          = key;
    this.strategy     = strategy;
    this.smartBlocked = smartBlocked;

    // Freeze so nothing accidentally mutates the result downstream
    Object.freeze(this);
  }

  /** Seconds until window resets (for Retry-After header) */
  get retryAfterSeconds() {
    return Math.ceil((this.resetAt - Date.now()) / 1000);
  }

  toJSON() {
    return {
      allowed:   this.allowed,
      limit:     this.limit,
      remaining: this.remaining,
      resetAt:   this.resetAt,
      retryAfter: this.retryAfter,
    };
  }
}

module.exports = { RateLimitResult };
