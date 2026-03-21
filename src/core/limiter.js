'use strict';

const EventEmitter                = require('events');
const { resolveConfig }           = require('./config');
const { MemoryStore }             = require('../store/memoryStore');
const { fixedWindowCheck }        = require('../strategies/fixedWindow');
const { slidingWindowCheck }      = require('../strategies/slidingWindow');
const { tokenBucketCheck }        = require('../strategies/tokenBucket');
const { slidingWindowLog }        = require('../strategies/slidingWindowLog');
const { leakyBucket }             = require('../strategies/leakyBucket');
const { resolveKeyGenerator }     = require('../utils/keyGenerator');
const { extractIp }               = require('../utils/keyGenerator');
const { createLogger }            = require('../utils/logger');
const { AnalyticsTracker }        = require('../analytics/tracker');
const { SmartDetector }           = require('../smart/detector');
const { setHeaders }              = require('../middleware/headers');
const { checkAccess }             = require('./accessControl');
const { PrometheusFormatter }     = require('../analytics/prometheus');
const { RuleEngine }              = require('./ruleEngine');
const { WebhookSender }           = require('../webhook/sender');
const { Scheduler }               = require('./scheduler');
const { dashboardMiddleware }     = require('../dashboard/dashboardMiddleware');

const STRATEGY_MAP = {
  'fixed-window':   fixedWindowCheck,
  'sliding-window': slidingWindowCheck,
  'token-bucket':   tokenBucketCheck,
  'sliding-window-log': slidingWindowLog,
  'leaky-bucket':   leakyBucket,
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
class Limiter extends EventEmitter {
  /**
   * @param {object} options - NextLimiter configuration (see config.js for defaults)
   */
  constructor(options = {}) {
    super();
    this.setMaxListeners(50);
    this.on('error', () => {}); // default no-op handler prevents crashes

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
    this._smart = this._config.smart ? new SmartDetector(this._config, this) : null;

    // Stats event interval
    if (this._config.statsInterval) {
      this._statsTimer = setInterval(() => {
        this.emit('stats', this.getStats());
      }, this._config.statsInterval).unref();
    }

    // Engine, Scheduler & Webhook
    this.ruleEngine = this._config.rules ? new RuleEngine(this._config.rules, this._store, this, this._config) : null;
    this.scheduler = this._config.schedule ? new Scheduler(this._config.schedule, this._config) : null;
    this.webhookSender = this._config.webhook ? new WebhookSender(this._config) : null;
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

        // ── Access control (whitelist / blacklist) ───────────────────────────
        const clientIp = extractIp(req);
        const access   = checkAccess(clientIp, this._config, this);

        if (access.action === 'block') {
          return res.status(403).json({
            error:   'Forbidden',
            message: 'Your IP address has been blocked.',
          });
        }

        if (access.action === 'skip') {
          // Whitelisted — bypass all rate limiting, proceed immediately
          return next();
        }
        // ────────────────────────────────────────────────────────────────────

        let result;
        let rawKey;
        let key;
        let failedRuleName;

        if (this.ruleEngine) {
          const ruleResult = await this.ruleEngine.check(req);
          result = ruleResult.mostRestrictive;
          rawKey = ruleResult.key; // composite key
          key = ruleResult.key;
          failedRuleName = ruleResult.failedRule ? ruleResult.failedRule.name : undefined;

          if (this._config.headers) {
            res.setHeader('X-RateLimit-Rule-Count', ruleResult.results.length);
            if (!ruleResult.allowed && failedRuleName) {
              res.setHeader('X-RateLimit-Failed-Rule', failedRuleName);
            }
          }
        } else {
          rawKey = this._keyGenerator(req);
          key    = `${this._config.keyPrefix}${rawKey}`;
          result = await this._runCheck(key);
        }
        
        // Emit events
        if (result.allowed) {
          this.emit('allowed', rawKey, result);
        } else {
          this.emit('blocked', rawKey, result);
          if (this.webhookSender) {
             this.webhookSender.send({
               event: 'blocked',
               key,
               ip: clientIp,
               limit: result.limit,
               count: result.limit - result.remaining,
               timestamp: new Date().toISOString(),
               retryAfter: result.retryAfter,
               strategy: result.strategy,
               ...(failedRuleName ? { ruleName: failedRuleName } : {})
             });
          }
        }

        // Record analytics
        this._analytics.record(key, result.allowed);

        // Set headers (base headers overrides single rule headers if rule engine is active, that is fine)
        if (this._config.headers) {
          setHeaders(res, result);
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
        this.emit('error', err);
        // Never let rate limiter errors take down the application
        this._log.warn(`Middleware error: ${err.message}. Failing open.`);
        next();
      }
    };
  }

  /**
   * Express route handler for serving Prometheus metrics.
   * Exposes getStats() data in plain text format (version=0.0.4).
   *
   * @example
   * app.get('/metrics', limiter.metricsHandler());
   */
  metricsHandler() {
    return (req, res) => {
      try {
        const formatter = new PrometheusFormatter(this);
        res.set('Content-Type', formatter.contentType());
        res.send(formatter.format());
      } catch (err) {
        res.status(500).type('text/plain').send(`Error generating metrics: ${err.message}`);
      }
    };
  }

  /**
   * Global middleware that automatically intercepts GET /metrics requests
   * and serves the Prometheus exposition format. Passes through all other routes.
   *
   * @example
   * app.use(limiter.metricsMiddleware());
   */
  metricsMiddleware() {
    return (req, res, next) => {
      if (req.method === 'GET' && req.path === '/metrics') {
        return this.metricsHandler()(req, res);
      }
      next();
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
    // Apply access control if the key looks like a plain IP address
    const looksLikeIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(String(key).trim());
    if (looksLikeIp) {
      const access = checkAccess(key, this._config, this);
      if (access.action === 'block') {
        return {
          allowed:      false,
          limit:        this._config.max,
          remaining:    0,
          resetAt:      Date.now(),
          retryAfter:   0,
          key,
          strategy:     this._config.strategy,
          smartBlocked: false,
          blocked:      true,
          reason:       'blacklisted',
        };
      }
      if (access.action === 'skip') {
        return {
          allowed:    true,
          limit:      this._config.max,
          remaining:  Infinity,
          resetAt:    Date.now() + this._config.windowMs,
          retryAfter: 0,
          key,
          strategy:   this._config.strategy,
          smartBlocked: false,
          reason:     'whitelisted',
        };
      }
    }

    const fullKey = `${this._config.keyPrefix}${key}`;
    const result  = await this._runCheck(fullKey);
    this._analytics.record(fullKey, result.allowed);

    if (result.allowed) this.emit('allowed', key, result);
    else this.emit('blocked', key, result);

    return result;
  }

  /**
   * Reset rate limit state for a key.
   *
   * @param {string} key
   */
  resetKey(key) {
    const fullKey = `${this._config.keyPrefix}${key}`;
    this._store.delete(fullKey);
    this.emit('reset', key);
  }

  /**
   * Cleanly dispose of stats cycles and store buffers.
   */
  destroy() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    if (this._store && typeof this._store.destroy === 'function') {
      this._store.destroy();
    }
    this.removeAllListeners();
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
   * Returns an Express middleware for displaying a live dashboard.
   *
   * @param {object} options
   * @param {string} options.password - If set, enable HTTP Basic Auth
   * @param {number} options.refreshMs - SSE push interval (default 2000ms)
   * @param {string} options.path - Mount path prefix (default '/nextlimiter')
   * @returns {function}
   */
  dashboardMiddleware(options = {}) {
    return dashboardMiddleware(this, options);
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

    stats.activeSchedule = this.scheduler ? this.scheduler.resolve() : null;

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
    let effectiveConfig = this.scheduler ? this.scheduler.resolve() : this._config;

    // Apply smart penalty if relevant
    if (this._smart) {
      const { penalized, effectiveMax } = this._smart.check(key);
      if (penalized) {
        // Create a shallow config override with reduced max
        effectiveConfig = { ...effectiveConfig, max: effectiveMax };
      }
    }

    return this._strategy(key, effectiveConfig, this._store);
  }
}

module.exports = { Limiter };
