<div align="center">
  <h1>🚀 NextLimiter</h1>
  <p><strong>Production-ready rate limiting for Node.js — simple, smart, and built for real SaaS apps.</strong></p>
  
  [![npm version](https://img.shields.io/npm/v/nextlimiter.svg?style=flat-square)](https://www.npmjs.com/package/nextlimiter)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)
  [![Node.js CI](https://github.com/abhishekck31/nexlimiter/actions/workflows/node.js.yml/badge.svg?style=flat-square)](https://github.com/abhishekck31/nexlimiter/actions)
  [![Coverage Status](https://img.shields.io/coveralls/github/abhishekck31/nexlimiter/main.svg?style=flat-square)](https://coveralls.io/github/abhishekck31/nexlimiter?branch=main)
</div>

---

## ✨ Why NextLimiter?

Most rate limiting libraries make you choose between simple-but-limited and powerful-but-complex. NextLimiter brings **Enterprise-grade** rate limiting directly to your stack with **zero external dependencies** required out of the box.

| Feature | express-rate-limit | rate-limiter-flexible | **NextLimiter** |
|---|:---:|:---:|:---:|
| Zero-config usage | ✓ | ✗ | **✓** |
| Supported Frameworks | Express | Agnostic | **Express, Fastify, Next.js, Hono** |
| Algorithms | Fixed | Multiple | **5 algorithms included** |
| Live Dashboard UI | ✗ | ✗ | **✓** |
| CLI Load Tester | ✗ | ✗ | **✓** |
| SaaS plan tiers | ✗ | ✗ | **✓** |
| Multi-rule Engine | ✗ | ✗ | **✓** |
| Webhooks & Events | ✗ | ✗ | **✓** |
| Time-based Schedules| ✗ | ✗ | **✓** |
| Smart Limiting | ✗ | ✗ | **✓** |
| DDoS Memory Safe | ✗ | ✓ | **✓ (LRU Size Caps)** |
| Redis support | ✗ | ✓ | **✓ (Atomic Lua INCR)** |

---

## 📦 Installation

```bash
npm install nextlimiter
```

> **Note:** NextLimiter uses an optimized in-memory store by default with active DDoS protection (memory caps). For distributed/multi-server deployments, we recommend adding Redis: `npm install ioredis`.

---

## 🚀 Quick Start

NextLimiter supports major Node.js and Edge frameworks natively.

### Express
```javascript
const { autoLimit, createLimiter } = require('nextlimiter');

const limiter = createLimiter({ windowMs: 60_000, max: 100 });
app.use('/api', limiter.middleware());
```

### Fastify
```javascript
const nextlimiterFastify = require('nextlimiter/fastify');

fastify.register(nextlimiterFastify, {
  windowMs: 60_000,
  max: 100,
  strategy: 'sliding-window'
});
```

### Next.js (App Router)
```javascript
import { withRateLimit } from 'nextlimiter/next';

export const GET = withRateLimit(
  { windowMs: 60_000, max: 10 },
  async (req) => {
    return Response.json({ success: true });
  }
);
```

---

## 🛡️ Top Features

### 1. The 5 Algorithms
Choose your exact tradeoff between accuracy, burst-leniency, and memory.
1. **`sliding-window` (default)**: Weighted two-window approximation. Accurate & low memory footprint.
2. **`sliding-window-log`**: Stores a perfect timestamp log for 100% precise sliding-window calculations.
3. **`token-bucket`**: Refills continuous tokens. Excellent for APIs expecting spike/burst volume.
4. **`leaky-bucket`**: Constant output rate draining queue. Smooths traffic perfectly.
5. **`fixed-window`**: Simple request counting per interval.

### 2. Live Dashboard UI 📈
Monitor live stats, track volume, and identify top blocked IPs through a completely self-contained, real-time dashboard. Secured against timing-attacks.
```javascript
const limiter = createLimiter({ max: 100 });

app.use('/nextlimiter', limiter.dashboardMiddleware({
  password: 'admin-secret', // Securely verified using HMAC & timingSafeEqual
  refreshMs: 2000
}));
```

### 3. Built-in CLI Tool 🛠
Load-test, debug, and benchmark rate limits locally or remotely.
```bash
npx nextlimiter benchmark --url http://localhost:3000 --duration 30 --concurrency 10
```

### 4. SaaS Plan Tiers 💎
Map API limits directly to your subscription tiers:
```javascript
const { createPlanLimiter } = require('nextlimiter');

// 'free' (60/min), 'pro' (600/min), 'enterprise' (6000/min)
app.use('/api', createPlanLimiter('pro', { keyBy: 'api-key' }).middleware());
```

### 5. Multi-Rule Engine ⚙️
Layer your limits. Enforce broad infrastructure limits alongside strict path-specific limits:
```javascript
const { RuleEngine } = require('nextlimiter');

const engine = new RuleEngine();
engine.addRule('global', { max: 1000, windowMs: 60000 });
engine.addRule('auth',   { max: 5, windowMs: 300000, strategy: 'token-bucket' }, (req) => req.path.startsWith('/login'));

app.use(engine.middleware());
```

---

## 💾 Storage Backends & Security

### MemoryStore (DDoS Protected)
The default `MemoryStore` is heavily optimized. It periodically cleans up expired keys and supports a strict **`maxSize`** cap (default: `50,000` keys). Under severe DDoS attacks using randomized IPs, NextLimiter will aggressively evict older/expired entries down to 90% capacity to ensure your Node.js process never crashes from memory exhaustion.

### RedisStore (Distributed Scale)
Ready to scale horizontally? The built-in `RedisStore` leverages atomic Lua `INCR` operations. Never encounter race conditions or split-brain tracking natively across load balancers.
```javascript
const Redis = require('ioredis');
const { createLimiter, RedisStore } = require('nextlimiter');

const redis = new Redis();
const limiter = createLimiter({
  store: new RedisStore(redis),
  max: 100
});
```

---

## 🎛 Technical Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `windowMs` | `number` | `60000` | Calculation mapping intervals in milliseconds. |
| `max` | `number` | `100` | Max request hit ceiling allowed per window. |
| `strategy` | `string` | `'sliding-window'`| Algorithm to enforce. |
| `keyBy` | `string/fn`| `'ip'` | Determines the unique key (`'ip'`, `'api-key'`, or custom function). |
| `whitelist`| `Array` | `[]` | Explicit array of IPs/CIDRs to skip. |
| `blacklist`| `Array` | `[]` | Explicit array of IPs/CIDRs to permanently block. |
| `webhook` | `object` | `{}` | `{ url, threshold }` for Slack/Discord alerts on heavy abuse. |
| `smart` | `boolean`| `false` | Enable behavior-based anomaly detection & penalization. |

---

## 📄 License
MIT © Abhishek
