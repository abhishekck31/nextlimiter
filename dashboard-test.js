const express = require('express');
const { createLimiter } = require('./src/index');

const app = express();
const limiter = createLimiter({ max: 10, windowMs: 10000 });

app.use('/nextlimiter', limiter.dashboardMiddleware({
  password: 'admin', 
  refreshMs: 500
}));

app.use('/api', limiter.middleware());
app.get('/api/test', (req, res) => res.send('OK'));

app.listen(3001, () => {
  console.log('Dashboard running on http://localhost:3001/nextlimiter');
});
