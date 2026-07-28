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
  statsInterval: undefined,  // ms interval to emit 'stats' event

  rules:         null,       // RuleConfig[] — multiple rate limit constraints
  schedule:      null,       // ScheduleEntry[] — time-based config overrides

  webhook:           null,
  webhookRetries:    3,
  webhookBackoff:    'exponential',
  webhookTimeout:    5000,
  webhookSecret:     null,

  drainRateMs:       undefined,  // leaky-bucket only
  capacity:          undefined,  // leaky-bucket only
};

/**
 * Resolve final config by merging preset → plan → user options → defaults.
 * @param {object} userOptions
 * @returns {object}
 */
function resolveConfig(userOptions = {}) {
  let base = { ...DEFAULT_CONFIG };

  // Apply preset
  if (userOptions.preset) { // Use userOptions.preset here to ensure it's applied
    const presetCfg = PRESETS[userOptions.preset];
    if (!presetCfg) {throw new Error(`[NextLimiter] Unknown preset: ${userOptions.preset}`);}
    // Merge preset config into base, allowing userOptions to override later
    base = { ...base, ...presetCfg };
  }

  // Mutually exclusive core configurations
  const hasRules = userOptions.rules !== undefined && userOptions.rules !== null;
  const hasSchedule = userOptions.schedule !== undefined && userOptions.schedule !== null;
  const hasMax = userOptions.max !== undefined && userOptions.max !== null;

  if (hasRules && hasSchedule) {
    throw new Error('[NextLimiter] config.rules and config.schedule are mutually exclusive.');
  }
  if (hasRules && hasMax) {
    throw new Error('[NextLimiter] config.max/windowMs and config.rules are mutually exclusive.');
  }
  if (hasSchedule && hasMax) {
    throw new Error('[NextLimiter] config.max/windowMs and config.schedule are mutually exclusive.');
  }

  // Apply user overrides
  Object.assign(base, userOptions);

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

  // Deep validate
  if (base.rules) {
    if (!Array.isArray(base.rules) || base.rules.length === 0) {
      throw new Error('[NextLimiter] config.rules must be a non-empty array.');
    }
    for (const rule of base.rules) {
      if (!rule.keyBy) {throw new Error('[NextLimiter] Each rule must have a keyBy property.');}
      if (typeof rule.max !== 'number' || rule.max <= 0) {throw new Error('[NextLimiter] Each rule must have a positive max integer.');}
      if (typeof rule.windowMs !== 'number' || rule.windowMs <= 0) {throw new Error('[NextLimiter] Each rule must have a positive windowMs integer.');}
    }
  } else if (base.schedule) {
    if (!Array.isArray(base.schedule) || base.schedule.length === 0) {
      throw new Error('[NextLimiter] config.schedule must be a non-empty array.');
    }
    let prevEnd = -1;
    for (let i = 0; i < base.schedule.length; i++) {
        const entry = base.schedule[i];
        if (!entry.hours) {throw new Error('[NextLimiter] Each schedule entry must have an hours string (e.g., "9-17").');}
        if (typeof entry.max !== 'number' || entry.max <= 0) {throw new Error('[NextLimiter] Each schedule entry must have a positive max integer.');}
        
        const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(entry.hours);
        if (!match) {throw new Error(`[NextLimiter] Invalid hours format: ${entry.hours}`);}
        const s = parseInt(match[1], 10), e = parseInt(match[2], 10);
        if (s < 0 || s > 23 || e < 0 || e > 23) {throw new Error('[NextLimiter] Schedule hours must be between 0 and 23. Got: ' + entry.hours);}
        if (e < s) {throw new Error(`[NextLimiter] Invalid schedule: end hour (${e}) cannot be less than start hour (${s}).`);}
        
        // Basic overlap check
        if (s <= prevEnd) {console.warn('[NextLimiter] Warning: Overlapping schedule entries detected.');}
        prevEnd = e;
    }
    if (prevEnd < 23) {console.warn('[NextLimiter] Warning: Schedule entries do not cover a full 24-hr cycle.');}
    // Base max/windowMs must still be valid for fallback
    if (base.max <= 0) {throw new Error('[NextLimiter] config.max must be greater than 0');}
    if (base.windowMs <= 0) {throw new Error('[NextLimiter] config.windowMs must be greater than 0');}
  } else {
    // Standard mode validation
    if (base.max <= 0) {throw new Error('[NextLimiter] config.max must be greater than 0');}
    if (base.windowMs <= 0) {throw new Error('[NextLimiter] config.windowMs must be greater than 0');}
  }

  // Validate whitelist / blacklist (warn, never throw)
  for (const listName of ['whitelist', 'blacklist']) {
    const list = base[listName];
    if (list === null || list === undefined) {continue;}
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

  // Validate statsInterval
  if (base.statsInterval !== undefined) {
    if (typeof base.statsInterval !== 'number' || base.statsInterval <= 0) {
      console.warn('[NextLimiter] config.statsInterval must be a positive number. Disabling.');
      base.statsInterval = undefined;
    } else if (base.statsInterval < 1000) {
      console.warn('[NextLimiter] config.statsInterval must be at least 1000ms. Clamping to 1000ms.');
      base.statsInterval = 1000;
    }
  }

  // Validate webhook
  if (base.webhook) {
    if (!base.webhook.startsWith('http://') && !base.webhook.startsWith('https://')) {
        throw new Error('[NextLimiter] config.webhook must be a valid URL starting with http:// or https://');
    }
    if (base.webhook.startsWith('http://')) {
        console.warn('[NextLimiter] Warning: Webhook URL is using insecure http://. Consider switching to https://');
    }
    if (base.webhookRetries < 0 || base.webhookRetries > 10) {base.webhookRetries = 3;}
    if (base.webhookTimeout < 500) {base.webhookTimeout = 5000;}
  }

  // Validate new strategies
  if (base.strategy === 'sliding-window-log' && base.max > 10000) {
    console.warn('[NextLimiter] Warning: "sliding-window-log" stores an array of timestamps. Using max > 10000 may impact memory and performance.');
  }

  if (base.drainRateMs !== undefined || base.capacity !== undefined) {
    if (base.strategy !== 'leaky-bucket') {
      console.warn('[NextLimiter] Warning: drainRateMs and capacity are ignored for strategy "' + base.strategy + '"');
    } else {
      if (base.drainRateMs !== undefined && (typeof base.drainRateMs !== 'number' || base.drainRateMs <= 0)) {
        throw new Error('[NextLimiter] drainRateMs must be a positive number');
      }
      if (base.capacity !== undefined && (typeof base.capacity !== 'number' || base.capacity <= 0 || !Number.isInteger(base.capacity))) {
        throw new Error('[NextLimiter] capacity must be a positive integer');
      }
    }
  }

  return base;
}

module.exports = { DEFAULT_CONFIG, DEFAULT_PLANS, PRESETS, resolveConfig };
