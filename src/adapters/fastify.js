'use strict';

/**
 * NextLimiter — Fastify adapter
 *
 * Registers a Fastify plugin that applies rate limiting via an onRequest hook.
 * Uses the same createLimiter() core — no rate limit logic lives here.
 *
 * Peer dependency: fastify-plugin (npm install fastify-plugin)
 *
 * @example
 * const fastify = require('fastify')();
 * const fastifyRateLimit = require('nextlimiter/fastify');
 *
 * fastify.register(fastifyRateLimit, { max: 100, windowMs: 60_000 });
 */

const { createLimiter } = require('../index');

/**
 * Extract the best available IP from a Fastify request.
 * @param {object} request - Fastify request object
 * @returns {string}
 */
function extractIp(request) {
  return (
    request.headers['cf-connecting-ip'] ||
    request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    request.ip ||
    'unknown'
  );
}

/**
 * Fastify plugin factory.
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} options - Same options as createLimiter()
 * @param {function} done
 */
async function plugin(fastify, options) {
  const limiter = createLimiter(options);

  fastify.addHook('onRequest', async (request, reply) => {
    try {
      const ip     = extractIp(request);
      const result = await limiter.check(ip);

      if (!result.allowed) {
        return reply.code(429).send({
          error:      'Too Many Requests',
          retryAfter: result.retryAfter,
          limit:      result.limit,
          resetAt:    new Date(result.resetAt).toISOString(),
        });
      }

      // Set rate limit headers on allowed requests
      reply.header('X-RateLimit-Limit',     String(result.limit));
      reply.header('X-RateLimit-Remaining', String(result.remaining));
      reply.header('X-RateLimit-Reset',     String(Math.ceil(result.resetAt / 1000)));
      reply.header('X-RateLimit-Strategy',  result.strategy);
    } catch (err) {
      // Fail open — never let the rate limiter take down the app
      request.log.warn(`[NextLimiter] Rate limiter error: ${err.message}. Failing open.`);
    }
  });
}

let fastifyPlugin;
try {
  fastifyPlugin = require('fastify-plugin');
} catch {
  // If fastify-plugin is not installed, wrap minimally so the plugin still works
  fastifyPlugin = (fn, _meta) => fn;
}

module.exports = fastifyPlugin(plugin, {
  fastify:  '>=4.0.0',
  name:     'nextlimiter',
});
