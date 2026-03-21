'use strict';
const http = require('http');
const https = require('https');

function parseArgs() {
    const args = process.argv.slice(3);
    const options = { url: null, duration: 10, concurrency: 10, rps: 0 };
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url') options.url = args[++i];
        else if (args[i] === '--duration') options.duration = parseInt(args[++i], 10);
        else if (args[i] === '--concurrency') options.concurrency = parseInt(args[++i], 10);
        else if (args[i] === '--rps') options.rps = parseInt(args[++i], 10);
    }
    
    if (!options.url) {
        console.error('Usage: npx nextlimiter benchmark --url <url> [options]');
        process.exit(1);
    }
    return options;
}

function fetchTarget(targetUrl) {
    const t0 = Date.now();
    return new Promise((resolve) => {
        const parsed = new URL(targetUrl);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            timeout: 10000
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve({ t: Date.now() - t0, s: res.statusCode }));
        });
        req.on('error', () => resolve({ t: Date.now() - t0, s: 0 }));
        req.on('timeout', () => { req.destroy(); resolve({ t: Date.now() - t0, s: 0 }); });
        req.end();
    });
}

function calculatePercentile(arr, p) {
    if (arr.length === 0) return 0;
    arr.sort((a,b) => a - b);
    const idx = Math.floor(arr.length * p);
    return arr[idx];
}

function drawProgressBar(pct, text) {
    if (!process.stdout.isTTY) return;
    const cw = process.stdout.columns || 80;
    const meta = ` ${pct.toFixed(0)}% | ${text}`;
    const barLen = Math.max(10, cw - meta.length - 4);
    const filled = Math.floor(barLen * (pct / 100));
    const empty = barLen - filled;
    
    const bar = '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
    process.stdout.write(`\r${bar}${meta}`);
}

module.exports = async function() {
    const opts = parseArgs();
    console.log(`Benchmarking ${opts.url} for ${opts.duration} seconds with ${opts.concurrency} workers...`);

    const endAt = Date.now() + (opts.duration * 1000);
    let running = true;
    let totalReqs = 0, blocked = 0;
    const latencies = [];
    const codes = { 200: 0, 429: 0 };
    let intervalTimer;

    const worker = async () => {
        while (running && Date.now() < endAt) {
            const res = await fetchTarget(opts.url);
            totalReqs++;
            latencies.push(res.t);
            if (res.s === 429) { blocked++; codes[429] = (codes[429] || 0) + 1; }
            else if (res.s > 0) { codes[res.s] = (codes[res.s] || 0) + 1; }
            
            if (opts.rps > 0) {
                const sleepMs = 1000 / opts.rps;
                await new Promise(r => setTimeout(r, sleepMs));
            }
        }
    };

    const workers = [];
    for (let i = 0; i < opts.concurrency; i++) {
        workers.push(worker());
    }

    intervalTimer = setInterval(() => {
        const remaining = endAt - Date.now();
        if (remaining <= 0) return;
        const elapsed = (opts.duration * 1000) - remaining;
        const pct = Math.min(100, (elapsed / (opts.duration * 1000)) * 100);
        const avg = latencies.length > 0 ? Math.round(latencies.reduce((a,b)=>a+b, 0) / latencies.length) : 0;
        drawProgressBar(pct, `${totalReqs} req | ${blocked} blocked | ${avg}ms avg \x1b[K`);
    }, 500);

    await Promise.all(workers);
    clearInterval(intervalTimer);
    if (process.stdout.isTTY) process.stdout.write('\n\n');

    const durationSec = opts.duration;
    const throughput = (totalReqs / durationSec).toFixed(1);
    const blockPct = totalReqs > 0 ? ((blocked / totalReqs) * 100).toFixed(2) : '0.00';
    const avgLat = totalReqs > 0 ? Math.round(latencies.reduce((a,b)=>a+b,0) / latencies.length) : 0;
    const p95 = calculatePercentile(latencies, 0.95);
    const p99 = calculatePercentile(latencies, 0.99);
    
    let codesText = Object.entries(codes).filter(([_,v])=>v>0).map(([k,v])=>`${k}: ${v}`).join(', ');
    
    console.log(`Benchmark Results — ${opts.url}`);
    console.log(`Duration:        ${durationSec.toFixed(1)}s`);
    console.log(`Total requests:  ${totalReqs}`);
    console.log(`Req/sec:         ${throughput}`);
    console.log(`Blocked:         ${blocked} (${blockPct}%)`);
    console.log(`Avg latency:     ${avgLat}ms`);
    console.log(`p95 latency:     ${p95}ms`);
    console.log(`p99 latency:     ${p99}ms`);
    console.log(`Status codes:    ${codesText}`);
};
