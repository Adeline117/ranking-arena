import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const migrationFile = '20260808020000_copier_snapshot_trust_publication_substrate.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationFile), 'utf8')
const proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/copier-snapshot-trust-publication-substrate.pg17.sh'
  ),
  'utf8'
)
const sqlWithoutLineComments = migration.replace(/^\s*--.*$/gm, '')

describe('copier snapshot artifact@2 publication substrate', () => {
  it('has one versioned identity bound to the exact trust RAW-role predecessor', () => {
    const identity = migrationFile.match(/^(\d{14})_(.+)\.sql$/)
    expect(identity?.[1]).toBe('20260808020000')
    expect(identity?.[2]).toBe('copier_snapshot_trust_publication_substrate')
    expect('20260808020000' > '20260808010000').toBe(true)
    expect(
      readdirSync(join(process.cwd(), 'supabase/migrations')).filter((name) =>
        name.startsWith('20260808020000_')
      )
    ).toEqual([migrationFile])

    expect(migration).toContain("ledger.name = 'copier_snapshot_trust_raw_role'")
    expect(migration).not.toContain("ledger.version = '20260808010000'")
    expect(migration).toContain('37929ff0398005969dc415e82488c8d1654492b6e5588824b2c73f98c16765ef')
    expect(migration).toContain(
      'requires one exact copier_snapshot_trust_raw_role migration ledger name and body'
    )
  })

  it('creates a private sibling header/row contract without changing v1', () => {
    expect(migration).toContain('CREATE TABLE arena.copier_snapshot_trust_publications')
    expect(migration).toContain('CREATE TABLE arena.copier_snapshot_trust_rows')
    expect(sqlWithoutLineComments).not.toMatch(
      /\b(?:ALTER|DROP)\s+TABLE\s+(?:ONLY\s+)?arena\.copier_snapshot_(?:publications|rows)\b/i
    )
    expect(sqlWithoutLineComments).not.toMatch(
      /\b(?:CREATE|ALTER|DROP)\s+FUNCTION\s+arena\.publish_copier_snapshot\b/i
    )
    expect(sqlWithoutLineComments).not.toMatch(/\bCREATE\s+POLICY\b/i)
    expect(sqlWithoutLineComments).not.toMatch(/^\s*GRANT\b/im)
    expect(sqlWithoutLineComments).not.toMatch(/\bCREATE\s+FUNCTION\s+arena\.publish_/i)
  })

  it('pins the artifact, child-ledger, tuple, multiset, and publisher domains', () => {
    for (const contract of [
      'arena.copier-snapshot-publication-evidence@2',
      'arena.strict-canonical-json@1',
      'arena.ingest.copier-snapshot-artifact@2',
      'arena.ingest.copier-snapshot-artifact@1',
      'arena.ingest.copier-candidate-ledger@1',
      'arena.ingest.copier-parser-conservation@1',
      'arena.ingest.copier-projection-ledger@1',
      'arena.ingest.copier-projection-tuple@1',
      'arena.ingest.length-prefixed-utf8.nonnegative-int32be@1',
      'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1',
      'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1',
      'arena.ingest.copier-occurrence-uniqueness.reject-batch@1',
      'arena.ingest.copier-snapshot-publisher@2',
    ]) {
      expect(migration).toContain(contract)
    }
    expect(migration).toContain("raw_artifact_role = 'copier_snapshot_trust'")
    expect(migration).toContain("parser_contract =\n      'arena.ingest.copier-parser.'")
  })

  it('stores exact evidence coordinates, child hashes, and canonical projection text', () => {
    for (const field of [
      'outer_source_run_id',
      'snapshot_source_run_id',
      'candidate_ledger_sha256',
      'parser_conservation_sha256',
      'projection_ledger_sha256',
      'source_candidate_fixed_multiset_sha256',
      'candidate_projection_fixed_multiset_sha256',
      'row_ordinal',
      'source_page_ordinal',
      'candidate_ordinal',
      'source_candidate_sha256',
      'projection_sha256',
      'copier_pnl_text',
      'copier_invested_text',
      'copy_duration_days_text',
    ]) {
      expect(migration).toContain(field)
    }
    expect(migration).toContain('source_event_at timestamptz CHECK (source_event_at IS NULL)')
    expect(migration).toContain('9007199254740991')
    expect(migration).toContain('2147483647')
    expect(migration).toContain('pg_catalog.trim_scale')
    expect(migration).toContain("U&'\\0009")
  })

  it('fails closed on completeness, rank eligibility, and duplicate occurrences', () => {
    expect(migration).toContain("coverage_state IN ('partial', 'unknown')")
    expect(migration).not.toMatch(/coverage_state\s+IN\s*\([^)]*'complete'/i)
    expect(migration).toContain(
      'rank_eligible boolean NOT NULL DEFAULT false CHECK (NOT rank_eligible)'
    )
    expect(migration).toContain('observed_candidate_count = parsed_row_count')
    expect(migration).toContain('uq_copier_snapshot_trust_row_coordinate')
    expect(migration).toContain('uq_copier_snapshot_trust_row_source_candidate')
    expect(migration).toContain('uq_copier_snapshot_trust_row_projection')
    expect(migration).toContain('uq_copier_snapshot_trust_row_dedupe')
  })

  it('makes a lane-scoped linear chain with one root, no fork, and exact retry identities', () => {
    expect(migration).toContain('fk_copier_snapshot_trust_publication_predecessor')
    expect(migration).toContain('publication_id, source_id, trader_id, lane')
    expect(migration).toContain('uidx_copier_snapshot_trust_publication_root')
    expect(migration).toContain('uidx_copier_snapshot_trust_publication_predecessor')
    expect(migration).toContain('uq_copier_snapshot_trust_publication_outer')
    expect(migration).toContain('uq_copier_snapshot_trust_publication_lane_observation')
    expect(migration).toContain('copier snapshot trust successor clock must increase')
    expect(migration).toContain('idx_copier_snapshot_trust_publication_latest')
  })

  it('keeps RAW tombstones narrow and all new relations/functions API-inaccessible', () => {
    for (const relation of ['copier_snapshot_trust_publications', 'copier_snapshot_trust_rows']) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE arena\\.${relation}\\s+ENABLE ROW LEVEL SECURITY`)
      )
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE arena\\.${relation}\\s+FORCE ROW LEVEL SECURITY`)
      )
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE arena\\.${relation}[\\s\\S]{0,100}FROM PUBLIC, anon, authenticated, service_role`
        )
      )
    }
    expect(migration).toContain(
      'new copier snapshot trust publication requires one live RAW pointer'
    )
    expect(migration).toContain('copier snapshot trust publication RAW role or identity drifted')
    expect(migration).toMatch(
      /FROM arena\.sources AS source_row[\s\S]*?FOR SHARE OF source_row, trader_row/
    )
    expect(migration).toMatch(/FROM arena\.raw_objects AS raw_object[\s\S]*?FOR SHARE;/)
    expect(migration).toContain('NEW.live_raw_object_id IS NULL')
    expect(migration).toContain('pg_catalog.pg_trigger_depth() > 1')
    expect(migration).toContain('quarantined copier snapshot trust RAW evidence cannot be deleted')
    expect(migration).toMatch(
      /CREATE FUNCTION arena\.protect_copier_snapshot_trust_raw_object\(\)[\s\S]*?LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp\s+SET row_security = off/
    )
    expect((migration.match(/\bSECURITY DEFINER\b/g) ?? []).length).toBe(1)
    expect(migration).toContain("v_function.proname = 'protect_copier_snapshot_trust_raw_object'")
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain("'DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER'")
    expect(migration).toContain("ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]")
    expect(migration).toContain("ARRAY['EXECUTE']::text[]")
  })

  it('has a disposable PG17 proof for v1 isolation, ACL, constraints, chain, and GC', () => {
    for (const marker of [
      'legacy v1 fingerprint',
      'wrong trust RAW role migration ledger',
      'RAW protect SECURITY DEFINER/ACL fingerprint',
      'postgres owner ordinary old RAW DML',
      'private API table ACL',
      'duplicate publication idempotency identity',
      'second lane root',
      'publication fork',
      'cross-lane predecessor',
      'duplicate source occurrence',
      'duplicate projection occurrence',
      'concurrent RAW updater blocked by publication FOR SHARE',
      'concurrent RAW updater rejected after publication commit',
      'publication receipt mutation',
      'ordinary RAW GC tombstone',
      'quarantined trust RAW delete',
      'copier snapshot trust publication substrate PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
