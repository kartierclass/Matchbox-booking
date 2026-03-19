const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');

// Generate readable ref code
function genRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'MBM-';
  for (let i = 0; i < 6; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}

// Format time for display: 06:00:00 -> 6AM
function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 || 12;
  return m === 0 ? `${hour}${ampm}` : `${hour}:${m.toString().padStart(2,'0')}${ampm}`;
}

// GET /api/turfs
router.get('/turfs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, location, address FROM turfs WHERE is_active = true ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/slots?turf_id=&sport=&date=
router.get('/slots', async (req, res) => {
  const { turf_id, sport, date, court_type } = req.query;
  if (!turf_id || !sport || !date) {
    return res.status(400).json({ error: 'turf_id, sport, and date are required' });
  }

  try {
    // Clean expired locks
    await pool.query('DELETE FROM slot_locks WHERE expires_at < NOW()');

    const { rows } = await pool.query(`
      SELECT
        s.id,
        s.sport,
        s.court_type,
        s.start_time,
        s.end_time,
        s.price,
        CASE
          WHEN b.id IS NOT NULL THEN 'booked'
          WHEN l.id IS NOT NULL THEN 'held'
          ELSE 'available'
        END AS status,
        l.expires_at AS held_until
      FROM slots s
      LEFT JOIN bookings b
        ON b.slot_id = s.id
        AND b.booking_date = $3
        AND b.status != 'cancelled'
      LEFT JOIN slot_locks l
        ON l.slot_id = s.id
        AND l.booking_date = $3
        AND l.expires_at > NOW()
      WHERE s.turf_id = $1
        AND s.sport = $2
        AND s.court_type = $4
        AND s.is_active = true
      ORDER BY s.start_time
    `, [turf_id, sport, date, (court_type && court_type !== 'undefined') ? court_type : 'Full']);

    const slots = rows.map(r => ({
      id: r.id,
      sport: r.sport,
      court_type: r.court_type,
      time: `${fmtTime(r.start_time)}–${fmtTime(r.end_time)}`,
      start_time: r.start_time,
      end_time: r.end_time,
      price: parseFloat(r.price),
      status: r.status,
      held_until: r.held_until || null,
    }));

    res.json(slots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/slots/lock — hold a slot for 10 minutes
router.post('/slots/lock', async (req, res) => {
  const { slot_id, date, phone } = req.body;
  if (!slot_id || !date || !phone) {
    return res.status(400).json({ error: 'slot_id, date, and phone are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clean expired locks
    await client.query('DELETE FROM slot_locks WHERE expires_at < NOW()');

    // Check if slot is already booked
    const booked = await client.query(
      `SELECT id FROM bookings WHERE slot_id = $1 AND booking_date = $2 AND status != 'cancelled'`,
      [slot_id, date]
    );
    if (booked.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot already booked' });
    }

    // Check if slot is locked by someone else
    const locked = await client.query(
      `SELECT locked_by FROM slot_locks WHERE slot_id = $1 AND booking_date = $2 AND expires_at > NOW()`,
      [slot_id, date]
    );
    if (locked.rows.length > 0 && locked.rows[0].locked_by !== phone) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot is currently held by another user' });
    }

    // Remove any existing lock by this user for this slot
    await client.query(
      'DELETE FROM slot_locks WHERE slot_id = $1 AND booking_date = $2 AND locked_by = $3',
      [slot_id, date, phone]
    );

    // Create new lock (10 minutes)
    const expires = new Date(Date.now() + 5 * 60 * 1000);
    await client.query(
      'INSERT INTO slot_locks (id, slot_id, booking_date, locked_by, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [uuidv4(), slot_id, date, phone, expires]
    );

    await client.query('COMMIT');
    res.json({ locked: true, expires_at: expires });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/bookings — confirm a booking (supports multiple slots)
router.post('/bookings', async (req, res) => {
  const { slot_ids, turf_id, date, name, phone, players, court_type, total_amount } = req.body;
  if (!slot_ids?.length || !turf_id || !date || !name || !phone || !players) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify all slots are locked by this user
    for (const slot_id of slot_ids) {
      const lock = await client.query(
        `SELECT id FROM slot_locks WHERE slot_id = $1 AND booking_date = $2 AND locked_by = $3 AND expires_at > NOW()`,
        [slot_id, date, phone]
      );
      if (lock.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'One or more holds expired. Please reselect your slots.' });
      }
    }

    // Upsert customer
    const custRes = await client.query(
      `INSERT INTO customers (id, phone, name) VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [uuidv4(), phone, name]
    );
    const customer_id = custRes.rows[0].id;

    // Generate unique ref
    let ref_code, attempts = 0;
    do {
      ref_code = genRef();
      attempts++;
      if (attempts > 10) throw new Error('Could not generate unique ref');
    } while ((await client.query('SELECT id FROM bookings WHERE ref_code = $1', [ref_code])).rows.length > 0);

    // Insert one booking per slot
    const bookingIds = [];
    for (const slot_id of slot_ids) {
      const slotRes = await client.query('SELECT price FROM slots WHERE id = $1', [slot_id]);
      const price = slotRes.rows[0]?.price;
      const bid = uuidv4();
      await client.query(
        `INSERT INTO bookings (id, turf_id, slot_id, customer_id, booking_date, court_type, player_count, total_amount, ref_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [bid, turf_id, slot_id, customer_id, date, court_type || 'Full', players, price,
         slot_ids.length === 1 ? ref_code : `${ref_code}-${bookingIds.length + 1}`]
      );
      bookingIds.push(bid);
    }

    // Release all locks
    for (const slot_id of slot_ids) {
      await client.query('DELETE FROM slot_locks WHERE slot_id = $1 AND booking_date = $2', [slot_id, date]);
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      booking: {
        ref_code,
        name,
        phone,
        players,
        amount: total_amount,
        date,
        slot_count: slot_ids.length,
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'One of these slots was just booked. Please choose again.' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/bookings — admin: list all bookings
router.get('/bookings', async (req, res) => {
  const { date, turf_id, status } = req.query;
  try {
    let where = ['b.status != $1'];
    let params = ['deleted'];
    let idx = 2;

    if (date) { where.push(`b.booking_date = $${idx++}`); params.push(date); }
    if (turf_id) { where.push(`b.turf_id = $${idx++}`); params.push(turf_id); }
    if (status) { where.push(`b.status = $${idx++}`); params.push(status); }

    const { rows } = await pool.query(`
      SELECT
        b.id, b.ref_code, b.booking_date, b.status,
        b.court_type, b.player_count, b.total_amount, b.created_at,
        c.name AS customer_name, c.phone AS customer_phone,
        t.name AS turf_name, t.location,
        s.sport,
        TO_CHAR(s.start_time, 'HH12:MI AM') AS start_time,
        TO_CHAR(s.end_time, 'HH12:MI AM') AS end_time
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      JOIN turfs t ON t.id = b.turf_id
      JOIN slots s ON s.id = b.slot_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.booking_date DESC, s.start_time ASC
    `, params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/bookings/:id/cancel — admin: cancel a booking
router.patch('/bookings/:id/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING id, ref_code`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json({ success: true, ref_code: rows[0].ref_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — admin dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const [bookings, revenue, today, turfs] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM bookings WHERE status = 'confirmed'`),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total FROM bookings WHERE status = 'confirmed'`),
      pool.query(`SELECT COUNT(*) FROM bookings WHERE booking_date = CURRENT_DATE AND status = 'confirmed'`),
      pool.query(`SELECT COUNT(*) FROM turfs WHERE is_active = true`),
    ]);

    res.json({
      total_bookings: parseInt(bookings.rows[0].count),
      total_revenue: parseFloat(revenue.rows[0].total),
      today_bookings: parseInt(today.rows[0].count),
      active_turfs: parseInt(turfs.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
