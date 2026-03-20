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

// GET /api/slots?turf_id=&sport=&date=&court_type=
router.get('/slots', async (req, res) => {
  const { turf_id, sport, date, court_type } = req.query;
  if (!turf_id || !sport || !date) {
    return res.status(400).json({ error: 'turf_id, sport, and date are required' });
  }

  const requestedCourt = (court_type && court_type !== 'undefined') ? court_type : 'Full';
  const isPitchSport = ['Football', 'Box Cricket'].includes(sport);

  try {
    await pool.query('DELETE FROM slot_locks WHERE expires_at < NOW()');

    // Get all slots for this turf/sport/court_type
    const { rows } = await pool.query(`
      SELECT
        s.id,
        s.sport,
        s.court_type,
        s.start_time,
        s.end_time,
        s.price,
        s.is_active
      FROM slots s
      WHERE s.turf_id = $1
        AND s.sport = $2
        AND s.court_type = $3
        AND s.is_active = true
      ORDER BY s.start_time
    `, [turf_id, sport, requestedCourt]);

    // For each slot, calculate capacity usage across BOTH half and full slots at same time
    const slotData = await Promise.all(rows.map(async (r) => {
      let status = 'available';

      if (isPitchSport) {
        // Get all bookings for this turf/sport/start_time on this date (both Half and Full)
        const cap = await pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN sl.court_type = 'Full' THEN 2 ELSE 1 END), 0) AS units_booked,
            COALESCE(SUM(CASE WHEN sl.court_type = 'Full' THEN 2 ELSE 1 END), 0) AS confirmed_units
          FROM bookings b
          JOIN slots sl ON sl.id = b.slot_id
          WHERE sl.turf_id = $1
            AND sl.sport = $2
            AND sl.start_time = $3
            AND b.booking_date = $4
            AND b.status != 'cancelled'
        `, [turf_id, sport, r.start_time, date]);

        // Also check locks (count as held capacity)
        const locks = await pool.query(`
          SELECT COALESCE(SUM(CASE WHEN sl.court_type = 'Full' THEN 2 ELSE 1 END), 0) AS units_locked
          FROM slot_locks l
          JOIN slots sl ON sl.id = l.slot_id
          WHERE sl.turf_id = $1
            AND sl.sport = $2
            AND sl.start_time = $3
            AND l.booking_date = $4
            AND l.expires_at > NOW()
        `, [turf_id, sport, r.start_time, date]);

        const confirmedUnits = parseInt(cap.rows[0].units_booked) || 0;
        const lockedUnits = parseInt(locks.rows[0].units_locked) || 0;
        const totalUnits = confirmedUnits + lockedUnits;
        const thisSlotUnits = requestedCourt === 'Full' ? 2 : 1;

        if (confirmedUnits >= 2) {
          status = 'booked'; // fully confirmed booked
        } else if (totalUnits + thisSlotUnits > 2) {
          status = 'held'; // would exceed capacity due to locks
        } else if (confirmedUnits + thisSlotUnits > 2) {
          status = 'booked';
        }
      } else {
        // Pickleball — simple 1:1 check
        const booked = await pool.query(
          `SELECT id FROM bookings WHERE slot_id = $1 AND booking_date = $2 AND status != 'cancelled'`,
          [r.id, date]
        );
        const locked = await pool.query(
          `SELECT id FROM slot_locks WHERE slot_id = $1 AND booking_date = $2 AND expires_at > NOW()`,
          [r.id, date]
        );
        if (booked.rows.length > 0) status = 'booked';
        else if (locked.rows.length > 0) status = 'held';
      }

      return {
        id: r.id,
        sport: r.sport,
        court_type: r.court_type,
        time: `${fmtTime(r.start_time)}–${fmtTime(r.end_time)}`,
        start_time: r.start_time,
        end_time: r.end_time,
        price: parseFloat(r.price),
        status,
      };
    }));

    res.json(slotData);
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

    // Get this slot's details
    const slotInfo = await client.query(
      'SELECT turf_id, sport, start_time, court_type FROM slots WHERE id = $1',
      [slot_id]
    );
    if (!slotInfo.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Slot not found' });
    }
    const { turf_id, sport, start_time, court_type } = slotInfo.rows[0];

    // Check slot is not in the past
    const slotDateTime = new Date(`${date}T${start_time}`);
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    if (slotDateTime < nowIST) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This slot has already passed' });
    }
    const isPitchSport = ['Football', 'Box Cricket'].includes(sport);
    const thisUnits = court_type === 'Full' ? 2 : 1;

    if (isPitchSport) {
      // Capacity check — count confirmed bookings + locks (excluding this user's own locks)
      const cap = await client.query(`
        SELECT COALESCE(SUM(CASE WHEN sl.court_type = 'Full' THEN 2 ELSE 1 END), 0) AS units
        FROM bookings b
        JOIN slots sl ON sl.id = b.slot_id
        WHERE sl.turf_id = $1 AND sl.sport = $2 AND sl.start_time = $3
          AND b.booking_date = $4 AND b.status != 'cancelled'
      `, [turf_id, sport, start_time, date]);

      const locks = await client.query(`
        SELECT COALESCE(SUM(CASE WHEN sl.court_type = 'Full' THEN 2 ELSE 1 END), 0) AS units
        FROM slot_locks l
        JOIN slots sl ON sl.id = l.slot_id
        WHERE sl.turf_id = $1 AND sl.sport = $2 AND sl.start_time = $3
          AND l.booking_date = $4 AND l.expires_at > NOW()
          AND l.locked_by != $5
      `, [turf_id, sport, start_time, date, phone]);

      const usedUnits = parseInt(cap.rows[0].units) + parseInt(locks.rows[0].units);
      if (usedUnits + thisUnits > 2) {
        await client.query('ROLLBACK');
        const msg = court_type === 'Full'
          ? 'Full court not available — a half court is already booked for this slot'
          : 'Both halves are already taken for this slot';
        return res.status(409).json({ error: msg });
      }
    } else {
      // Pickleball — simple check
      const booked = await client.query(
        `SELECT id FROM bookings WHERE slot_id = $1 AND booking_date = $2 AND status != 'cancelled'`,
        [slot_id, date]
      );
      if (booked.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Slot already booked' });
      }
      const locked = await client.query(
        `SELECT locked_by FROM slot_locks WHERE slot_id = $1 AND booking_date = $2 AND expires_at > NOW()`,
        [slot_id, date]
      );
      if (locked.rows.length > 0 && locked.rows[0].locked_by !== phone) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Slot is currently held by another user' });
      }
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
  const { slot_ids, turf_id, date, name, phone, players, court_type, total_amount, member_id } = req.body;
  if (!slot_ids?.length || !turf_id || !date || !name || !phone || !players) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify all slots are locked by this user + capacity still valid
    for (const slot_id of slot_ids) {
      const lock = await client.query(
        `SELECT id FROM slot_locks WHERE slot_id = $1 AND booking_date = $2 AND locked_by = $3 AND expires_at > NOW()`,
        [slot_id, date, phone]
      );
      if (lock.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'One or more holds expired. Please reselect your slots.' });
      }

      // Final capacity check at booking time
      const slotInfo = await client.query(
        'SELECT turf_id, sport, start_time, court_type FROM slots WHERE id = $1',
        [slot_id]
      );
      const { turf_id: tid, sport, start_time, court_type: ct } = slotInfo.rows[0];
      const isPitchSport = ['Football', 'Box Cricket'].includes(sport);

      if (isPitchSport) {
        const thisUnits = ct === 'Full' ? 2 : 1;
        const cap = await client.query(`
          SELECT COALESCE(SUM(CASE WHEN sl.court_type = 'Full' THEN 2 ELSE 1 END), 0) AS units
          FROM bookings b
          JOIN slots sl ON sl.id = b.slot_id
          WHERE sl.turf_id = $1 AND sl.sport = $2 AND sl.start_time = $3
            AND b.booking_date = $4 AND b.status != 'cancelled'
        `, [tid, sport, start_time, date]);

        const usedUnits = parseInt(cap.rows[0].units);
        if (usedUnits + thisUnits > 2) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This slot was just taken. Please choose another.' });
        }
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

    // Wallet deduction if member booking
    if (member_id) {
      const totalAmt = parseFloat(total_amount) || 0;
      // Update all booking rows with member_id
      for (const bid of bookingIds) {
        await client.query('UPDATE bookings SET member_id = $1 WHERE id = $2', [member_id, bid]);
      }
      // Deduct from wallet
      await client.query(
        'UPDATE members SET balance = balance - $1 WHERE id = $2',
        [totalAmt, member_id]
      );
      await client.query(
        `INSERT INTO wallet_transactions (id, member_id, type, amount, reference, note)
         VALUES ($1, $2, 'deduction', $3, $4, 'Booking deduction')`,
        [uuidv4(), member_id, totalAmt, ref_code]
      );
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
      return res.status(409).json({ error: 'One of these slots was just taken. Please choose another.' });
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
    let where = ['b.status != $1', 'b.member_id IS NULL'];
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get booking details before cancelling
    const bookingRes = await client.query(
      `SELECT id, ref_code, member_id, total_amount, status FROM bookings WHERE id = $1`,
      [req.params.id]
    );
    if (bookingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }
    const booking = bookingRes.rows[0];
    if (booking.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Booking already cancelled' });
    }

    // Cancel the booking
    await client.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
      [req.params.id]
    );

    // Refund wallet if member booking
    if (booking.member_id && parseFloat(booking.total_amount) > 0) {
      await client.query(
        'UPDATE members SET balance = balance + $1 WHERE id = $2',
        [parseFloat(booking.total_amount), booking.member_id]
      );
      await client.query(
        `INSERT INTO wallet_transactions (id, member_id, type, amount, reference, note)
         VALUES ($1, $2, 'topup', $3, $4, 'Refund for cancelled booking')`,
        [uuidv4(), booking.member_id, parseFloat(booking.total_amount), booking.ref_code]
      );
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      ref_code: booking.ref_code,
      refunded: booking.member_id ? parseFloat(booking.total_amount) : 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/stats — admin dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const [bookings, revenue, today, turfs] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM bookings WHERE status = 'confirmed' AND member_id IS NULL`),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total FROM bookings WHERE status = 'confirmed' AND member_id IS NULL`),
      pool.query(`SELECT COUNT(*) FROM bookings WHERE booking_date = CURRENT_DATE AND status = 'confirmed' AND member_id IS NULL`),
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

// GET /api/customers
router.get('/customers', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.phone,
        c.created_at,
        COUNT(b.id) AS total_bookings,
        MAX(b.created_at) AS last_booking
      FROM customers c
      LEFT JOIN bookings b ON b.customer_id = c.id AND b.status != 'cancelled'
      GROUP BY c.id
      ORDER BY total_bookings DESC, c.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/booking — admin makes a booking on behalf of customer
router.post('/admin/booking', async (req, res) => {
  const { slot_ids, turf_id, date, name, phone, court_type, note } = req.body;
  if (!slot_ids?.length || !turf_id || !date || !name || !phone) {
    return res.status(400).json({ error: 'slot_ids, turf_id, date, name and phone are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert customer
    const custRes = await client.query(
      `INSERT INTO customers (id, phone, name) VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [uuidv4(), phone, name]
    );
    const customer_id = custRes.rows[0].id;

    // Generate ref
    let ref_code, attempts = 0;
    do {
      ref_code = genRef();
      attempts++;
      if (attempts > 10) throw new Error('Could not generate unique ref');
    } while ((await client.query('SELECT id FROM bookings WHERE ref_code = $1', [ref_code])).rows.length > 0);

    // Capacity check and insert for each slot
    const bookingIds = [];
    for (const slot_id of slot_ids) {
      const slotInfo = await client.query(
        'SELECT turf_id, sport, start_time, court_type, price FROM slots WHERE id = $1',
        [slot_id]
      );
      const sl = slotInfo.rows[0];
      const isPitchSport = ['Football', 'Box Cricket'].includes(sl.sport);

      if (isPitchSport) {
        const cap = await client.query(`
          SELECT COALESCE(SUM(CASE WHEN sl.court_type = 'Full' THEN 2 ELSE 1 END), 0) AS units
          FROM bookings b JOIN slots sl ON sl.id = b.slot_id
          WHERE sl.turf_id = $1 AND sl.sport = $2 AND sl.start_time = $3
            AND b.booking_date = $4 AND b.status != 'cancelled'
        `, [sl.turf_id, sl.sport, sl.start_time, date]);
        const ct = court_type || sl.court_type;
        const thisUnits = ct === 'Full' ? 2 : 1;
        if (parseInt(cap.rows[0].units) + thisUnits > 2) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Slot ${fmtTime(sl.start_time)} is already fully booked` });
        }
      } else {
        const booked = await client.query(
          `SELECT id FROM bookings WHERE slot_id = $1 AND booking_date = $2 AND status != 'cancelled'`,
          [slot_id, date]
        );
        if (booked.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Slot ${fmtTime(sl.start_time)} is already booked` });
        }
      }

      const bid = uuidv4();
      const slotRef = slot_ids.length === 1 ? ref_code : `${ref_code}-${bookingIds.length + 1}`;
      await client.query(
        `INSERT INTO bookings (id, turf_id, slot_id, customer_id, booking_date, court_type, player_count, total_amount, ref_code, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed')`,
        [bid, turf_id, slot_id, customer_id, date, court_type || sl.court_type, 1, sl.price, slotRef]
      );
      bookingIds.push(bid);
    }

    await client.query('COMMIT');
    res.json({ success: true, ref_code, booking_count: bookingIds.length });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'One of these slots was just booked' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/admin/block — block a slot
router.post('/admin/block', async (req, res) => {
  const { slot_ids, turf_id, date, reason } = req.body;
  if (!slot_ids?.length || !turf_id || !date) {
    return res.status(400).json({ error: 'slot_ids, turf_id, and date are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find or create a system "blocked" customer
    let custRes = await client.query(`SELECT id FROM customers WHERE phone = 'BLOCKED'`);
    if (!custRes.rows.length) {
      custRes = await client.query(
        `INSERT INTO customers (id, phone, name) VALUES ($1, 'BLOCKED', 'BLOCKED') RETURNING id`,
        [uuidv4()]
      );
    }
    const customer_id = custRes.rows[0].id;

    const blocked = [];
    for (const slot_id of slot_ids) {
      const existing = await client.query(
        `SELECT id FROM bookings WHERE slot_id = $1 AND booking_date = $2 AND status != 'cancelled'`,
        [slot_id, date]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        const slotInfo = await pool.query('SELECT start_time FROM slots WHERE id = $1', [slot_id]);
        return res.status(409).json({ error: `Slot ${fmtTime(slotInfo.rows[0]?.start_time)} already has a booking` });
      }

      const slotInfo = await client.query('SELECT turf_id, price, court_type FROM slots WHERE id = $1', [slot_id]);
      const sl = slotInfo.rows[0];
      const ref = 'BLK-' + Math.random().toString(36).substring(2,8).toUpperCase();

      await client.query(
        `INSERT INTO bookings (id, turf_id, slot_id, customer_id, booking_date, court_type, player_count, total_amount, ref_code, status)
         VALUES ($1,$2,$3,$4,$5,$6,0,0,$7,'blocked')`,
        [uuidv4(), turf_id, slot_id, customer_id, date, sl.court_type, ref]
      );
      blocked.push(slot_id);
    }

    await client.query('COMMIT');
    res.json({ success: true, blocked_count: blocked.length, reason });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/admin/block — unblock a slot
router.delete('/admin/block', async (req, res) => {
  const { slot_id, date } = req.body;
  if (!slot_id || !date) return res.status(400).json({ error: 'slot_id and date required' });
  try {
    await pool.query(
      `UPDATE bookings SET status = 'cancelled' WHERE slot_id = $1 AND booking_date = $2 AND status = 'blocked'`,
      [slot_id, date]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
