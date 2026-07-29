import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh'
  ),
  'utf8'
)

const functionName = 'arena.write_leaderboard_rank_generation_batch_v1'
const writerStart = migration.indexOf(`CREATE FUNCTION ${functionName}(`)
const writerEnd = migration.indexOf(`ALTER FUNCTION ${functionName}(`, writerStart)
const writer =
  writerStart >= 0 && writerEnd > writerStart ? migration.slice(writerStart, writerEnd) : ''

const normalizeCommaList = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

describe('leaderboard rank generation atomic batch writer', () => {
  it('installs exactly one dormant owner-only typed writer signature', () => {
    const signature = migration.match(
      /CREATE FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\(([\s\S]*?)\)\s*RETURNS jsonb/
    )?.[1]

    expect(signature).toBeDefined()
    expect(normalizeCommaList(signature!)).toEqual([
      'p_season_id text',
      'p_generation_seq bigint',
      'p_score_cohort_id uuid',
      'p_batch_index integer',
      'p_score_input_manifest_id uuid',
      'p_score_input_manifest_digest text',
      'p_batch_sha256_plan text[]',
      'p_rows arena.leaderboard_rank_batch_row_v1[]',
    ])
    expect(writer).not.toBe('')
    expect(writer).toMatch(
      /RETURNS jsonb\s+LANGUAGE plpgsql\s+VOLATILE\s+CALLED ON NULL INPUT\s+PARALLEL UNSAFE\s+SECURITY INVOKER/
    )
    expect(writer).toContain('SET search_path = pg_catalog, pg_temp')
    expect(writer).toContain('SET "TimeZone" = \'UTC\'')
    expect(migration).toMatch(
      /ALTER FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\([\s\S]*?OWNER TO postgres;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).not.toMatch(/GRANT\s+(?:ALL|EXECUTE)/i)
    expect(migration).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./)
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/i)
  })

  it('verifies the immutable plan before returning a frozen zero-write replay', () => {
    const claimLookup = writer.indexOf(
      'FROM ONLY arena.leaderboard_rank_generation_claims AS claim'
    )
    const typedEvidence = writer.indexOf('arena.build_leaderboard_rank_typed_batch_evidence_v1(')
    const writeSet = writer.indexOf('arena.build_leaderboard_rank_generation_write_set_sha256_v1(')
    const receiptLookup = writer.indexOf(
      'FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt'
    )
    const replayReturn = writer.indexOf('RETURN pg_catalog.jsonb_build_object(', receiptLookup)
    const headLookup = writer.indexOf(
      'FROM ONLY arena.leaderboard_rank_generation_heads AS head',
      replayReturn
    )
    const manifestLookup = writer.indexOf(
      'FROM ONLY arena.leaderboard_score_input_manifests AS stored',
      replayReturn
    )

    expect(claimLookup).toBeGreaterThan(-1)
    expect(typedEvidence).toBeGreaterThan(claimLookup)
    expect(writeSet).toBeGreaterThan(typedEvidence)
    expect(receiptLookup).toBeGreaterThan(writeSet)
    expect(replayReturn).toBeGreaterThan(receiptLookup)
    expect(headLookup).toBeGreaterThan(replayReturn)
    expect(manifestLookup).toBeGreaterThan(replayReturn)

    const replayPath = writer.slice(receiptLookup, replayReturn)
    expect(replayPath).toContain('batch_sha256')
    expect(replayPath).toContain('score_input_manifest_id')
    expect(replayPath).toContain('score_input_manifest_digest')
    expect(replayPath).toContain('row_count')
    expect(replayPath).toContain('source_count')
    expect(replayPath).toContain('first_source')
    expect(replayPath).toContain('first_source_trader_id')
    expect(replayPath).toContain('last_source')
    expect(replayPath).toContain('last_source_trader_id')
    expect(replayPath).toContain('arena.leaderboard_rank_generation_source_fence_receipts')
    expect(replayPath).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|LOCK TABLE)\b/)
    expect(writer).toContain('generation batch receipt conflicts with immutable replay')
    expect(pg17Proof).toContain('terminal generation exact replay was not frozen')
    expect(pg17Proof).toContain('expired generation exact replay was not frozen')
    expect(pg17Proof).toContain('exact replay depended on a pruned manifest')
    expect(pg17Proof).toContain(
      'exact replay changed rank, head, fence, receipt, or sequence state'
    )
    expect(pg17Proof).toContain('replay accepted incomplete source-receipt topology')
    expect(pg17Proof).toContain('replay accepted a different immutable batch payload')
  })

  it('takes authorization, manifest, rank-table, and source locks in one deadlock-safe order', () => {
    const replayReturn = writer.indexOf('RETURN pg_catalog.jsonb_build_object(')
    const headLookup = writer.indexOf(
      'FROM ONLY arena.leaderboard_rank_generation_heads AS head',
      replayReturn
    )
    const headLock = writer.indexOf('FOR UPDATE', headLookup)
    const firstAuthorizationClock = writer.indexOf('pg_catalog.clock_timestamp()', headLock)
    const manifestLookup = writer.indexOf(
      'FROM ONLY arena.leaderboard_score_input_manifests AS stored',
      firstAuthorizationClock
    )
    const manifestLock = writer.indexOf('FOR SHARE', manifestLookup)
    const rankTableLock = writer.indexOf(
      'LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE',
      manifestLock
    )
    const fenceSeed = writer.indexOf(
      'INSERT INTO arena.leaderboard_rank_mutation_fences',
      rankTableLock
    )
    const fenceLookup = writer.indexOf(
      'FROM ONLY arena.leaderboard_rank_mutation_fences AS fence',
      fenceSeed
    )
    const fenceLock = writer.indexOf('FOR UPDATE', fenceLookup)
    const upsert = writer.indexOf('INSERT INTO public.leaderboard_ranks', fenceLock)
    const persistedEvidence = writer.indexOf(
      'arena.build_leaderboard_rank_batch_evidence_v1(',
      upsert
    )
    const finalAuthorizationClock = writer.indexOf(
      'pg_catalog.clock_timestamp()',
      persistedEvidence
    )

    expect(headLookup).toBeGreaterThan(replayReturn)
    expect(headLock).toBeGreaterThan(headLookup)
    expect(firstAuthorizationClock).toBeGreaterThan(headLock)
    expect(manifestLookup).toBeGreaterThan(firstAuthorizationClock)
    expect(manifestLock).toBeGreaterThan(manifestLookup)
    expect(rankTableLock).toBeGreaterThan(manifestLock)
    expect(fenceSeed).toBeGreaterThan(rankTableLock)
    expect(fenceLookup).toBeGreaterThan(fenceSeed)
    expect(fenceLock).toBeGreaterThan(fenceLookup)
    expect(upsert).toBeGreaterThan(fenceLock)
    expect(persistedEvidence).toBeGreaterThan(upsert)
    expect(finalAuthorizationClock).toBeGreaterThan(persistedEvidence)
    expect(writer.match(/pg_catalog\.clock_timestamp\(\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(writer).toMatch(/ORDER BY [a-z_.]+source COLLATE pg_catalog\."C"/)
    expect(writer).toContain("v_head.phase NOT IN ('claimed', 'writing')")
    expect(writer).toContain('head.lease_expires_at <=')
    expect(writer).toContain('generation lease expired while atomic batch write was waiting')
    expect(pg17Proof).toContain('post-lock clock did not reject an expired writer lease')
    expect(pg17Proof).toContain(
      'expired-after-lock batch changed rank, head, fence, or receipt state'
    )
  })

  it('admits only the manifest exact positive slice with deterministic typmod quantization', () => {
    expect(writer).toContain("v_manifest.manifest->'inputs'")
    expect(writer).toContain("v_manifest.manifest->'outputs'")
    expect(writer).toContain("->>'totalScore'")
    expect(writer).toContain("->'factors'")
    for (const field of [
      'source',
      'source_trader_id',
      'roi',
      'pnl',
      'max_drawdown',
      'win_rate',
      'sharpe_ratio',
      'profit_factor',
      'trades_count',
    ]) {
      expect(writer).toContain(`->>'${field}'`)
    }
    expect(writer.match(/::double precision/g)?.length).toBeGreaterThanOrEqual(9)
    expect(writer).toContain('pg_catalog.floor(')
    expect(writer).toContain('0.3')
    expect(writer).toContain('0.2')
    expect(writer).toContain('0.5')
    expect(writer).toContain('profitability_score')
    expect(writer).toContain('risk_control_score')
    expect(writer).toContain('execution_score')
    expect(writer).toContain('score_factors')
    expect(writer).toContain('manifest positive output count disagrees with generation claim')
    expect(writer).toContain('typed batch is not an exact manifest-positive slice')
    expect(writer).toContain('pg_catalog.jsonb_path_query_array(')
    expect(writer).toContain("'$[*] ? (@.totalScore > 0)'::pg_catalog.jsonpath")
    expect(writer).toContain('v_positive_slice')
    expect(writer.match(/arena\.verify_leaderboard_score_input_manifest_v1\(/g)).toHaveLength(1)
    expect(pg17Proof).toContain('replay accepted a different immutable batch payload')
  })

  it('overwrites every non-key persisted field and injects all server-owned authority', () => {
    const insertColumns = writer.match(
      /INSERT INTO public\.leaderboard_ranks(?: AS [a-z_]+)?\s*\(([\s\S]*?)\)\s*SELECT/
    )?.[1]
    expect(insertColumns).toBeDefined()
    expect(normalizeCommaList(insertColumns!)).toEqual([
      'season_id',
      'source',
      'source_type',
      'source_trader_id',
      'rank',
      'arena_score',
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'followers',
      'trades_count',
      'handle',
      'avatar_url',
      'computed_at',
      'profitability_score',
      'risk_control_score',
      'execution_score',
      'score_completeness',
      'trading_style',
      'avg_holding_hours',
      'style_confidence',
      'sharpe_ratio',
      'sortino_ratio',
      'profit_factor',
      'calmar_ratio',
      'trader_type',
      'is_outlier',
      'metrics_estimated',
      'rank_change',
      'is_new',
      'copiers',
      'arena_score_v4',
      'arena_score_v3',
      'score_factors',
      'rank_publication_id',
    ])

    const conflict = writer.match(
      /ON CONFLICT \(season_id, source, source_trader_id\)\s*DO UPDATE SET([\s\S]*?)\n\s*RETURNING/
    )?.[1]
    expect(conflict).toBeDefined()
    const updatedColumns = normalizeCommaList(insertColumns!).filter(
      (column) => !['season_id', 'source', 'source_trader_id'].includes(column)
    )
    for (const column of updatedColumns) {
      expect(conflict).toMatch(
        new RegExp(`(?:[a-z_]+\\.)?${column}\\s*=\\s*EXCLUDED\\.${column}\\b`)
      )
    }
    expect(conflict!.match(/EXCLUDED\./g)).toHaveLength(33)
    expect(conflict).not.toContain('COALESCE(')
    expect(writer).toContain('v_claim.computed_at')
    expect(writer).toContain('p_score_cohort_id')
    expect(writer).not.toMatch(/rank_publication_id\s*=\s*(?:input|typed_row|row_input)\./)
    expect(pg17Proof).toContain('atomic upsert retained stale nullable rank fields')
    expect(pg17Proof).toContain('atomic upsert trusted caller-owned generation authority')
  })

  it('proves post-write persisted equality before recording complete fence receipts', () => {
    const upsert = writer.indexOf('INSERT INTO public.leaderboard_ranks')
    const persistedEvidence = writer.indexOf(
      'arena.build_leaderboard_rank_batch_evidence_v1(',
      upsert
    )
    const equalityCheck = writer.indexOf('IS DISTINCT FROM', persistedEvidence)
    const batchReceipt = writer.indexOf(
      'INSERT INTO arena.leaderboard_rank_generation_batch_receipts',
      equalityCheck
    )
    const sourceReceipt = writer.indexOf(
      'arena.leaderboard_rank_generation_source_fence_receipts',
      batchReceipt
    )
    const headUpdate = writer.indexOf(
      'UPDATE ONLY arena.leaderboard_rank_generation_heads',
      Math.max(batchReceipt, sourceReceipt)
    )

    expect(persistedEvidence).toBeGreaterThan(upsert)
    expect(equalityCheck).toBeGreaterThan(persistedEvidence)
    expect(batchReceipt).toBeGreaterThan(equalityCheck)
    expect(sourceReceipt).toBeGreaterThan(equalityCheck)
    expect(headUpdate).toBeGreaterThan(batchReceipt)
    expect(headUpdate).toBeGreaterThan(sourceReceipt)
    expect(writer).toContain('typed and persisted batch evidence diverged')
    expect(writer).toContain('mutation_seq_before')
    expect(writer).toContain('mutation_seq_after')
    expect(writer).toMatch(
      /mutation_window\.mutation_seq_after\s*-\s*mutation_window\.mutation_seq_before/
    )
    expect(writer).toContain('source_identity_sha256')
    expect(writer).toContain('prior batch source fence does not continue')
    expect(writer).toContain('batch_index')
    expect(writer).toContain('expected_batch_count')
    expect(writer).toContain('expected_rank_count')
    expect(writer).toContain('previous batch identity range overlaps this batch')
    expect(writer).toContain("SET phase = 'writing'")
    expect(writer).not.toMatch(/\n\s*EXCEPTION\s+WHEN/)
    expect(pg17Proof).toContain('persisted evidence was not byte-identical to typed evidence')
    expect(pg17Proof).toContain(
      'mixed insert-update batch recorded the wrong per-source fence delta'
    )
    expect(pg17Proof).toContain(
      'successful atomic batch did not commit ranks and receipts together'
    )
  })

  it('rolls every failed batch back and leaves no partial authority behind', () => {
    expect(pg17Proof).toContain('persisted mismatch changed rank, head, fence, or receipt state')
    expect(pg17Proof).toContain(
      'expired-after-lock batch changed rank, head, fence, or receipt state'
    )
    expect(pg17Proof).toContain(
      'mixed insert-update batch recorded the wrong per-source fence delta'
    )
    expect(pg17Proof).toContain(
      'successful atomic batch did not commit ranks and receipts together'
    )
  })

  it('pins dependency and callable catalogs and fails closed on replay drift', () => {
    expect(migration).toContain('7fa1e9f60a7b6cb4072dce842ddd10c367046fcb431a2ae655a9a806172df67e')
    expect(migration).toContain('f82b8b26dee4b1b5a92d4750ad42ed65d91bd7972bac0ef0f14f0b94e24f197d')
    expect(migration).toContain('bdecbbc94ffbfd966122651552c09e3509f7bb1e87a36f5eb31a31315ea0770b')
    expect(migration).toContain('function_row.prosrc')
    expect(migration).toContain('function_row.proargtypes = ARRAY[')
    expect(migration).toContain('function_row.proargnames = ARRAY[')
    expect(migration).toContain('atomic batch writer has a noncanonical overload')
    expect(migration).toContain('atomic batch writer dependency catalog drifted')
    expect(migration).toContain('atomic batch writer body drifted')
    expect(migration).toContain('2f31f274ddac524b3de3eac8962fa079414b790807f57e509acc5eb3686d005a')
    expect(migration).toContain('84c34d0b190ae745a2516a4e8b63111ba8f82dd2adc586e3836ea086e9d962a7')
    expect(migration).toContain('e8d93b0faac5f16601a1b7a3e750fe46345ec2465e67297bb52fefdf005cdd74')
    expect(migration.match(/'[0-9a-f]{64}'/g)?.length).toBeGreaterThanOrEqual(4)
    expect(migration).not.toMatch(/__[A-Z0-9_]+__/)
    expect(migration).not.toMatch(/(?:TODO|TBD|PLACEHOLDER)[_: -]*[A-Z0-9_]*/i)
    expect(pg17Proof).toContain("EXPECTED_DEPENDENCY_DIGESTS=$'acl|13|")
    expect(pg17Proof).toContain('catalog|12|cbd7e49f')
    expect(pg17Proof).toContain("printf 'writer-body|%s\\n'")
  })

  it('uses one outer transaction and never publishes an API RPC', () => {
    expect(migration.trimStart().startsWith('-- Dormant owner-only')).toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).not.toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration).not.toMatch(/^\s*(?:TRUNCATE|DROP TABLE|DROP FUNCTION)\b/im)
  })
})
