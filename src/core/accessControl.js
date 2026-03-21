'use strict';

const { ipMatchesList } = require('../utils/cidr');

/**
 * Access control check — evaluated BEFORE rate limiting.
 *
 * Precedence: blacklist > whitelist > allow
 *
 * @param {string} ip     - Client's real IP address
 * @param {object} config - Resolved NextLimiter config
 * @returns {{ action: 'allow'|'block'|'skip', reason: string }}
 *
 * @example
 * checkAccess('5.6.1.1', { blacklist: ['5.6.0.0/16'] })
 * // → { action: 'block', reason: 'blacklisted' }
 *
 * checkAccess('10.0.5.5', { whitelist: ['10.0.0.0/8'] })
 * // → { action: 'skip', reason: 'whitelisted' }
 *
 * checkAccess('1.2.3.4', {})
 * // → { action: 'allow', reason: 'proceed' }
 */
function checkAccess(ip, config) {
  // Blacklist wins — always checked first regardless of whitelist
  if (config.blacklist && ipMatchesList(ip, config.blacklist)) {
    return { action: 'block', reason: 'blacklisted' };
  }

  // Whitelist — bypass all rate limiting
  if (config.whitelist && ipMatchesList(ip, config.whitelist)) {
    return { action: 'skip', reason: 'whitelisted' };
  }

  return { action: 'allow', reason: 'proceed' };
}

module.exports = { checkAccess };
