'use strict';
const { resolveKeyGenerator } = require('../utils/keyGenerator');
const { fixedWindowCheck } = require('../strategies/fixedWindow');
const { slidingWindowCheck } = require('../strategies/slidingWindow');
const { tokenBucketCheck } = require('../strategies/tokenBucket');
const { slidingWindowLog } = require('../strategies/slidingWindowLog');
const { leakyBucket } = require('../strategies/leakyBucket');

const STRATEGY_MAP = {
  'fixed-window': fixedWindowCheck,
  'sliding-window': slidingWindowCheck,
  'token-bucket': tokenBucketCheck,
  'sliding-window-log': slidingWindowLog,
  'leaky-bucket': leakyBucket,
};

class RuleEngine {
  constructor(rules, store, emitter, globalConfig) {
    this._rules = rules.map((r, i) => {
      const strategyName = r.strategy || 'sliding-window';
      const strategyFn = STRATEGY_MAP[strategyName];
      if (!strategyFn) throw new Error(`[NextLimiter] Unknown strategy in rule: ${strategyName}`);
      return {
        ...r,
        name: r.name || `rule${i}`,
        index: i,
        keyGenerator: typeof r.keyBy === 'function' ? r.keyBy : resolveKeyGenerator(r.keyBy),
        strategyFn
      };
    });
    this._store = store;
    this._emitter = emitter;
    this._globalConfig = globalConfig;
  }

  async check(req) {
    const promises = this._rules.map(rule => {
      const rawKey = rule.keyGenerator(req);
      const fullKey = `${this._globalConfig.keyPrefix}${rule.name}:${rule.keyBy}:${rawKey}`;
      
      const config = { max: rule.max, windowMs: rule.windowMs };
      return Promise.resolve(rule.strategyFn(fullKey, config, this._store)).then(result => {
        return {
          ...result,
          key: fullKey,
          rawKey,
          rule
        };
      });
    });

    const results = await Promise.all(promises);
    
    let allowed = true;
    let failedRule = null;
    let mostRestrictive = results[0];
    let mostRestrictiveRemaining = Infinity;

    // Find the most restrictive outcome and if any caused a block.
    for (const res of results) {
      if (!res.allowed) {
        allowed = false;
        if (!failedRule) failedRule = res.rule;
      }
      if (res.remaining < mostRestrictiveRemaining) {
        mostRestrictiveRemaining = res.remaining;
        mostRestrictive = res;
      }
    }

    if (!allowed) {
      let longestRetry = -1;
      for (const res of results) {
         if (!res.allowed && res.retryAfter > longestRetry) {
             longestRetry = res.retryAfter;
             mostRestrictive = res; // prioritize the one with highest retry limit to wait for
         }
      }
    }

    const compositeKey = results.map(r => r.key).join('|');

    return {
      allowed,
      failedRule,
      results,
      mostRestrictive,
      key: compositeKey
    };
  }
}

module.exports = { RuleEngine };
