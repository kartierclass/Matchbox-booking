const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/matchbox',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

function slots30(sport, startH, endH, price, courtType) {
  const rows = [];
  for (let h = startH; h < endH; h++) {
    const hStr = String(h).padStart(2,'0');
    const h1Str = String(h+1).padStart(2,'0');
    rows.push(`('${sport}','${hStr}:00','${hStr}:30',${price},'${courtType}')`);
    rows.push(`('${sport}','${hStr}:30','${h1Str}:00',${price},'${courtType}')`);
  }
  return rows;
}

function slots1hr(sport, startH, endH, price, courtType) {
  const rows = [];
  for (let h = startH; h < endH; h++) {
    const hStr = String(h).padStart(2,'0');
    const h1Str = String(h+1).padStart(2,'0');
    rows.push(`('${sport}','${hStr}:00','${h1Str}:00',${price},'${courtType}')`);
  }
  return rows;
}

const hebbalSlots = [
  ...slots30('Football',6,17,900,'Half'),
  ...slots30('Football',17,23,1400,'Half'),
  ...slots30('Football',6,17,1800,'Full'),
  ...slots30('Football',17,23,2500,'Full'),
  ...slots30('Box Cricket',6,17,900,'Half'),
  ...slots30('Box Cricket',17,23,1400,'Half'),
  ...slots30('Box Cricket',6,17,1800,'Full'),
  ...slots30('Box Cricket',17,23,2500,'Full'),
  ...slots1hr('Pickleball',6,17,550,'Full'),
  ...slots1hr('Pickleball',17,23,600,'Full'),
].join(',');

const vijSlots = [
  ...slots30('Football',6,17,900,'Half'),
  ...slots30('Football',17,23,1200,'Half'),
  ...slots30('Football',6,17,1800,'Full'),
  ...slots30('Football',17,23,2400,'Full'),
  ...slots30('Box Cricket',6,17,900,'Half'),
  ...slots30('Box Cricket',17,23,1200,'Half'),
  ...slots30('Box Cricket',6,17,1800,'Full'),
  ...slots30('Box Cricket',17,23,2400,'Full'),
].join(',');

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
    court_type VARCHAR(20) NOT NULL DEFAULT 'Full',
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    price DECIMAL(10,2) NOT NULL,
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
    court_type VARCHAR(20),
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

  DO $$ BEGIN ALTER TABLE slots ADD COLUMN IF NOT EXISTS court_type VARCHAR(20) NOT NULL DEFAULT 'Full'; EXCEPTION WHEN others THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE bookings ADD COLUMN IF NOT EXISTS court_type VARCHAR(20); EXCEPTION WHEN others THEN NULL; END $$;

  UPDATE turfs SET is_active = false WHERE location = 'Yadavgiri';

  INSERT INTO turfs (name, location, address) VALUES
    ('Match-Box Hebbal', 'Hebbal', 'Plot No 31, Survey 115, Hebbal Village, Mysuru 570017'),
    ('Match-Box Vijayanagar', 'Vijayanagar', '283/2, Vijaya Nagar 3rd Stage, Mysuru 570030')
  ON CONFLICT DO NOTHING;

  DELETE FROM slot_locks;
  DELETE FROM slots WHERE turf_id IN (SELECT id FROM turfs WHERE location IN ('Hebbal','Vijayanagar'));

  INSERT INTO slots (turf_id, sport, start_time, end_time, price, court_type)
  SELECT t.id, s.sport, s.st::TIME, s.et::TIME, s.price, s.ct
  FROM turfs t
  JOIN (VALUES ${hebbalSlots}) AS s(sport,st,et,price,ct) ON true
  WHERE t.location = 'Hebbal';

  INSERT INTO slots (turf_id, sport, start_time, end_time, price, court_type)
  SELECT t.id, s.sport, s.st::TIME, s.et::TIME, s.price, s.ct
  FROM turfs t
  JOIN (VALUES ${vijSlots}) AS s(sport,st,et,price,ct) ON true
  WHERE t.location = 'Vijayanagar';
`;

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(initSQL);
    console.log('✅ Database initialised');
  } catch (err) {
    console.error('DB init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
