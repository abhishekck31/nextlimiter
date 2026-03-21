'use strict';

const request = require('supertest');
const express = require('express');
const { createLimiter } = require('../src/index');

describe('Live Dashboard UI', () => {

    test('GET / returns 200 with text/html content type', async () => {
        const app = express();
        const limiter = createLimiter({ max: 100 });
        app.use(limiter.dashboardMiddleware());

        const res = await request(app).get('/nextlimiter/');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.text).toContain('nextlimiter dashboard');
    });

    test('GET /api/stats returns valid JSON matching getStats() shape', async () => {
        const app = express();
        const limiter = createLimiter({ max: 100 });
        app.use(limiter.dashboardMiddleware());

        await limiter.check('test-api');

        const res = await request(app).get('/nextlimiter/api/stats');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        
        const stats = JSON.parse(res.text);
        expect(stats.totalRequests).toBe(1);
        expect(stats.blockedRequests).toBe(0);
        expect(stats.blockRate).toBe(0);
        expect(Array.isArray(stats.topKeys)).toBe(true);
        expect(stats.topKeys.length).toBe(1);
        expect(stats.topKeys[0].key).toContain('test-api');
    });

    test('GET /api/history returns array of items', async () => {
        jest.useFakeTimers();
        const app = express();
        const limiter = createLimiter({ max: 100 });
        const mw = limiter.dashboardMiddleware({ refreshMs: 1000 });
        app.use(mw);

        jest.advanceTimersByTime(2000); // 2 ticks

        const res = await request(app).get('/nextlimiter/api/history');
        expect(res.statusCode).toBe(200);
        
        const history = JSON.parse(res.text);
        expect(history.length).toBeGreaterThanOrEqual(1);
        expect(history[0]).toHaveProperty('timestamp');
        expect(history[0]).toHaveProperty('stats');
        
        jest.useRealTimers();
    });

    test('POST /api/reset/:key calls limiter.resetKey with decoded key', async () => {
        const app = express();
        const limiter = createLimiter({ max: 1, strategy: 'sliding-window-log' });
        app.use(limiter.dashboardMiddleware());

        await limiter.check('my key space'); // space encoded as %20
        await limiter.check('my key space'); // hit limit
        expect(limiter.getStats().blockedRequests).toBe(1);

        const res = await request(app).post('/nextlimiter/api/reset/my%20key%20space');
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.text).success).toBe(true);

        const allowed = await limiter.check('my key space');
        expect(allowed.allowed).toBe(true); // reset correctly!
    });

    test('With password set: GET / without auth returns 401', async () => {
        const app = express();
        const limiter = createLimiter({ max: 100 });
        app.use(limiter.dashboardMiddleware({ password: 'secretpassword' }));

        const res = await request(app).get('/nextlimiter/');
        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Basic realm="nextlimiter dashboard"');
        expect(res.text).toBe('Unauthorized');
    });

    test('With password set: GET / with correct Basic auth returns 200', async () => {
        const app = express();
        const limiter = createLimiter({ max: 100 });
        app.use(limiter.dashboardMiddleware({ password: 'secretpassword' }));

        const authBuffer = Buffer.from('admin:secretpassword').toString('base64');

        const res = await request(app)
            .get('/nextlimiter/')
            .set('Authorization', 'Basic ' + authBuffer);
            
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('nextlimiter dashboard');
    });

    test('With password set: wrong password returns 401', async () => {
        const app = express();
        const limiter = createLimiter({ max: 100 });
        app.use(limiter.dashboardMiddleware({ password: 'secretpassword' }));

        const authBuffer = Buffer.from('admin:wrongpassword').toString('base64');

        const res = await request(app)
            .get('/nextlimiter/')
            .set('Authorization', 'Basic ' + authBuffer);
            
        expect(res.statusCode).toBe(401);
    });

    test('GET /api/stream sets correct SSE headers', (done) => {
        const app = express();
        const limiter = createLimiter({ max: 100 });
        app.use(limiter.dashboardMiddleware());

        const server = app.listen(0, () => {
            const port = server.address().port;
            const http = require('http');
            http.get(`http://localhost:${port}/nextlimiter/api/stream`, (res) => {
                expect(res.statusCode).toBe(200);
                expect(res.headers['content-type']).toBe('text/event-stream');
                res.destroy();
                server.close(done);
            });
        });
    });

    test('dashboardMiddleware() is a function on limiter instance', () => {
        const limiter = createLimiter({ max: 100 });
        expect(typeof limiter.dashboardMiddleware).toBe('function');
    });
});
