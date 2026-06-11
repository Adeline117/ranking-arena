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

import { Pool } from 'pg'

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
    max: 5,
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
