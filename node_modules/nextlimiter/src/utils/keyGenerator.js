'use strict';

/**
 * Built-in key generators.
 * Each returns a string that uniquely identifies the rate-limit subject.
 */

/**
 * Extract real client IP, respecting common proxy headers.
 * Order: X-Forwarded-For → X-Real-IP → req.ip → req.socket.remoteAddress
 *
 * @param {object} req - Express request
 * @returns {string}
 */
function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For can be a comma-separated list; first entry is client IP
    return forwarded.split(',')[0].trim();
  }
  return (
    req.headers['x-real-ip'] ||
    req.ip ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

/**
 * Rate limit by authenticated user ID.
 * Looks for userId in: req.user.id → req.user._id → req.userId → req.auth.userId
 *
 * Falls back to IP if no user is found (unauthenticated requests).
 *
 * @param {object} req
 * @returns {string}
 */
function getUserId(req) {
  const userId =
    (req.user && (req.user.id || req.user._id || req.user.userId)) ||
    req.userId ||
    (req.auth && req.auth.userId);

  return userId ? `user:${userId}` : `ip:${getIP(req)}`;
}

/**
 * Rate limit by API key.
 * Looks for key in: Authorization header (Bearer) → X-API-Key header → query.apiKey
 *
 * Falls back to IP if no API key found.
 *
 * @param {object} req
 * @returns {string}
 */
function getApiKey(req) {
  // Bearer token in Authorization header
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    return `apikey:${auth.slice(7)}`;
  }

  // X-API-Key custom header
  const headerKey = req.headers['x-api-key'];
  if (headerKey) return `apikey:${headerKey}`;

  // Query parameter fallback
  const queryKey = req.query && req.query.apiKey;
  if (queryKey) return `apikey:${queryKey}`;

  // Final fallback: IP
  return `ip:${getIP(req)}`;
}

/**
 * Resolve a key generator function from the `keyBy` config value.
 *
 * @param {string|function} keyBy - 'ip' | 'user-id' | 'api-key' | custom fn
 * @returns {function}
 */
function resolveKeyGenerator(keyBy) {
  if (typeof keyBy === 'function') return keyBy;

  switch (keyBy) {
    case 'ip':      return getIP;
    case 'user-id': return getUserId;
    case 'api-key': return getApiKey;
    default:
      throw new Error(
        `[NexLimit] Unknown keyBy value: "${keyBy}". Use 'ip', 'user-id', 'api-key', or a custom function.`
      );
  }
}

module.exports = { getIP, getUserId, getApiKey, resolveKeyGenerator };
