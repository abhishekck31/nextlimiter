'use strict';

/**
 * Built-in SaaS plan definitions.
 * These can be overridden by passing `plans` in createLimiter options.
 */
const DEFAULT_PLANS = {
  free: {
    windowMs: 60_000,     // 1 minute
    max: 60,              // 60 req/min
    burstMax: 10,         // allow short burst of 10 extra
    description: 'Free tier — 60 requests per minute',
  },
  pro: {
    windowMs: 60_000,
    max: 600,
    burstMax: 100,
    description: 'Pro tier — 600 requests per minute',
  },
  enterprise: {
    windowMs: 60_000,
    max: 6000,
    burstMax: 1000,
    description: 'Enterprise tier — 6000 requests per minute',
  },
};

/**
 * Named presets for quick configuration.
 *
 * @example
 * createLimiter({ preset: 'strict' })
 */
const PRESETS = {
  strict: {
    windowMs: 60_000,
    max: 30,
    strategy: 'sliding-window',
    smart: true,
  },
  relaxed: {
    windowMs: 60_000,
    max: 300,
    strategy: 'token-bucket',
    smart: false,
  },
  api: {
    windowMs: 60_000,
    max: 100,
    strategy: 'sliding-window',
    smart: true,
    keyBy: 'api-key',
  },
  auth: {
    windowMs: 15 * 60_000,  // 15 minutes
    max: 10,                 // only 10 attempts per 15 min
    strategy: 'fixed-window',
    smart: true,
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
  },
};

/**
 * Default configuration merged with user options.
 */
const DEFAULT_CONFIG = {
  windowMs: 60_000,
  max: 100,
  strategy: 'sliding-window',
  keyBy: 'ip',
  keyPrefix: 'nexlimit:',
  message: 'Too many requests, please try again later.',
  statusCode: 429,
  headers: true,
  smart: false,
  smartThreshold: 2.0,     // trigger smart limiting at 2x normal rate
  smartCooldownMs: 60_000, // how long smart penalty lasts
  smartPenaltyFactor: 0.5, // reduce limit to 50% for suspicious keys
  logging: false,
  logPrefix: '[NexLimit]',
  skip: null,               // (req) => bool — skip rate limiting
  onLimitReached: null,     // (req, res, info) => void
  store: null,              // custom store instance
  plan: null,               // 'free' | 'pro' | 'enterprise' | null
  plans: DEFAULT_PLANS,     // plan map — override to define custom plans
  preset: null,             // 'strict' | 'relaxed' | 'api' | 'auth'
  keyGenerator: null,       // (req) => string — custom key fn
};

/**
 * Resolve final config by merging preset → plan → user options → defaults.
 * @param {object} userOptions
 * @returns {object}
 */
function resolveConfig(userOptions = {}) {
  let base = { ...DEFAULT_CONFIG };

  // Apply named preset first (lowest priority)
  if (userOptions.preset && PRESETS[userOptions.preset]) {
    base = { ...base, ...PRESETS[userOptions.preset] };
  }

  // Merge user options
  base = { ...base, ...userOptions };

  // Apply plan limits (overrides windowMs and max if plan is set)
  if (base.plan) {
    const planDefs = base.plans || DEFAULT_PLANS;
    const planCfg = planDefs[base.plan];
    if (!planCfg) {
      throw new Error(
        `[NexLimit] Unknown plan "${base.plan}". Available: ${Object.keys(planDefs).join(', ')}`
      );
    }
    base.windowMs = planCfg.windowMs;
    base.max      = planCfg.max;
    base._burstMax = planCfg.burstMax;
  }

  // Validate
  if (base.max <= 0) throw new Error('[NexLimit] config.max must be greater than 0');
  if (base.windowMs <= 0) throw new Error('[NexLimit] config.windowMs must be greater than 0');

  return base;
}

module.exports = { DEFAULT_CONFIG, DEFAULT_PLANS, PRESETS, resolveConfig };
