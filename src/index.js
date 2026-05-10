require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: true,   // reflect request origin — allows web, mobile, and native apps
  credentials: true,
}));

// Stripe webhook needs raw body — mount BEFORE express.json
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));

app.use('/api/auth',       require('./routes/auth'));
app.use('/api/profile',    require('./routes/profile'));
app.use('/api/signatures', require('./routes/signatures'));
app.use('/api/billing',    require('./routes/billing'));
app.use('/api/admin',      require('./routes/admin'));
app.use('/api/requests',   require('./routes/requests'));

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Generic error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => console.log(`iSigner API → http://localhost:${PORT}`));
