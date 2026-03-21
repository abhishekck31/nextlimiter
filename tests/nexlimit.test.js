'use strict';

const { MemoryStore }        = require('../src/store/memoryStore');
const { fixedWindowCheck }   = require('../src/strategies/fixedWindow');
const { slidingWindowCheck } = require('../src/strategies/slidingWindow');
const { tokenBucketCheck }   = require('../src/strategies/tokenBucket');
const { AnalyticsTracker }   = require('../src/analytics/tracker');
const { createLimiter, autoLimit, createPlanLimiter, createPresetLimiter } = require('../src/index');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    windowMs:          1000,
    max:               3,
    strategy:          'fixed-window',
    smart:             false,
    smartThreshold:    2.0,
    smartCooldownMs:   60_000,
    smartPenaltyFactor: 0.5,
    ...overrides,
  };
}

function freshStore() {
  return new MemoryStore();
}

// ─── MemoryStore ──────────────────────────────────────────────────────────────

describe('MemoryStore', () => {
  let store;
  beforeEach(() => { store = freshStore(); });
  afterEach(() => store.destroy());

  test('set and get a value', () => {
    store.set('k', 42, 5000);
    expect(store.get('k')).toBe(42);
  });

  test('returns undefined for missing key', () => {
    expect(store.get('missing')).toBeUndefined();
  });

  test('returns undefined for expired key', () => {
    store.set('expired', 'value', -1); // already expired
    expect(store.get('expired')).toBeUndefined();
  });

  test('increment creates key at 1', () => {
    const val = store.increment('counter', 5000);
    expect(val).toBe(1);
  });

  test('increment increases existing value', () => {
    store.increment('counter', 5000);
    store.increment('counter', 5000);
    const val = store.increment('counter', 5000);
    expect(val).toBe(3);
  });

  test('increment resets expired key to 1', async () => {
    store.increment('counter', 1); // 1ms TTL
    await new Promise(r => setTimeout(r, 5));
    const val = store.increment('counter', 5000);
    expect(val).toBe(1);
  });

  test('delete removes key', () => {
    store.set('k', 'v', 5000);
    store.delete('k');
    expect(store.get('k')).toBeUndefined();
  });

  test('keys returns non-expired keys', () => {
    store.set('a', 1, 5000);
    store.set('b', 2, 5000);
    store.set('c', 3, -1); // expired
    const keys = store.keys();
    expect(keys).toContain('a');
    expect(keys).toContain('b');
    expect(keys).not.toContain('c');
  });
});

// ─── Fixed Window ─────────────────────────────────────────────────────────────

describe('Fixed Window strategy', () => {
  let store;
  beforeEach(() => { store = freshStore(); });
  afterEach(() => store.destroy());

  test('allows requests under limit', () => {
    const cfg = makeConfig({ max: 3 });
    const r1 = fixedWindowCheck('key1', cfg, store);
    const r2 = fixedWindowCheck('key1', cfg, store);
    const r3 = fixedWindowCheck('key1', cfg, store);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
  });

  test('blocks the request exceeding limit', () => {
    const cfg = makeConfig({ max: 3 });
    fixedWindowCheck('key2', cfg, store);
    fixedWindowCheck('key2', cfg, store);
    fixedWindowCheck('key2', cfg, store);
    const r4 = fixedWindowCheck('key2', cfg, store);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  test('remaining decrements correctly', () => {
    const cfg = makeConfig({ max: 5 });
    const r1 = fixedWindowCheck('key3', cfg, store);
    expect(r1.remaining).toBe(4);
    const r2 = fixedWindowCheck('key3', cfg, store);
    expect(r2.remaining).toBe(3);
  });

  test('different keys are independent', () => {
    const cfg = makeConfig({ max: 2 });
    fixedWindowCheck('userA', cfg, store);
    fixedWindowCheck('userA', cfg, store);
    const blocked = fixedWindowCheck('userA', cfg, store);
    const allowed  = fixedWindowCheck('userB', cfg, store);
    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  test('result has correct structure', () => {
    const cfg = makeConfig();
    const r = fixedWindowCheck('key4', cfg, store);
    expect(r).toMatchObject({
      allowed:   expect.any(Boolean),
      limit:     3,
      remaining: expect.any(Number),
      resetAt:   expect.any(Number),
      strategy:  'fixed-window',
    });
  });

  test('returns retryAfter > 0 when blocked', () => {
    const cfg = makeConfig({ max: 1 });
    fixedWindowCheck('key5', cfg, store);
    const r = fixedWindowCheck('key5', cfg, store);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });
});

// ─── Sliding Window ───────────────────────────────────────────────────────────

describe('Sliding Window strategy', () => {
  let store;
  beforeEach(() => { store = freshStore(); });
  afterEach(() => store.destroy());

  test('allows requests under limit', () => {
    const cfg = makeConfig({ max: 5, strategy: 'sliding-window' });
    for (let i = 0; i < 5; i++) {
      expect(slidingWindowCheck('sw1', cfg, store).allowed).toBe(true);
    }
  });

  test('blocks when limit reached', () => {
    const cfg = makeConfig({ max: 3, strategy: 'sliding-window' });
    slidingWindowCheck('sw2', cfg, store);
    slidingWindowCheck('sw2', cfg, store);
    slidingWindowCheck('sw2', cfg, store);
    const r = slidingWindowCheck('sw2', cfg, store);
    expect(r.allowed).toBe(false);
  });

  test('strategy name is correct', () => {
    const cfg = makeConfig({ max: 5, strategy: 'sliding-window' });
    const r = slidingWindowCheck('sw3', cfg, store);
    expect(r.strategy).toBe('sliding-window');
  });
});

// ─── Token Bucket ─────────────────────────────────────────────────────────────

describe('Token Bucket strategy', () => {
  let store;
  beforeEach(() => { store = freshStore(); });
  afterEach(() => store.destroy());

  test('allows up to capacity requests', () => {
    const cfg = makeConfig({ max: 5, strategy: 'token-bucket' });
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(tokenBucketCheck('tb1', cfg, store));
    }
    expect(results.every(r => r.allowed)).toBe(true);
  });

  test('blocks when bucket is empty', () => {
    const cfg = makeConfig({ max: 3, strategy: 'token-bucket' });
    tokenBucketCheck('tb2', cfg, store);
    tokenBucketCheck('tb2', cfg, store);
    tokenBucketCheck('tb2', cfg, store);
    const r = tokenBucketCheck('tb2', cfg, store);
    expect(r.allowed).toBe(false);
  });

  test('remaining decrements', () => {
    const cfg = makeConfig({ max: 5, strategy: 'token-bucket' });
    const r1 = tokenBucketCheck('tb3', cfg, store);
    const r2 = tokenBucketCheck('tb3', cfg, store);
    expect(r1.remaining).toBeGreaterThan(r2.remaining);
  });

  test('strategy name is correct', () => {
    const cfg = makeConfig({ max: 5, strategy: 'token-bucket' });
    const r = tokenBucketCheck('tb4', cfg, store);
    expect(r.strategy).toBe('token-bucket');
  });
});

// ─── Analytics Tracker ───────────────────────────────────────────────────────

describe('AnalyticsTracker', () => {
  let tracker;
  beforeEach(() => { tracker = new AnalyticsTracker(); });

  test('totalRequests counts all records', () => {
    tracker.record('k1', true);
    tracker.record('k1', true);
    tracker.record('k1', false);
    expect(tracker.getStats().totalRequests).toBe(3);
  });

  test('blockedRequests counts only false', () => {
    tracker.record('k1', true);
    tracker.record('k1', false);
    tracker.record('k1', false);
    expect(tracker.getStats().blockedRequests).toBe(2);
  });

  test('blockRate is correct', () => {
    tracker.record('k1', true);
    tracker.record('k1', false);
    expect(tracker.getStats().blockRate).toBe(0.5);
  });

  test('topKeys returns most frequent', () => {
    tracker.record('ip:1', true);
    tracker.record('ip:1', true);
    tracker.record('ip:2', true);
    const { topKeys } = tracker.getStats();
    expect(topKeys[0].key).toBe('ip:1');
    expect(topKeys[0].count).toBe(2);
  });

  test('reset clears all counters', () => {
    tracker.record('k1', true);
    tracker.record('k1', false);
    tracker.reset();
    const stats = tracker.getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.blockedRequests).toBe(0);
  });
});

// ─── createLimiter ────────────────────────────────────────────────────────────

describe('createLimiter()', () => {
  test('creates a Limiter instance', () => {
    const limiter = createLimiter({ windowMs: 60_000, max: 100 });
    expect(typeof limiter.middleware).toBe('function');
    expect(typeof limiter.check).toBe('function');
    expect(typeof limiter.getStats).toBe('function');
  });

  test('throws on unknown strategy', () => {
    expect(() => createLimiter({ strategy: 'unknown' })).toThrow('Unknown strategy');
  });

  test('throws on invalid plan', () => {
    expect(() => createLimiter({ plan: 'galaxy' })).toThrow('Unknown plan');
  });

  test('throws on max <= 0', () => {
    expect(() => createLimiter({ max: 0 })).toThrow('config.max must be greater than 0');
  });
});

// ─── createPlanLimiter ────────────────────────────────────────────────────────

describe('createPlanLimiter()', () => {
  test('free plan has lower max than pro', () => {
    const free = createPlanLimiter('free');
    const pro  = createPlanLimiter('pro');
    expect(free.config.max).toBeLessThan(pro.config.max);
  });

  test('enterprise has highest max', () => {
    const pro        = createPlanLimiter('pro');
    const enterprise = createPlanLimiter('enterprise');
    expect(enterprise.config.max).toBeGreaterThan(pro.config.max);
  });
});

// ─── createPresetLimiter ──────────────────────────────────────────────────────

describe('createPresetLimiter()', () => {
  test('strict has lower max than relaxed', () => {
    const strict  = createPresetLimiter('strict');
    const relaxed = createPresetLimiter('relaxed');
    expect(strict.config.max).toBeLessThan(relaxed.config.max);
  });

  test('auth preset has long window', () => {
    const auth = createPresetLimiter('auth');
    expect(auth.config.windowMs).toBeGreaterThan(60_000);
  });

  test('throws on unknown preset', () => {
    expect(() => createPresetLimiter('nonexistent')).toThrow('Unknown preset');
  });
});

// ─── Programmatic limiter.check() ────────────────────────────────────────────

describe('limiter.check()', () => {
  test('returns allowed result for fresh key', async () => {
    const limiter = createLimiter({ windowMs: 60_000, max: 10 });
    const result  = await limiter.check('test-user');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  test('blocks after exceeding max', async () => {
    const limiter = createLimiter({ windowMs: 60_000, max: 3 });
    await limiter.check('user-x');
    await limiter.check('user-x');
    await limiter.check('user-x');
    const r = await limiter.check('user-x');
    expect(r.allowed).toBe(false);
  });

  test('getStats reflects check() calls', async () => {
    const limiter = createLimiter({ windowMs: 60_000, max: 100 });
    await limiter.check('u1');
    await limiter.check('u1');
    const stats = limiter.getStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.allowedRequests).toBe(2);
    expect(stats.blockedRequests).toBe(0);
  });
});
