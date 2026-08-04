import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260804054000_publish_copier_snapshot_atomically.sql'),
  'utf8'
)
const proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/publish-copier-snapshot-atomically.pg17.sh'),
  'utf8'
)

describe('atomic copier snapshot publisher', () => {
  it('is a single private security-definer boundary with fixed configuration', () => {
    expect(migration).toContain('CREATE FUNCTION arena.publish_copier_snapshot(')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('SET row_security = off')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.publish_copier_snapshot\([\s\S]*?TO service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.publish_copier_snapshot\([\s\S]*?FROM PUBLIC, anon, authenticated/
    )
  })

  it('rechecks live source, subject, RAW identity, and capture metadata', () => {
    for (const marker of [
      "source_row.status = 'active'",
      "source_row.serving_mode = 'serving'",
      'source_row.copier_table_depth IN',
      '\'{"claimed":true}\'::jsonb',
      'v_raw.source_id IS DISTINCT FROM p_source_id',
      'v_raw.trader_id IS DISTINCT FROM p_trader_id',
      'v_raw.storage_path IS DISTINCT FROM p_raw_storage_path',
      'v_raw.content_hash IS DISTINCT FROM p_raw_content_hash',
      "v_raw.trust_artifact_role IS DISTINCT FROM 'copier_snapshot'",
      "v_raw.meta->>'data_contract' IS DISTINCT FROM",
      "v_raw.meta->>'source_slug' IS DISTINCT FROM v_source_slug",
      "v_raw.meta->>'exchange_trader_id' IS DISTINCT FROM",
      "v_raw.meta->>'fetch_region' IS DISTINCT FROM v_fetch_region",
      "v_raw.meta->'fetch_failed' IS DISTINCT FROM 'false'::jsonb",
    ]) {
      expect(migration).toContain(marker)
    }
  })

  it('lets PostgreSQL own exact row conservation and versioned hashes', () => {
    expect(migration).toContain('arena.ingest.copier-row-set.pg-jsonb-row-hashes@1')
    expect(migration).toContain('arena.ingest.copier-snapshot-row@1')
    expect(migration).toContain('pg_catalog.sha256(')
    expect(migration).toContain('pg_catalog.string_agg(')
    expect(migration).toContain('GET DIAGNOSTICS v_inserted = ROW_COUNT')
    expect(migration).toContain('copier snapshot atomic row verification failed')
    expect(migration).toContain('row_value.source_event_at IS NOT NULL')
    expect(migration).toContain('ALTER COLUMN source_event_at DROP NOT NULL')
    expect(migration).not.toMatch(/ON CONFLICT DO NOTHING/)
  })

  it('serializes the subject and rejects stale or branching publications', () => {
    expect(migration).toContain("'arena.publish-copier-snapshot:'")
    expect(migration).toContain('p_observed_at <= v_previous_observed_at')
    expect(migration).toContain('stale copier snapshot publication rejected')
    expect(migration).toContain('uq_copier_snapshot_publication_raw_parser')
    expect(migration).toContain('previous_publication_id')
  })

  it('has executable PG17 proof for publish, replay, rollback, lifecycle, and ACLs', () => {
    for (const marker of [
      'service role copier publish',
      'exact copier retry',
      'stale copier publication succeeded',
      'malformed copier ordinals succeeded',
      'wrong-subject copier RAW succeeded',
      'demoted source copier publish succeeded',
      'claimed trader copier publish succeeded',
      'failed copier publications leaked rows',
      'atomic copier snapshot publisher PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
