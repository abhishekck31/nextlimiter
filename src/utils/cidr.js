'use strict';

/**
 * CIDR IP matching utilities — zero dependencies, pure bitwise arithmetic.
 * Works in any runtime: Node.js, Cloudflare Workers, Deno, Bun, Edge.
 *
 * No Buffer, no `net` module, no external libraries.
 */

/**
 * Convert an IPv4 dotted-decimal string to a 32-bit unsigned integer.
 *
 * @param {string} ip - e.g. '192.168.1.50'
 * @returns {number} 32-bit unsigned integer
 * @throws {Error} if the string is not a valid IPv4 address
 *
 * @example
 * ipToInt('1.2.3.4') // → 16909060
 * ipToInt('0.0.0.0') // → 0
 * ipToInt('255.255.255.255') // → 4294967295
 */
function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) {
    throw new Error(`[NextLimiter] Invalid IPv4 address: "${ip}"`);
  }
  let result = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (isNaN(octet) || octet < 0 || octet > 255 || String(octet) !== part.trim()) {
      throw new Error(`[NextLimiter] Invalid IPv4 octet "${part}" in address "${ip}"`);
    }
    result = ((result << 8) | octet) >>> 0;
  }
  return result >>> 0; // ensure unsigned
}

/**
 * Convert a CIDR string (or plain IP) to a { networkInt, maskInt } range.
 *
 * - '10.0.0.0/8'  → { networkInt: 167772160, maskInt: 4278190080 }
 * - '1.2.3.4'     → treated as /32 (exact match only)
 *
 * @param {string} cidr - e.g. '192.168.1.0/24' or '1.2.3.4'
 * @returns {{ networkInt: number, maskInt: number }}
 * @throws {Error} on invalid CIDR
 *
 * @example
 * cidrToRange('10.0.0.0/8')
 * // → { networkInt: 167772160, maskInt: 4278190080 }
 *
 * cidrToRange('192.168.1.0/24')
 * // → { networkInt: 3232235776, maskInt: 4294967040 }
 */
function cidrToRange(cidr) {
  const slashIdx = String(cidr).indexOf('/');

  if (slashIdx === -1) {
    // Plain IP — treat as /32
    const networkInt = ipToInt(cidr);
    return { networkInt, maskInt: 0xFFFFFFFF >>> 0 };
  }

  const ip     = cidr.slice(0, slashIdx);
  const prefix = parseInt(cidr.slice(slashIdx + 1), 10);

  if (isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`[NextLimiter] Invalid CIDR prefix in "${cidr}"`);
  }

  // Build the subnet mask: ( all 1s ) left-shifted by (32 - prefix), force unsigned
  // Special case: prefix 0 → mask is 0 (matches everything)
  const maskInt    = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  const networkInt = (ipToInt(ip) & maskInt) >>> 0;

  return { networkInt, maskInt };
}

/**
 * Check whether an IP address falls within a CIDR range (or matches a plain IP).
 *
 * @param {string} ip   - e.g. '10.0.1.5'
 * @param {string} cidr - e.g. '10.0.0.0/8' or '10.0.1.5'
 * @returns {boolean}
 *
 * @example
 * ipMatchesCidr('10.0.1.5',    '10.0.0.0/8')       // → true
 * ipMatchesCidr('192.168.1.50','192.168.1.0/24')    // → true
 * ipMatchesCidr('1.2.3.4',     '1.2.3.4')           // → true  (exact /32)
 * ipMatchesCidr('1.2.3.5',     '1.2.3.4')           // → false
 * ipMatchesCidr('172.0.0.1',   '10.0.0.0/8')        // → false
 */
function ipMatchesCidr(ip, cidr) {
  try {
    const ipInt = ipToInt(ip);
    const range = cidrToRange(cidr);
    return ((ipInt & range.maskInt) >>> 0) === range.networkInt;
  } catch {
    // Any parse failure → conservative answer: not a match
    return false;
  }
}

/**
 * Check whether an IP matches ANY entry in a list of IPs or CIDR ranges.
 *
 * @param {string}   ip   - Client IP to test
 * @param {string[]} list - Array of IPs or CIDR strings
 * @returns {boolean} true if ip matches at least one entry
 *
 * @example
 * ipMatchesList('10.0.5.5', ['10.0.0.0/8', '192.168.1.1'])  // → true
 * ipMatchesList('11.0.0.1', ['10.0.0.0/8'])                 // → false
 * ipMatchesList('1.2.3.4',  [])                              // → false
 */
function ipMatchesList(ip, list) {
  if (!list || list.length === 0) {return false;}
  for (const entry of list) {
    if (ipMatchesCidr(ip, entry)) {return true;}
  }
  return false;
}

module.exports = { ipToInt, cidrToRange, ipMatchesCidr, ipMatchesList };

// ── Inline test cases (run with node src/utils/cidr.js) ──────────────────────
//
// ipMatchesCidr('10.0.1.5',    '10.0.0.0/8')        → true
// ipMatchesCidr('192.168.1.50','192.168.1.0/24')     → true
// ipMatchesCidr('1.2.3.4',     '1.2.3.4')            → true  (exact /32)
// ipMatchesCidr('1.2.3.5',     '1.2.3.4')            → false
// ipMatchesCidr('172.0.0.1',   '10.0.0.0/8')         → false
// ipMatchesList('10.0.5.5',    ['10.0.0.0/8'])        → true
// ipMatchesList('11.0.0.1',    ['10.0.0.0/8'])        → false
// ipMatchesList('5.6.1.1',     ['5.6.0.0/16'])        → true
// ipMatchesList('5.7.0.1',     ['5.6.0.0/16'])        → false
