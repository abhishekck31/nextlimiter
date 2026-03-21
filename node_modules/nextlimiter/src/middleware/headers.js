'use strict';

/**
 * Apply standard rate limit headers to an Express response.
 *
 * Headers set:
 *   X-RateLimit-Limit     — max requests per window
 *   X-RateLimit-Remaining — remaining requests in current window
 *   X-RateLimit-Reset     — Unix timestamp (seconds) when window resets
 *   X-RateLimit-Strategy  — algorithm name (informational)
 *   Retry-After           — seconds to wait (only on 429 responses)
 *
 * @param {object} res           - Express response object
 * @param {object} result        - RateLimitResult instance
 * @param {boolean} includeRetry - Whether to add Retry-After header
 */
function setHeaders(res, result, includeRetry = false) {
  res.setHeader('X-RateLimit-Limit',     result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset',     Math.ceil(result.resetAt / 1000));
  res.setHeader('X-RateLimit-Strategy',  result.strategy);

  if (includeRetry && !result.allowed) {
    const retrySeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', retrySeconds);
  }
}

module.exports = { setHeaders };
