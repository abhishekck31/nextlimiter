'use strict';

const { Limiter }     = require('./core/limiter');
const { PRESETS, DEFAULT_PLANS } = require('./core/config');
const { MemoryStore } = require('./store/memoryStore');
const { RedisStore }  = require('./store/redisStore');

/**
 * Create a fully configured rate limiter instance.
 *
 * @param {object} [options]
 * @param {number}  [options.windowMs=60000]      - Time window in ms
 * @param {number}  [options.max=100]             - Max requests per window
 * @param {string}  [options.strategy='sliding-window'] - 'fixed-window' | 'sliding-window' | 'token-bucket'
 * @param {string}  [options.keyBy='ip']          - 'ip' | 'user-id' | 'api-key' | function
 * @param {string}  [options.plan]                - 'free' | 'pro' | 'enterprise'
 * @param {string}  [options.preset]              - 'strict' | 'relaxed' | 'api' | 'auth'
 * @param {boolean} [options.smart=false]         - Enable behavior-based smart limiting
 * @param {boolean} [options.logging=false]       - Enable request logging
 * @param {boolean} [options.headers=true]        - Send X-RateLimit-* headers
 * @param {string}  [options.message]             - Custom 429 message
 * @param {number}  [options.statusCode=429]      - HTTP status for blocked requests
 * @param {object}  [options.store]               - Custom store instance
 * @param {function} [options.skip]               - (req) => bool — skip rate limiting
 * @param {function} [options.onLimitReached]     - (req, res, result) => void
 * @param {function} [options.keyGenerator]       - (req) => string — custom key function
 * @param {object}  [options.plans]               - Custom plan definitions
 *
 * @returns {Limiter}
 *
 * @example
 * const limiter = createLimiter({ windowMs: 60_000, max: 100 });
 * app.use(limiter.middleware());
 */
function createLimiter(options = {}) {
  return new Limiter(options);
}

/**
 * Zero-config rate limiter.
 * Returns an Express middleware directly — no .middleware() call needed.
 *
 * Defaults: 100 requests per minute, sliding window, IP-based, no logging.
 *
 * @param {object} [options] - Optional overrides
 * @returns {function} Express middleware
 *
 * @example
 * app.use(autoLimit());
 * app.use(autoLimit({ max: 50, logging: true }));
 */
function autoLimit(options = {}) {
  const limiter = new Limiter({ logging: true, ...options });
  return limiter.middleware();
}

/**
 * Create a rate limiter pre-configured for a SaaS plan.
 *
 * @param {string} planName - 'free' | 'pro' | 'enterprise'
 * @param {object} [options] - Additional options to merge
 * @returns {Limiter}
 *
 * @example
 * const limiter = createPlanLimiter('pro', { keyBy: 'api-key', logging: true });
 * app.use('/api', limiter.middleware());
 */
function createPlanLimiter(planName, options = {}) {
  return new Limiter({ ...options, plan: planName });
}

/**
 * Create a rate limiter from a named preset.
 *
 * @param {string} presetName - 'strict' | 'relaxed' | 'api' | 'auth'
 * @param {object} [options]  - Overrides applied on top of the preset
 * @returns {Limiter}
 *
 * @example
 * app.post('/login', createPresetLimiter('auth').middleware());
 */
function createPresetLimiter(presetName, options = {}) {
  if (!PRESETS[presetName]) {
    throw new Error(
      `[NextLimiter] Unknown preset "${presetName}". Available: ${Object.keys(PRESETS).join(', ')}`
    );
  }
  return new Limiter({ ...options, preset: presetName });
}

module.exports = {
  // Core factory functions
  createLimiter,
  autoLimit,
  createPlanLimiter,
  createPresetLimiter,

  // Class — for advanced usage / subclassing
  Limiter,

  // Storage
  MemoryStore,
  RedisStore,

  // Constants
  PRESETS,
  DEFAULT_PLANS,
};
