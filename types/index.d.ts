// NextLimiter — TypeScript type definitions
// Compatible with @types/node and @types/express
import { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'events';

// ── Store interface ──────────────────────────────────────────────────────────

export interface Store {
  get(key: string): any;
  set(key: string, value: any, ttlMs: number): void;
  increment(key: string, ttlMs: number): number;
  delete(key: string): void;
  keys(): string[];
  clear(): void;
}

// ── Plan definitions ─────────────────────────────────────────────────────────

export interface PlanDefinition {
  windowMs: number;
  max: number;
  burstMax?: number;
  description?: string;
}

export interface RuleConfig {
  keyBy: 'ip' | 'api-key' | 'user-id' | string | ((req: Request) => string);
  max: number;
  windowMs: number;
  strategy?: 'sliding-window' | 'token-bucket' | 'fixed-window';
  name?: string;
}

export interface RuleEngineResult {
  allowed: boolean;
  failedRule: RuleConfig | null;
  results: RateLimitResult[];
  mostRestrictive: RateLimitResult;
  key: string;
}

export interface ScheduleEntry {
  hours: string;
  max: number;
  windowMs?: number;
  strategy?: string;
}

export interface WebhookPayload {
  event: string;
  key: string;
  ip: string;
  limit: number;
  count: number;
  timestamp: string;
  retryAfter: number;
  strategy: string;
  ruleName?: string;
}

export type BuiltInPlan = 'free' | 'pro' | 'enterprise';
export type BuiltInPreset = 'strict' | 'relaxed' | 'api' | 'auth';
export type Strategy = 'fixed-window' | 'sliding-window' | 'token-bucket';
export type KeyBy = 'ip' | 'user-id' | 'api-key';

// ── Configuration ────────────────────────────────────────────────────────────

export interface LimiterOptions {
  /** Time window in milliseconds. Default: 60000 (1 minute) */
  windowMs?: number;

  /** Maximum number of requests per window. Default: 100 */
  max?: number;

  /** Rate limiting algorithm. Default: 'sliding-window' */
  strategy?: Strategy;

  /** How to generate the rate limit key. Default: 'ip' */
  keyBy?: KeyBy | ((req: Request) => string);

  /** Redis key prefix. Default: 'nextlimiter:' */
  keyPrefix?: string;

  /** SaaS plan name — overrides windowMs and max */
  plan?: BuiltInPlan | string;

  /** Named preset to use as base configuration */
  preset?: BuiltInPreset;

  /** Custom plan definitions (extend or replace built-in plans) */
  plans?: Record<string, PlanDefinition>;

  /** Enable behavior-based smart rate limiting. Default: false */
  smart?: boolean;

  /** Burst threshold multiplier that triggers smart penalty. Default: 2.0 */
  smartThreshold?: number;

  /** How long smart penalty lasts in ms. Default: 60000 */
  smartCooldownMs?: number;

  /** Reduce limit to this fraction when penalized. Default: 0.5 */
  smartPenaltyFactor?: number;

  /** Enable request logging. Default: false */
  logging?: boolean;

  /** Log prefix string. Default: '[NextLimiter]' */
  logPrefix?: string;

  /** Send X-RateLimit-* headers. Default: true */
  headers?: boolean;

  /** HTTP status code for blocked requests. Default: 429 */
  statusCode?: number;

  /** Message body for blocked requests */
  message?: string;

  /** Custom storage backend */
  store?: Store;

  /**
   * Return true to skip rate limiting for this request.
   * Useful for whitelisting internal services or health checks.
   */
  skip?: (req: Request) => boolean;

  /** Called when a request is blocked. Replaces the default 429 response. */
  onLimitReached?: (req: Request, res: Response, info: RateLimitResult) => void;

  /** Fully custom key generator function */
  keyGenerator?: (req: Request) => string;

  /** Array of IPs or CIDR ranges to bypass rate limiting */
  whitelist?: string[];

  /** Array of IPs or CIDR ranges to block immediately (403) */
  blacklist?: string[];

  /** ms interval to emit 'stats' event. undefined = disabled. */
  statsInterval?: number;

  rules?: RuleConfig[];
  schedule?: ScheduleEntry[];
  webhook?: string;
  webhookRetries?: number;
  webhookBackoff?: 'exponential' | 'linear' | 'fixed';
  webhookTimeout?: number;
  webhookSecret?: string;
}

// ── Rate limit result ────────────────────────────────────────────────────────

export interface RateLimitResult {
  /** Whether this request is allowed to proceed */
  allowed: boolean;

  /** Maximum requests per window */
  limit: number;

  /** Remaining requests in current window */
  remaining: number;

  /** Unix timestamp (ms) when the window resets */
  resetAt: number;

  /** Seconds to wait before retrying (0 if allowed) */
  retryAfter: number;

  /** The resolved rate limit key */
  key: string;

  /** Strategy used for this check */
  strategy: Strategy;

  /** True if blocked specifically by smart limiting */
  smartBlocked: boolean;

  /** Seconds until resetAt */
  readonly retryAfterSeconds: number;

  toJSON(): Omit<RateLimitResult, 'key' | 'strategy' | 'smartBlocked' | 'retryAfterSeconds' | 'toJSON'>;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface PenaltyInfo {
  key: string;
  normalLimit: number;
  reducedLimit: number;
  cooldownMs: number;
  detectedAt: string;
}

export declare class PrometheusFormatter {
  constructor(limiter: Limiter);
  format(): string;
  contentType(): string;
}

export interface KeyCount {
  key: string;
  count: number;
}

export interface SmartPenalizedKey {
  key: string;
  expiresAt: number;
  remainingMs: number;
}

export interface LimiterStats {
  totalRequests: number;
  blockedRequests: number;
  allowedRequests: number;
  blockRate: number;
  topKeys: KeyCount[];
  topBlocked: KeyCount[];
  trackedSince: string;
  uptimeMs: number;
  smartLimiting?: {
    enabled: boolean;
    penalizedKeys: SmartPenalizedKey[];
  };
  config: {
    strategy: Strategy;
    windowMs: number;
    max: number;
    keyBy: string;
    plan: string;
    smart: boolean;
  };
}

// ── Limiter class ────────────────────────────────────────────────────────────

export declare class Limiter extends EventEmitter {
  constructor(options?: LimiterOptions);

  /** Returns an Express-compatible middleware function */
  middleware(): (req: Request, res: Response, next: NextFunction) => Promise<void>;

  /**
   * Express route handler for serving Prometheus metrics.
   * Exposes getStats() data in plain text format (version=0.0.4).
   */
  metricsHandler(): (req: any, res: any) => void;

  /**
   * Global middleware that automatically intercepts GET /metrics requests.
   * Passes through all other routes.
   */
  metricsMiddleware(): (req: any, res: any, next: any) => void;

  /** Programmatic rate limit check by key string */
  check(key: string): Promise<RateLimitResult>;

  /** Reset rate limit state for a specific key */
  reset(key: string): Promise<void>;

  /** Reset rate limit state and clear from store immediately */
  resetKey(key: string): void;

  /** Clean up stores and timers */
  destroy(): void;

  /** Get analytics snapshot */
  getStats(): LimiterStats;

  /** Reset analytics counters */
  resetStats(): void;

  /** Read-only resolved configuration */
  readonly config: Readonly<Required<LimiterOptions>>;

  // Typed EventEmitter overloads
  on(event: 'blocked',     listener: (key: string, result: RateLimitResult) => void): this;
  on(event: 'allowed',     listener: (key: string, result: RateLimitResult) => void): this;
  on(event: 'penalized',   listener: (key: string, info: PenaltyInfo) => void): this;
  on(event: 'blacklisted', listener: (ip: string) => void): this;
  on(event: 'whitelisted', listener: (ip: string) => void): this;
  on(event: 'reset',       listener: (key: string) => void): this;
  on(event: 'stats',       listener: (stats: LimiterStats) => void): this;
  on(event: 'error',       listener: (err: Error) => void): this;

  once(event: 'blocked',     listener: (key: string, result: RateLimitResult) => void): this;
  once(event: 'allowed',     listener: (key: string, result: RateLimitResult) => void): this;
  once(event: 'penalized',   listener: (key: string, info: PenaltyInfo) => void): this;
  once(event: 'blacklisted', listener: (ip: string) => void): this;
  once(event: 'whitelisted', listener: (ip: string) => void): this;
  once(event: 'reset',       listener: (key: string) => void): this;
  once(event: 'stats',       listener: (stats: LimiterStats) => void): this;
  once(event: 'error',       listener: (err: Error) => void): this;
}

// ── Factory functions ────────────────────────────────────────────────────────

/**
 * Create a fully configured Limiter instance.
 *
 * @example
 * const limiter = createLimiter({ windowMs: 60_000, max: 100 });
 * app.use(limiter.middleware());
 */
export declare function createLimiter(options?: LimiterOptions): Limiter;

/**
 * Zero-config middleware. Returns an Express handler directly.
 *
 * @example
 * app.use(autoLimit());
 */
export declare function autoLimit(options?: LimiterOptions): ReturnType<Limiter['middleware']>;

/**
 * Create a limiter pre-configured for a SaaS plan tier.
 *
 * @example
 * const limiter = createPlanLimiter('pro', { keyBy: 'api-key' });
 */
export declare function createPlanLimiter(plan: BuiltInPlan | string, options?: LimiterOptions): Limiter;

/**
 * Create a limiter from a named preset.
 *
 * @example
 * app.post('/login', createPresetLimiter('auth').middleware());
 */
export declare function createPresetLimiter(preset: BuiltInPreset, options?: LimiterOptions): Limiter;

// ── Storage ──────────────────────────────────────────────────────────────────

export declare class MemoryStore implements Store {
  constructor();
  get(key: string): any;
  set(key: string, value: any, ttlMs: number): void;
  increment(key: string, ttlMs: number): number;
  delete(key: string): void;
  keys(): string[];
  clear(): void;
  destroy(): void;
  readonly size: number;
}

/**
 * RedisStore — Redis-backed storage backend for NextLimiter.
 *
 * Requires ioredis to be installed separately:
 *   npm install ioredis
 *
 * Uses an atomic Lua script for increment — race-condition safe across
 * multiple Node.js processes behind a load balancer.
 *
 * @example
 * import Redis from 'ioredis';
 * import { createLimiter, RedisStore } from 'nextlimiter';
 *
 * const redis = new Redis();
 * const limiter = createLimiter({ store: new RedisStore(redis), max: 100 });
 * app.use('/api', limiter.middleware());
 */
export declare class RedisStore implements Store {
  /**
   * @param client - A connected ioredis client instance
   */
  constructor(client: any);
  get(key: string): Promise<any>;
  set(key: string, value: any, ttlMs: number): Promise<void>;
  /** Atomically increments the counter using a Lua script. */
  increment(key: string, ttlMs: number): Promise<number>;
  delete(key: string): Promise<void>;
  keys(): string[];
  clear(): void;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Check whether an IP matches a CIDR range string.
 * Supports standard CIDR (10.0.0.0/8) and exact exact IPs (1.2.3.4).
 */
export declare function ipMatchesCidr(ip: string, cidr: string): boolean;

/** Check whether an IP matches ANY element in a list of IPs / CIDR ranges. */
export declare function ipMatchesList(ip: string, list: string[]): boolean;


// ── Constants ────────────────────────────────────────────────────────────────

export declare const PRESETS: Record<BuiltInPreset, LimiterOptions>;
export declare const DEFAULT_PLANS: Record<BuiltInPlan, PlanDefinition>;

// ── Adapters ─────────────────────────────────────────────────────────────────
//
// These are available as subpath imports:
//   import fastifyRateLimit from 'nextlimiter/fastify'
//   import { withRateLimit, withRateLimitEdge } from 'nextlimiter/next'
//   import { rateLimitMiddleware } from 'nextlimiter/hono'

// fastify adapter
declare module 'nextlimiter/fastify' {
  import { FastifyPluginAsync } from 'fastify';
  const fastifyRateLimit: FastifyPluginAsync<LimiterOptions>;
  export default fastifyRateLimit;
}

// next.js adapter
declare module 'nextlimiter/next' {
  import type { NextApiRequest, NextApiResponse } from 'next';

  /**
   * Wrap a Next.js Pages Router API handler with rate limiting (Node.js runtime).
   */
  export function withRateLimit<T extends (req: NextApiRequest, res: NextApiResponse) => any>(
    handler: T,
    options?: LimiterOptions
  ): (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

  /**
   * Wrap a Next.js App Router / middleware handler with rate limiting (Edge runtime).
   * Uses Web Request / Response API only — no Node.js built-ins.
   */
  export function withRateLimitEdge<T extends (req: Request) => Promise<Response>>(
    handler: T,
    options?: LimiterOptions
  ): (req: Request) => Promise<Response>;
}

// hono adapter
declare module 'nextlimiter/hono' {
  /**
   * Returns a Hono middleware that applies rate limiting.
   * Safe for Cloudflare Workers, Bun, Deno — uses Web APIs only.
   *
   * @example
   * app.use('*', rateLimitMiddleware({ max: 100, windowMs: 60_000 }));
   */
  export function rateLimitMiddleware(options?: LimiterOptions): (c: any, next: () => Promise<void>) => Promise<void>;
}

