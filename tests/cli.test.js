'use strict';
const https = require('https');
const testCmd = require('../bin/commands/test');
const benchmarkCmd = require('../bin/commands/benchmark');
const inspectCmd = require('../bin/commands/inspect');

describe('CLI Commands', () => {
    let mockReq;
    let oldArgv;
    let logs = [];
    let errs = [];

    beforeEach(() => {
        oldArgv = process.argv;
        logs = [];
        errs = [];
        jest.spyOn(console, 'log').mockImplementation(s => logs.push(s));
        jest.spyOn(console, 'error').mockImplementation(s => errs.push(s));
        jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
        
        mockReq = jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
            const res = new (require('events').EventEmitter)();
            res.statusCode = 200;
            res.headers = {
                'x-ratelimit-limit': '100',
                'x-ratelimit-remaining': '99',
                'x-ratelimit-strategy': 'sliding-window'
            };
            process.nextTick(() => {
                if(cb) cb(res);
                res.emit('data', 'chunk');
                res.emit('end');
            });
            return { on: jest.fn(), end: jest.fn(), destroy: jest.fn() };
        });
    });

    afterEach(() => {
        process.argv = oldArgv;
        jest.restoreAllMocks();
    });

    test('test command fires exactly --requests', async () => {
        process.argv = ['node', 'bin', 'test', 'https://example.com', '--requests', '5', '--json'];
        await testCmd();
        expect(mockReq).toHaveBeenCalledTimes(5);
        expect(logs.join('\n')).toContain('"total":5');
    });

    test('test command reads X-RateLimit-* correctly and counts allowed vs blocked', async () => {
        let calls = 0;
        mockReq.mockImplementation((opts, cb) => {
            calls++;
            const res = new (require('events').EventEmitter)();
            res.statusCode = calls > 2 ? 429 : 200;
            res.headers = {
                'x-ratelimit-limit': '2',
                'x-ratelimit-strategy': 'fixed-window',
                'retry-after': '5'
            };
            process.nextTick(() => {
                if(cb) cb(res);
                res.emit('end');
            });
            return { on: jest.fn(), end: jest.fn(), destroy: jest.fn() };
        });

        process.argv = ['node', 'bin', 'test', 'https://example.com', '--requests', '4', '--json'];
        await testCmd();
        expect(mockReq).toHaveBeenCalledTimes(4);
        const jsonOut = JSON.parse(logs[0]);
        expect(jsonOut.allowed).toBe(2);
        expect(jsonOut.blocked).toBe(2);
        expect(jsonOut.firstBlock).toBe(3);
        expect(jsonOut.blockStrategy).toBe('fixed-window');
    });

    test('invalid URL throws descriptive error and exits', async () => {
        process.argv = ['node', 'bin', 'test', 'not-a-url'];
        await expect(testCmd()).rejects.toThrow('process.exit');
        expect(errs.join('\n')).toContain('Invalid URL');
    });

    test('inspect prints all X-RateLimit-* headers', async () => {
        process.argv = ['node', 'bin', 'inspect', 'https://example.com'];
        await inspectCmd();
        const out = logs.join('\n');
        expect(out).toContain('URL:        https://example.com');
        expect(out).toContain('Status:     200 OK');
        expect(out).toContain('Limit:      100');
        expect(out).toContain('Remaining:  99');
        expect(out).toContain('Strategy:   sliding-window');
    });

    test('benchmark stops after --duration and computes p95/p99 correctly', async () => {
        jest.useFakeTimers();
        let i = 0;
        mockReq.mockImplementation((opts, cb) => {
            const res = new (require('events').EventEmitter)();
            res.statusCode = 200;
            const t0 = Date.now();
            setTimeout(() => { // Simulate varying delays
                if(cb) cb(res);
                res.emit('end');
            }, 10 + (i%5)); 
            i++;
            return { on: jest.fn(), end: jest.fn(), destroy: jest.fn() };
        });

        process.argv = ['node', 'bin', 'benchmark', '--url', 'https://example.com', '--duration', '2', '--concurrency', '2'];
        
        // Execute benchmark but we must fast-forward timers
        const promise = benchmarkCmd();
        
        // Let event loop process requests to build up throughput
        for (let j = 0; j < 50; j++) {
            await Promise.resolve();
            jest.advanceTimersByTime(50);
        }
        jest.advanceTimersByTime(2000); 

        await promise;
        jest.useRealTimers();
        
        const out = logs.join('\n');
        expect(out).toContain('Benchmark Results — https://example.com');
        expect(out).toMatch(/Total requests:\s+\d+/);
        expect(out).toMatch(/p95 latency:\s+\d+ms/);
        expect(out).toMatch(/p99 latency:\s+\d+ms/);
    });

    test('--help prints usage without crashing', () => {
        oldArgv = process.argv;
        process.argv = ['node', 'nextlimiter', '--help'];
        expect(() => { 
           // Run via require will crash since it calls exit, so we just check it
           jest.isolateModules(() => { require('../bin/nextlimiter'); });
        }).toThrow('process.exit');
        expect(logs.join('\n')).toContain('Usage: npx nextlimiter <command>');
    });

    test('--version prints version string matching package.json', () => {
        oldArgv = process.argv;
        process.argv = ['node', 'nextlimiter', '--version'];
        expect(() => { 
           jest.isolateModules(() => { require('../bin/nextlimiter'); });
        }).toThrow('process.exit');
        const pkg = require('../package.json');
        expect(logs.join('\n')).toContain('v' + pkg.version);
    });
    
    test('unknown command exits 1', () => {
        oldArgv = process.argv;
        process.argv = ['node', 'nextlimiter', 'fake-cmd'];
        expect(() => { 
           jest.isolateModules(() => { require('../bin/nextlimiter'); });
        }).toThrow('process.exit');
        expect(errs.join('\n')).toContain('Unknown command: fake-cmd');
    });
});
