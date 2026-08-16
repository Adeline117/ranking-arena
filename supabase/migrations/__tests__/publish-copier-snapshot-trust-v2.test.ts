import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const migrationFile = '20260808021000_publish_copier_snapshot_trust_v2.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationFile), 'utf8')
const proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/publish-copier-snapshot-trust-v2.pg17.sh'),
  'utf8'
)
const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
const sqlWithoutLineComments = migration.replace(/^\s*--.*$/gm, '')

describe('copier snapshot trust v2 atomic publisher', () => {
  it('is one ordered migration bound to the exact reviewed substrate body', () => {
    const identity = migrationFile.match(/^(\d{14})_(.+)\.sql$/)
    expect(identity?.[1]).toBe('20260808021000')
    expect(identity?.[2]).toBe('publish_copier_snapshot_trust_v2')
    expect('20260808021000' > '20260808020000').toBe(true)
    expect(
      readdirSync(join(process.cwd(), 'supabase/migrations')).filter((name) =>
        name.startsWith('20260808021000_')
      )
    ).toEqual([migrationFile])

    expect(migration).toContain("ledger.name = 'copier_snapshot_trust_publication_substrate'")
    expect(migration).toContain('2d86fc0a15fc8e75791e29da17f79b772a9d15ebd8f22702689d16599dbf16ae')
    expect(migration).toContain(
      'requires one exact copier_snapshot_trust_publication_substrate migration ledger name and body'
    )
  })

  it('accepts only the four canonical child TEXT values and rebuilds the outer bytes before JSON parsing', () => {
    expect(migration).toMatch(
      /CREATE FUNCTION arena\.publish_copier_snapshot_trust_v2\(\s*p_raw_object_id bigint,\s*p_source_id smallint,\s*p_trader_id bigint,\s*p_lane text,\s*p_outer_source_run_id text,\s*p_snapshot_strict_canonical_json text,\s*p_candidate_ledger_strict_canonical_json text,\s*p_parser_conservation_strict_canonical_json text,\s*p_projection_ledger_strict_canonical_json text\s*\)/s
    )
    expect(migration).toContain('v_snapshot_sha256 := pg_catalog.encode(')
    expect(migration).toContain('v_outer_preimage :=')
    expect(migration).toContain('"candidate_ledger":')
    expect(migration).toContain('"snapshot_source_run_id":"')
    expect(migration.indexOf('v_outer_preimage :=')).toBeLessThan(
      migration.indexOf('v_snapshot := p_snapshot_strict_canonical_json::jsonb')
    )
    expect(migration).toContain('v_outer_sha256 IS DISTINCT FROM p_outer_source_run_id')
    expect(migration).toContain(
      'copier snapshot trust RAW byte anchor, child anchors, role, or retention state mismatch'
    )
    expect(migration).toContain('canonical evidence exceeds byte limit')
    expect(migration).toContain('outer artifact exceeds byte limit')
  })

  it('pins every SQL parser-affecting GUC used by decimal and regex contracts', () => {
    expect(migration).toContain('SET LOCAL standard_conforming_strings = on')
    expect(migration).toMatch(
      /CREATE FUNCTION arena\.copier_snapshot_trust_float8_plain_decimal_v2\(p_value text\)[\s\S]*?SET extra_float_digits = 3[\s\S]*?SET standard_conforming_strings = on/s
    )
    expect(migration).toMatch(
      /CREATE FUNCTION arena\.publish_copier_snapshot_trust_v2\([\s\S]*?SET row_security = off\s+SET standard_conforming_strings = on/s
    )
    expect(migration).toContain("'extra_float_digits=3'")
    expect(migration).toContain("'standard_conforming_strings=on'")
    expect(migration).toContain('0.10000000000000001')
  })

  it('replays exact candidate/parser/projection occurrences and fixed byte multisets without deduplication', () => {
    expect(migration).toContain('candidate page count failed')
    expect(migration).toContain('candidate occurrence count failed')
    expect(migration).toContain('parser conservation binding failed')
    expect(migration).toContain('projection child binding failed')
    expect(migration).toContain('projection row shape failed')
    expect(migration).toContain('tuple hash, parser ordinal, or candidate coordinate replay failed')
    expect(migration).toContain('fixed-byte multiset replay failed')
    expect(migration).toContain('pg_catalog.int8send(pg_catalog.count(*))')
    expect(migration).toMatch(
      /string_agg\(\s*member,\s*pg_catalog\.decode\('', 'hex'\) ORDER BY member/s
    )
    expect(migration).not.toMatch(/\bDISTINCT\s+member\b/i)
    expect(migration).not.toMatch(/ON CONFLICT\s+DO NOTHING/i)
  })

  it('keeps publication private, non-ranking, and serializable against mutable evidence', () => {
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION arena.publish_copier_snapshot_trust_v2')
    expect(migration).toContain('TO service_role')
    expect(migration).toContain('REVOKE ALL ON FUNCTION')
    expect(migration).toContain('FOR SHARE;')
    expect(migration).toContain('publish-copier-snapshot-trust-v2:lane:')
    expect(migration).toContain('publication clock is stale')
    expect(migration).toContain("(v_live_trader.meta->>'claimed') IS NOT DISTINCT FROM 'true'")
    expect(migration).toContain("WHEN v_caller_limited OR v_source_depth <> 'full' THEN 'partial'")
    expect(migration).toContain("ELSE 'unknown'")
    expect(migration).toMatch(/v_coverage_state,\s+false\s+\)/)
    expect(migration).toContain('IF NOT v_was_replayed AND NOT v_is_current_head THEN')
    expect(sqlWithoutLineComments).not.toMatch(
      /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:ONLY\s+)?arena\.copier_snapshot_(?!trust_)/i
    )
  })

  it('has a PostgreSQL 17 proof covering byte anchors, GUC isolation, replay, and negative vectors', () => {
    for (const marker of [
      'Disposable PostgreSQL 17 proof',
      'legacy v1 fingerprint',
      'service-role-only SECURITY DEFINER ACL fingerprint',
      'fixed outer canonical preimage SHA-256',
      'golden atomic publication receipt',
      'hostile extra_float_digits helper isolation',
      'hostile session GUC exact retry isolation',
      'canonical-text whitespace tamper',
      'projection count omission',
      'projection reorder',
      'projection tuple hash fabrication',
      'fixed multiset domain/hash tamper',
      'candidate pages.length/page_count drift',
      'non-shortest JavaScript decimal',
      'string claimed trader',
      'boolean claimed trader',
      'SET standard_conforming_strings=off',
      'SET extra_float_digits=-15',
    ]) {
      expect(proof).toContain(marker)
    }
  })

  it('runs the complete RAW role, substrate, and publisher proof chain in CI', () => {
    expect(packageJson).toContain(
      '"qa:copier-trust-publisher-v2-pg17": "bash supabase/migrations/__tests__/copier-snapshot-trust-raw-role.pg17.sh && bash supabase/migrations/__tests__/copier-snapshot-trust-publication-substrate.pg17.sh && bash supabase/migrations/__tests__/publish-copier-snapshot-trust-v2.pg17.sh"'
    )
    expect(ciWorkflow).toContain('name: Prove copier snapshot trust v2 publisher')
    expect(ciWorkflow).toContain('run: npm run qa:copier-trust-publisher-v2-pg17')
  })
})
