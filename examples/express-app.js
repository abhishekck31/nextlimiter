'use strict';

/**
 * NexLimit — Complete Express Example
 *
 * Demonstrates every feature of the library:
 *   - autoLimit()           Zero-config global middleware
 *   - createLimiter()       Custom configuration
 *   - createPlanLimiter()   SaaS plan-based limiting
 *   - createPresetLimiter() Named presets
 *   - limiter.check()       Programmatic (non-HTTP) usage
 *   - limiter.getStats()    Analytics
 *   - smart limiting        Behavior-based dynamic throttling
 *   - skip()                Whitelist specific requests
 *   - onLimitReached()      Custom 429 handler
 */

const express = require('express');
const {
  autoLimit,
  createLimiter,
  createPlanLimiter,
  createPresetLimiter,
} = require('../src/index');

const app = express();
app.use(express.json());

// ── 1. Zero-config global rate limiting ──────────────────────────────────────
//
// Applies to every route below this middleware.
// Default: 100 req/min per IP, sliding window.
//
app.use(autoLimit({ logging: true }));


// ── 2. Custom rate limiter on a specific route group ─────────────────────────
//
const apiLimiter = createLimiter({
  windowMs:  60_000,
  max:       200,
  strategy:  'sliding-window',
  keyBy:     'ip',
  logging:   true,
  headers:   true,
  message:   'API rate limit exceeded. Please slow down.',

  // Skip rate limiting for health checks and internal services
  skip: (req) => {
    return (
      req.path === '/health' ||
      req.headers['x-internal-service'] === 'true'
    );
  },
});

app.use('/api', apiLimiter.middleware());


// ── 3. SaaS plan-based limiting ───────────────────────────────────────────────
//
// Different endpoints enforce different plan tiers.
// In a real app, you'd look up the user's plan from their JWT or DB.
//
const freeLimiter       = createPlanLimiter('free',       { keyBy: 'api-key', logging: true });
const proLimiter        = createPlanLimiter('pro',        { keyBy: 'api-key', logging: true });
const enterpriseLimiter = createPlanLimiter('enterprise', { keyBy: 'api-key', logging: true });

// Custom plan definitions
const startupLimiter = createLimiter({
  plans: {
    startup: { windowMs: 60_000, max: 150, burstMax: 20, description: 'Startup plan' },
    growth:  { windowMs: 60_000, max: 500, burstMax: 80, description: 'Growth plan'  },
  },
  plan: 'startup',
  keyBy: 'api-key',
  logging: true,
});

app.get('/api/v1/free',       freeLimiter.middleware(),       (req, res) => res.json({ tier: 'free',       data: 'ok' }));
app.get('/api/v1/pro',        proLimiter.middleware(),        (req, res) => res.json({ tier: 'pro',        data: 'ok' }));
app.get('/api/v1/enterprise', enterpriseLimiter.middleware(), (req, res) => res.json({ tier: 'enterprise', data: 'ok' }));
app.get('/api/v1/startup',    startupLimiter.middleware(),    (req, res) => res.json({ tier: 'startup',    data: 'ok' }));


// ── 4. Named presets ──────────────────────────────────────────────────────────
//
// Built-in presets for common scenarios.
//
const authLimiter   = createPresetLimiter('auth',   { logging: true });
const strictLimiter = createPresetLimiter('strict', { logging: true });

app.post('/auth/login',    authLimiter.middleware(),   (req, res) => res.json({ status: 'authenticated' }));
app.post('/auth/register', authLimiter.middleware(),   (req, res) => res.json({ status: 'registered' }));
app.get('/admin',          strictLimiter.middleware(), (req, res) => res.json({ status: 'admin area' }));


// ── 5. Smart rate limiting ────────────────────────────────────────────────────
//
// Detects burst traffic and dynamically reduces limits for suspicious IPs.
// Normal users are unaffected. Abusers get throttled automatically.
//
const smartLimiter = createLimiter({
  windowMs:         60_000,
  max:              100,
  smart:            true,
  smartThreshold:   1.5,       // trigger at 1.5x normal rate
  smartCooldownMs:  30_000,    // penalty lasts 30 seconds
  smartPenaltyFactor: 0.3,     // reduce to 30% of normal limit
  logging:          true,
  strategy:         'token-bucket',
});

app.use('/api/v2', smartLimiter.middleware());
app.get('/api/v2/data', (req, res) => res.json({ data: 'smart-protected route' }));


// ── 6. Custom 429 handler ─────────────────────────────────────────────────────
//
const customLimiter = createLimiter({
  windowMs: 60_000,
  max:      10,
  onLimitReached: (req, res, result) => {
    // Full control over the blocked response
    res.status(429).json({
      error:     'Whoa there! 🚦',
      message:   `You have sent ${result.limit} requests this minute. Calm down!`,
      cooldown:  result.retryAfter,
      resetAt:   new Date(result.resetAt).toISOString(),
      tip:       'Upgrade to Pro for higher limits.',
    });
  },
});

app.get('/strict-endpoint', customLimiter.middleware(), (req, res) => {
  res.json({ message: 'You made it through the strict endpoint!' });
});


// ── 7. Programmatic check (non-HTTP context) ──────────────────────────────────
//
// Use limiter.check() when you need rate limiting outside of Express middleware:
// background jobs, WebSocket messages, cron tasks, etc.
//
const jobLimiter = createLimiter({ windowMs: 60_000, max: 5 });

async function processWebSocketMessage(userId, message) {
  const result = await jobLimiter.check(`ws:${userId}`);
  if (!result.allowed) {
    return { error: 'Rate limit exceeded', retryAfter: result.retryAfter };
  }
  return { processed: true, message };
}


// ── 8. User-based limiting ────────────────────────────────────────────────────
//
// Requires authentication middleware to set req.user before this runs.
//
const userLimiter = createLimiter({
  windowMs: 60_000,
  max:      500,
  keyBy:    'user-id',  // uses req.user.id (falls back to IP if unauthenticated)
  logging:  true,
});

// Simulate auth middleware
app.use('/user-api', (req, res, next) => {
  req.user = { id: req.headers['x-user-id'] || 'anonymous' };
  next();
});
app.use('/user-api', userLimiter.middleware());
app.get('/user-api/profile', (req, res) => res.json({ user: req.user }));


// ── 9. Analytics endpoint ─────────────────────────────────────────────────────
//
// Expose rate limit stats — protect this with auth in production!
//
app.get('/admin/rate-limit-stats', (req, res) => {
  res.json({
    global:    apiLimiter.getStats(),
    smart:     smartLimiter.getStats(),
    auth:      authLimiter.getStats(),
  });
});

// Reset stats endpoint
app.post('/admin/rate-limit-stats/reset', (req, res) => {
  apiLimiter.resetStats();
  res.json({ message: 'Stats reset.' });
});


// ── 10. Health check (bypasses all rate limiting via skip()) ──────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));


// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  NexLimit example server running on http://localhost:${PORT}\n`);
  console.log('  Try these endpoints:');
  console.log('    GET  /api/v1/free          — free tier (60 req/min)');
  console.log('    GET  /api/v1/pro           — pro tier (600 req/min)');
  console.log('    GET  /api/v2/data          — smart rate limited');
  console.log('    POST /auth/login           — 10 attempts per 15 min');
  console.log('    GET  /strict-endpoint      — 10 req/min with custom 429');
  console.log('    GET  /admin/rate-limit-stats — live analytics\n');
});

module.exports = app; // For testing
