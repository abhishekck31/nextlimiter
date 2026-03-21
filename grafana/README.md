# NextLimiter Grafana & Prometheus Integration

NextLimiter provides a built-in, zero-dependency Prometheus exposition formatter. You don't need `prom-client` or any other external libraries to expose metrics.

## 1. Expose the Metrics Endpoint

Use the built-in `metricsHandler()` or `metricsMiddleware()` on your NextLimiter instance.

```js
const express = require('express');
const { createLimiter } = require('nextlimiter');

const app = express();
const limiter = createLimiter({ max: 100 });

// Apply rate limiter to your API
app.use('/api', limiter.middleware());

// Option A: Specific metric endpoint
app.get('/metrics', limiter.metricsHandler());

// Option B: Mount globally (automatically registers GET /metrics)
// app.use(limiter.metricsMiddleware());

app.listen(3000);
```

## 2. Configure Prometheus

Add your Node.js application to your `prometheus.yml` scrape configuration.

```yaml
scrape_configs:
  - job_name: 'nextlimiter'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
    scrape_interval: 10s
```

## 3. Import Dashboard into Grafana

A pre-built dashboard template is available in this package.

1. Open Grafana and go to **Dashboards** → **New** → **Import**.
2. Click **Upload JSON file** or copy/paste the contents.
3. Select your `dashboard.json` file from the `grafana/` folder.
4. Select your Prometheus Data Source when prompted.
5. Click **Import**.

The dashboard includes:
- Total & Blocked Requests count
- Current Block Rate
- Uptime
- Request Rate timeseries (Allowed vs Blocked)
- Top Blocked IPs (Top 10)
- Top Request Volumes by Key (Top 10)
