const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');

// ── MEMBER LOGIN ─────────────────────────────────────────
// POST /api/members/login
router.post('/login', async (req, res) => {
  const { invite_code } = req.body;
  if (!invite_code) return res.status(400).json({ error: 'Invite code required' });

  try {
    const { rows } = await pool.query(
      'SELECT id, name, phone, balance, created_at FROM members WHERE invite_code = $1 AND is_active = true',
      [invite_code.trim().toUpperCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid invite code' });
    res.json({ member: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MEMBER PROFILE ────────────────────────────────────────
// GET /api/members/:id
router.get('/:id', async (req, res) => {
  try {
    // Get member details
    const memberRes = await pool.query(
      'SELECT id, name, phone, balance, created_at FROM members WHERE id = $1 AND is_active = true',
      [req.params.id]
    );
    if (!memberRes.rows.length) return res.status(404).json({ error: 'Member not found' });
    const member = memberRes.rows[0];

    // Get booking history
    const bookingsRes = await pool.query(`
      SELECT
        b.id, b.ref_code, b.booking_date, b.status, b.court_type,
        b.total_amount, b.created_at,
        t.name AS turf_name, t.location,
        s.sport,
        TO_CHAR(s.start_time, 'HH12:MI AM') AS start_time,
        TO_CHAR(s.end_time, 'HH12:MI AM') AS end_time
      FROM bookings b
      JOIN turfs t ON t.id = b.turf_id
      JOIN slots s ON s.id = b.slot_id
      WHERE b.member_id = $1
      ORDER BY b.created_at DESC
      LIMIT 50
    `, [req.params.id]);

    // Get wallet transactions
    const txRes = await pool.query(`
      SELECT id, type, amount, reference, note, created_at
      FROM wallet_transactions
      WHERE member_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.params.id]);

    res.json({
      member,
      bookings: bookingsRes.rows,
      transactions: txRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TOPUP STUB ────────────────────────────────────────────
// POST /api/members/:id/topup
router.post('/:id/topup', async (req, res) => {
  // Razorpay integration placeholder — plug in when account is ready
  res.json({
    stub: true,
    message: 'Payment coming soon — contact admin to top up your wallet.',
  });
});

// ── RAZORPAY WEBHOOK STUB ─────────────────────────────────
// POST /api/members/razorpay/webhook
router.post('/razorpay/webhook', async (req, res) => {
  // TODO: verify Razorpay signature, credit wallet
  res.json({ received: true });
});

// ── ADMIN: LIST ALL MEMBERS ───────────────────────────────
// GET /api/admin/members
router.get('/admin/members', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        m.id, m.name, m.phone, m.invite_code, m.balance, m.is_active, m.created_at,
        COALESCE(SUM(CASE WHEN wt.type = 'topup' THEN wt.amount ELSE 0 END), 0) AS total_topped_up,
        COUNT(DISTINCT b.id) AS total_bookings,
        MAX(b.created_at) AS last_booking
      FROM members m
      LEFT JOIN wallet_transactions wt ON wt.member_id = m.id
      LEFT JOIN bookings b ON b.member_id = m.id AND b.status != 'cancelled'
      GROUP BY m.id
      ORDER BY m.balance ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: CREATE MEMBER ──────────────────────────────────
// POST /api/admin/members
router.post('/admin/members', async (req, res) => {
  const { name, phone, invite_code, initial_balance } = req.body;
  if (!name || !phone || !invite_code) {
    return res.status(400).json({ error: 'Name, phone and invite code are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO members (id, name, phone, invite_code, balance)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, phone, invite_code, balance`,
      [uuidv4(), name, phone, invite_code.toUpperCase(), parseFloat(initial_balance) || 0]
    );

    if (parseFloat(initial_balance) > 0) {
      await client.query(
        `INSERT INTO wallet_transactions (id, member_id, type, amount, note)
         VALUES ($1, $2, 'topup', $3, 'Initial balance')`,
        [uuidv4(), rows[0].id, parseFloat(initial_balance)]
      );
    }

    await client.query('COMMIT');
    res.json({ member: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Invite code already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── ADMIN: ADJUST BALANCE ─────────────────────────────────
// POST /api/admin/members/:id/adjust
router.post('/admin/members/:id/adjust', async (req, res) => {
  const { amount, note } = req.body;
  if (!amount || isNaN(parseFloat(amount))) {
    return res.status(400).json({ error: 'Valid amount required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const adj = parseFloat(amount);
    const type = adj >= 0 ? 'topup' : 'deduction';

    await client.query(
      'UPDATE members SET balance = balance + $1 WHERE id = $2',
      [adj, req.params.id]
    );

    await client.query(
      `INSERT INTO wallet_transactions (id, member_id, type, amount, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), req.params.id, type, Math.abs(adj), note || 'Manual adjustment by admin']
    );

    const { rows } = await client.query(
      'SELECT id, name, balance FROM members WHERE id = $1',
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, member: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── ADMIN: MEMBER TRANSACTION HISTORY ────────────────────
// GET /api/admin/members/:id/history
router.get('/admin/members/:id/history', async (req, res) => {
  try {
    const memberRes = await pool.query(
      'SELECT id, name, phone, balance, invite_code FROM members WHERE id = $1',
      [req.params.id]
    );
    if (!memberRes.rows.length) return res.status(404).json({ error: 'Member not found' });

    const txRes = await pool.query(`
      SELECT id, type, amount, reference, note, created_at
      FROM wallet_transactions WHERE member_id = $1
      ORDER BY created_at DESC
    `, [req.params.id]);

    const bookingsRes = await pool.query(`
      SELECT
        b.id, b.ref_code, b.booking_date, b.status, b.court_type,
        b.total_amount, b.created_at,
        t.location, s.sport,
        TO_CHAR(s.start_time, 'HH12:MI AM') AS start_time,
        TO_CHAR(s.end_time, 'HH12:MI AM') AS end_time
      FROM bookings b
      JOIN turfs t ON t.id = b.turf_id
      JOIN slots s ON s.id = b.slot_id
      WHERE b.member_id = $1
      ORDER BY b.created_at DESC
    `, [req.params.id]);

    res.json({
      member: memberRes.rows[0],
      transactions: txRes.rows,
      bookings: bookingsRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
