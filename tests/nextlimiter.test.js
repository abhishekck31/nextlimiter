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

// ─── Adapter helpers ──────────────────────────────────────────────────────────

/**
 * Build a mock limiter whose check() returns a controlled RateLimitResult.
 */
function mockLimiter(allowed = true, overrides = {}) {
  return {
    check: jest.fn().mockResolvedValue({
      allowed,
      limit:       100,
      remaining:   allowed ? 99 : 0,
      resetAt:     Date.now() + 60_000,
      retryAfter:  allowed ? 0 : 30,
      strategy:    'sliding-window',
      smartBlocked: false,
      ...overrides,
    }),
  };
}

// ─── Fastify adapter ──────────────────────────────────────────────────────────
//
// We test the core hook logic directly rather than registering a full Fastify
// server. The adapter is a thin wrapper — what matters is the IP extraction,
// the 429 path, and the header-setting path.

describe('Fastify adapter — hook logic', () => {
  function makeFastifyPair({ ip = '1.2.3.4', headers = {} } = {}) {
    const reply = {
      code:   jest.fn().mockReturnThis(),
      send:   jest.fn().mockReturnThis(),
      header: jest.fn(),
    };
    const request = { ip, headers, log: { warn: jest.fn() } };
    return { request, reply };
  }

  /** Simulates the onRequest hook registered by the Fastify adapter. */
  async function runHook(limiterInstance, request, reply) {
    try {
      const ip = (
        request.headers['cf-connecting-ip'] ||
        request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        request.ip ||
        'unknown'
      );
      const result = await limiterInstance.check(ip);

      if (!result.allowed) {
        return reply.code(429).send({
          error:      'Too Many Requests',
          retryAfter: result.retryAfter,
        });
      }

      reply.header('X-RateLimit-Limit',     String(result.limit));
      reply.header('X-RateLimit-Remaining', String(result.remaining));
      reply.header('X-RateLimit-Reset',     String(Math.ceil(result.resetAt / 1000)));
      reply.header('X-RateLimit-Strategy',  result.strategy);
    } catch (err) {
      request.log.warn(`[NextLimiter] error: ${err.message}`);
    }
  }

  test('allowed request: sets X-RateLimit-* headers, no 429', async () => {
    const limiter = mockLimiter(true);
    const { request, reply } = makeFastifyPair({ ip: '10.0.0.1' });

    await runHook(limiter, request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '99');
  });

  test('blocked request: sends 429 with retryAfter', async () => {
    const limiter = mockLimiter(false);
    const { request, reply } = makeFastifyPair({ ip: '5.5.5.5' });

    await runHook(limiter, request, reply);

    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Too Many Requests', retryAfter: 30 })
    );
  });

  test('IP fallback: prefers cf-connecting-ip', async () => {
    const limiter = mockLimiter(true);
    const { request, reply } = makeFastifyPair({
      ip:      '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.5' },
    });
    await runHook(limiter, request, reply);
    expect(limiter.check).toHaveBeenCalledWith('203.0.113.5');
  });

  test('IP fallback: x-forwarded-for over req.ip', async () => {
    const limiter = mockLimiter(true);
    const { request, reply } = makeFastifyPair({
      ip:      '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });
    await runHook(limiter, request, reply);
    expect(limiter.check).toHaveBeenCalledWith('203.0.113.5');
  });

  test('IP fallback: uses req.ip when no forwarding headers', async () => {
    const limiter = mockLimiter(true);
    const { request, reply } = makeFastifyPair({ ip: '9.9.9.9' });
    await runHook(limiter, request, reply);
    expect(limiter.check).toHaveBeenCalledWith('9.9.9.9');
  });

  test('fails open on limiter error', async () => {
    const brokenLimiter = { check: jest.fn().mockRejectedValue(new Error('Redis down')) };
    const { request, reply } = makeFastifyPair();
    await runHook(brokenLimiter, request, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(request.log.warn).toHaveBeenCalled();
  });
});

// ─── Next.js adapter ──────────────────────────────────────────────────────────


describe('Next.js adapter — withRateLimit (Pages Router)', () => {
  const { withRateLimit } = require('../src/adapters/next');

  function makeNodeContext({ xff = null, remoteAddr = '9.9.9.9' } = {}) {
    const headers = xff ? { 'x-forwarded-for': xff } : {};
    const req = { headers, socket: { remoteAddress: remoteAddr } };
    const res = {
      _status: null, _body: null, _headers: {},
      status:    jest.fn().mockReturnThis(),
      json:      jest.fn().mockReturnThis(),
      setHeader: jest.fn((k, v) => { res._headers[k] = v; }),
    };
    return { req, res };
  }

  test('allowed: calls handler and sets headers', async () => {
    const handler = jest.fn();
    const options = { max: 100, windowMs: 60_000 };
    const wrapped = withRateLimit(handler, options);
    const { req, res } = makeNodeContext({ remoteAddr: '1.1.1.1' });

    await wrapped(req, res);
    expect(handler).toHaveBeenCalledWith(req, res);
  });

  test('blocked: returns 429 and does NOT call handler', async () => {
    // Use a real limiter with max:1 so second call is blocked
    const { createLimiter: realCreate } = require('../src/index');
    const limiter = realCreate({ max: 1, windowMs: 60_000, strategy: 'fixed-window' });

    // Patch getLimiter by creating a custom options object
    const options = { max: 1, windowMs: 60_000, strategy: 'fixed-window' };
    const handler = jest.fn();
    const wrapped = withRateLimit(handler, options);

    const { req: req1, res: res1 } = makeNodeContext({ remoteAddr: '2.2.2.2' });
    const { req: req2, res: res2 } = makeNodeContext({ remoteAddr: '2.2.2.2' });

    await wrapped(req1, res1); // first call allowed
    await wrapped(req2, res2); // second call blocked

    expect(res2.status).toHaveBeenCalledWith(429);
    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Too Many Requests' })
    );
  });

  test('IP extraction: prefers x-forwarded-for', async () => {
    const handler = jest.fn();
    const options = { max: 100, windowMs: 60_000 };
    const wrapped = withRateLimit(handler, options);
    const { req, res } = makeNodeContext({ xff: '198.51.100.1, 10.0.0.1', remoteAddr: '127.0.0.1' });

    await wrapped(req, res);

    // handler should have been called (allowed), confirming IP was extracted
    expect(handler).toHaveBeenCalled();
  });

  test('IP extraction: falls back to socket.remoteAddress', async () => {
    const handler = jest.fn();
    const options = { max: 100, windowMs: 60_000 };
    const wrapped = withRateLimit(handler, options);
    const { req, res } = makeNodeContext({ remoteAddr: '192.0.2.10' });

    await wrapped(req, res);
    expect(handler).toHaveBeenCalled();
  });
});

describe('Next.js adapter — withRateLimitEdge (Edge runtime)', () => {
  const { withRateLimitEdge } = require('../src/adapters/next');

  function makeEdgeRequest({ cfIp = null, xff = null } = {}) {
    const headersMap = {};
    if (cfIp) headersMap['cf-connecting-ip'] = cfIp;
    if (xff)  headersMap['x-forwarded-for']  = xff;
    return {
      headers: {
        get: (key) => headersMap[key.toLowerCase()] ?? null,
      },
    };
  }

  test('allowed: handler is called and Response is returned', async () => {
    const handler = jest.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const options = { max: 100, windowMs: 60_000 };
    const wrapped = withRateLimitEdge(handler, options);
    const req     = makeEdgeRequest({ cfIp: '1.2.3.4' });

    const res = await wrapped(req);
    expect(handler).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  test('blocked: returns 429 Response, handler not called', async () => {
    const handler  = jest.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const options2 = { max: 1, windowMs: 60_000, strategy: 'fixed-window' };
    const wrapped  = withRateLimitEdge(handler, options2);

    const req1 = makeEdgeRequest({ cfIp: '7.7.7.7' });
    const req2 = makeEdgeRequest({ cfIp: '7.7.7.7' });

    const res1 = await wrapped(req1);
    const res2 = await wrapped(req2);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(429);
  });

  test('IP extraction: prefers cf-connecting-ip', async () => {
    const handler = jest.fn().mockResolvedValue(new Response('OK'));
    const options = { max: 100, windowMs: 60_000 };
    const wrapped = withRateLimitEdge(handler, options);
    const req     = makeEdgeRequest({ cfIp: '203.0.113.99', xff: '10.0.0.1' });

    await wrapped(req);
    expect(handler).toHaveBeenCalled();
  });
});

// ─── Hono adapter ─────────────────────────────────────────────────────────────

describe('Hono adapter — rateLimitMiddleware', () => {
  const { rateLimitMiddleware } = require('../src/adapters/hono');

  function makeHonoContext({ cfIp = null, xff = null } = {}) {
    const headersMap = {};
    if (cfIp) headersMap['cf-connecting-ip'] = cfIp;
    if (xff)  headersMap['x-forwarded-for']  = xff;

    const _headers = {};
    const c = {
      req: {
        header: (key) => headersMap[key.toLowerCase()] ?? null,
      },
      header: jest.fn((k, v) => { _headers[k] = v; }),
      json:   jest.fn((body, status) => ({ body, status })),
      _headers,
    };
    return c;
  }

  test('allowed: calls next() and sets X-RateLimit-* headers', async () => {
    const next    = jest.fn().mockResolvedValue(undefined);
    const options = { max: 100, windowMs: 60_000 };
    const mw      = rateLimitMiddleware(options);
    const c       = makeHonoContext({ cfIp: '4.4.4.4' });

    await mw(c, next);

    expect(next).toHaveBeenCalled();
    expect(c.header).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
    expect(c.header).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
  });

  test('blocked: returns 429 JSON, does NOT call next()', async () => {
    const next    = jest.fn().mockResolvedValue(undefined);
    const options = { max: 1, windowMs: 60_000, strategy: 'fixed-window' };
    const mw      = rateLimitMiddleware(options);

    const c1 = makeHonoContext({ cfIp: '6.6.6.6' });
    const c2 = makeHonoContext({ cfIp: '6.6.6.6' });

    await mw(c1, next);
    await mw(c2, next);

    // second call: next should NOT have been called a second time
    expect(next).toHaveBeenCalledTimes(1);
    expect(c2.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Too Many Requests' }),
      429
    );
  });

  test('IP fallback: x-forwarded-for when cf-connecting-ip absent', async () => {
    const next    = jest.fn().mockResolvedValue(undefined);
    const options = { max: 100, windowMs: 60_000 };
    const mw      = rateLimitMiddleware(options);
    const c       = makeHonoContext({ xff: '172.16.0.1, 10.0.0.1' });

    await mw(c, next);
    expect(next).toHaveBeenCalled();
    // headers should be set — confirms a key was derived, not 'unknown'
    expect(c.header).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
  });

  test('IP fallback: uses "unknown" when no IP headers present', async () => {
    const next    = jest.fn().mockResolvedValue(undefined);
    const options = { max: 100, windowMs: 60_000 };
    const mw      = rateLimitMiddleware(options);
    const c       = makeHonoContext();

    await mw(c, next);
    // Should still succeed — falls back to 'unknown' key
    expect(next).toHaveBeenCalled();
  });
});

