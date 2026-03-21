# NextLimiter

**Production-ready rate limiting for Node.js — simple, smart, and built for real SaaS apps.**

[![npm version](https://badge.fury.io/js/nextlimiter.svg)](https://www.npmjs.com/package/nextlimiter)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-38%20passing-brightgreen)](https://github.com/abhishekck31/nexlimiter/actions)

---

## Why NextLimiter?

Most rate limiting libraries make you choose between simple-but-limited and powerful-but-complex. NextLimiter does both.

| Feature | express-rate-limit | rate-limiter-flexible | **NextLimiter** |
|---|---|---|---|
| Zero-config usage | ✓ | ✗ | ✓ |
| SaaS plan tiers | ✗ | ✗ | **✓** |
| Smart / behavior-based limiting | ✗ | ✗ | **✓** |
| Built-in analytics | ✗ | ✗ | **✓** |
| Programmatic `check()` API | ✗ | ✓ | ✓ |
| Named presets | ✗ | ✗ | **✓** |
| Redis support (built-in) | ✗ | ✓ | **✓** |
| TypeScript types included | ✓ | ✓ | ✓ |
| Zero dependencies | ✓ | ✗ | ✓ |

---

## Installation

```bash
npm install nextlimiter
```

No Redis required. Works out of the box with in-memory storage.

For distributed / multi-server deployments, add Redis:

```bash
npm install ioredis
```

---

## Quick Start

### Zero-config (one line)

```js
const { autoLimit } = require('nextlimiter');
app.use(autoLimit());
// → 100 requests/min per IP, sliding window, no setup needed
```

### Custom configuration

```js
const { createLimiter } = require('nextlimiter');

const limiter = createLimiter({
  windowMs: 60_000,   // 1 minute
  max:      100,      // max 100 requests per window
  strategy: 'sliding-window',
  logging:  true,
});

app.use('/api', limiter.middleware());
```

---

## Core Concepts

### Strategies

#### `sliding-window` (default)
The most accurate algorithm. Uses a weighted two-window approximation — same approach as Cloudflare and Nginx's `limit_req_zone`. No boundary-burst problem. O(1) memory per key.

```js
createLimiter({ strategy: 'sliding-window', windowMs: 60_000, max: 100 })
```

#### `token-bucket`
Tokens refill continuously. Allows controlled bursts up to `max` tokens while enforcing a sustained rate. Used by Stripe for their API. Best for APIs where occasional spikes are expected.

```js
createLimiter({ strategy: 'token-bucket', windowMs: 60_000, max: 100 })
```

#### `fixed-window`
Simplest approach. Counts requests in fixed time intervals. Lowest memory usage. Note: susceptible to boundary-burst attacks (a client can use 2× the limit by straddling a window boundary).

```js
createLimiter({ strategy: 'fixed-window', windowMs: 60_000, max: 100 })
```

---

## Features

### SaaS Plan-Based Limiting

Apply different rate limits based on subscription tier without writing conditional logic:

```js
const { createPlanLimiter } = require('nextlimiter');

// Built-in plans: free (60/min), pro (600/min), enterprise (6000/min)
const limiter = createPlanLimiter('pro', {
  keyBy:   'api-key',
  logging: true,
});

app.use('/api', limiter.middleware());
```

**Custom plan definitions:**

```js
const limiter = createLimiter({
  plans: {
    startup:    { windowMs: 60_000, max: 150,  burstMax: 20  },
    growth:     { windowMs: 60_000, max: 500,  burstMax: 80  },
    enterprise: { windowMs: 60_000, max: 5000, burstMax: 500 },
  },
  plan: 'startup',  // swap this based on req.user.plan at runtime
});
```

**Dynamic plan selection per request:**

```js
// Create a limiter per plan, pick the right one in your route handler
const planLimiters = {
  free:       createPlanLimiter('free',       { keyBy: 'api-key' }),
  pro:        createPlanLimiter('pro',        { keyBy: 'api-key' }),
  enterprise: createPlanLimiter('enterprise', { keyBy: 'api-key' }),
};

app.use('/api', (req, res, next) => {
  const plan = req.user?.plan || 'free';
  return planLimiters[plan].middleware()(req, res, next);
});
```

---

### Smart Rate Limiting

Detects burst traffic and dynamically reduces limits for suspicious clients — without blocking them entirely.

```js
const limiter = createLimiter({
  windowMs:           60_000,
  max:                100,
  smart:              true,
  smartThreshold:     2.0,    // flag if rate exceeds 2× normal
  smartCooldownMs:    60_000, // penalty lasts 60 seconds
  smartPenaltyFactor: 0.5,    // reduce limit to 50% during penalty
});
```

**How it works:**
1. Tracks the request rate for each key in a short observation window (10% of `windowMs`)
2. If rate exceeds `normalRate × smartThreshold`, the key is flagged
3. Flagged keys get `floor(max × smartPenaltyFactor)` as their effective limit
4. Penalty expires after `smartCooldownMs`
5. Legitimate users are completely unaffected

---

### Named Presets

Four built-in presets for the most common scenarios:

```js
const { createPresetLimiter } = require('nextlimiter');

// Strict — 30 req/min, sliding window, smart limiting on
app.use('/admin', createPresetLimiter('strict').middleware());

// Relaxed — 300 req/min, token bucket
app.use('/public', createPresetLimiter('relaxed').middleware());

// API — 100 req/min, api-key based, smart on
app.use('/api', createPresetLimiter('api').middleware());

// Auth — 10 attempts per 15 minutes (brute-force protection)
app.post('/login', createPresetLimiter('auth').middleware());
```

---

### Built-in Analytics

Every limiter instance tracks metrics automatically:

```js
const stats = limiter.getStats();

console.log(stats);
// {
//   totalRequests:   15420,
//   blockedRequests: 234,
//   allowedRequests: 15186,
//   blockRate:       0.0152,
//   topKeys: [
//     { key: 'nextlimiter:ip:1.2.3.4', count: 892 },
//     { key: 'nextlimiter:ip:5.6.7.8', count: 441 },
//   ],
//   topBlocked: [
//     { key: 'nextlimiter:ip:1.2.3.4', count: 78 },
//   ],
//   trackedSince: '2024-01-15T10:00:00.000Z',
//   uptimeMs: 3600000,
//   config: {
//     strategy: 'sliding-window',
//     windowMs: 60000,
//     max: 100,
//     plan: 'pro',
//     smart: true,
//   }
// }

// Expose as an endpoint (protect with auth in production)
app.get('/admin/stats', (req, res) => res.json(limiter.getStats()));

// Reset counters
limiter.resetStats();
```

---

### Key-Based Limiting

**By IP (default):**
```js
createLimiter({ keyBy: 'ip' })
// Uses X-Forwarded-For → X-Real-IP → req.ip (proxy-aware)
```

**By authenticated user ID:**
```js
createLimiter({ keyBy: 'user-id' })
// Reads req.user.id → req.user._id → req.userId
// Falls back to IP for unauthenticated requests
```

**By API key:**
```js
createLimiter({ keyBy: 'api-key' })
// Reads Authorization: Bearer <token> → X-API-Key header → ?apiKey query param
```

**Custom key function:**
```js
createLimiter({
  keyGenerator: (req) => `tenant:${req.headers['x-tenant-id']}`,
})
```

---

### Programmatic API

Use `limiter.check()` for rate limiting outside HTTP middleware — WebSockets, background jobs, cron tasks:

```js
const limiter = createLimiter({ windowMs: 60_000, max: 10 });

// WebSocket message handler
async function onMessage(userId, message) {
  const result = await limiter.check(`ws:${userId}`);

  if (!result.allowed) {
    socket.emit('error', {
      message:    'Rate limit exceeded',
      retryAfter: result.retryAfter,
    });
    return;
  }

  processMessage(message);
}

// Background job
async function runExport(userId) {
  const result = await limiter.check(`export:${userId}`);
  if (!result.allowed) throw new Error(`Try again in ${result.retryAfter}s`);
  // ... run export
}
```

---

### Developer-Friendly Logging

```js
createLimiter({ logging: true, logPrefix: '[API]' })
```

Output:
```
2024-01-15T10:23:41.000Z [API] BLOCKED ip:1.2.3.4 (101/100) via sliding-window
2024-01-15T10:23:42.000Z [API] BLOCKED ip:1.2.3.4 (45/22) via sliding-window [smart]
```

Colors are automatically disabled in non-TTY environments (CI, Docker logs).

---

### Skip and Custom Handlers

```js
createLimiter({
  // Skip rate limiting for specific requests
  skip: (req) =>
    req.path === '/health' ||
    req.headers['x-internal-service'] === 'true' ||
    req.ip === '127.0.0.1',

  // Full control over the blocked response
  onLimitReached: (req, res, result) => {
    res.status(429).json({
      error:      'Rate limit exceeded',
      retryAfter: result.retryAfter,
      upgrade:    'Upgrade to Pro for 10× the rate limit',
      docsUrl:    'https://yourapp.com/docs/rate-limits',
    });
  },
})
```

---

## Full Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | `number` | `60000` | Time window in milliseconds |
| `max` | `number` | `100` | Max requests per window |
| `strategy` | `string` | `'sliding-window'` | `'fixed-window'` \| `'sliding-window'` \| `'token-bucket'` |
| `keyBy` | `string\|fn` | `'ip'` | `'ip'` \| `'user-id'` \| `'api-key'` \| `(req) => string` |
| `keyPrefix` | `string` | `'nextlimiter:'` | Redis/store key prefix |
| `plan` | `string` | `null` | `'free'` \| `'pro'` \| `'enterprise'` |
| `plans` | `object` | built-in | Custom plan definitions |
| `preset` | `string` | `null` | `'strict'` \| `'relaxed'` \| `'api'` \| `'auth'` |
| `smart` | `boolean` | `false` | Enable smart burst detection |
| `smartThreshold` | `number` | `2.0` | Rate multiplier that triggers penalty |
| `smartCooldownMs` | `number` | `60000` | How long smart penalty lasts |
| `smartPenaltyFactor` | `number` | `0.5` | Limit multiplier during penalty (0–1) |
| `logging` | `boolean` | `false` | Enable console logging |
| `logPrefix` | `string` | `'[NextLimiter]'` | Log line prefix |
| `headers` | `boolean` | `true` | Send `X-RateLimit-*` headers |
| `statusCode` | `number` | `429` | HTTP status for blocked requests |
| `message` | `string` | `'Too many requests...'` | Default 429 message |
| `store` | `Store` | `MemoryStore` | Custom storage backend (`MemoryStore` or `RedisStore`) |
| `skip` | `fn` | `null` | `(req) => boolean` — skip rate limiting |
| `onLimitReached` | `fn` | `null` | `(req, res, result) => void` |
| `keyGenerator` | `fn` | `null` | `(req) => string` — override key generation |

---

## Response Headers

Every response includes these headers:

```
X-RateLimit-Limit:     100
X-RateLimit-Remaining: 43
X-RateLimit-Reset:     1705315200
X-RateLimit-Strategy:  sliding-window
Retry-After:           47          ← only on 429 responses
```

---

## Redis Support (Distributed Deployments)

NextLimiter ships a built-in `RedisStore` for distributed / multi-server setups. It uses an **atomic Lua script** for `increment()` so there are zero race conditions across multiple Node.js processes behind a load balancer.

### Installation

```bash
npm install ioredis
```

### Usage

```js
const Redis = require('ioredis');
const { createLimiter, RedisStore } = require('nextlimiter');

const redis = new Redis(); // connects to 127.0.0.1:6379 by default

const limiter = createLimiter({
  store:    new RedisStore(redis),
  max:      100,
  windowMs: 60_000,
  strategy: 'sliding-window',
  keyBy:    'ip',
  logging:  true,
});

app.use('/api', limiter.middleware());
```

### With Redis Cluster / Sentinel

```js
// Redis Cluster
const redis = new Redis.Cluster([{ host: '127.0.0.1', port: 6380 }]);

// Redis Sentinel
const redis = new Redis({
  sentinels: [{ host: 'sentinel-1', port: 26379 }],
  name: 'mymaster',
});

const limiter = createLimiter({ store: new RedisStore(redis), max: 100 });
```

### How the Lua Script Works

The `increment()` method uses a single-script atomic operation:

```lua
local new = redis.call('INCR', KEYS[1])
if new == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return new
```

All three steps (INCR + conditional PEXPIRE) execute atomically in Redis — no race condition is possible, even with 100+ Node.js instances.

### Custom Store Interface

You can also implement your own store for any backend (MongoDB, DynamoDB, Postgres, etc.) — just implement 5 methods:

```js
class MyCustomStore {
  async get(key)                 { /* return value or undefined */ }
  async set(key, value, ttlMs)  { /* store with TTL */ }
  async increment(key, ttlMs)   { /* atomic increment, return new count */ }
  async delete(key)             { /* remove key */ }
  keys()                        { /* return string[] — can be [] */ }
}

const limiter = createLimiter({ store: new MyCustomStore() });
```

---

## TypeScript

Full TypeScript support included — no `@types/nextlimiter` needed:

```ts
import { createLimiter, RedisStore, LimiterOptions, RateLimitResult, Store } from 'nextlimiter';
import Redis from 'ioredis';

// In-memory (development)
const limiter = createLimiter({ windowMs: 60_000, max: 100 });

// Redis-backed (production)
const redis = new Redis();
const prodLimiter = createLimiter({
  store:    new RedisStore(redis),
  max:      100,
  strategy: 'sliding-window',
  smart:    true,
});

const result: RateLimitResult = await prodLimiter.check('user:42');
```

---

## License

MIT
