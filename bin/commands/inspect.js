'use strict';
const http = require('http');
const https = require('https');

function parseArgs() {
    const args = process.argv.slice(3);
    const options = { url: args[0] };
    
    if (!options.url || options.url.startsWith('-')) {
        console.error('Usage: npx nextlimiter inspect <url>');
        process.exit(1);
    }
    try { new URL(options.url); } catch(e) { console.error('Invalid URL'); process.exit(1); }
    return options;
}

module.exports = async function() {
    const opts = parseArgs();
    const parsed = new URL(opts.url);
    const lib = parsed.protocol === 'https:' ? https : http;
    
    return new Promise((resolve) => {
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            timeout: 10000
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
                const h = res.headers;
                const pad = (s, len=26) => String(s).padEnd(len);
                
                console.log(`┌─ nextlimiter inspect ──────────────────┐`);
                console.log(`│ URL:        ${pad(opts.url)} │`);
                console.log(`│ Status:     ${pad(res.statusCode + ' ' + http.STATUS_CODES[res.statusCode])} │`);
                
                if (h['x-ratelimit-limit']) console.log(`│ Limit:      ${pad(h['x-ratelimit-limit'])} │`);
                if (h['x-ratelimit-remaining']) console.log(`│ Remaining:  ${pad(h['x-ratelimit-remaining'])} │`);
                if (h['x-ratelimit-reset']) {
                    const date = new Date(parseInt(h['x-ratelimit-reset'], 10) * 1000);
                    const txt = !isNaN(date.getTime()) ? date.toISOString().replace('T', ' ').substring(0, 19) + ' UTC' : h['x-ratelimit-reset'];
                    console.log(`│ Reset:      ${pad(txt)} │`);
                }
                if (h['x-ratelimit-strategy']) console.log(`│ Strategy:   ${pad(h['x-ratelimit-strategy'])} │`);
                if (h['retry-after']) console.log(`│ Retry-After: ${pad(h['retry-after'] + ' seconds')} │`);
                
                const other = Object.keys(h).filter(k => k.startsWith('x-ratelimit-') && !['x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset','x-ratelimit-strategy'].includes(k));
                other.forEach(k => {
                    const v = typeof h[k] === 'string' ? h[k].substring(0, 26) : h[k];
                    const keyTxt = k.substring('x-ratelimit-'.length);
                    console.log(`│ ${String(keyTxt + ':').padEnd(11)} ${pad(v)} │`);
                });
                console.log(`└────────────────────────────────────────┘`);
                resolve();
            });
        });
        
        req.on('error', (err) => { console.error('Error fetching:', err.message); process.exit(1); resolve(); });
        req.on('timeout', () => { console.error('Request timed out'); process.exit(1); resolve(); });
        req.end();
    });
};
