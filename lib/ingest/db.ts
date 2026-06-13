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
      '[ingest] INGEST_DATABASE_URL not set. Use the Supabase SESSION pooler URI ' +
        '(Dashboard → Connect → Session pooler, port 5432) — NOT the transaction ' +
        'pooler (6543). See the architecture note below.'
    )
  }

  // ── Pooler-mode guard (2026-06-12 root-cause prevention) ──
  // A persistent worker with its OWN node-pg pool MUST use the SESSION pooler
  // (5432) or a direct connection — each client gets a dedicated upstream
  // Postgres backend. The TRANSACTION pooler (6543) multiplexes a tiny shared
  // upstream pool meant for serverless; a long-lived pooled worker starves it
  // → `ECHECKOUTTIMEOUT in Transaction mode` even while Postgres has 60/90 free.
  // This silent misfit cost hours to diagnose; if a redeploy ever reverts the
  // URL to :6543, scream at startup instead of melting down quietly.
  if (/:6543\b/.test(url) && !url.includes('127.0.0.1') && !url.includes('localhost')) {
    console.error(
      '[ingest] ⚠️ INGEST_DATABASE_URL points at the TRANSACTION pooler (:6543). ' +
        'A persistent worker MUST use the SESSION pooler (:5432) — the transaction ' +
        'pooler will starve under its node-pg pool (ECHECKOUTTIMEOUT). Switch the port to 5432.'
    )
  }

  pool = new Pool({
    connectionString: url,
    // ── Multi-node budget (2026-06-12 pool-exhaustion fix) ──
    // BOTH ingest nodes (Mac `local` + SG `vps_sg`) import this file and open
    // their OWN pool. With the SESSION pooler (5432, see guard above) each
    // connection is a dedicated Postgres backend, so the budget is against
    // Postgres max_connections (90), not a tiny Supavisor transaction pool.
    // Mac peak demand is INGEST_CONCURRENCY(3) + tier-c(2) + scheduler(1) ≈ 6,
    // so 8 covers it; two nodes = 16 backends, far under 90 (≈30 used by the
    // rest of the system). Verified steady state: exactly 8+8 in pg_stat_activity.
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
