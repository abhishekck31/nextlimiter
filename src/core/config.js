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
  keyPrefix: 'nextlimiter:',
  message: 'Too many requests, please try again later.',
  statusCode: 429,
  headers: true,
  smart: false,
  smartThreshold: 2.0,     // trigger smart limiting at 2x normal rate
  smartCooldownMs: 60_000, // how long smart penalty lasts
  smartPenaltyFactor: 0.5, // reduce limit to 50% for suspicious keys
  logging: false,
  logPrefix: '[NextLimiter]',
  skip: null,               // (req) => bool — skip rate limiting
  onLimitReached: null,     // (req, res, info) => void
  store: null,              // custom store instance
  plan: null,               // 'free' | 'pro' | 'enterprise' | null
  plans: DEFAULT_PLANS,     // plan map — override to define custom plans
  preset: null,             // 'strict' | 'relaxed' | 'api' | 'auth'
  keyGenerator: null,       // (req) => string — custom key fn
  whitelist:     null,       // string[] — IPs/CIDRs that bypass rate limiting
  blacklist:     null,       // string[] — IPs/CIDRs that always get 403
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
        `[NextLimiter] Unknown plan "${base.plan}". Available: ${Object.keys(planDefs).join(', ')}`
      );
    }
    base.windowMs = planCfg.windowMs;
    base.max      = planCfg.max;
    base._burstMax = planCfg.burstMax;
  }

  // Validate
  if (base.max <= 0) throw new Error('[NextLimiter] config.max must be greater than 0');
  if (base.windowMs <= 0) throw new Error('[NextLimiter] config.windowMs must be greater than 0');

  // Validate whitelist / blacklist (warn, never throw)
  for (const listName of ['whitelist', 'blacklist']) {
    const list = base[listName];
    if (list == null) continue;
    if (!Array.isArray(list)) {
      console.warn(`[NextLimiter] config.${listName} must be an array. Ignoring.`);
      base[listName] = null;
      continue;
    }
    const valid = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        console.warn(`[NextLimiter] config.${listName}: skipping invalid entry:`, entry);
        continue;
      }
      // Loose format check: must look like x.x.x.x or x.x.x.x/n
      if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(entry.trim())) {
        console.warn(`[NextLimiter] config.${listName}: entry "${entry}" doesn't look like a valid IP or CIDR. It will be attempted anyway.`);
      }
      valid.push(entry.trim());
    }
    base[listName] = valid.length > 0 ? valid : null;
  }

  return base;
}

module.exports = { DEFAULT_CONFIG, DEFAULT_PLANS, PRESETS, resolveConfig };
