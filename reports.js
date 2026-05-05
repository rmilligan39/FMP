const { Pool } = require('pg');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured.' });
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const result = await pool.query(
      `SELECT id, ticker, company_name, source, created_at
       FROM reports
       ORDER BY created_at DESC
       LIMIT 50`
    );

    return res.status(200).json({ reports: result.rows });
  } catch (err) {
    console.error('Reports list error:', err.message);
    return res.status(500).json({ error: 'Database error: ' + err.message });
  } finally {
    await pool.end();
  }
};
