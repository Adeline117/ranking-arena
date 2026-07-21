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

import { Pool, types, type PoolClient } from 'pg'

// node-pg returns NUMERIC/BIGINT as strings by default — the source of a
// whole class of `.toFixed is not a function` / string-math bugs (freshness
// sentinel hit one). Parse them as JS numbers ONCE here: ingest values are
// metrics/counts well within Number.MAX_SAFE_INTEGER precision, and every
// money value is bounded by upstream validation.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)))
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)))

let pool: Pool | null = null

/**
 * A worker query must never outlive its BullMQ job indefinitely.  The server
 * deadline cancels genuinely slow SQL; the slightly wider client deadline is
 * the final shield when a pooler/TCP connection stays open but loses the
 * backend response.  Keep these deterministic across Mac and VPS workers.
 */
export const INGEST_DB_STATEMENT_TIMEOUT_MS = 4 * 60_000
export const INGEST_DB_QUERY_TIMEOUT_MS = 5 * 60_000
export const INGEST_DB_LOCK_TIMEOUT_MS = 60_000
export const INGEST_DB_KEEPALIVE_INITIAL_DELAY_MS = 10_000

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
    // ── Multi-node budget (2026-07-09 re-budget; was 2026-06-12) ──
    // BOTH ingest nodes (Mac `local` + SG `vps_sg`) import this file and open
    // their OWN pool. The binding constraint is the Supavisor SESSION pooler's
    // pool_size — raised 15 → 30 by the owner (2026-07-09) after concurrency 8
    // hit EMAXCONNSESSION at startup burst. Budget: 2 nodes × 14 = 28 ≤ 30
    // Supavisor backends, which themselves sit well under Postgres
    // max_connections (90, ~30 used by the rest of the system). Node peak
    // demand is INGEST_CONCURRENCY(8-12) + tier-c(2) + scheduler(1).
    max: 14,
    // CRITICAL: must be SHORTER than Supavisor's server-side idle timeout.
    // At 30s, node-pg kept clients Supavisor had already closed → the next
    // checkout got a dead socket and threw `EDBHANDLEREXITED`. Releasing
    // idle clients at 10s both avoids stale sockets AND returns the pooler
    // slot to the other node faster.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Server-side deadline for normal slow/blocked SQL.  query_timeout is
    // intentionally wider: it also rejects the local Promise when Supavisor
    // has lost the backend response and PostgreSQL can no longer cancel it.
    statement_timeout: INGEST_DB_STATEMENT_TIMEOUT_MS,
    query_timeout: INGEST_DB_QUERY_TIMEOUT_MS,
    lock_timeout: INGEST_DB_LOCK_TIMEOUT_MS,
    // Surface a half-open socket before a query rides it into EDBHANDLEREXITED.
    keepAlive: true,
    keepAliveInitialDelayMillis: INGEST_DB_KEEPALIVE_INITIAL_DELAY_MS,
    // Supabase pooler requires TLS; local dev (127.0.0.1) does not.
    ssl:
      url.includes('127.0.0.1') || url.includes('localhost')
        ? undefined
        : { rejectUnauthorized: false },
  })

  // Catches errors on IDLE clients sitting in the pool. It does NOT cover a
  // CHECKED-OUT client whose connection dies mid-use — that error surfaces on
  // the client itself, and with no `client.on('error')` listener node-pg lets it
  // bubble to process 'uncaughtException' → crash-restart. Use ingestClientConnect()
  // for any pool.connect() so checked-out clients get their own error listener.
  pool.on('error', (err) => {
    console.error('[ingest] pg idle-client pool error (non-fatal):', err.message)
  })

  return pool
}

/**
 * Checkout a pooled client WITH a checked-out error listener attached.
 *
 * ROOT FIX (2026-07-01, verified via scripts/test-edbhandler-repro.mts): when
 * Supavisor closes a connection mid-transaction, the checked-out client emits
 * one-or-more 'error' events (messages vary: "terminating connection due to
 * administrator command", "(EDBHANDLEREXITED) connection to database closed",
 * "Connection terminated unexpectedly"). Without a listener, EventEmitter throws
 * → 'uncaughtException' → the worker crash-restarts (~60-90s re-warm). `pool.on
 * ('error')` does NOT catch these (it only covers idle clients — proven). This
 * absorbs them (message-independent, unlike a fragile string match) and removes
 * the listener on release so it never accumulates on a reused healthy client.
 */
export async function ingestClientConnect(): Promise<PoolClient> {
  const client = await getIngestPool().connect()
  const onError = (err: Error) => {
    console.error(
      '[ingest] checked-out client connection drop (non-fatal, client discarded):',
      err.message
    )
  }
  client.on('error', onError)
  const origRelease = client.release.bind(client)
  ;(client as unknown as { release: (err?: Error | boolean) => void }).release = (
    err?: Error | boolean
  ) => {
    client.removeListener('error', onError)
    origRelease(err)
  }
  return client
}

export async function closeIngestPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
