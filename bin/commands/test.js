'use strict';
const http = require('http');
const https = require('https');

function parseArgs() {
    const args = process.argv.slice(3);
    const options = { url: args[0], requests: 110, concurrency: 1, method: 'GET', headers: {}, delay: 0, json: false };
    
    if (!options.url || options.url.startsWith('-')) {
        console.error('Usage: npx nextlimiter test <url> [options]');
        process.exit(1);
    }
    try { new URL(options.url); } catch(e) { console.error('Invalid URL'); process.exit(1); }

    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--requests') options.requests = parseInt(args[++i], 10);
        else if (args[i] === '--concurrency') options.concurrency = parseInt(args[++i], 10);
        else if (args[i] === '--method') options.method = args[++i];
        else if (args[i] === '--header') {
            const [k, v] = args[++i].split(':');
            if (k && v) options.headers[k.trim()] = v.trim();
        }
        else if (args[i] === '--delay') options.delay = parseInt(args[++i], 10);
        else if (args[i] === '--json') options.json = true;
    }
    return options;
}

function doRequest(targetUrl, method, headers) {
    return new Promise((resolve) => {
        const parsed = new URL(targetUrl);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method,
            headers,
            timeout: 10000
        }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                // simple redirect follow
                return resolve(doRequest(res.headers.location, method, headers));
            }
            res.on('data', () => {});
            res.on('end', () => resolve({
                status: res.statusCode,
                limit: res.headers['x-ratelimit-limit'],
                remaining: res.headers['x-ratelimit-remaining'],
                strategy: res.headers['x-ratelimit-strategy'],
                retryAfter: res.headers['retry-after'] || res.headers['x-ratelimit-reset'],
            }));
        });
        req.on('error', (err) => resolve({ error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }) });
        req.end();
    });
}

function delayBlock(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = async function() {
    const opts = parseArgs();
    const isTTY = process.stdout.isTTY;
    const cGreen = isTTY ? '\x1b[32m' : '';
    const cYellow = isTTY ? '\x1b[33m' : '';
    const cRed = isTTY ? '\x1b[31m' : '';
    const cReset = isTTY ? '\x1b[0m' : '';

    let allowed = 0, blocked = 0, blockStrategy = '', firstBlock = -1;

    for (let i = 1; i <= opts.requests; i += opts.concurrency) {
        const batch = [];
        for (let j = 0; j < opts.concurrency && (i + j) <= opts.requests; j++) {
            batch.push(doRequest(opts.url, opts.method, opts.headers));
        }
        
        const results = await Promise.all(batch);
        results.forEach((r, idx) => {
            const reqNum = i + idx;
            if (r.error) {
                if (!opts.json) console.log(`Request ${reqNum}: ${cRed}Error: ${r.error}${cReset}`);
                return;
            }
            if (r.status >= 200 && r.status < 300) {
                allowed++;
                if (!opts.json) console.log(`Request ${reqNum}:\t${cGreen}${r.status} OK${cReset} \t(remaining: ${r.remaining || '?'})`);
            } else if (r.status === 429) {
                blocked++;
                if (firstBlock === -1) firstBlock = reqNum;
                blockStrategy = blockStrategy || r.strategy || 'unknown';
                if (!opts.json) {
                    console.log(`Request ${reqNum}:\t${cYellow}429 Too Many Requests${cReset}`);
                    if (idx === batch.length-1) { // print extra details on last item in block batch
                       console.log(`  Retry-After:\t${r.retryAfter || '?'}`);
                       console.log(`  Strategy:\t${blockStrategy}`);
                       console.log(`  Limit:\t${r.limit || '?'}`);
                    }
                }
            } else {
                if (!opts.json) console.log(`Request ${reqNum}:\t${cRed}${r.status}${cReset}`);
            }
        });
        
        if (opts.delay) await delayBlock(opts.delay);
    }

    if (opts.json) {
        console.log(JSON.stringify({ total: opts.requests, allowed, blocked, firstBlock, blockStrategy }));
    } else {
        const pad = (s, len=31) => String(s).padEnd(len);
        console.log(`\n┌─────────────────────────────────┐`);
        console.log(`│ Total requests:     ${pad(opts.requests, 12)}│`);
        console.log(`│ Allowed:            ${pad(allowed, 12)}│`);
        console.log(`│ Blocked (429):      ${pad(blocked, 12)}│`);
        console.log(`│ Block rate:         ${pad(((blocked/opts.requests)*100).toFixed(2)+'%', 12)}│`);
        console.log(`│ First block at:     ${pad(firstBlock === -1 ? 'none' : 'request ' + firstBlock, 12)}│`);
        console.log(`│ Strategy detected:  ${pad(blockStrategy || 'N/A', 12)}│`);
        console.log(`└─────────────────────────────────┘`);
    }
};
