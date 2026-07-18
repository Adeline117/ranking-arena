import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718133000_history_partition_range_guard.sql'),
  'utf8'
)
const publisher = readFileSync(join(process.cwd(), 'lib/ingest/serving/publish.ts'), 'utf8')
const partitionGuard = readFileSync(
  join(process.cwd(), 'lib/ingest/serving/history-partitions.ts'),
  'utf8'
)

describe('history partition range guard migration', () => {
  it('is transactional, bounded, serialized, and owner-only', () => {
    expect(migration).toMatch(/^BEGIN;$/m)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('months_ahead > 24')
    expect(migration).toContain('months_back > 120')
    expect(migration).toContain("interval '10 years'")
    expect(migration).toContain("interval '2 months'")
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('privilege.grantee <> function_row.proowner')
  })

  it('seeds the live missing-history runway and guards every future batch', () => {
    expect(migration).toContain("SELECT arena.ensure_month_partitions('order_records', 2, 12)")
    expect(migration).toContain("SELECT arena.ensure_month_partitions('transfer_history', 2, 12)")
    expect(migration).toContain("SELECT arena.ensure_month_partitions('copier_records', 2, 12)")
    expect(publisher).toContain('await ensureHistoryPartitions(client, kind, rows)')
    expect(partitionGuard).toContain(
      "'SELECT arena.ensure_history_partitions($1, $2::timestamptz[])'"
    )
    expect(partitionGuard).toContain("position_history') return null")
  })
})
