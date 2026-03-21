'use strict';

class Scheduler {
  constructor(schedule, baseConfig) {
    this._schedule = schedule;
    this._baseConfig = baseConfig;
  }

  resolve(now = new Date()) {
    const currentHour = this._currentHourUTC(now);
    
    for (const entry of this._schedule) {
      const { start, end } = this._parseHours(entry.hours);
      if (currentHour >= start && currentHour <= end) {
        return {
          ...this._baseConfig,
          max: entry.max,
          windowMs: entry.windowMs !== undefined ? entry.windowMs : this._baseConfig.windowMs,
          strategy: entry.strategy || this._baseConfig.strategy
        };
      }
    }

    return this._baseConfig;
  }

  _currentHourUTC(now) {
    return now.getUTCHours();
  }

  _parseHours(rangeStr) {
    const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(rangeStr);
    if (!match) throw new Error(`[NextLimiter] Invalid schedule hours format: "${rangeStr}" (expected "start-end" e.g. "9-17")`);
    
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    
    if (start < 0 || start > 23 || end < 0 || end > 23) {
      throw new Error(`[NextLimiter] Schedule hours must be between 0 and 23. Got: ${rangeStr}`);
    }
    if (end < start) {
      throw new Error(`[NextLimiter] Schedule end hour cannot be less than start hour. Got: ${rangeStr}`);
    }

    return { start, end };
  }
}

module.exports = { Scheduler };
