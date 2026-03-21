'use strict';

// ANSI color codes — auto-disabled on non-TTY environments
const isTTY = process.stdout && process.stdout.isTTY;
const c = {
  reset:  isTTY ? '\x1b[0m'  : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  red:    isTTY ? '\x1b[31m' : '',
  green:  isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan:   isTTY ? '\x1b[36m' : '',
  gray:   isTTY ? '\x1b[90m' : '',
};

/**
 * Create a logger bound to a specific prefix and enabled flag.
 *
 * @param {string}  prefix  - e.g. '[NexLimit]'
 * @param {boolean} enabled - logging on/off
 * @returns {{ blocked, allowed, warn, info }}
 */
function createLogger(prefix, enabled) {
  if (!enabled) {
    return {
      blocked: () => {},
      allowed: () => {},
      warn:    () => {},
      info:    () => {},
    };
  }

  const tag = `${c.bold}${c.cyan}${prefix}${c.reset}`;
  const ts  = () => `${c.gray}${new Date().toISOString()}${c.reset}`;

  return {
    /**
     * Log a blocked request.
     * @param {string} key
     * @param {number} count
     * @param {number} limit
     * @param {string} strategy
     * @param {boolean} smart
     */
    blocked(key, count, limit, strategy, smart = false) {
      const smartTag = smart ? ` ${c.yellow}[smart]${c.reset}` : '';
      console.log(
        `${ts()} ${tag} ${c.red}BLOCKED${c.reset}${smartTag} ` +
        `${c.bold}${key}${c.reset} ` +
        `${c.red}(${count}/${limit})${c.reset} ` +
        `${c.dim}via ${strategy}${c.reset}`
      );
    },

    /**
     * Log an allowed request (only useful for debugging — off by default).
     */
    allowed(key, remaining, limit) {
      console.log(
        `${ts()} ${tag} ${c.green}ALLOWED${c.reset} ` +
        `${c.bold}${key}${c.reset} ` +
        `${c.dim}(${remaining}/${limit} remaining)${c.reset}`
      );
    },

    warn(message) {
      console.warn(`${ts()} ${tag} ${c.yellow}WARN${c.reset} ${message}`);
    },

    info(message) {
      console.log(`${ts()} ${tag} ${c.cyan}INFO${c.reset} ${message}`);
    },
  };
}

module.exports = { createLogger };
