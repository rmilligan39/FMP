const { Pool } = require('pg');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured.' });
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id            TEXT PRIMARY KEY,
        ticker        TEXT NOT NULL,
        company_name  TEXT,
        html          TEXT NOT NULL,
        source        TEXT DEFAULT 'fmp',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_reports_ticker ON reports(ticker);
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
    `);

    return res.status(200).json({ success: true, message: 'Table "reports" created successfully.' });
  } catch (err) {
    console.error('Setup error:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
};
