const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/matchbox',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const initSQL = `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  CREATE TABLE IF NOT EXISTS turfs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    location VARCHAR(100) NOT NULL,
    address TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turf_id UUID REFERENCES turfs(id),
    sport VARCHAR(50) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    days_available VARCHAR(7) DEFAULT '1111111',
    is_active BOOLEAN DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turf_id UUID REFERENCES turfs(id),
    slot_id UUID REFERENCES slots(id),
    customer_id UUID REFERENCES customers(id),
    booking_date DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'confirmed',
    player_count INT,
    total_amount DECIMAL(10,2),
    ref_code VARCHAR(20) UNIQUE,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_slot_per_date UNIQUE (slot_id, booking_date)
  );

  CREATE TABLE IF NOT EXISTS slot_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id UUID REFERENCES slots(id),
    booking_date DATE NOT NULL,
    locked_by VARCHAR(20) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  INSERT INTO turfs (name, location, address) VALUES
    ('Match-Box Hebbal', 'Hebbal', 'Plot No 31, Survey 115, Hebbal Village, Mysuru 570017'),
    ('Match-Box Vijayanagar', 'Vijayanagar', '283/2, Vijaya Nagar 3rd Stage, Mysuru 570030'),
    ('Match-Box Yadavgiri', 'Yadavgiri', '2nd Main, 8th Cross Rd, Yadavagiri, Mysuru 570020')
  ON CONFLICT DO NOTHING;

  INSERT INTO slots (turf_id, sport, start_time, end_time, price)
  SELECT t.id, s.sport, s.start_time::TIME, s.end_time::TIME, s.price
  FROM turfs t
  CROSS JOIN (VALUES
    ('Football', '05:00', '06:00', 600),
    ('Football', '06:00', '07:00', 800),
    ('Football', '07:00', '08:00', 800),
    ('Football', '08:00', '09:00', 700),
    ('Football', '09:00', '10:00', 600),
    ('Football', '16:00', '17:00', 800),
    ('Football', '17:00', '18:00', 1000),
    ('Football', '18:00', '19:00', 1200),
    ('Football', '19:00', '20:00', 1200),
    ('Football', '20:00', '21:00', 1000),
    ('Football', '21:00', '22:00', 800),
    ('Pickleball', '06:00', '07:00', 400),
    ('Pickleball', '07:00', '08:00', 400),
    ('Pickleball', '08:00', '09:00', 400),
    ('Pickleball', '16:00', '17:00', 500),
    ('Pickleball', '17:00', '18:00', 600),
    ('Pickleball', '18:00', '19:00', 700),
    ('Pickleball', '19:00', '20:00', 700),
    ('Pickleball', '20:00', '21:00', 600),
    ('Box Cricket', '05:00', '06:00', 700),
    ('Box Cricket', '06:00', '07:00', 900),
    ('Box Cricket', '07:00', '08:00', 900),
    ('Box Cricket', '08:00', '09:00', 800),
    ('Box Cricket', '17:00', '18:00', 1000),
    ('Box Cricket', '18:00', '19:00', 1100),
    ('Box Cricket', '19:00', '20:00', 1100),
    ('Box Cricket', '20:00', '21:00', 900)
  ) AS s(sport, start_time, end_time, price)
  WHERE NOT EXISTS (
    SELECT 1 FROM slots WHERE turf_id = t.id AND sport = s.sport AND start_time = s.start_time::TIME
  );
`;

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(initSQL);
    console.log('✅ Database initialised');
  } catch (err) {
    console.error('DB init error:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
