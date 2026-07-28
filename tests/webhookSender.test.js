'use strict';

const https  = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebhookSender } = require('../src/webhook/sender');

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeMockRequest({ statusCode = 200, shouldError = false, shouldTimeout = false } = {}) {
  const req = {
    on:         jest.fn(),
    setTimeout: jest.fn(),
    write:      jest.fn(),
    end:        jest.fn(),
    destroy:    jest.fn(),
  };

  const mockImpl = (opts, cb) => {
    if (shouldError) {
      // Network error path: emit error, never call the response callback
      process.nextTick(() => {
        const errorHandler = req.on.mock.calls.find(([event]) => event === 'error');
        if (errorHandler) errorHandler[1](new Error('ECONNREFUSED'));
      });
    } else if (shouldTimeout) {
      // Timeout path: trigger the timeout callback, never call response callback
      process.nextTick(() => {
        const timeoutHandler = req.setTimeout.mock.calls[0]?.[1];
        if (timeoutHandler) timeoutHandler();
      });
    } else {
      // Happy path
      const res = new EventEmitter();
      res.statusCode = statusCode;
      process.nextTick(() => {
        cb(res);
        res.emit('data', '{"ok":true}');
        res.emit('end');
      });
    }

    return req;
  };

  return { req, mockImpl };
}

// ── Basic send ────────────────────────────────────────────────────────────────

describe('WebhookSender — basic send', () => {
  let spy;
  afterEach(() => spy && spy.mockRestore());

  test('send() calls https.request with correct POST options', async () => {
    const { req, mockImpl } = makeMockRequest();
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const sender = new WebhookSender({ webhook: 'https://example.com/hook' });
    sender.send({ event: 'blocked' });

    // Give the fire-and-forget promise time to resolve
    await new Promise(r => setTimeout(r, 20));

    expect(spy).toHaveBeenCalledTimes(1);
    const [options] = spy.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.hostname).toBe('example.com');
    expect(options.path).toBe('/hook');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  test('send() serialises payload as JSON in the request body', async () => {
    const { req, mockImpl } = makeMockRequest();
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const sender  = new WebhookSender({ webhook: 'https://example.com/hook' });
    const payload = { event: 'blocked', key: 'ip:1.2.3.4', limit: 10 };
    sender.send(payload);
    await new Promise(r => setTimeout(r, 20));

    const body = JSON.parse(req.write.mock.calls[0][0]);
    expect(body).toEqual(payload);
  });

  test('send() resolves without throwing even when the server returns non-2xx', async () => {
    const { mockImpl } = makeMockRequest({ statusCode: 500 });
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const sender = new WebhookSender({
      webhook: 'https://example.com/hook',
      webhookRetries: 0,
    });

    // fire-and-forget — must not throw / reject
    await expect(sender.send({ event: 'blocked' })).resolves.toBeUndefined();
    await new Promise(r => setTimeout(r, 20));
  });
});

// ── HMAC signature ────────────────────────────────────────────────────────────

describe('WebhookSender — HMAC signature', () => {
  let spy;
  afterEach(() => spy && spy.mockRestore());

  test('adds X-nextlimiter-signature header when webhookSecret is set', async () => {
    const { req, mockImpl } = makeMockRequest();
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const secret = 'super-secret';
    const sender = new WebhookSender({ webhook: 'https://example.com/hook', webhookSecret: secret });
    sender.send({ event: 'test' });
    await new Promise(r => setTimeout(r, 20));

    const [options] = spy.mock.calls[0];
    expect(options.headers['X-nextlimiter-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  test('HMAC signature is correct sha256 of the serialised body', async () => {
    const { req, mockImpl } = makeMockRequest();
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const secret  = 'my-secret';
    const payload = { event: 'blocked', count: 5 };
    const sender  = new WebhookSender({ webhook: 'https://example.com/hook', webhookSecret: secret });
    sender.send(payload);
    await new Promise(r => setTimeout(r, 20));

    const body     = req.write.mock.calls[0][0];
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const [options] = spy.mock.calls[0];
    expect(options.headers['X-nextlimiter-signature']).toBe(expected);
  });

  test('does NOT add signature header when webhookSecret is absent', async () => {
    const { mockImpl } = makeMockRequest();
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const sender = new WebhookSender({ webhook: 'https://example.com/hook' });
    sender.send({ event: 'test' });
    await new Promise(r => setTimeout(r, 20));

    const [options] = spy.mock.calls[0];
    expect(options.headers['X-nextlimiter-signature']).toBeUndefined();
  });
});

// ── Retry logic ───────────────────────────────────────────────────────────────

describe('WebhookSender — retry logic', () => {
  let spy;
  afterEach(() => spy && spy.mockRestore());

  test('retries the configured number of times on failure', async () => {
    let attempt = 0;
    spy = jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
      attempt++;
      const res = new EventEmitter();
      // Fail first two times, succeed on third
      res.statusCode = attempt < 3 ? 500 : 200;
      const req = { on: jest.fn(), setTimeout: jest.fn(), write: jest.fn(), end: jest.fn() };
      process.nextTick(() => { cb(res); res.emit('data', ''); res.emit('end'); });
      return req;
    });

    const sender = new WebhookSender({
      webhook: 'https://example.com/hook',
      webhookRetries: 3,
      webhookBackoff: 'fixed',
    });

    // Override _getInitialDelay to use 1 ms for faster tests
    sender._getInitialDelay = () => 1;
    sender._getNextDelay    = () => 1;

    sender.send({ event: 'blocked' });
    await new Promise(r => setTimeout(r, 100));

    expect(attempt).toBe(3); // failed twice, succeeded on third
  }, 10_000);

  test('webhookRetries:0 means no retries — fails immediately', async () => {
    let attempt = 0;
    spy = jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
      attempt++;
      const res = new EventEmitter();
      res.statusCode = 500;
      const req = { on: jest.fn(), setTimeout: jest.fn(), write: jest.fn(), end: jest.fn() };
      process.nextTick(() => { cb(res); res.emit('data', ''); res.emit('end'); });
      return req;
    });

    const sender = new WebhookSender({
      webhook: 'https://example.com/hook',
      webhookRetries: 0,
    });
    sender.send({ event: 'blocked' });
    await new Promise(r => setTimeout(r, 30));

    expect(attempt).toBe(1);
  });
});

// ── Back-off strategies ───────────────────────────────────────────────────────

describe('WebhookSender — back-off strategies', () => {
  let sender;

  test('exponential: initial delay is 100ms', () => {
    sender = new WebhookSender({ webhook: 'https://x.com', webhookBackoff: 'exponential' });
    expect(sender._getInitialDelay()).toBe(100);
  });

  test('exponential: each delay doubles', () => {
    sender = new WebhookSender({ webhook: 'https://x.com', webhookBackoff: 'exponential' });
    expect(sender._getNextDelay(100)).toBe(200);
    expect(sender._getNextDelay(200)).toBe(400);
  });

  test('linear: initial delay is 1000ms', () => {
    sender = new WebhookSender({ webhook: 'https://x.com', webhookBackoff: 'linear' });
    expect(sender._getInitialDelay()).toBe(1000);
  });

  test('linear: each delay increases by 1000ms', () => {
    sender = new WebhookSender({ webhook: 'https://x.com', webhookBackoff: 'linear' });
    expect(sender._getNextDelay(1000)).toBe(2000);
    expect(sender._getNextDelay(2000)).toBe(3000);
  });

  test('fixed: initial delay is 1000ms', () => {
    sender = new WebhookSender({ webhook: 'https://x.com', webhookBackoff: 'fixed' });
    expect(sender._getInitialDelay()).toBe(1000);
  });

  test('fixed: delay never changes', () => {
    sender = new WebhookSender({ webhook: 'https://x.com', webhookBackoff: 'fixed' });
    expect(sender._getNextDelay(1000)).toBe(1000);
    expect(sender._getNextDelay(500)).toBe(500);
  });
});

// ── Timeout handling ──────────────────────────────────────────────────────────

describe('WebhookSender — timeout', () => {
  let spy;
  afterEach(() => spy && spy.mockRestore());

  test('sets a request timeout equal to webhookTimeout', async () => {
    const { req, mockImpl } = makeMockRequest();
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const sender = new WebhookSender({
      webhook: 'https://example.com/hook',
      webhookTimeout: 3000,
    });
    sender.send({ event: 'test' });
    await new Promise(r => setTimeout(r, 20));

    expect(req.setTimeout).toHaveBeenCalledWith(3000, expect.any(Function));
  });
});

// ── _makeRequest() ───────────────────────────────────────────────────────────

describe('WebhookSender — _makeRequest()', () => {
  let spy;
  afterEach(() => spy && spy.mockRestore());

  test('resolves with statusCode and body on 2xx', async () => {
    const { mockImpl } = makeMockRequest({ statusCode: 201 });
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const sender = new WebhookSender({ webhook: 'https://example.com/hook' });
    const result = await sender._makeRequest({ event: 'ok' });
    expect(result.statusCode).toBe(201);
    expect(result.body).toBe('{"ok":true}');
  });

  test('rejects with descriptive error on non-2xx', async () => {
    const { mockImpl } = makeMockRequest({ statusCode: 403 });
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const sender = new WebhookSender({ webhook: 'https://example.com/hook' });
    await expect(sender._makeRequest({ event: 'fail' })).rejects.toThrow('Webhook failed with status: 403');
  });

  test('rejects on network error', async () => {
    const { mockImpl } = makeMockRequest({ shouldError: true });
    spy = jest.spyOn(https, 'request').mockImplementation(mockImpl);

    const sender = new WebhookSender({ webhook: 'https://example.com/hook' });
    await expect(sender._makeRequest({ event: 'fail' })).rejects.toThrow('ECONNREFUSED');
  });
});
