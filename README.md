# NextLimiter

**Production-ready rate limiting for Node.js — simple, smart, and built for real SaaS apps.**

[![npm version](https://badge.fury.io/js/nextlimiter.svg)](https://www.npmjs.com/package/nextlimiter)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Why NextLimiter?

Most rate limiting libraries make you choose between simple-but-limited and powerful-but-complex. NextLimiter brings Enterprise-grade rate limiting directly to your stack with **zero external dependencies**.

| Feature | express-rate-limit | rate-limiter-flexible | **NextLimiter (v1.3.0)** |
|---|---|---|---|
| Zero-config usage | ✓ | ✗ | ✓ |
| Supported Frameworks | Express | Agnostic | **Express, Fastify, Next.js, Hono** |
| Algorithms | Fixed | Multiple | **5 algorithms included** |
| Live Dashboard UI | ✗ | ✗ | **✓** |
| CLI Load Tester | ✗ | ✗ | **✓** |
| SaaS plan tiers | ✗ | ✗ | **✓** |
| Multi-rule Engine | ✗ | ✗ | **✓** |
| CIDR Allow/Block lists| ✗ | ✗ | **✓** |
| Webhooks & Events | ✗ | ✗ | **✓** |
| Time-based Schedules | ✗ | ✗ | **✓** |
| Prometheus Metrics | ✗ | ✗ | **✓** |
| Smart Limiting | ✗ | ✗ | **✓** |
| Redis support | ✗ | ✓ | **✓ (Built-in)** |

---

## Installation

```bash
npm install nextlimiter
```

No Redis required. Works out of the box with in-memory storage.
For distributed / multi-server deployments, add Redis: `npm install ioredis`.

---

## The Built-in CLI Tool

NextLimiter ships with an incredibly powerful built-in CLI tool for load-testing, debugging, and benchmarking rate limits locally or remotely.

```bash
# 1. Inspect rate limit headers for a single request
npx nextlimiter inspect https://api.your-app.com/users

# 2. Test specific request limits & concurrency
npx nextlimiter test https://api.your-app.com --requests 200 --concurrency 5

# 3. Continuous benchmarking & block-rate measurement
npx nextlimiter benchmark --url http://localhost:3000 --duration 30 --concurrency 10
```

---

## Quick Start (Framework Extensions)

NextLimiter supports major Node.js/Edge frameworks natively out of the box:

### Express
```js
const { autoLimit, createLimiter } = require('nextlimiter');

const limiter = createLimiter({ windowMs: 60_000, max: 100 });
app.use('/api', limiter.middleware());
```

### Fastify
```js
const nextlimiterFastify = require('nextlimiter/fastify');

fastify.register(nextlimiterFastify, {
  windowMs: 60_000,
  max: 100,
  strategy: 'sliding-window'
});
```

### Next.js (App Router)
```js
import { withRateLimit } from 'nextlimiter/next';

export const GET = withRateLimit(
  { windowMs: 60_000, max: 10 },
  async (req) => {
    return Response.json({ success: true });
  }
);
```

### Hono (Cloudflare Workers, Bun, etc)
```js
import { nextlimiterHono } from 'nextlimiter/hono'

app.use('/api/*', nextlimiterHono({ windowMs: 60_000, max: 100 }))
```

---

## Live Dashboard UI

Monitor live stats, tracking volume, and top blocked IPs through a completely self-contained, zero-dependency Dashboard middleware! Features real-time SSE chart rendering.

```js
const limiter = createLimiter({ max: 100 });

app.use('/nextlimiter', limiter.dashboardMiddleware({
  password: 'admin-secret', // Highly recommended for production!
  refreshMs: 2000
}));
```

---

## The 5 Rate Limiting Algorithms

NextLimiter ships 5 industry-standard algorithms. Choose your exact tradeoff between accuracy, burst-leniency, and memory.

1. **`sliding-window` (default)**
   Weighted two-window approximation (Nginx approach). Accurate and lowest memory footprint (O(1)).
2. **`sliding-window-log`** (New in v1.3.0)
   Stores a perfect timestamp log for identical accuracy as tracking sliding-window-counters (perfect precision). Costs O(N) memory per client.
3. **`token-bucket`**
   Refills continuous tokens. Excellent for APIs expecting spike/burst volume up to `max` tokens.
4. **`leaky-bucket`** (New in v1.3.0)
   Constant output rate draining queue. If the queue hits `capacity`, further requests drop.
   `createLimiter({ strategy: 'leaky-bucket', drainRateMs: 500, capacity: 20 })`
5. **`fixed-window`**
   Counts simple requests per exact bucket interval. Lowest resource usage, but can be bypassed on boundaries.

---

## Advanced Features

### Multiple Rule Engine (Layered Limits)
Enforce broad infrastructure limits alongside strict targeted path limits:
```js
const { RuleEngine } = require('nextlimiter');

const engine = new RuleEngine();
engine.addRule('global', { max: 1000, windowMs: 60000 });
engine.addRule('auth',   { max: 5,    windowMs: 300000,  strategy: 'token-bucket' }, (req) => req.path.startsWith('/login'));

app.use(engine.middleware());
```

### IP Whitelist, Blacklist & CIDR blocks
Support explicit IPs or CIDR IPv4 subnets using `whitelist` and `blacklist` arrays.
```js
createLimiter({
  max: 100,
  whitelist: ['127.0.0.1', '10.0.0.0/8'],
  blacklist: ['192.168.1.5']
});
```

### Webhook Alerts & Slack Integration
Get pinged instantly when abusers bash your endpoints:
```js
createLimiter({
  max: 100,
  webhook: {
    url: 'https://hooks.slack.com/services/T000/B000/XXX',
    threshold: 150, // Fire if blocked count exceeds 150
    cooldownMs: 3600_000 // Max 1 ping per hour
  }
});
```

### Event Emitter
Subscribe to internals to build custom loggers:
```js
const limiter = createLimiter({ max: 100 });

limiter.on('blocked', (key, result) => {
  myDatabase.logAbuse(key, result);
});
```

### Prometheus Analytics Endpoint
Drop-in format generation for Prometheus monitoring systems:
```js
const { PrometheusFormatter } = require('nextlimiter');

app.get('/metrics', (req, res) => {
  const formatter = new PrometheusFormatter(limiter.getStats());
  res.setHeader('Content-Type', 'text/plain');
  res.end(formatter.format());
});
```

### Rate Limiting Schedules
Increase or lower your limits during specific busy hours:
```js
createLimiter({
  max: 500, // Standard limit
  schedules: [
    {
      action: 'scale',
      factor: 0.5,           // Reduce limit to 50% (250) during busy hour
      from: '18:00',         // 6 PM
      to: '19:00',           // 7 PM
      days: [1,2,3,4,5]      // Monday-Friday
    }
  ]
})
```

### SaaS Plan Limits
```js
const { createPlanLimiter } = require('nextlimiter');

// Built-in plans: free (60/min), pro (600/min), enterprise (6000/min)
app.use('/api', createPlanLimiter('pro', { keyBy: 'api-key' }).middleware());
```

### Smart Penalty Limiting
Detect burst traffic cleanly tracking behavior models automatically:
```js
createLimiter({
  smart:              true,
  smartThreshold:     2.0,    // flag if rate exceeds 2× normal
  smartPenaltyFactor: 0.5,    // reduce limit to 50% during penalty
});
```

---

## Redis Storage Support

Included built-in `RedisStore` leveraging atomic Lua `INCR` operations. Never encounter race conditions natively scaling limits synchronously through load balancers:

```bash
npm install ioredis
```

```js
const Redis = require('ioredis');
const { createLimiter, RedisStore } = require('nextlimiter');

const redis = new Redis();

const limiter = createLimiter({
  store: new RedisStore(redis),
  max:   100
});
```

---

## Technical Options

| Setting | Defaults | Notes |
|---------|----------|-------|
| `windowMs` | `60000` | Calculation mapping intervals (Ms) |
| `max` | `100` | Max request hit ceiling allowed per window |
| `strategy` | `'sliding-window'` | Limits (`fixed-window`, `leaky-bucket`, etc) |
| `keyBy` | `'ip'` | Determines `key` ('ip' / 'api-key') |
| `whitelist` | `[]` | Explicit array skipping matching IPs/CIDRs |
| `blacklist` | `[]` | Explicit array automatically terminating IPs/CIDRs |
| `webhook` | `{}` | Config map pointing `{ url, threshold }` destinations |
| `smart` | `false` | Smart penalization booleans active logic checks |

---

## License
MIT
