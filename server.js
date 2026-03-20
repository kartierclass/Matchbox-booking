const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');
const bookingsRouter = require('./routes/bookings');
const membersRouter = require('./routes/members');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
}));
app.use(express.json());

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// Routes
app.use('/api', bookingsRouter);
app.use('/api/members', membersRouter);

// Auto-clean expired locks every 5 minutes
const { pool } = require('./db');
setInterval(async () => {
  try {
    const { rowCount } = await pool.query('DELETE FROM slot_locks WHERE expires_at < NOW()');
    if (rowCount > 0) console.log(`🧹 Cleared ${rowCount} expired lock(s)`);
  } catch (err) {
    console.error('Lock cleanup error:', err.message);
  }
}, 5 * 60 * 1000);

// Start
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`⚡ Match-Box API running on port ${PORT}`);
  });
});
