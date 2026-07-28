import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260725016500_leaderboard_rank_persisted_codec.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/leaderboard-rank-persisted-codec.pg17.sh'),
  'utf8'
)

describe('leaderboard persisted rank codec', () => {
  it('pins the real 37-column partitioned target and excludes only surrogate id', () => {
    expect(migration).toContain('v_column_count <> 37')
    expect(migration).toContain("('id', 'bigint', true, false)")
    expect(migration).toContain("('arena_score', 'numeric(10,2)', false, false)")
    expect(migration).toContain("('roi', 'numeric(12,4)', false, false)")
    expect(migration).toContain("('pnl', 'numeric(18,2)', false, false)")
    expect(migration).toContain("('arena_score_v4', 'numeric', false, false)")
    expect(migration).toContain("('arena_score_v3', 'numeric', false, false)")
    expect(migration).toContain("('score_factors', 'jsonb', false, false)")
    expect(migration).toContain("('rank_publication_id', 'uuid', false, false)")
    expect(migration).toContain('UNIQUE (season_id, source, source_trader_id)')
    expect(migration).toContain('index_row.indisvalid')
    expect(migration).toContain('index_row.indisready')
    expect(migration).toContain('index_row.indislive')
    expect(migration).toContain("pg_catalog.pg_get_partkeydef(table_row.oid) = 'LIST (season_id)'")
    expect(migration).toContain('ef570914223b68d4ce4f9c5e9217a2a6b0b052c79a6e660c71916441b4e4ab25')
    expect(migration).not.toContain('(p_rank).id,')
    expect(migration).not.toMatch(/created_at|updated_at/)
  })

  it('encodes every persisted business/publication field with a domain-separated format', () => {
    expect(migration).toContain('CREATE FUNCTION arena.encode_leaderboard_rank_row_v1(')
    expect(migration).toContain("'leaderboard-rank-persisted-row@1'")
    expect(migration).toContain("'leaderboard-score-factors@1'")
    expect(migration).toContain('pg_catalog.trim_scale((p_rank).arena_score)::text')
    expect(migration).toContain("(p_rank).computed_at AT TIME ZONE 'UTC'")
    expect(migration).toContain('\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\'')
    expect(migration).toContain('(p_rank).rank_publication_id::text')
    expect(migration).toContain('(p_rank).metrics_estimated')
    expect(pg17Proof).toContain('6e36eea539e6854152727597f8791aa80692d90b1d084445b9d4757a38dfd8c6')
    expect(pg17Proof).toContain("canonical_octet_length'")
    expect(pg17Proof).toContain('|873')
  })

  it('rejects partial, estimated, outlier, malformed, and non-finite rank rows', () => {
    expect(migration).toContain("score_completeness IS DISTINCT FROM 'full'")
    expect(migration).toContain('metrics_estimated IS DISTINCT FROM false')
    expect(migration).toContain('is_outlier IS DISTINCT FROM false')
    expect(migration).toContain("ARRAY['NaN', 'Infinity', '-Infinity']")
    expect(migration).toContain("'2020-01-01 00:00:00+00'::timestamptz")
    expect(migration).toContain("'2100-01-01 00:00:00+00'::timestamptz")
    expect(migration).toContain('persisted leaderboard rank core metric or score is invalid')
    expect(migration).toContain('(p_rank).season_id IS NULL')
    expect(migration).toContain('persisted leaderboard score_factors shape is invalid')
    expect(migration).toContain('NOT v_factors ?& ARRAY[')
    expect(migration).toContain('pg_catalog.pg_column_size(v_factors) > 8192')
    expect(pg17Proof).toContain('codec accepted partial rank metrics')
    expect(pg17Proof).toContain('codec accepted numeric NaN')
    expect(pg17Proof).toContain('codec accepted numeric infinity')
    expect(pg17Proof).toContain('codec accepted infinite computed_at')
    expect(pg17Proof).toContain('codec accepted missing score factor key')
    expect(pg17Proof).toContain('codec accepted string score factor')
  })

  it('builds bounded order-independent evidence from locked persisted rows', () => {
    expect(migration).toContain('CREATE FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(')
    expect(migration).toContain('VOLATILE')
    expect(migration).toContain('PARALLEL UNSAFE')
    expect(migration).toContain('FOR SHARE OF rank_row')
    expect(migration).toContain('ORDER BY (identity.value->>\'source\') COLLATE pg_catalog."C"')
    expect(migration).toContain('When the final lock is acquired all rows coexist')
    expect(migration).toContain(
      'pg_catalog.jsonb_agg(\n            arena.encode_leaderboard_rank_row_v1(rank_row)'
    )
    expect(migration).toContain("pg_catalog.convert_to(v_rank.source_trader_id, 'UTF8')")
    expect(migration).not.toContain('v_normalized_identities')
    expect(migration).not.toContain('v_encoded_rows := v_encoded_rows ||')
    expect(migration).toContain('persisted rank batch contains a duplicate identity')
    expect(migration).toContain('v_row_count < 1 OR v_row_count > 1000')
    expect(migration).toContain("'leaderboard-rank-persisted-batch@1'")
    expect(migration).toContain("'leaderboard-rank-source-identities@1'")
    expect(migration).toContain('canonical encoding exceeds 67108864 bytes')
    expect(pg17Proof).toContain('caller identity order changed persisted batch digest')
    expect(pg17Proof).toContain('persisted batch source proofs changed or lost C order')
    expect(pg17Proof).toContain('single-source 1000-row proof is malformed')
    expect(pg17Proof).toContain('batch accepted duplicate composite identities')
    expect(pg17Proof).toContain('batch rejected or timed out on the 1000-row 24 MiB boundary')
    expect(pg17Proof).toContain('1000-row 24 MiB boundary')
    expect(pg17Proof).toContain('quadratic JSONB accumulator')
    expect(pg17Proof).toContain('batch accepted 1001 identities')
    expect(pg17Proof).toContain('persisted batch evidence did not retain row locks')
    expect(pg17Proof).toContain('concurrency builder never blocked before its final row lock')
    expect(pg17Proof).toContain(
      'concurrent final-row commit was not represented by one locked evidence snapshot'
    )
    expect(pg17Proof).toContain('pg_advisory_lock(4242, 165)')
  })

  it('is private, replay-stable, and fails closed on schema or catalog drift', () => {
    expect(migration).toContain('SECURITY INVOKER')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration).not.toMatch(/GRANT\s+EXECUTE/i)
    expect(migration).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./)
    expect(migration).toContain('persisted rank codec has a noncanonical overload')
    expect(migration).toContain('function_row.prosrc')
    expect(migration).toContain('e667a6cadd6c0c21ecfa2bb920e6583f511a8e6f1c77e5e92f1a1bec36d6122e')
    expect(migration).toContain('bdecbbc94ffbfd966122651552c09e3509f7bb1e87a36f5eb31a31315ea0770b')
    expect(migration).not.toMatch(/__[A-Z0-9_]+__/)
    expect(pg17Proof).toContain('codec migration accepted a partial install')
    expect(pg17Proof).toContain('codec migration accepted numeric typmod drift')
    expect(pg17Proof).toContain('codec migration accepted a detached partition')
    expect(pg17Proof).toContain('codec replay silently repaired a rogue grant')
    expect(pg17Proof).toContain('codec replay accepted volatility drift')
    expect(pg17Proof).toContain('codec replay accepted a missing composite identity constraint')
    expect(pg17Proof).toContain('codec replay accepted a replaced encoder body')
    expect(pg17Proof).toContain(
      'codec replay changed function identity, physical rows, or sequence state'
    )
  })

  it('remains a dormant read-only primitive with one outer transaction', () => {
    expect(migration).toContain('This migration performs no leaderboard DML')
    expect(migration).toContain('not terminal')
    expect(migration).toContain('No DML and not terminal publication authority')
    expect(migration).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM)\s+public\.leaderboard_ranks/i
    )
    expect(migration.trimStart().startsWith('-- Dormant owner-only')).toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/i)
  })
})
