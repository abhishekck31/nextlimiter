'use strict';

/**
 * SmartDetector — behavior-based dynamic rate limiting.
 *
 * Detects anomalous traffic patterns and temporarily reduces the limit
 * for flagged keys without blocking them entirely.
 *
 * Detection logic:
 *   1. Track request rate for each key over a short observation window
 *   2. If the observed rate exceeds (normalRate × smartThreshold), flag the key
 *   3. Flagged keys get a reduced limit: floor(max × smartPenaltyFactor)
 *   4. The penalty expires after smartCooldownMs
 *
 * This lets legitimate burst-y users (e.g. someone running a data export)
 * slow down gracefully rather than hitting a hard wall.
 */
class SmartDetector {
  /**
   * @param {object} config - Resolved NextLimiter config
   * @param {import('events').EventEmitter} [emitter] - Optional event emitter
   */
  constructor(config, emitter) {
    this._config = config;
    this._emitter = emitter;
    this._penalizedSet = new Set();

    // Map: key → { windowStart, count, penalized, penaltyExpires }
    /** @type {Map<string, object>} */
    this._state = new Map();

    // Observation window = 10% of the rate limit window (min 1s, max 30s)
    this._observationMs = Math.min(
      30_000,
      Math.max(1_000, Math.floor(config.windowMs * 0.1))
    );
  }

  /**
   * Check whether a key should be penalized and what its effective limit is.
   *
   * @param {string} key
   * @returns {{ penalized: boolean, effectiveMax: number }}
   */
  check(key) {
    const now    = Date.now();
    const config = this._config;
    let state  = this._state.get(key);

    if (!state) {
      state = {
        windowStart:    now,
        count:          0,
        penalized:      false,
        penaltyExpires: 0,
      };
      this._state.set(key, state);
    }

    // --- Record this request in the observation window ---
    if (now - state.windowStart > this._observationMs) {
      // Slide the window
      const normalRatePerObsWindow =
        (config.max / config.windowMs) * this._observationMs;

      // Was the previous window anomalous?
      if (state.count > normalRatePerObsWindow * config.smartThreshold) {
        state.penalized      = true;
        state.penaltyExpires = now + config.smartCooldownMs;

        if (this._emitter && !this._penalizedSet.has(key)) {
          this._penalizedSet.add(key);
          this._emitter.emit('penalized', key, {
            key,
            normalLimit: config.max,
            reducedLimit: Math.floor(config.max * config.smartPenaltyFactor),
            cooldownMs: config.smartCooldownMs,
            detectedAt: new Date().toISOString()
          });
        }
      }

      // Reset observation window
      state.windowStart = now;
      state.count       = 0;
    }

    state.count++;

    // --- Check if currently under penalty ---
    if (state.penalized && now < state.penaltyExpires) {
      return {
        penalized:    true,
        effectiveMax: Math.max(1, Math.floor(config.max * config.smartPenaltyFactor)),
      };
    }

    // Penalty expired — lift it
    if (state.penalized && now >= state.penaltyExpires) {
      state.penalized = false;
      this._penalizedSet.delete(key);
    }

    return { penalized: false, effectiveMax: config.max };
  }

  /**
   * Return a snapshot of currently penalized keys.
   * @returns {Array<{key: string, expiresAt: number, remainingMs: number}>}
   */
  getPenalizedKeys() {
    const now = Date.now();
    const result = [];
    for (const [key, state] of this._state) {
      if (state.penalized && now < state.penaltyExpires) {
        result.push({
          key,
          expiresAt:   state.penaltyExpires,
          remainingMs: state.penaltyExpires - now,
        });
      }
    }
    return result;
  }

  /** Clear all tracking state. */
  reset() {
    this._state.clear();
    this._penalizedSet.clear();
  }
}

module.exports = { SmartDetector };
