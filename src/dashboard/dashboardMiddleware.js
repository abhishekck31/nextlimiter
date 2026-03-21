'use strict';

const { Buffer } = require('buffer');
const { generateDashboardHTML } = require('./html');

function dashboardMiddleware(limiter, options = {}) {
  const mountPath = options.path || '/nextlimiter';
  const refreshMs = options.refreshMs || 2000;
  
  // Ring buffer for history (max 60 entries)
  const history = [];
  
  const historyInterval = setInterval(() => {
    history.push({ timestamp: Date.now(), stats: limiter.getStats() });
    if (history.length > 60) history.shift();
  }, refreshMs);
  if (historyInterval.unref) historyInterval.unref();

  return function(req, res, next) {
    const fullPath = req.originalUrl || req.url || '';
    if (!fullPath.startsWith(mountPath)) {
      return next();
    }

    if (options.password) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="nextlimiter dashboard"');
        res.statusCode = 401;
        return res.end('Unauthorized');
      }
      const b64 = authHeader.substring(6);
      const credentials = Buffer.from(b64, 'base64').toString();
      const matchPos = credentials.indexOf(':');
      const pass = matchPos >= 0 ? credentials.substring(matchPos + 1) : credentials;
      if (pass !== options.password) {
        res.setHeader('WWW-Authenticate', 'Basic realm="nextlimiter dashboard"');
        res.statusCode = 401;
        return res.end('Unauthorized');
      }
    }

    const subPath = fullPath.substring(fullPath.indexOf(mountPath) + mountPath.length).split('?')[0] || '/';

    if (req.method === 'GET' && (subPath === '/' || subPath === '')) {
      res.setHeader('Content-Type', 'text/html');
      res.statusCode = 200;
      return res.end(generateDashboardHTML({ refreshMs }));
    }

    if (req.method === 'GET' && subPath === '/api/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      return res.end(JSON.stringify(limiter.getStats()));
    }

    if (req.method === 'GET' && subPath === '/api/history') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      return res.end(JSON.stringify(history));
    }

    if (req.method === 'POST' && subPath.startsWith('/api/reset/')) {
       const keyToReset = decodeURIComponent(subPath.substring('/api/reset/'.length));
       limiter.resetKey(keyToReset);
       res.setHeader('Content-Type', 'application/json');
       res.statusCode = 200;
       return res.end(JSON.stringify({ success: true }));
    }

    if (req.method === 'GET' && subPath === '/api/stream') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.statusCode = 200;
      
      const sendData = () => {
        res.write(`data: ${JSON.stringify(limiter.getStats())}\n\n`);
      };
      
      const interval = setInterval(sendData, refreshMs);
      sendData(); // Send initial state immediately

      req.on('close', () => clearInterval(interval));
      return;
    }

    // 404 for unknown dashboard routes
    res.statusCode = 404;
    res.end('Not Found');
  };
}

module.exports = { dashboardMiddleware };
