/**
 * Reproduction test for the EDBHANDLEREXITED worker crash + fix verification.
 *
 * Registers the SAME handlers the worker uses (db.ts pool.on('error') is inside
 * getIngestPool; here we add the ingest-worker.ts uncaughtException/unhandledRejection
 * handlers), then FORCES a mid-transaction connection death exactly like Supavisor
 * closing a connection: it checks out a client, BEGINs, gets the client's backend
 * pid, terminates that backend from a SEPARATE client, then runs another query on
 * the now-dead client — the real EDBHANDLEREXITED path.
 *
 * We run it TWICE via an env flag:
 *   WORKER_FIX=0  → the OLD handler (exit(1) on any uncaughtException)
 *   WORKER_FIX=1  → the NEW handler (EDBHANDLEREXITED non-fatal)
 * and print whether the process SURVIVES. Read-only queries only (SELECT), no writes.
 *
 * Run: npx tsx scripts/test-edbhandler-repro.mts
 */
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '..', 'worker', '.env') })

import { getIngestPool, ingestClientConnect } from '../lib/ingest/db'

const FIX = process.env.WORKER_FIX !== '0' // default: test the NEW handler

let sawUncaught = false
let exited = false

// The ingest-worker.ts handlers (both variants):
process.on('unhandledRejection', (reason) => {
  console.log('  [handler] UNHANDLED REJECTION (logged, non-fatal):', String((reason as { message?: string })?.message ?? reason).slice(0, 80))
})
process.on('uncaughtException', (err) => {
  sawUncaught = true
  const msg = String((err as { message?: string })?.message ?? err)
  if (FIX && /EDBHANDLEREXITED|connection to database closed|Connection terminated|ECONNRESET|read ECONNRESET/i.test(msg)) {
    console.log('  [handler] recoverable DB connection drop (non-fatal):', msg.slice(0, 80))
    return
  }
  console.log(`  [handler] UNCAUGHT EXCEPTION → would exit(1) [FIX=${FIX ? 1 : 0}]:`, msg.slice(0, 80))
  exited = true
  // Don't actually exit in the test harness — record it so we can report.
})

async function main() {
  console.log(`\n=== EDBHANDLEREXITED reproduction (WORKER_FIX=${FIX ? 1 : 0}) ===`)
  const pool = getIngestPool()

  // HELPER=1 → use the real ingestClientConnect() root fix. Else raw pool.connect().
  const client = process.env.HELPER === '1' ? await ingestClientConnect() : await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    const pid = rows[0].pid
    console.log(`  checked-out client backend pid=${pid}; terminating it from another connection…`)

    // Kill THIS client's backend from a separate pooled connection (simulates Supavisor drop).
    await pool.query('SELECT pg_terminate_backend($1)', [pid])

    // Give the socket-close event a tick to propagate to the checked-out client.
    await new Promise((r) => setTimeout(r, 300))

    // Now use the dead client — the real EDBHANDLEREXITED path (mid-transaction).
    console.log('  querying the dead client (expect EDBHANDLEREXITED)…')
    await client.query('SELECT 1')
    console.log('  (unexpected: query succeeded)')
    await client.query('COMMIT')
  } catch (err) {
    console.log('  [txn catch] query threw:', String((err as { message?: string })?.message ?? err).slice(0, 80))
    try {
      await client.query('ROLLBACK') // this ALSO throws on a dead conn — the bug
    } catch (rbErr) {
      console.log('  [txn catch] ROLLBACK also threw:', String((rbErr as { message?: string })?.message ?? rbErr).slice(0, 60))
    }
  } finally {
    try { client.release() } catch { /* client already destroyed */ }
  }

  // Let any async client 'error' events fire.
  await new Promise((r) => setTimeout(r, 800))

  console.log('\n  RESULT:')
  console.log('    uncaughtException seen:', sawUncaught)
  console.log('    would-have-exited(1):', exited)
  console.log(`    → with FIX=${FIX ? 1 : 0}, the worker ${exited ? 'WOULD CRASH-RESTART ❌' : 'SURVIVES ✅'}`)
  process.exit(0)
}

main().catch((e) => {
  console.error('  test harness error:', e)
  process.exit(2)
})
