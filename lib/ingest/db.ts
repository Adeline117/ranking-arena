/**
 * Direct Postgres access for the ingestion pipeline.
 *
 * The ingest worker deliberately bypasses PostgREST: bulk snapshot publishes
 * write thousands of rows per cycle and the `arena` schema is not in the
 * hosted PostgREST exposed list during the migration. Connection string
 * comes from INGEST_DATABASE_URL (Supabase pooler, transaction mode) or
 * falls back to DATABASE_URL.
 *
 * Worker-only: app/** must not import this module (Vercel functions use
 * the Supabase client; ESLint guard enforces the boundary).
 */

import { Pool, types } from 'pg'

// node-pg returns NUMERIC/BIGINT as strings by default — the source of a
// whole class of `.toFixed is not a function` / string-math bugs (freshness
// sentinel hit one). Parse them as JS numbers ONCE here: ingest values are
// metrics/counts well within Number.MAX_SAFE_INTEGER precision, and every
// money value is bounded by upstream validation.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)))
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)))

let pool: Pool | null = null

export function getIngestPool(): Pool {
  if (pool) return pool

  const url = process.env.INGEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      '[ingest] INGEST_DATABASE_URL not set. Use the Supabase pooler URI ' +
        '(Dashboard → Connect → Transaction pooler).'
    )
  }

  pool = new Pool({
    connectionString: url,
    // main queue (3) + tier-c queue (2) + scheduler/maintenance can all
    // hold a client concurrently; 5 was contention-edge at 23 sources.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase pooler requires TLS; local dev (127.0.0.1) does not.
    ssl:
      url.includes('127.0.0.1') || url.includes('localhost')
        ? undefined
        : { rejectUnauthorized: false },
  })

  pool.on('error', (err) => {
    console.error('[ingest] pg pool error:', err.message)
  })

  return pool
}

export async function closeIngestPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
