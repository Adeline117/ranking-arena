import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260725017000_leaderboard_rank_typed_batch_contract.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-typed-batch-contract.pg17.sh'
  ),
  'utf8'
)
const persistedCodecProof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/leaderboard-rank-persisted-codec.pg17.sh'),
  'utf8'
)

describe('leaderboard typed rank batch contract', () => {
  it('exposes exactly 33 typed business fields and no server-owned authority', () => {
    const definition = migration.match(
      /CREATE TYPE arena\.leaderboard_rank_batch_row_v1 AS \(([^]*?)\n    \);/
    )?.[1]
    expect(definition).toBeDefined()

    const fields = definition!
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter(Boolean)
    expect(fields).toEqual([
      'source text',
      'source_type text',
      'source_trader_id text',
      'rank integer',
      'arena_score numeric(10, 2)',
      'roi numeric(12, 4)',
      'pnl numeric(18, 2)',
      'win_rate numeric(5, 2)',
      'max_drawdown numeric(5, 2)',
      'followers integer',
      'trades_count integer',
      'handle text',
      'avatar_url text',
      'profitability_score numeric(6, 2)',
      'risk_control_score numeric(6, 2)',
      'execution_score numeric(6, 2)',
      'score_completeness text',
      'trading_style text',
      'avg_holding_hours numeric(10, 2)',
      'style_confidence numeric(6, 4)',
      'sharpe_ratio numeric(10, 4)',
      'sortino_ratio numeric(10, 4)',
      'profit_factor numeric(10, 4)',
      'calmar_ratio numeric(10, 4)',
      'trader_type text',
      'is_outlier boolean',
      'metrics_estimated boolean',
      'rank_change integer',
      'is_new boolean',
      'copiers integer',
      'arena_score_v4 numeric',
      'arena_score_v3 numeric',
      'score_factors jsonb',
    ])
    expect(definition).not.toMatch(/\b(?:id|season_id|computed_at|rank_publication_id)\b/)
    expect(migration).toContain('v_column_count <> 37')
    expect(migration).toContain(') <> 33 OR EXISTS (')
  })

  it('injects generation authority and delegates rank eligibility to the pinned codec', () => {
    expect(migration.indexOf('LOCK TABLE ONLY public.leaderboard_ranks')).toBeLessThan(
      migration.indexOf('v_column_contract_sha256')
    )
    expect(migration).toContain('153127c5850e4f841b32bb3809b78bb815bed23643caf8394fb92997d6535514')
    expect(migration).toContain('persisted rank codec dependency has a noncanonical overload')
    expect(migration).toContain('function_row.proargtypes = ARRAY[')
    expect(migration).toContain('function_row.proargnames = ARRAY[')
    expect(migration).toContain('NULL::bigint,')
    expect(migration).toContain('p_season_id,')
    expect(migration).toContain('p_computed_at,')
    expect(migration).toContain('p_score_cohort_id')
    expect(migration).toContain(')::public.leaderboard_ranks')
    expect(migration).toContain('arena.encode_leaderboard_rank_row_v1(rank_row)')
    expect(migration).toContain('e667a6cadd6c0c21ecfa2bb920e6583f511a8e6f1c77e5e92f1a1bec36d6122e')
    expect(migration).toContain('bdecbbc94ffbfd966122651552c09e3509f7bb1e87a36f5eb31a31315ea0770b')
    expect(migration).toContain('v_row_count < 1')
    expect(migration).toContain('v_row_count > 1000')
    expect(migration).toContain('duplicate identity')
    expect(migration).toContain('ORDER BY input.source COLLATE pg_catalog."C"')
    expect(migration).not.toContain('v_encoded_rows := v_encoded_rows ||')
  })

  it('builds the same domain-separated persisted evidence in one canonical pass', () => {
    expect(migration).toContain("'leaderboard-rank-persisted-batch@1'")
    expect(migration).toContain("'leaderboard-rank-persisted-batch-evidence@1'")
    expect(migration).toContain("'leaderboard-rank-source-identities@1'")
    expect(migration).toContain('canonical encoding exceeds 67108864 bytes')
    expect(pg17Proof).toContain('6e36eea539e6854152727597f8791aa80692d90b1d084445b9d4757a38dfd8c6')
    expect(pg17Proof).toContain('typed evidence is not byte-identical to persisted evidence')
    expect(pg17Proof).toContain('typed evidence diverged at the 1000-row boundary')
    expect(pg17Proof).toContain('caller typed-row order changed canonical evidence')
    expect(pg17Proof).toContain('server-owned typed batch authority did not affect its digest')
  })

  it('fails the entire typed batch closed for partial, unknown, and untrusted rows', () => {
    expect(pg17Proof).toContain('typed batch accepted a partial row among valid rows')
    expect(pg17Proof).toContain('typed batch accepted an unknown row among valid rows')
    expect(pg17Proof).toContain('typed batch accepted an estimated row among valid rows')
    expect(pg17Proof).toContain('typed batch accepted an unknown core metric among valid rows')
    expect(pg17Proof).toContain('failed partial/unknown typed batch changed persisted rank state')
    expect(pg17Proof).toContain('typed batch accepted a duplicate composite identity')
    expect(pg17Proof).toContain('typed batch accepted a zero-based array')
    expect(pg17Proof).toContain('typed batch accepted 1001 rows')
  })

  it('content-addresses one feasible ordered generation plan without duplicates', () => {
    expect(migration).toContain("'leaderboard-rank-generation-write-set@1'")
    expect(migration).toContain('v_distinct_batch_count <> v_batch_count')
    expect(migration).toContain('DISTINCT digest.value COLLATE pg_catalog."C"')
    expect(migration).toContain('p_expected_rank_count::bigint <=')
    expect(migration).toContain('v_batch_count::bigint * 1000')
    expect(migration).toContain('pg_catalog.array_lower(p_batch_sha256_plan, 1)')
    expect(migration).toContain('pg_catalog.pg_column_size(p_batch_sha256_plan) > 1048576')
    expect(migration).not.toContain('p_batch_sha256_plan::text')
    expect(migration).not.toContain('p_expected_rank_count::text')
    expect(pg17Proof).toContain('ec126bc4dc90a99ddaba2c43e558298ebb9b9cf83c33fc060d90331a420584b9')
    expect(pg17Proof).toContain('ordered generation batch plan did not affect write-set digest')
    expect(pg17Proof).toContain('write-set accepted impossible batch capacity')
    expect(pg17Proof).toContain('write-set accepted a duplicate batch digest')
    expect(pg17Proof).toContain('write-set accepted a multidimensional digest plan')
    expect(pg17Proof).toContain('session timezone changed generation write-set digest')
  })

  it('is private, dormant, replay-stable, and fail-closed on catalog drift', () => {
    expect(migration).toContain('SECURITY INVOKER')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration).not.toMatch(/GRANT\s+(?:USAGE|EXECUTE)/i)
    expect(migration).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./)
    expect(migration).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM)\s+public\.leaderboard_ranks/i
    )
    expect(migration).toContain('7fa1e9f60a7b6cb4072dce842ddd10c367046fcb431a2ae655a9a806172df67e')
    expect(migration).toContain('f82b8b26dee4b1b5a92d4750ad42ed65d91bd7972bac0ef0f14f0b94e24f197d')
    expect(migration).not.toMatch(/__[A-Z0-9_]+__/)
    expect(pg17Proof).toContain('typed contract replay changed object, rank-row, or sequence state')
    expect(pg17Proof).toContain('typed replay silently repaired a rogue type grant')
    expect(pg17Proof).toContain('typed migration accepted a codec dependency overload')
    expect(pg17Proof).toContain('typed replay accepted a non-API codec dependency grant')
    expect(pg17Proof).toContain('typed replay accepted composite attribute drift')
    expect(pg17Proof).toContain('typed replay accepted positional parent-column drift')
    expect(pg17Proof).toContain('typed replay accepted a replaced write-set body')
    expect(persistedCodecProof).toContain('LEADERBOARD_TYPED_BATCH_PG17_EXTENSION')
    expect(migration.trimStart().startsWith('-- Dormant owner-only')).toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/i)
  })
})
