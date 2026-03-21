// NextLimiter — TypeScript type definitions
// Compatible with @types/node and @types/express

import { Request, Response, NextFunction } from 'express';

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

export declare class Limiter {
  constructor(options?: LimiterOptions);

  /** Returns an Express-compatible middleware function */
  middleware(): (req: Request, res: Response, next: NextFunction) => Promise<void>;

  /** Programmatic rate limit check by key string */
  check(key: string): Promise<RateLimitResult>;

  /** Reset rate limit state for a specific key */
  reset(key: string): Promise<void>;

  /** Get analytics snapshot */
  getStats(): LimiterStats;

  /** Reset analytics counters */
  resetStats(): void;

  /** Read-only resolved configuration */
  readonly config: Readonly<Required<LimiterOptions>>;
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

// ── Constants ────────────────────────────────────────────────────────────────

export declare const PRESETS: Record<BuiltInPreset, LimiterOptions>;
export declare const DEFAULT_PLANS: Record<BuiltInPlan, PlanDefinition>;
