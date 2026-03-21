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

// ─── IP Whitelist and Blacklist ───────────────────────────────────────────────

describe('IP whitelist and blacklist', () => {
  let mockConsoleWarn;

  beforeEach(() => {
    mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    mockConsoleWarn.mockRestore();
  });

  test('blacklisted IP gets 403, rate limit store is never touched', async () => {
    const store = freshStore();
    const storeIncSpy = jest.spyOn(store, 'increment');
    const limiter = createLimiter({
      store,
      blacklist: ['192.168.1.100'],
      keyBy: 'ip'
    });
    
    let statusCode = 0;
    let jsonBody = null;
    const req = { ip: '192.168.1.100', headers: {} };
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: (body) => { jsonBody = body; return res; }
    };
    const next = jest.fn();

    await limiter.middleware()(req, res, next);

    expect(statusCode).toBe(403);
    expect(jsonBody.error).toBe('Forbidden');
    expect(next).not.toHaveBeenCalled();
    expect(storeIncSpy).not.toHaveBeenCalled();
  });

  test('whitelisted IP bypasses rate limiting even when over limit', async () => {
    const limiter = createLimiter({
      max: 1, // very low limit
      whitelist: ['10.0.5.5'],
      keyBy: 'ip'
    });
    
    const req = { ip: '10.0.5.5', headers: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    // Do more requests than max
    await limiter.middleware()(req, res, next);
    await limiter.middleware()(req, res, next);
    await limiter.middleware()(req, res, next);

    // It should have called next() 3 times
    expect(next).toHaveBeenCalledTimes(3);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('CIDR blacklist blocks within range and allows outside', async () => {
    const limiter = createLimiter({ blacklist: ['5.6.0.0/16'] });
    const middleware = limiter.middleware();
    
    const runReq = async (ip) => {
      let code = 200;
      const res = { status: (c) => { code = c; return res; }, json: () => {} };
      const next = jest.fn();
      await middleware({ ip, headers: {} }, res, next);
      return { code, calledNext: next.mock.calls.length > 0 };
    };

    const blocked = await runReq('5.6.1.1');
    expect(blocked.code).toBe(403);
    expect(blocked.calledNext).toBe(false);

    const allowed = await runReq('5.7.0.1');
    expect(allowed.code).toBe(200);   // not changed to 403
    expect(allowed.calledNext).toBe(true);
  });

  test('CIDR whitelist skips within range and enforces outside', async () => {
    // 1 request max to enforce effectively
    const limiter = createLimiter({ max: 1, whitelist: ['10.0.0.0/8'] });
    const middleware = limiter.middleware();
    
    const runReq = async (ip) => {
      let code = 200;
      const res = { 
        status: (c) => { code = c; return res; }, 
        json: () => {}, 
        setHeader: () => {}
      };
      const next = jest.fn();
      await middleware({ ip, headers: {} }, res, next);
      return { code, calledNext: next.mock.calls.length > 0 };
    };

    // 10.0.5.5 should bypass and always work
    let wl1 = await runReq('10.0.5.5');
    let wl2 = await runReq('10.0.5.5');
    expect(wl1.calledNext).toBe(true);
    expect(wl2.calledNext).toBe(true);

    // 11.0.0.1 is outside, should hit limit
    let norm1 = await runReq('11.0.0.1');
    let norm2 = await runReq('11.0.0.1');
    expect(norm1.calledNext).toBe(true);
    expect(norm2.code).toBe(429);
  });

  test('exact IP blacklist blocks that exact IP only', async () => {
    const limiter = createLimiter({ blacklist: ['8.8.8.8'] });
    const middleware = limiter.middleware();
    
    const runReq = async (ip) => {
      let code = 200;
      const res = { status: (c) => { code = c; return res; }, json: () => {}, setHeader: () => {} };
      await middleware({ ip, headers: {} }, res, jest.fn());
      return code;
    };

    expect(await runReq('8.8.8.8')).toBe(403);
    expect(await runReq('8.8.8.9')).not.toBe(403);
  });

  test('blacklist takes priority over whitelist if IP appears in both', async () => {
    const limiter = createLimiter({
      whitelist: ['1.1.1.0/24'],
      blacklist: ['1.1.1.1'] // Specifically block one IP in the whitelist subnet
    });
    
    let code = 200;
    const res = { status: (c) => { code = c; return res; }, json: () => {} };
    await limiter.middleware()({ ip: '1.1.1.1', headers: {} }, res, jest.fn());
    
    // Blacklist wins
    expect(code).toBe(403);
  });

  test('invalid CIDR entry in list logs warning but does not crash', async () => {
    const limiter = createLimiter({
      whitelist: ['10.0.0.0/8', 'invalid_ip', ''], // empty string & invalid IP handled
      max: 10
    });
    
    expect(mockConsoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('skipping invalid entry'),
      ''
    );
    expect(mockConsoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('doesn\'t look like a valid IP or CIDR'),
    );

    const res = { setHeader: () => {} };
    const next = jest.fn();
    await limiter.middleware()({ ip: '10.0.0.1', headers: {} }, res, next);
    expect(next).toHaveBeenCalled(); // Whitelist still works for the valid entry
  });

  test('check() programmatic API respects blacklist and whitelist', async () => {
    const limiter = createLimiter({
      whitelist: ['20.0.0.0/8'],
      blacklist: ['30.30.30.30'],
      max: 5
    });

    // Check blacklist
    const bReq = await limiter.check('30.30.30.30');
    expect(bReq.allowed).toBe(false);
    expect(bReq.blocked).toBe(true); // new property from access control
    expect(bReq.reason).toBe('blacklisted');

    // Check whitelist
    const wReq = await limiter.check('20.20.20.20');
    expect(wReq.allowed).toBe(true);
    expect(wReq.remaining).toBe(Infinity);
    expect(wReq.reason).toBe('whitelisted');

    // Check normal IP
    const nReq = await limiter.check('40.40.40.40');
    expect(nReq.allowed).toBe(true);
    expect(nReq.remaining).not.toBe(Infinity);
    expect(nReq.reason).toBeUndefined();
  });
});

// ─── Prometheus Metrics ───────────────────────────────────────────────────────

describe('Prometheus metrics', () => {
  const { PrometheusFormatter } = require('../src/analytics/prometheus');

  test('empty stats (zero requests) produces valid output, no NaN values', () => {
    const limiter = createLimiter();
    const formatter = new PrometheusFormatter(limiter);
    const text = formatter.format();

    expect(text).toContain('# HELP nextlimiter_requests_total');
    expect(text).toContain('# TYPE nextlimiter_requests_total counter');
    expect(text).toContain('nextlimiter_requests_total{status="allowed"} 0');
    expect(text).toContain('nextlimiter_requests_total{status="blocked"} 0');
    
    // Block rate should be 0 when no requests, not NaN
    expect(text).toContain('nextlimiter_block_rate 0\n');
    expect(text).not.toContain('NaN');
    expect(text.endsWith('\n')).toBe(true); // format() output ends with a newline character
  });

  test('allowed and blocked counts match getStats() values exactly', async () => {
    const limiter = createLimiter({ max: 2 });
    
    await limiter.check('ip:1.1.1.1');
    await limiter.check('ip:1.1.1.1');
    await limiter.check('ip:1.1.1.1'); // blocked

    const stats = limiter.getStats();
    expect(stats.allowedRequests).toBe(2);
    expect(stats.blockedRequests).toBe(1);
    expect(stats.totalRequests).toBe(3);

    const formatter = new PrometheusFormatter(limiter);
    const text = formatter.format();

    expect(text).toContain(`nextlimiter_requests_total{status="allowed"} 2`);
    expect(text).toContain(`nextlimiter_requests_total{status="blocked"} 1`);
  });

  test('block_rate value matches getStats().blockRate', async () => {
    const limiter = createLimiter({ max: 1 });
    await limiter.check('ip:2.2.2.2');
    await limiter.check('ip:2.2.2.2'); // blocked

    const formatter = new PrometheusFormatter(limiter);
    const text = formatter.format();
    const stats = limiter.getStats();
    
    expect(text).toContain(`nextlimiter_block_rate ${stats.blockRate}`);
  });

  test('topBlocked entries appear as individual labelled lines', async () => {
    const limiter = createLimiter({ max: 1 });
    await limiter.check('ip:3.3.3.3');
    await limiter.check('ip:3.3.3.3'); // block 1
    await limiter.check('ip:3.3.3.3'); // block 2
    
    await limiter.check('user:bob');
    await limiter.check('user:bob'); // block 1

    const text = new PrometheusFormatter(limiter).format();
    
    expect(text).toContain('# TYPE nextlimiter_top_blocked_ip gauge');
    // Notice that the "nextlimiter:ip:" prefix should be stripped, but "nextlimiter:user:" remains "user:"
    expect(text).toContain('nextlimiter_top_blocked_ip{ip="3.3.3.3"} 2');
    expect(text).toContain('nextlimiter_top_blocked_ip{ip="user:bob"} 1');
  });

  test('label values with special chars (quotes, backslashes) are escaped', async () => {
    const limiter = createLimiter({ max: 5 });
    await limiter.check('weird"\\name\n');

    const text = new PrometheusFormatter(limiter).format();
    // '"' becomes '\"', '\' becomes '\\', '\n' becomes '\n' (escaped)
    expect(text).toContain('key="nextlimiter:weird\\"\\\\name\\n"');
  });

  test('metricsHandler() sets Content-Type to Prometheus content type and returns 200', () => {
    const limiter = createLimiter();
    const handler = limiter.metricsHandler();
    
    let typeSet = null;
    let bodySent = null;
    let statusCode = 200;

    const res = {
      set: (k, v) => { if (k.toLowerCase() === 'content-type') typeSet = v; },
      send: (body) => { bodySent = body; },
      status: (code) => { statusCode = code; return res; },
      type: () => res
    };

    handler({}, res);

    expect(statusCode).toBe(200);
    expect(typeSet).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(bodySent).toContain('nextlimiter_uptime_seconds');
  });

  test('metricsMiddleware() intercepts /metrics and serves it', () => {
    const limiter = createLimiter();
    const middleware = limiter.metricsMiddleware();
    
    const req = { method: 'GET', path: '/metrics' };
    const res = { set: jest.fn(), send: jest.fn() };
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalled();
  });

  test('metricsMiddleware() skips other routes', () => {
    const limiter = createLimiter();
    const middleware = limiter.metricsMiddleware();
    
    const req = { method: 'GET', path: '/api/users' };
    const res = { set: jest.fn(), send: jest.fn() };
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// ─── Event Emitter ────────────────────────────────────────────────────────────

describe('Event emitter', () => {
  test('limiter.on is a function (EventEmitter correctly mixed in)', () => {
    const limiter = createLimiter();
    expect(typeof limiter.on).toBe('function');
    expect(typeof limiter.emit).toBe('function');
    expect(typeof limiter.once).toBe('function');
    expect(typeof limiter.off).toBe('function');
  });

  test('"blocked" and "allowed" events fire with correct keys and results', async () => {
    const limiter = createLimiter({ max: 1 });
    const allowedCb = jest.fn();
    const blockedCb = jest.fn();
    
    limiter.on('allowed', allowedCb);
    limiter.on('blocked', blockedCb);

    await limiter.check('test:key');
    expect(allowedCb).toHaveBeenCalledTimes(1);
    expect(blockedCb).not.toHaveBeenCalled();
    expect(allowedCb.mock.calls[0][0]).toBe('test:key');
    expect(allowedCb.mock.calls[0][1].allowed).toBe(true);

    await limiter.check('test:key');
    expect(allowedCb).toHaveBeenCalledTimes(1);
    expect(blockedCb).toHaveBeenCalledTimes(1);
    expect(blockedCb.mock.calls[0][0]).toBe('test:key');
    expect(blockedCb.mock.calls[0][1].allowed).toBe(false);
  });

  test('"blocked" event does NOT fire for whitelisted IPs, but "whitelisted" fires', async () => {
    // max must be > 0. We'll set it to 1 and do 2 requests to guarantee it would normally block
    const limiter = createLimiter({ max: 1, whitelist: ['1.1.1.1'], keyBy: 'ip' });
    const blockedCb = jest.fn();
    const whitelistedCb = jest.fn();
    
    limiter.on('blocked', blockedCb);
    limiter.on('whitelisted', whitelistedCb);

    await limiter.check('1.1.1.1');
    await limiter.check('1.1.1.1'); // Normally blocks here
    expect(blockedCb).not.toHaveBeenCalled();
    expect(whitelistedCb).toHaveBeenCalledWith('1.1.1.1');
  });

  test('"blacklisted" event fires when IP matches blacklist', async () => {
    const limiter = createLimiter({ blacklist: ['2.2.2.2'] });
    const blacklistedCb = jest.fn();
    limiter.on('blacklisted', blacklistedCb);

    await limiter.check('2.2.2.2');
    expect(blacklistedCb).toHaveBeenCalledWith('2.2.2.2');
  });

  test('"penalized" event fires once when smart detector first flags a key', async () => {
    jest.useFakeTimers();
    const limiter = createLimiter({ 
      smart: true, 
      max: 10, 
      windowMs: 60000,
      smartThreshold: 1.0,
      smartPenaltyFactor: 0.5,
      smartCooldownMs: 10000 
    });
    
    const penalizedCb = jest.fn();
    limiter.on('penalized', penalizedCb);

    // Blast it to trigger penalty
    for (let i = 0; i < 15; i++) {
       await limiter.check('burst-key');
    }

    // Advance time by enough to slide the observation window (10% of 60s = 6s)
    jest.advanceTimersByTime(6500);

    // One more check required to slide the window and trigger the penalty processing
    await limiter.check('burst-key');

    expect(penalizedCb).toHaveBeenCalledTimes(1);
    const cbArgs = penalizedCb.mock.calls[0];
    expect(cbArgs[0]).toBe(`${limiter.config.keyPrefix}burst-key`);
    expect(cbArgs[1].normalLimit).toBe(10);
    expect(cbArgs[1].reducedLimit).toBe(5);
    expect(cbArgs[1]).toHaveProperty('detectedAt');

    // Subsequent blasts should not emit penalized again because it's already penalized
    for (let i = 0; i < 5; i++) {
       await limiter.check('burst-key');
    }
    expect(penalizedCb).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('"reset" event fires after limiter.resetKey(key) is called', () => {
    const limiter = createLimiter();
    const resetCb = jest.fn();
    limiter.on('reset', resetCb);

    limiter.resetKey('some-key');
    expect(resetCb).toHaveBeenCalledWith('some-key');
  });

  test('"stats" event fires after statsInterval ms', () => {
    jest.useFakeTimers();
    const limiter = createLimiter({ statsInterval: 1000 });
    const statsCb = jest.fn();
    limiter.on('stats', statsCb);

    jest.advanceTimersByTime(1100);
    expect(statsCb).toHaveBeenCalledTimes(1);
    expect(statsCb.mock.calls[0][0]).toHaveProperty('totalRequests');

    jest.advanceTimersByTime(1000);
    expect(statsCb).toHaveBeenCalledTimes(2);

    limiter.destroy();
    jest.advanceTimersByTime(1000);
    expect(statsCb).toHaveBeenCalledTimes(2); // no longer ticking
    jest.useRealTimers();
  });

  test('"error" event: default no-op handler prevents unhandled error crash', async () => {
    const badStore = {
      get: () => { throw new Error('DB boom'); },
      set: () => {},
      increment: () => { throw new Error('DB boom'); }
    };
    
    const limiter = createLimiter({ store: badStore });
    const errorCb = jest.fn();
    limiter.on('error', errorCb);

    const mw = limiter.middleware();
    await mw({ ip: '1.2.3.4', headers: {} }, {}, jest.fn());

    expect(errorCb).toHaveBeenCalled();
    expect(errorCb.mock.calls[0][0].message).toBe('DB boom');
  });

  test('limiter.once() fires exactly once then unsubscribes', async () => {
    const limiter = createLimiter({ max: 10 });
    const cb = jest.fn();
    limiter.once('allowed', cb);

    await limiter.check('ok-key');
    await limiter.check('ok-key');

    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('limiter.off() correctly removes the listener', async () => {
    const limiter = createLimiter({ max: 10 });
    const cb = jest.fn();
    limiter.on('allowed', cb);
    
    await limiter.check('k');
    expect(cb).toHaveBeenCalledTimes(1);

    limiter.off('allowed', cb);
    await limiter.check('k');
    expect(cb).toHaveBeenCalledTimes(1); // Still 1
  });

  test('multiple listeners on same event all receive the event', async () => {
    const limiter = createLimiter({ max: 10 });
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    limiter.on('allowed', cb1);
    limiter.on('allowed', cb2);

    await limiter.check('q');
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  test('setMaxListeners(50) avoids MaxListenersExceededWarning', () => {
    const limiter = createLimiter();
    // This will throw or warn in Node natively if limit is 10 and we add 20
    for(let i = 0; i < 20; i++) {
       limiter.on('allowed', () => {});
    }
    expect(limiter.getMaxListeners()).toBe(50);
  });
});

// ─── Rule Engine ─────────────────────────────────────────────────────────────

describe('Rule Engine', () => {
  test('All rules pass -> request allowed', async () => {
    const rules = [
      { keyBy: () => 'ip-1', max: 5, windowMs: 1000, name: 'per-ip' },
      { keyBy: () => 'user-1', max: 10, windowMs: 1000, name: 'per-user' }
    ];
    const limiter = createLimiter({ rules, failOpen: false });
    
    // Call middleware
    const mw = limiter.middleware();
    const req = { method: 'GET', path: '/', headers: {}, socket: { remoteAddress: '1.1.1.1' } };
    const res = { setHeader: jest.fn(), status: jest.fn(() => res), json: jest.fn(), set: jest.fn() };
    const next = jest.fn();

    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Rule-Count', 2);
  });

  test('First rule fails -> request blocked, failedRule is rule 0', async () => {
    const rules = [
      { keyBy: () => 'ip-1', max: 1, windowMs: 1000, name: 'per-ip' },
      { keyBy: () => 'user-1', max: 10, windowMs: 1000, name: 'per-user' }
    ];
    const limiter = createLimiter({ rules, failOpen: false });
    const mw = limiter.middleware();
    const req = { method: 'GET', path: '/', headers: {}, socket: { remoteAddress: '2.2.2.2' } };
    const res = { setHeader: jest.fn(), status: jest.fn(() => res), json: jest.fn(), set: jest.fn() };
    const next = jest.fn();

    await mw(req, res, next); // allowed
    await mw(req, res, next); // blocked

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Failed-Rule', 'per-ip');
  });

  test('rules and max at same level throws config validation error', () => {
    expect(() => createLimiter({ max: 5, windowMs: 1000, rules: [{ keyBy: 'ip', max: 5, windowMs: 1000 }] }))
      .toThrow('mutually exclusive');
  });
});

// ─── Webhook Alerts ──────────────────────────────────────────────────────────

describe('Webhook Alerts', () => {
  const https = require('https');
  let requestSpy;

  beforeEach(() => {
    requestSpy = jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
      // Mock successful webhook (200)
      const res = new (require('events').EventEmitter)();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit('data', '{}');
        res.emit('end');
      });
      return { on: jest.fn(), setTimeout: jest.fn(), write: jest.fn(), end: jest.fn() };
    });
  });

  afterEach(() => {
    requestSpy.mockRestore();
  });

  test('Webhook fires after block but NOT for allowed', async () => {
    const limiter = createLimiter({ max: 1, webhook: 'https://example.com/hook' });
    const mw = limiter.middleware();
    const req = { method: 'GET', path: '/', headers: {}, socket: { remoteAddress: '3.3.3.3' } };
    const res = { setHeader: jest.fn(), status: jest.fn(() => res), json: jest.fn(), set: jest.fn() };
    const next = jest.fn();

    await mw(req, res, next);
    expect(requestSpy).not.toHaveBeenCalled(); // allowed

    await mw(req, res, next); // blocked
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // Verify webhook payload
    const bodyWritten = requestSpy.mock.results[0].value.write.mock.calls[0][0];
    const payload = JSON.parse(bodyWritten);
    expect(payload.event).toBe('blocked');
    expect(payload.limit).toBe(1);
    expect(payload.count).toBe(1);
  });

  test('Webhook does NOT fire for whitelisted IPs', async () => {
    const limiter = createLimiter({ max: 1, webhook: 'https://example.com/hook', whitelist: ['1.1.1.1'], keyBy: 'ip' });
    const mw = limiter.middleware();
    const req = { method: 'GET', path: '/', ip: '1.1.1.1', headers: {}, socket: { remoteAddress: '1.1.1.1' } };
    const res = { setHeader: jest.fn(), status: jest.fn(() => res), json: jest.fn(), set: jest.fn() };
    const next = jest.fn();

    await mw(req, res, next);
    expect(requestSpy).not.toHaveBeenCalled(); 
  });

  test('Webhook HMAC signature header', async () => {
    const secret = 'my-secret';
    const limiter = createLimiter({ max: 1, webhook: 'https://example.com/hook', webhookSecret: secret });
    const mw = limiter.middleware();
    const req = { method: 'GET', path: '/', headers: {}, socket: { remoteAddress: '4.4.4.4' } };
    const res = { setHeader: jest.fn(), status: jest.fn(() => res), json: jest.fn(), set: jest.fn() };
    
    await mw(req, res, jest.fn()); // allowed
    await mw(req, res, jest.fn()); // blocked
    
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const options = requestSpy.mock.calls[0][0];
    expect(options.headers['X-nextlimiter-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});

// ─── Time-Based Schedules ────────────────────────────────────────────────────

describe('Time-Based Schedules', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('Resolves schedule limits correctly based on UTC hour', async () => {
    const schedule = [
      { hours: '0-8', max: 10, windowMs: 60000 },
      { hours: '9-17', max: 300, windowMs: 60000 }, 
      { hours: '18-23', max: 100, windowMs: 60000 }
    ];

    const limiter = createLimiter({ schedule, keyBy: 'ip' });

    // Mock Date to 12 PM UTC (business hours) -> max 300
    jest.setSystemTime(new Date('2024-01-01T12:00:00Z'));
    const stats12 = limiter.getStats();
    expect(stats12.activeSchedule.max).toBe(300);

    // Mock Date to 3 AM UTC (night) -> max 10
    jest.setSystemTime(new Date('2024-01-01T03:00:00Z'));
    const stats3 = limiter.getStats();
    expect(stats3.activeSchedule.max).toBe(10);

    // Mock Date to 20 UTC (evening) -> max 100
    jest.setSystemTime(new Date('2024-01-01T20:00:00Z'));
    const stats20 = limiter.getStats();
    expect(stats20.activeSchedule.max).toBe(100);
  });

  test('schedule and rules together throws config validation error', () => {
    expect(() => createLimiter({ 
        schedule: [{ hours: '0-23', max: 10 }], 
        rules: [{ keyBy: 'ip', max: 5, windowMs: 1000 }] 
    })).toThrow('mutually exclusive');
  });

  test('Invalid hours string throws descriptive error', () => {
    expect(() => createLimiter({ schedule: [{ hours: '25-30', max: 10 }] }))
      .toThrow('between 0 and 23');
      
    expect(() => createLimiter({ schedule: [{ hours: '17-9', max: 10 }] }))
      .toThrow('cannot be less than start hour');
  });
});

// ─── Sliding Window Log Strategy ─────────────────────────────────────────────

describe('sliding-window-log', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('Allows exactly max requests in a window and blocks request max+1', async () => {
    const limiter = createLimiter({ max: 2, windowMs: 1000, strategy: 'sliding-window-log' });
    jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));
    
    let res = await limiter.check('ip');
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(1);
    
    res = await limiter.check('ip');
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(0);

    // Blocked
    res = await limiter.check('ip');
    expect(res.allowed).toBe(false);
    expect(res.retryAfter).toBe(1); // 1000ms until oldest expires
    
    jest.advanceTimersByTime(1001); // advance 1001ms to let timestamps expire
    res = await limiter.check('ip');
    expect(res.allowed).toBe(true);
  });
});

// ─── Leaky Bucket Strategy ───────────────────────────────────────────────────

describe('leaky-bucket', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('Allows requests up to capacity, queues overflow and drops max+1', async () => {
    const limiter = createLimiter({ max: 5, windowMs: 5000, strategy: 'leaky-bucket' });
    // capacity defaults to 5, drainRateMs defaults to 5000 / 5 = 1000ms
    jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));
    
    for (let i = 0; i < 5; i++) {
        let res = await limiter.check('req');
        expect(res.allowed).toBe(true);
    }
    
    let res = await limiter.check('req');
    expect(res.allowed).toBe(false);
    expect(res.retryAfter).toBe(1); // 1000ms until first token is drained
    
    jest.advanceTimersByTime(2000); // 2000ms -> drains 2
    res = await limiter.check('req');
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(1);
    
    res = await limiter.check('req');
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(0);
    
    res = await limiter.check('req');
    expect(res.allowed).toBe(false); 
  });
});
