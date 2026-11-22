/**
 * PG17 driver for trust-evidence-retention.pg17.sh: runs the worker's real
 * RAW retention candidate SQL (lib/ingest/raw.ts) against the isolated
 * cluster after a purge and prints which RAW objects would enter the GC
 * queue. Read-only (the candidate SELECT runs in a rolled-back transaction).
 */
import { Client } from 'pg'

import { METRIC_TRUST_EVIDENCE_PRESENT_SQL, rawObjectRetentionCandidateSql } from '@/lib/ingest/raw'

const client = new Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: 'postgres',
  database: 'postgres',
})
await client.connect()
try {
  const present = (await client.query<{ present: boolean }>(METRIC_TRUST_EVIDENCE_PRESENT_SQL))
    .rows[0].present
  await client.query('BEGIN')
  const candidates = await client.query<{ id: string }>(rawObjectRetentionCandidateSql(present), [
    '30',
  ])
  await client.query('ROLLBACK')
  process.stdout.write(
    `RESULT ${JSON.stringify({
      present,
      rawCandidates: candidates.rows.map((row) => Number(row.id)).sort((a, b) => a - b),
    })}\n`
  )
} finally {
  await client.end()
}
