// db/pool.js
// Single shared PostgreSQL connection pool. Import this everywhere instead of
// creating new pg.Pool() instances — connection pooling is what makes this
// scale; one pool per process, reused across all requests.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,                     // max simultaneous connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // FIX (index-candles requests hanging forever / stuck "pending" in the
  // Network tab): connectionTimeoutMillis above only bounds how long we wait
  // to ACQUIRE a connection from the pool — it does nothing once a query is
  // actually running. If a query ever stalls server-side (locked row, dead
  // TCP connection that hasn't been noticed yet, etc.) the request had no
  // way to time out and just hung indefinitely, which is exactly what the
  // Network tab showed (10+ requests sitting at "pending" past 15s+).
  // statement_timeout tells Postgres itself to kill a query after 8s;
  // query_timeout is the pg client's own belt-and-braces timer for the same
  // thing. Either one firing turns a silent hang into a real error that
  // asyncHandler/errorHandler can turn into an HTTP response.
  statement_timeout: 8000,
  query_timeout: 8000,
});

pool.on('error', (err) => {
  // A backend client crashed (e.g. network blip) — log it, don't crash the whole server
  console.error('[db] Unexpected error on idle client', err);
});

/**
 * Run a single query. Use this for simple one-off queries.
 * @param {string} text - SQL with $1, $2... placeholders
 * @param {Array} params
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.NODE_ENV !== 'production') {
    console.log('[db]', text.slice(0, 80), `${Date.now() - start}ms`, `rows=${res.rowCount}`);
  }
  return res;
}

/**
 * Get a client for a transaction. Caller MUST release it.
 * Usage:
 *   const client = await getClient();
 *   try {
 *     await client.query('BEGIN');
 *     ... queries ...
 *     await client.query('COMMIT');
 *   } catch (e) {
 *     await client.query('ROLLBACK');
 *     throw e;
 *   } finally {
 *     client.release();
 *   }
 */
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, getClient };
