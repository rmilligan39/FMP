const { Pool } = require('pg');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Extract report ID from URL: /api/report/AAPL-20260505-a1b2
  const urlParts = req.url.split('/');
  const reportId = urlParts[urlParts.length - 1]?.split('?')[0];

  if (!reportId) {
    return res.status(400).json({ error: 'Missing report ID.' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured.' });
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const result = await pool.query(
      'SELECT id, ticker, company_name, html, source, created_at FROM reports WHERE id = $1',
      [reportId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    const report = result.rows[0];
    return res.status(200).json({
      id: report.id,
      ticker: report.ticker,
      companyName: report.company_name,
      html: report.html,
      source: report.source,
      createdAt: report.created_at,
    });
  } catch (err) {
    console.error('Report fetch error:', err.message);
    return res.status(500).json({ error: 'Database error: ' + err.message });
  } finally {
    await pool.end();
  }
};
