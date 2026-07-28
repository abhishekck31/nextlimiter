'use strict';

/**
 * NextLimiter — Next.js adapter
 *
 * Provides two higher-order wrappers:
 *   withRateLimit()     — for Next.js Pages Router API routes (Node.js runtime)
 *   withRateLimitEdge() — for App Router / middleware.js (Edge runtime, Web APIs only)
 *
 * No peer dependencies required.
 *
 * @example
 * // Pages Router (pages/api/hello.js)
 * const { withRateLimit } = require('nextlimiter/next');
 * export default withRateLimit(handler, { max: 100, windowMs: 60_000 });
 *
 * // App Router / Edge (middleware.js)
 * const { withRateLimitEdge } = require('nextlimiter/next');
 * export default withRateLimitEdge(handler, { max: 50 });
 */

const { createLimiter } = require('../index');

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Memoize limiter instances per options reference so the limiter is only
 * created once per HOC call, not on every request.
 */
const limiterCache = new WeakMap();

function getLimiter(options) {
  if (limiterCache.has(options)) {return limiterCache.get(options);}
  const limiter = createLimiter(options);
  limiterCache.set(options, limiter);
  return limiter;
}

// ── Pages Router (Node.js runtime) ───────────────────────────────────────────

/**
 * Higher-order function for Next.js Pages Router API routes.
 * Wraps a handler with rate limiting using the Node.js HTTP req/res API.
 *
 * @param {function} handler - Next.js API route handler (req, res) => void
 * @param {object}   options - createLimiter() options
 * @returns {function} wrapped async handler
 *
 * @example
 * export default withRateLimit(async (req, res) => {
 *   res.json({ hello: 'world' });
 * }, { max: 100, windowMs: 60_000 });
 */
function withRateLimit(handler, options = {}) {
  const limiter = getLimiter(options);

  return async function rateLimitedHandler(req, res) {
    try {
      const ip =
        (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) ||
        req.socket?.remoteAddress ||
        'unknown';

      const result = await limiter.check(ip);

      if (!result.allowed) {
        return res.status(429).json({
          error:      'Too Many Requests',
          retryAfter: result.retryAfter,
          limit:      result.limit,
          resetAt:    new Date(result.resetAt).toISOString(),
        });
      }

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit',     String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset',     String(Math.ceil(result.resetAt / 1000)));
      res.setHeader('X-RateLimit-Strategy',  result.strategy);

      return handler(req, res);
    } catch (err) {
      // Fail open — never let the rate limiter crash the API route
      console.warn(`[NextLimiter] Rate limiter error: ${err.message}. Failing open.`);
      return handler(req, res);
    }
  };
}

// ── App Router / Edge runtime (Web APIs only) ─────────────────────────────────

/**
 * Higher-order function for Next.js App Router or middleware.js.
 * Uses Web Request/Response API only — no Node.js built-ins.
 * Safe to run on Vercel Edge, Cloudflare Workers, and Deno.
 *
 * @param {function} handler - async (request: Request) => Response
 * @param {object}   options - createLimiter() options
 * @returns {function} wrapped async handler
 *
 * @example
 * // middleware.js
 * export default withRateLimitEdge(async (req) => {
 *   return new Response('OK');
 * }, { max: 50, windowMs: 60_000 });
 */
function withRateLimitEdge(handler, options = {}) {
  const limiter = getLimiter(options);

  return async function rateLimitedEdgeHandler(request) {
    try {
      const ip =
        request.headers.get('cf-connecting-ip') ||
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown';

      const result = await limiter.check(ip);

      if (!result.allowed) {
        return new Response(
          JSON.stringify({
            error:      'Too Many Requests',
            retryAfter: result.retryAfter,
            limit:      result.limit,
            resetAt:    new Date(result.resetAt).toISOString(),
          }),
          {
            status:  429,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Call the handler and inject rate limit headers into the response
      const response = await handler(request);

      // Clone with additional headers (Response is immutable)
      const headers = new Headers(response.headers);
      headers.set('X-RateLimit-Limit',     String(result.limit));
      headers.set('X-RateLimit-Remaining', String(result.remaining));
      headers.set('X-RateLimit-Reset',     String(Math.ceil(result.resetAt / 1000)));
      headers.set('X-RateLimit-Strategy',  result.strategy);

      return new Response(response.body, {
        status:     response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      // Fail open
      console.warn(`[NextLimiter] Rate limiter error: ${err.message}. Failing open.`);
      return handler(request);
    }
  };
}

module.exports = { withRateLimit, withRateLimitEdge };
