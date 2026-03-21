'use strict';

/**
 * Pure Node.js Prometheus Exposition Formatter
 * Zero dependencies. Converts limiter stats to valid Prometheus text format.
 */

class PrometheusFormatter {
  constructor(limiter) {
    this.limiter = limiter;
  }

  contentType() {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }

  /**
   * Escape label values according to Prometheus rules:
   * \ -> \\
   * " -> \"
   * \n -> \n
   */
  _escapeLabel(str) {
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }

  /**
   * Format a single metric block (help, type, and samples).
   */
  _metricBlock(name, help, type, samples) {
    if (!samples || samples.length === 0) return '';
    let block = `# HELP ${name} ${help}\n`;
    block += `# TYPE ${name} ${type}\n`;

    for (const sample of samples) {
      const labelEntries = Object.entries(sample.labels || {});
      if (labelEntries.length > 0) {
        const labelStrs = labelEntries.map(([k, v]) => `${k}="${this._escapeLabel(v)}"`);
        block += `${name}{${labelStrs.join(',')}} ${sample.value}\n`;
      } else {
        block += `${name} ${sample.value}\n`;
      }
    }
    return block + '\n';
  }

  format() {
    const stats = this.limiter.getStats();
    let output = '';

    // 1. Total requests (Counter)
    output += this._metricBlock(
      'nextlimiter_requests_total',
      'Total requests processed by nextlimiter',
      'counter',
      [
        { labels: { status: 'allowed' }, value: stats.allowedRequests },
        { labels: { status: 'blocked' }, value: stats.blockedRequests }
      ]
    );

    // 2. Block rate (Gauge)
    output += this._metricBlock(
      'nextlimiter_block_rate',
      'Ratio of blocked to total requests (0.0 to 1.0)',
      'gauge',
      [{ labels: {}, value: isNaN(stats.blockRate) ? 0 : stats.blockRate }]
    );

    // 3. Top blocked IPs (Gauge)
    const topBlockedSamples = (stats.topBlocked || []).slice(0, 10).map((item) => {
      // Clean up IP label
      let ip = item.key.replace(/^nextlimiter:(ip:)?/, '');
      return { labels: { ip }, value: item.count };
    });
    if (topBlockedSamples.length > 0) {
      output += this._metricBlock(
        'nextlimiter_top_blocked_ip',
        'Block count per offending IP',
        'gauge',
        topBlockedSamples
      );
    }

    // 4. Top keys by volume (Gauge)
    const topKeysSamples = (stats.topKeys || []).slice(0, 10).map((item) => {
      return { labels: { key: item.key }, value: item.count };
    });
    if (topKeysSamples.length > 0) {
      output += this._metricBlock(
        'nextlimiter_top_keys_total',
        'Total request count per key',
        'gauge',
        topKeysSamples
      );
    }

    // 5. Uptime seconds (Gauge)
    output += this._metricBlock(
      'nextlimiter_uptime_seconds',
      'Seconds since limiter was created',
      'gauge',
      [{ labels: {}, value: stats.uptimeMs / 1000 }]
    );

    // 6. Info (Gauge = 1)
    const version = '1.0.5'; // Current pkg version
    output += this._metricBlock(
      'nextlimiter_info',
      'Static info about the limiter instance',
      'gauge',
      [{ labels: { strategy: stats.config.strategy, version }, value: 1 }]
    );

    return output;
  }
}

module.exports = { PrometheusFormatter };
