import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729014500_leaderboard_rank_generation_canonical_batches.sql'
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

const withoutComments = migration
  .replace(/^\s*--[^\n]*(?:\n|$)/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

const preflight = withoutComments.match(/DO \$preflight\$([\s\S]*?)\$preflight\$;/)?.[1] ?? ''
const postflight = withoutComments.match(/DO \$postflight\$([\s\S]*?)\$postflight\$;/)?.[1] ?? ''
const rawRpcMatch = migration.match(
  /CREATE OR REPLACE FUNCTION public\.claim_leaderboard_rank_generation\([\s\S]*?\)\s*RETURNS jsonb[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
)
const rpcMatch = withoutComments.match(
  /CREATE OR REPLACE FUNCTION public\.claim_leaderboard_rank_generation\([\s\S]*?\)\s*RETURNS jsonb[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
)
const rpc = rpcMatch?.[1] ?? ''

const normalized = (value: string): string => value.replace(/\s+/g, ' ').trim()

describe('leaderboard rank generation canonical batches', () => {
  it('drains old claim bodies behind one claims-only access-exclusive barrier', () => {
    const claimLock = withoutComments.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_claims\n  IN ACCESS EXCLUSIVE MODE;'
    )
    const installState = withoutComments.indexOf(
      'CREATE TEMP TABLE leaderboard_generation_canonical_install_state'
    )

    expect(claimLock).toBeGreaterThan(-1)
    expect(installState).toBeGreaterThan(claimLock)
    expect(withoutComments).not.toMatch(/LOCK TABLE ONLY arena\.leaderboard_rank_generation_heads/)
    expect(withoutComments).not.toContain('IN SHARE ROW EXCLUSIVE MODE')
  })

  it('proves both concurrent upgrade orders without a head/claims lock cycle', () => {
    expect(pg17Proof).toContain('canonical-old-first-claim-race')
    expect(pg17Proof).toContain('canonical-old-first-migration-race')
    expect(pg17Proof).toContain('canonical-batch-migration-race')
    expect(pg17Proof).toContain('canonical-batch-legacy-claim-race')
    expect(pg17Proof).toMatch(/claims_lock\.mode\s*=\s*'AccessExclusiveLock'/)
    expect(pg17Proof).toMatch(/head_lock\.mode\s*=\s*'RowShareLock'/)
    expect(pg17Proof).toContain(
      'legacy loose claim committed behind the canonical migration barrier'
    )
    expect(pg17Proof).toContain('canonical migration deadlocked or failed in migration-first race')
  })

  it('pins the exact prior claim RPC, catalog shape, ACL, and sole overload', () => {
    expect(preflight).toContain('09f136557ede5e00ef5c519736c81abf44ea7780f336e216591304a746a746a2')
    expect(preflight).toContain("function_row.proowner = 'postgres'::pg_catalog.regrole")
    expect(preflight).toContain("language_row.lanname = 'plpgsql'")
    expect(preflight).toContain('function_row.prosecdef')
    expect(preflight).toContain("function_row.provolatile = 'v'")
    expect(preflight).toContain("function_row.proparallel = 'u'")
    expect(preflight).toContain('function_row.pronargs = 7')
    expect(preflight).toContain("'search_path=pg_catalog, pg_temp'")
    expect(preflight).toContain("'lock_timeout=10s'")
    expect(preflight).toMatch(
      /function_row\.proname\s*=\s*'claim_leaderboard_rank_generation'[\s\S]*?function_row\.oid IS DISTINCT FROM v_claim_function/
    )
    expect(preflight).toMatch(/pg_catalog\.count\(\*\)[\s\S]*?pg_catalog\.aclexplode[\s\S]*?<>\s*2/)
    expect(preflight).toContain("expanded.grantee = 'service_role'::pg_catalog.regrole")
    expect(preflight).toMatch(/has_function_privilege\(\s*'anon'[\s\S]*?'EXECUTE'/)
    expect(preflight).toMatch(/has_function_privilege\(\s*'authenticated'[\s\S]*?'EXECUTE'/)
  })

  it('pins the exact old capacity constraint before interpreting stored claims', () => {
    expect(preflight).toContain('leaderboard_rank_generation_claims_batch_capacity_check')
    expect(preflight).toContain(
      '((expected_batch_count <= 4096) AND (expected_rank_count <= 64000) AND ((expected_rank_count)::bigint <= ((expected_batch_count)::bigint * 1000)))'
    )
    expect(preflight).toContain('constraint_row.conkey = ARRAY[7, 6]::pg_catalog.int2[]')
    expect(preflight).toContain('constraint_row.convalidated')
    expect(preflight).toContain("constraint_row.contype = 'c'")

    const oldConstraintPin = preflight.indexOf('prior generation capacity constraint drifted')
    const historicalScan = preflight.indexOf('historical generation claim is incompatible')
    expect(oldConstraintPin).toBeGreaterThan(-1)
    expect(historicalScan).toBeGreaterThan(oldConstraintPin)
  })

  it('rejects every stored noncanonical population, including the legacy zero case', () => {
    const code = normalized(preflight)

    expect(code).toMatch(
      /FROM ONLY arena\.leaderboard_rank_generation_claims AS claim WHERE claim\.expected_rank_count < 1 OR claim\.expected_rank_count > 64000 OR claim\.expected_batch_count < 1 OR claim\.expected_batch_count > 64 OR claim\.expected_batch_count(?:::bigint)? IS DISTINCT FROM \(claim\.expected_rank_count::bigint \+ 999\) \/ 1000/
    )
    expect(preflight).toContain(
      'historical generation claim is incompatible with canonical 1000-row chunks'
    )
    expect(preflight).toMatch(
      /historical generation claim is incompatible[\s\S]{0,180}ERRCODE = '55000'/
    )
    expect(preflight).not.toMatch(
      /expected_rank_count\s*=\s*0[\s\S]{0,120}expected_batch_count\s*=\s*0/
    )

    const isCanonical = (rankCount: number, batchCount: number): boolean =>
      rankCount >= 1 &&
      rankCount <= 64_000 &&
      batchCount >= 1 &&
      batchCount <= 64 &&
      batchCount === Math.ceil(rankCount / 1000)

    for (const [rankCount, batchCount] of [
      [0, 0],
      [1, 0],
      [1, 2],
      [1000, 2],
      [1001, 1],
      [63_001, 63],
      [64_000, 63],
      [64_001, 64],
      [64_001, 65],
    ]) {
      expect(isCanonical(rankCount, batchCount)).toBe(false)
    }
    for (const [rankCount, batchCount] of [
      [1, 1],
      [1000, 1],
      [1001, 2],
      [63_001, 64],
      [64_000, 64],
    ]) {
      expect(isCanonical(rankCount, batchCount)).toBe(true)
    }
  })

  it('atomically replaces and validates the same canonical capacity check', () => {
    const dropIndex = withoutComments.indexOf(
      'DROP CONSTRAINT\n    leaderboard_rank_generation_claims_batch_capacity_check'
    )
    const addIndex = withoutComments.indexOf(
      'ADD CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check'
    )
    const notValidIndex = withoutComments.indexOf(') NOT VALID;', addIndex)
    const validateIndex = withoutComments.indexOf(
      'VALIDATE CONSTRAINT\n    leaderboard_rank_generation_claims_batch_capacity_check',
      notValidIndex
    )
    const rpcIndex = withoutComments.indexOf(
      'CREATE OR REPLACE FUNCTION public.claim_leaderboard_rank_generation'
    )

    expect(dropIndex).toBeGreaterThan(-1)
    expect(addIndex).toBeGreaterThan(dropIndex)
    expect(notValidIndex).toBeGreaterThan(addIndex)
    expect(validateIndex).toBeGreaterThan(notValidIndex)
    expect(rpcIndex).toBeGreaterThan(validateIndex)

    const check = normalized(withoutComments.slice(addIndex, notValidIndex))
    expect(check).toMatch(/expected_rank_count >= 1/)
    expect(check).toMatch(/expected_rank_count <= 64000/)
    expect(check).toMatch(/expected_batch_count >= 1/)
    expect(check).toMatch(/expected_batch_count <= 64/)
    expect(check).toMatch(
      /expected_batch_count(?:::bigint)? = \(expected_rank_count::bigint \+ 999\) \/ 1000/
    )
  })

  it('keeps the complete seven-argument RPC guard ahead of its first row lock', () => {
    expect(rpcMatch).not.toBeNull()
    expect(withoutComments).toMatch(
      /claim_leaderboard_rank_generation\(\s*p_season_id text,\s*p_score_cohort_id uuid,\s*p_write_set_sha256 text,\s*p_expected_rank_count integer,\s*p_expected_batch_count integer,\s*p_computed_at timestamptz,\s*p_lease_seconds integer\s*\)/
    )
    expect(withoutComments).toMatch(
      /RETURNS jsonb\s*LANGUAGE plpgsql\s*SECURITY DEFINER\s*SET search_path = pg_catalog, pg_temp\s*SET lock_timeout = '10s'/
    )

    const guard = normalized(rpc.slice(0, rpc.indexOf('SELECT head.*')))
    expect(guard).toContain("current_setting('transaction_isolation') <> 'read committed'")
    expect(guard).toContain("p_season_id NOT IN ('7D', '30D', '90D')")
    expect(guard).toContain('p_score_cohort_id IS NULL')
    expect(guard).toContain("p_write_set_sha256 !~ '^[0-9a-f]{64}$'")
    expect(guard).toContain('p_expected_rank_count IS NULL')
    expect(guard).toContain('p_expected_rank_count < 1')
    expect(guard).toContain('p_expected_rank_count > 64000')
    expect(guard).toContain('p_expected_batch_count IS NULL')
    expect(guard).toContain('p_expected_batch_count < 1')
    expect(guard).toContain('p_expected_batch_count > 64')
    expect(guard).toMatch(
      /p_expected_batch_count(?:::bigint)? IS DISTINCT FROM \(p_expected_rank_count::bigint \+ 999\) \/ 1000/
    )
    expect(guard).toContain('NOT pg_catalog.isfinite(p_computed_at)')
    expect(guard).toContain('p_lease_seconds < 15')
    expect(guard).toContain('p_lease_seconds > 300')
    expect(guard).not.toMatch(
      /p_expected_rank_count\s*=\s*0[\s\S]{0,120}p_expected_batch_count\s*=\s*0/
    )
    expect(rpc.indexOf('FOR UPDATE')).toBeGreaterThan(rpc.indexOf('canonical 1000-row batches'))
  })

  it('restores the exact owner-only plus service-role execution surface', () => {
    expect(withoutComments).toMatch(
      /ALTER FUNCTION public\.claim_leaderboard_rank_generation\([\s\S]*?\) OWNER TO postgres;/
    )
    expect(withoutComments).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_leaderboard_rank_generation\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(withoutComments).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_leaderboard_rank_generation\([\s\S]*?\) TO service_role;/
    )
  })

  it('recomputes the replacement body hash and postflights exact catalog authority', () => {
    expect(rawRpcMatch).not.toBeNull()
    const pinnedBodyHash = postflight.match(
      /v_function_body_sha256 IS DISTINCT FROM\s*'([0-9a-f]{64})'/
    )?.[1]
    const actualBodyHash = createHash('sha256')
      .update(rawRpcMatch?.[1] ?? '', 'utf8')
      .digest('hex')

    expect(pinnedBodyHash).toBeDefined()
    expect(pinnedBodyHash).toBe(actualBodyHash)
    expect(pinnedBodyHash).not.toBe(
      '09f136557ede5e00ef5c519736c81abf44ea7780f336e216591304a746a746a2'
    )
    expect(postflight).toContain('v_after_function IS DISTINCT FROM v_before_function')
    expect(postflight).toContain('v_after_constraint IS NOT DISTINCT FROM v_before_constraint')
    expect(postflight).toContain('function_row.pronargs = 7')
    expect(postflight).toContain("function_row.provolatile = 'v'")
    expect(postflight).toContain("function_row.proparallel = 'u'")
    expect(postflight).toContain('constraint_row.conkey = ARRAY[6, 7]::pg_catalog.int2[]')
    expect(postflight).toContain('constraint_row.convalidated')
    expect(postflight).toMatch(
      /FROM ONLY arena\.leaderboard_rank_generation_claims AS claim[\s\S]*?expected_rank_count < 1[\s\S]*?expected_batch_count > 64/
    )
    expect(postflight).toMatch(
      /function_row\.proname\s*=\s*'claim_leaderboard_rank_generation'[\s\S]*?function_row\.oid IS DISTINCT FROM v_after_function/
    )
    expect(postflight).toContain('pg_catalog.has_function_privilege')
  })
})
