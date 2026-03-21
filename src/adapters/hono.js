'use strict';

/**
 * NextLimiter — Hono adapter
 *
 * Provides a Hono-compatible middleware factory for Cloudflare Workers,
 * Bun, Deno, and any edge runtime supported by Hono.
 *
 * Uses Web APIs only (fetch/Request/Response/Headers) — no Node.js built-ins.
 * Safe to deploy on Cloudflare Workers, Vercel Edge, and Deno Deploy.
 *
 * No peer dependencies required beyond Hono itself.
 *
 * @example
 * const { Hono } = require('hono');
 * const { rateLimitMiddleware } = require('nextlimiter/hono');
 *
 * const app = new Hono();
 * app.use('*', rateLimitMiddleware({ max: 100, windowMs: 60_000 }));
 *
 * app.get('/', (c) => c.text('Hello World!'));
 * export default app;
 */

const { createLimiter } = require('../index');

/**
 * Extract the real client IP from a Hono context.
 * Prioritises Cloudflare's CF-Connecting-IP header, then X-Forwarded-For.
 *
 * @param {import('hono').Context} c
 * @returns {string}
 */
function extractIp(c) {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  );
}

/**
 * Hono middleware factory.
 *
 * @param {object} options - Same options as createLimiter()
 * @returns {import('hono').MiddlewareHandler}
 *
 * @example
 * app.use('/api/*', rateLimitMiddleware({ max: 100, windowMs: 60_000, strategy: 'sliding-window' }));
 */
function rateLimitMiddleware(options = {}) {
  const limiter = createLimiter(options);

  return async function honoRateLimitMiddleware(c, next) {
    try {
      const ip     = extractIp(c);
      const result = await limiter.check(ip);

      if (!result.allowed) {
        return c.json(
          {
            error:      'Too Many Requests',
            retryAfter: result.retryAfter,
            limit:      result.limit,
            resetAt:    new Date(result.resetAt).toISOString(),
          },
          429
        );
      }

      // Set rate limit headers before passing to next handler
      c.header('X-RateLimit-Limit',     String(result.limit));
      c.header('X-RateLimit-Remaining', String(result.remaining));
      c.header('X-RateLimit-Reset',     String(Math.ceil(result.resetAt / 1000)));
      c.header('X-RateLimit-Strategy',  result.strategy);

      await next();
    } catch (err) {
      // Fail open — never let the rate limiter crash the Hono app
      console.warn(`[NextLimiter] Rate limiter error: ${err.message}. Failing open.`);
      await next();
    }
  };
}

module.exports = { rateLimitMiddleware };
