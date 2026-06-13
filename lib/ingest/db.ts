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
    // ── Multi-node shared-pooler budget (2026-06-12 pool-exhaustion fix) ──
    // BOTH ingest nodes (Mac `local` + SG `vps_sg`) import this file and open
    // their OWN pool against the SAME Supabase transaction pooler (Supavisor).
    // Supavisor's default transaction pool_size is small (~15 on smaller
    // tiers); 10×2 nodes + legacy worker + Vercel reads saturated it →
    // `ECHECKOUTTIMEOUT in Transaction mode`. Mac peak demand is only
    // INGEST_CONCURRENCY(3) + tier-c(2) + scheduler(1) ≈ 6, so 8 covers it
    // with headroom while keeping the two-node footprint (16) under budget.
    max: 8,
    // CRITICAL: must be SHORTER than Supavisor's server-side idle timeout.
    // At 30s, node-pg kept clients Supavisor had already closed → the next
    // checkout got a dead socket and threw `EDBHANDLEREXITED`. Releasing
    // idle clients at 10s both avoids stale sockets AND returns the pooler
    // slot to the other node faster.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Surface a half-open socket before a query rides it into EDBHANDLEREXITED.
    keepAlive: true,
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
