'use strict';
const https = require('https');
const crypto = require('crypto');

class WebhookSender {
  constructor(config = {}) {
    this.webhook = config.webhook;
    this.webhookRetries = config.webhookRetries !== undefined ? config.webhookRetries : 3;
    this.webhookBackoff = config.webhookBackoff || 'exponential';
    this.webhookTimeout = config.webhookTimeout || 5000;
    this.webhookSecret = config.webhookSecret;
  }

  async send(payload) {
    // Fire-and-forget
    this._sendWithRetry(payload, this.webhookRetries, this._getInitialDelay()).catch(() => {
      // Intentionally swallow errors — background fire and forget
    });
  }

  async _sendWithRetry(payload, attemptsLeft, delayMs) {
    try {
      await this._makeRequest(payload);
    } catch (err) {
      if (attemptsLeft > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        const nextDelay = this._getNextDelay(delayMs);
        await this._sendWithRetry(payload, attemptsLeft - 1, nextDelay);
      } else {
        throw err;
      }
    }
  }

  _getInitialDelay() {
    if (this.webhookBackoff === 'linear' || this.webhookBackoff === 'fixed') return 1000;
    return 100; // exponential
  }

  _getNextDelay(currentDelay) {
    if (this.webhookBackoff === 'linear') return currentDelay + 1000;
    if (this.webhookBackoff === 'exponential') return currentDelay * 2;
    return currentDelay; // fixed
  }

  _makeRequest(payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const urlObj = new URL(this.webhook);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      if (this.webhookSecret) {
        const sig = crypto.createHmac('sha256', this.webhookSecret).update(body).digest('hex');
        options.headers['X-nextlimiter-signature'] = `sha256=${sig}`;
      }

      // We only support https natively as per requirement, though http objects won't crash here they just might fail protocol
      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', chunk => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: responseBody });
          } else {
            reject(new Error(`Webhook failed with status: ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => reject(err));
      
      req.setTimeout(this.webhookTimeout, () => {
        req.destroy();
        reject(new Error(`Webhook timed out after ${this.webhookTimeout}ms`));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { WebhookSender };
