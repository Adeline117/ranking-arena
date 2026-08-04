import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql'
  ),
  'utf8'
)
const proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/copier-snapshot-publication-substrate.pg17.sh'
  ),
  'utf8'
)

describe('copier snapshot publication substrate', () => {
  it('uses a sibling snapshot contract rather than weakening position-history evidence', () => {
    expect(migration).toContain('CREATE TABLE arena.copier_snapshot_publications')
    expect(migration).toContain('CREATE TABLE arena.copier_snapshot_rows')
    expect(migration).not.toMatch(/ALTER TABLE arena\.record_surface_publications/)
    expect(migration).not.toMatch(/surface\s*=\s*'position_history'/)
  })

  it('binds RAW identity, clocks, capture shape, source semantics, and row digest', () => {
    for (const field of [
      'raw_object_id',
      'raw_object_id_at_publication',
      'source_run_id',
      'raw_storage_path',
      'raw_content_hash',
      'raw_fetched_at',
      'observed_at',
      'published_at',
      'scan_terminal_state',
      'page_count',
      'parsed_row_count',
      'source_depth',
      'currency',
      'row_set_sha256',
      'row_sha256',
      'parser_contract',
      'row_hash_contract',
      'publisher_contract',
    ]) {
      expect(migration).toContain(field)
    }
    expect(migration).toContain("'stream_exhausted_unverified'")
    expect(migration).toContain("'caller_limited'")
    expect(migration).toContain("evidence_contract = 'arena.copier-snapshot-publication@1'")
    expect(migration).toContain('raw_content_hash = source_run_id')
    expect(migration).not.toContain('raw jsonb NOT NULL')
    expect(migration).toContain("'Infinity'::numeric")
  })

  it('pins the histogram privacy contract at cohort 10 and bucket 5', () => {
    expect(migration).toContain("privacy_contract = 'arena.copier-histogram-k-anonymity@1'")
    expect(migration).toContain('histogram_min_cohort = 10')
    expect(migration).toContain('histogram_min_bucket = 5')
  })

  it('keeps individual rows and trigger helpers private and immutable', () => {
    for (const relation of ['copier_snapshot_publications', 'copier_snapshot_rows']) {
      expect(migration).toContain(`ALTER TABLE arena.${relation} ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE arena.${relation} FORCE ROW LEVEL SECURITY`)
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE arena\\.${relation}[\\s\\S]{0,100}FROM PUBLIC, anon, authenticated, service_role`
        )
      )
    }
    expect(migration).toContain('copier snapshot publication receipts are immutable')
    expect(migration).toContain('copier snapshot rows are immutable')
    expect(migration).toContain('quarantined copier snapshot RAW evidence cannot be deleted')
    expect(migration).not.toMatch(/CREATE POLICY/)
  })

  it('has executable PG17 coverage for privacy, immutability, RAW GC, and legacy isolation', () => {
    for (const marker of [
      'browser role read snapshot receipts',
      'browser role read snapshot rows',
      'publication receipt mutation succeeded',
      'snapshot row mutation succeeded',
      'protected RAW identity mutation succeeded',
      'quarantined bound RAW deletion succeeded',
      'ordinary RAW GC did not tombstone only the live pointer',
      'legacy copier rows changed during substrate migration',
      'copier snapshot publication substrate PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
