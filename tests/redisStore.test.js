'use strict';

const { RedisStore } = require('../src/store/redisStore');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal ioredis mock. Individual tests override methods as needed.
 */
function makeClient(overrides = {}) {
  const store = new Map(); // in-memory backing for get/set/del

  const client = {
    eval: jest.fn(),
    get: jest.fn(async (key) => {
      const entry = store.get(key);
      return entry !== undefined ? entry : null;
    }),
    set: jest.fn(async (key, value) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key) => {
      const deleted = store.has(key) ? 1 : 0;
      store.delete(key);
      return deleted;
    }),
    _store: store,
    ...overrides,
  };
  return client;
}

// ── Constructor validation ────────────────────────────────────────────────────

describe('RedisStore — constructor', () => {
  test('accepts a valid ioredis client', () => {
    const client = makeClient();
    expect(() => new RedisStore(client)).not.toThrow();
  });

  test('throws when no client is passed', () => {
    expect(() => new RedisStore()).toThrow('[NextLimiter] RedisStore requires an ioredis client');
  });

  test('throws when client lacks eval()', () => {
    expect(() => new RedisStore({ get: jest.fn() })).toThrow(
      '[NextLimiter] RedisStore requires an ioredis client'
    );
  });

  test('throws when null is passed', () => {
    expect(() => new RedisStore(null)).toThrow();
  });
});

// ── get() ─────────────────────────────────────────────────────────────────────

describe('RedisStore — get()', () => {
  test('returns undefined when key does not exist', async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(null) });
    const store = new RedisStore(client);
    expect(await store.get('missing')).toBeUndefined();
  });

  test('returns parsed JSON value when key exists', async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(JSON.stringify({ count: 5 })) });
    const store = new RedisStore(client);
    expect(await store.get('k')).toEqual({ count: 5 });
  });

  test('returns raw string when value is not valid JSON', async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue('plain-string') });
    const store = new RedisStore(client);
    expect(await store.get('k')).toBe('plain-string');
  });

  test('returns number correctly (JSON.parse handles numbers)', async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue('42') });
    const store = new RedisStore(client);
    expect(await store.get('k')).toBe(42);
  });

  test('returns undefined when value is undefined (Redis RESP undefined)', async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(undefined) });
    const store = new RedisStore(client);
    expect(await store.get('k')).toBeUndefined();
  });

  test('calls client.get with the correct key', async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(null) });
    const store = new RedisStore(client);
    await store.get('my-key');
    expect(client.get).toHaveBeenCalledWith('my-key');
  });
});

// ── set() ─────────────────────────────────────────────────────────────────────

describe('RedisStore — set()', () => {
  test('calls client.set with key, JSON-serialised value, PX, and ttlMs', async () => {
    const client = makeClient({ set: jest.fn().mockResolvedValue('OK') });
    const store = new RedisStore(client);
    await store.set('k', { x: 1 }, 5000);
    expect(client.set).toHaveBeenCalledWith('k', JSON.stringify({ x: 1 }), 'PX', 5000);
  });

  test('serialises primitive number values', async () => {
    const client = makeClient({ set: jest.fn().mockResolvedValue('OK') });
    const store = new RedisStore(client);
    await store.set('num', 99, 1000);
    expect(client.set).toHaveBeenCalledWith('num', '99', 'PX', 1000);
  });

  test('serialises null as JSON null', async () => {
    const client = makeClient({ set: jest.fn().mockResolvedValue('OK') });
    const store = new RedisStore(client);
    await store.set('null-key', null, 1000);
    expect(client.set).toHaveBeenCalledWith('null-key', 'null', 'PX', 1000);
  });

  test('resolves without a return value', async () => {
    const client = makeClient({ set: jest.fn().mockResolvedValue('OK') });
    const store = new RedisStore(client);
    await expect(store.set('k', 'v', 1000)).resolves.toBeUndefined();
  });
});

// ── increment() ───────────────────────────────────────────────────────────────

describe('RedisStore — increment()', () => {
  function makeEvalClient(returnValue = 1) {
    return makeClient({ eval: jest.fn().mockResolvedValue(returnValue) });
  }

  test('returns 1 on first call (new key)', async () => {
    const client = makeEvalClient(1);
    const store = new RedisStore(client);
    expect(await store.increment('k', 60_000)).toBe(1);
  });

  test('returns incremented count on subsequent calls', async () => {
    const client = makeEvalClient(5);
    const store = new RedisStore(client);
    expect(await store.increment('k', 60_000)).toBe(5);
  });

  test('passes correct args to client.eval: script, numKeys=1, key, ttlMs', async () => {
    const client = makeEvalClient(1);
    const store = new RedisStore(client);
    await store.increment('rate:ip:1.2.3.4', 30_000);

    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String), // Lua script
      1,                  // numKeys
      'rate:ip:1.2.3.4', // KEYS[1]
      30_000              // ARGV[1] — ttlMs
    );
  });

  test('coerces Redis integer result to JS number', async () => {
    // ioredis returns Lua integers as JS numbers, but verify coercion is explicit
    const client = makeEvalClient('3'); // simulate string-ish return
    const store = new RedisStore(client);
    const result = await store.increment('k', 1000);
    expect(typeof result).toBe('number');
    expect(result).toBe(3);
  });

  test('propagates errors from client.eval', async () => {
    const client = makeClient({
      eval: jest.fn().mockRejectedValue(new Error('READONLY You can\'t write against a read only replica')),
    });
    const store = new RedisStore(client);
    await expect(store.increment('k', 1000)).rejects.toThrow('READONLY');
  });
});

// ── delete() ─────────────────────────────────────────────────────────────────

describe('RedisStore — delete()', () => {
  test('calls client.del with the correct key', async () => {
    const client = makeClient({ del: jest.fn().mockResolvedValue(1) });
    const store = new RedisStore(client);
    await store.delete('to-remove');
    expect(client.del).toHaveBeenCalledWith('to-remove');
  });

  test('resolves even when key does not exist', async () => {
    const client = makeClient({ del: jest.fn().mockResolvedValue(0) });
    const store = new RedisStore(client);
    await expect(store.delete('ghost')).resolves.toBeUndefined();
  });
});

// ── keys() / clear() ─────────────────────────────────────────────────────────

describe('RedisStore — keys() and clear()', () => {
  test('keys() returns an empty array (SCAN not required by interface)', () => {
    const store = new RedisStore(makeClient());
    expect(store.keys()).toEqual([]);
  });

  test('clear() is a no-op and does not throw', () => {
    const store = new RedisStore(makeClient());
    expect(() => store.clear()).not.toThrow();
  });
});

// ── Round-trip integration (mock Redis backed by Map) ─────────────────────────

describe('RedisStore — round-trip via mock Redis', () => {
  let client;
  let store;

  beforeEach(() => {
    // Full mock that simulates a real Redis: set stores in map, get reads from it
    const _db = new Map();
    client = {
      eval: jest.fn(async (_script, _numKeys, key, ttlMs) => {
        const current = _db.get(key);
        const newVal  = (current || 0) + 1;
        _db.set(key, newVal);
        return newVal;
      }),
      get:   jest.fn(async (key) => {
        const v = _db.get(key);
        return v !== undefined ? String(v) : null;
      }),
      set:   jest.fn(async (key, value) => { _db.set(key, value); return 'OK'; }),
      del:   jest.fn(async (key) => { const ok = _db.has(key); _db.delete(key); return ok ? 1 : 0; }),
    };
    store = new RedisStore(client);
  });

  test('set then get round-trips correctly', async () => {
    await store.set('user:1', { tokens: 10 }, 60_000);
    expect(await store.get('user:1')).toEqual({ tokens: 10 });
  });

  test('increment is monotonically increasing', async () => {
    const r1 = await store.increment('ip:1.1.1.1', 60_000);
    const r2 = await store.increment('ip:1.1.1.1', 60_000);
    const r3 = await store.increment('ip:1.1.1.1', 60_000);
    expect([r1, r2, r3]).toEqual([1, 2, 3]);
  });

  test('delete removes a key set via set()', async () => {
    await store.set('temp', 'value', 1000);
    await store.delete('temp');
    // After deletion the get mock returns null → undefined
    client.get.mockResolvedValueOnce(null);
    expect(await store.get('temp')).toBeUndefined();
  });
});
