'use strict';

const { resolveConfig }           = require('./config');
const { MemoryStore }             = require('../store/memoryStore');
const { fixedWindowCheck }        = require('../strategies/fixedWindow');
const { slidingWindowCheck }      = require('../strategies/slidingWindow');
const { tokenBucketCheck }        = require('../strategies/tokenBucket');
const { resolveKeyGenerator }     = require('../utils/keyGenerator');
const { createLogger }            = require('../utils/logger');
const { AnalyticsTracker }        = require('../analytics/tracker');
const { SmartDetector }           = require('../smart/detector');
const { setHeaders }              = require('../middleware/headers');

const STRATEGY_MAP = {
  'fixed-window':   fixedWindowCheck,
  'sliding-window': slidingWindowCheck,
  'token-bucket':   tokenBucketCheck,
};

/**
 * NextLimiter — the main Limiter class.
 *
 * Instantiate via `createLimiter(options)` or `autoLimit()`.
 * Do not call `new Limiter()` directly in application code.
 *
 * @example
 * const limiter = createLimiter({ windowMs: 60_000, max: 100 });
 * app.use(limiter.middleware());
 *
 * // Programmatic check
 * const result = await limiter.check('user:42');
 */
class Limiter {
  /**
   * @param {object} options - NextLimiter configuration (see config.js for defaults)
   */
  constructor(options = {}) {
    this._config = resolveConfig(options);

    // Storage backend
    this._store = this._config.store || new MemoryStore();

    // Strategy function
    const strategyFn = STRATEGY_MAP[this._config.strategy];
    if (!strategyFn) {
      throw new Error(
        `[NextLimiter] Unknown strategy "${this._config.strategy}". ` +
        `Valid options: ${Object.keys(STRATEGY_MAP).join(', ')}`
      );
    }
    this._strategy = strategyFn;

    // Key generator
    const keyByFn = this._config.keyGenerator || resolveKeyGenerator(this._config.keyBy);
    this._keyGenerator = keyByFn;

    // Logger
    this._log = createLogger(this._config.logPrefix, this._config.logging);

    // Analytics
    this._analytics = new AnalyticsTracker();

    // Smart detector
    this._smart = this._config.smart ? new SmartDetector(this._config) : null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns an Express middleware function.
   *
   * @returns {function} (req, res, next) => void
   *
   * @example
   * app.use('/api', limiter.middleware());
   */
  middleware() {
    return async (req, res, next) => {
      try {
        // Skip check if skip() returns true
        if (this._config.skip && this._config.skip(req)) {
          return next();
        }

        const rawKey = this._keyGenerator(req);
        const key    = `${this._config.keyPrefix}${rawKey}`;

        const result = await this._runCheck(key);

        // Record analytics
        this._analytics.record(key, result.allowed);

        // Set headers
        if (this._config.headers) {
          setHeaders(res, result, !result.allowed);
        }

        if (!result.allowed) {
          this._log.blocked(
            rawKey,
            result.limit - result.remaining,
            result.limit,
            result.strategy,
            result.smartBlocked
          );

          // Custom handler
          if (this._config.onLimitReached) {
            return this._config.onLimitReached(req, res, result);
          }

          return res.status(this._config.statusCode).json({
            error:      'Too Many Requests',
            message:    this._config.message,
            retryAfter: result.retryAfter,
            limit:      result.limit,
            resetAt:    new Date(result.resetAt).toISOString(),
          });
        }

        next();
      } catch (err) {
        // Never let rate limiter errors take down the application
        this._log.warn(`Error in rate limiter: ${err.message}. Failing open.`);
        next();
      }
    };
  }

  /**
   * Programmatic rate limit check — use outside of HTTP middleware context.
   *
   * @param {string} key - The rate limit key to check
   * @returns {Promise<import('../core/result').RateLimitResult>}
   *
   * @example
   * const result = await limiter.check('user:42');
   * if (!result.allowed) throw new Error('Rate limit exceeded');
   */
  async check(key) {
    const fullKey = `${this._config.keyPrefix}${key}`;
    const result  = await this._runCheck(fullKey);
    this._analytics.record(fullKey, result.allowed);
    return result;
  }

  /**
   * Manually reset the rate limit for a specific key.
   * Useful after a user upgrades their plan, or for admin overrides.
   *
   * @param {string} key
   */
  async reset(key) {
    const fullKey = `${this._config.keyPrefix}${key}`;
    await this._store.delete(fullKey);
    if (this._smart) this._smart.reset();
    this._log.info(`Reset key: ${fullKey}`);
  }

  /**
   * Get analytics snapshot.
   *
   * @returns {object}
   *
   * @example
   * const stats = limiter.getStats();
   * console.log(stats.totalRequests, stats.blockRate);
   */
  getStats() {
    const stats = this._analytics.getStats();

    if (this._smart) {
      stats.smartLimiting = {
        enabled:       true,
        penalizedKeys: this._smart.getPenalizedKeys(),
      };
    }

    stats.config = {
      strategy: this._config.strategy,
      windowMs: this._config.windowMs,
      max:      this._config.max,
      keyBy:    this._config.keyBy,
      plan:     this._config.plan || 'custom',
      smart:    this._config.smart,
    };

    return stats;
  }

  /**
   * Reset all analytics counters.
   */
  resetStats() {
    this._analytics.reset();
  }

  /**
   * Expose the resolved configuration (read-only).
   * @returns {object}
   */
  get config() {
    return Object.freeze({ ...this._config });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Run the strategy check, applying smart penalty if enabled.
   * @param {string} key - Fully-prefixed key
   * @returns {import('../core/result').RateLimitResult}
   */
  _runCheck(key) {
    let effectiveConfig = this._config;

    // Apply smart penalty if relevant
    if (this._smart) {
      const { penalized, effectiveMax } = this._smart.check(key);
      if (penalized) {
        // Create a shallow config override with reduced max
        effectiveConfig = { ...this._config, max: effectiveMax };
      }
    }

    return this._strategy(key, effectiveConfig, this._store);
  }
}

module.exports = { Limiter };
