/**
 * PG17 driver for retention-preserves-metric-trust-evidence.pg17.sh: runs the
 * worker's real retention SQL (lib/ingest raw/series builders) against the
 * isolated cluster and prints what it selected/deleted. No credentials.
 */
import { Client } from 'pg'

import { METRIC_TRUST_EVIDENCE_PRESENT_SQL, rawObjectRetentionCandidateSql } from '@/lib/ingest/raw'
import { snapshotEntryDownsampleSql } from '@/lib/ingest/serving/series'

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
  await client.query('COMMIT')
  const deleted = await client.query(snapshotEntryDownsampleSql(present), ['7'])
  process.stdout.write(
    `RESULT ${JSON.stringify({
      present,
      rawCandidates: candidates.rows.map((row) => Number(row.id)).sort((a, b) => a - b),
      entriesDeleted: deleted.rowCount,
    })}\n`
  )
} finally {
  await client.end()
}
