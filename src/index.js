require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

app.use('/api/auth',       require('./routes/auth'));
app.use('/api/profile',    require('./routes/profile'));
app.use('/api/signatures', require('./routes/signatures'));

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Generic error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`SignEase API → http://localhost:${PORT}`));
