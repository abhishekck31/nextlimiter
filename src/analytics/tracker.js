'use strict';

/**
 * Analytics tracker.
 *
 * Tracks request statistics in-process. Zero external dependencies.
 * Resets on process restart (use Redis-backed analytics for persistence).
 *
 * Collected metrics:
 *   totalRequests   — all requests seen by the limiter
 *   blockedRequests — requests that hit the limit
 *   allowedRequests — requests that passed through
 *   topKeys         — top 10 keys by request volume (Map: key → count)
 *   topBlocked      — top 10 keys by block count
 *   blockRate       — blocked / total (0–1)
 *   startedAt       — when tracking started
 */
class AnalyticsTracker {
  constructor() {
    this._total   = 0;
    this._blocked = 0;
    /** @type {Map<string, number>} */
    this._keyCounts   = new Map();
    /** @type {Map<string, number>} */
    this._blockCounts = new Map();
    this._startedAt   = new Date();
  }

  /**
   * Record a single request outcome.
   * @param {string}  key     - Rate limit key (e.g. "nexlimit:ip:1.2.3.4")
   * @param {boolean} allowed - Whether the request was allowed
   */
  record(key, allowed) {
    this._total++;
    if (!allowed) this._blocked++;

    // Track per-key volume
    this._keyCounts.set(key, (this._keyCounts.get(key) || 0) + 1);

    if (!allowed) {
      this._blockCounts.set(key, (this._blockCounts.get(key) || 0) + 1);
    }

    // Prune maps if they grow too large (keep top 10,000 keys)
    if (this._keyCounts.size > 10_000) this._pruneMap(this._keyCounts, 5_000);
    if (this._blockCounts.size > 10_000) this._pruneMap(this._blockCounts, 5_000);
  }

  /**
   * Return current statistics snapshot.
   * @returns {object}
   */
  getStats() {
    return {
      totalRequests:   this._total,
      blockedRequests: this._blocked,
      allowedRequests: this._total - this._blocked,
      blockRate:       this._total > 0
        ? parseFloat((this._blocked / this._total).toFixed(4))
        : 0,
      topKeys:    this._topN(this._keyCounts, 10),
      topBlocked: this._topN(this._blockCounts, 10),
      trackedSince: this._startedAt.toISOString(),
      uptimeMs:     Date.now() - this._startedAt.getTime(),
    };
  }

  /** Reset all counters. */
  reset() {
    this._total   = 0;
    this._blocked = 0;
    this._keyCounts.clear();
    this._blockCounts.clear();
    this._startedAt = new Date();
  }

  // ── private ──────────────────────────────────────────────────────────────

  /**
   * Return the top N entries from a Map, sorted by value descending.
   * @param {Map<string,number>} map
   * @param {number} n
   * @returns {Array<{key: string, count: number}>}
   */
  _topN(map, n) {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, count]) => ({ key, count }));
  }

  /**
   * Remove the lowest-count entries to keep map under maxSize.
   * @param {Map<string,number>} map
   * @param {number} maxSize
   */
  _pruneMap(map, maxSize) {
    const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
    map.clear();
    for (let i = 0; i < Math.min(maxSize, sorted.length); i++) {
      map.set(sorted[i][0], sorted[i][1]);
    }
  }
}

module.exports = { AnalyticsTracker };
