import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260725015000_leaderboard_rank_generation_claim.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/leaderboard-rank-generation-claim.pg17.sh'),
  'utf8'
)

const functionMatch = migration.match(
  /CREATE OR REPLACE FUNCTION public\.claim_leaderboard_rank_generation\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
)
const functionBody = functionMatch?.[1] ?? ''

describe('durable leaderboard rank generation claims', () => {
  it('adds only an expand-only claim ledger, fencing heads, and one RPC', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.match(/^CREATE TABLE IF NOT EXISTS/gm)).toHaveLength(2)
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_generation_claims'
    )
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_generation_heads'
    )
    expect(migration).not.toMatch(/DROP\s+(?:FUNCTION|TABLE|VIEW)/i)
    expect(migration).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\.leaderboard_ranks\b/i
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('persists a globally unique immutable generation identity', () => {
    expect(migration).toContain('PRIMARY KEY (season_id, generation_seq)')
    expect(migration).toContain('UNIQUE (score_cohort_id)')
    expect(migration).toContain('UNIQUE (season_id, generation_seq, score_cohort_id)')
    expect(migration).toContain("CHECK (contract = 'leaderboard-rank-generation-claim@1')")
    expect(migration).toContain("CHECK (write_set_sha256 ~ '^[0-9a-f]{64}$')")
    expect(migration).toContain('CHECK (generation_seq > 0 AND generation_seq <= 9007199254740000)')
    expect(migration).toContain('CHECK (lease_seconds >= 15 AND lease_seconds <= 300)')
    expect(migration).toContain('CREATE TRIGGER leaderboard_rank_generation_claim_immutable')
    expect(migration).toContain(
      'EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation()'
    )
    expect(migration).toContain(
      'ALTER TABLE arena.leaderboard_rank_generation_claims ENABLE ROW LEVEL SECURITY'
    )
  })

  it('preseeds exactly one idle linearization head for every public season', () => {
    for (const season of ['7D', '30D', '90D']) {
      expect(migration).toContain(`('${season}', 0, NULL, 'idle', NULL`)
    }
    expect(migration).toContain('FOREIGN KEY (season_id, generation_seq, score_cohort_id)')
    expect(migration).toContain('REFERENCES arena.leaderboard_rank_generation_claims')
    expect(migration).toMatch(
      /phase IN \(\s*'idle', 'claimed', 'writing', 'cleaned', 'reranked', 'sealed', 'failed'\s*\)/
    )
    expect(migration).toMatch(
      /phase IN \('claimed', 'writing', 'cleaned', 'reranked'\)\s+AND lease_expires_at IS NOT NULL\s+AND pg_catalog\.isfinite\(lease_expires_at\)/
    )
    expect(migration).toContain('generation head season set is not exact')
  })

  it('accepts only bounded, coherent, canonical claim inputs', () => {
    expect(functionBody).not.toBe('')
    expect(functionBody).toContain("p_season_id NOT IN ('7D', '30D', '90D')")
    expect(functionBody).toContain('p_score_cohort_id IS NULL')
    expect(functionBody).toContain("p_write_set_sha256 !~ '^[0-9a-f]{64}$'")
    expect(functionBody).toContain('p_expected_rank_count > 250000')
    expect(functionBody).toContain('p_expected_batch_count <= p_expected_rank_count')
    expect(functionBody).toContain('NOT pg_catalog.isfinite(p_computed_at)')
    expect(functionBody).toContain('p_lease_seconds < 15')
    expect(functionBody).toContain('p_lease_seconds > 300')
    expect(functionBody).toContain("USING ERRCODE = '22023'")
  })

  it('linearizes at the season head and takes its authorization clock after waiting', () => {
    const headLock = functionBody.indexOf(
      'FROM ONLY arena.leaderboard_rank_generation_heads AS head'
    )
    const forUpdate = functionBody.indexOf('FOR UPDATE', headLock)
    const authorizationClock = functionBody.indexOf(
      'v_now := pg_catalog.clock_timestamp()',
      forUpdate
    )
    const claimLookup = functionBody.indexOf(
      'FROM ONLY arena.leaderboard_rank_generation_claims AS claim',
      authorizationClock
    )

    expect(headLock).toBeGreaterThan(-1)
    expect(forUpdate).toBeGreaterThan(headLock)
    expect(authorizationClock).toBeGreaterThan(forUpdate)
    expect(claimLookup).toBeGreaterThan(authorizationClock)
    expect(functionBody.match(/pg_catalog\.clock_timestamp\(\)/g)).toHaveLength(1)
    expect(functionBody).toContain(
      "pg_catalog.current_setting('transaction_isolation') <> 'read committed'"
    )
    expect(functionBody).toContain("USING ERRCODE = '25001'")
  })

  it('freezes exact response-loss replay without renewing or reviving a cohort', () => {
    const existingLookup = functionBody.indexOf('WHERE claim.score_cohort_id = p_score_cohort_id')
    const existingBranch = functionBody.indexOf('IF FOUND THEN', existingLookup)
    const replayReturn = functionBody.indexOf(
      'RETURN pg_catalog.jsonb_build_object(',
      existingBranch
    )
    const insert = functionBody.indexOf(
      'INSERT INTO arena.leaderboard_rank_generation_claims',
      replayReturn
    )

    expect(existingLookup).toBeGreaterThan(-1)
    expect(existingBranch).toBeGreaterThan(existingLookup)
    expect(replayReturn).toBeGreaterThan(existingBranch)
    expect(insert).toBeGreaterThan(replayReturn)
    expect(functionBody.slice(existingBranch, replayReturn)).toContain(
      "v_head.phase NOT IN ('claimed', 'writing', 'cleaned', 'reranked')"
    )
    expect(functionBody.slice(existingBranch, replayReturn)).toContain(
      'v_head.lease_expires_at <= v_now'
    )
    expect(functionBody.slice(existingBranch, replayReturn)).not.toMatch(/UPDATE|INSERT/)
    expect(functionBody).toContain('generation cohort UUID was reused with different input')
    expect(functionBody).toContain('generation claim is expired, terminal, or superseded')
    expect(functionBody).toContain('active generation head lease disagrees with its claim')
  })

  it('rejects a competing active lease and advances one JS-safe sequence on takeover', () => {
    expect(functionBody).toContain("v_head.phase IN ('claimed', 'writing', 'cleaned', 'reranked')")
    expect(functionBody).toContain('v_head.lease_expires_at > v_now')
    expect(functionBody).toContain("USING ERRCODE = '55P03'")
    expect(functionBody).toContain('v_head.generation_seq >= 9007199254740000')
    expect(functionBody).toContain("USING ERRCODE = '54000'")
    expect(functionBody).toContain('v_next_generation_seq := v_head.generation_seq + 1')
    expect(
      functionBody.match(/INSERT INTO arena\.leaderboard_rank_generation_claims/g)
    ).toHaveLength(1)
    expect(
      functionBody.match(/UPDATE ONLY arena\.leaderboard_rank_generation_heads/g)
    ).toHaveLength(1)
    expect(functionBody).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT')
    expect(functionBody).toContain('generation head compare-and-set postcondition failed')
  })

  it('closes both tables and exposes only the exact service-role RPC', () => {
    expect(migration).toMatch(
      /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp\s+SET lock_timeout = '10s'/
    )
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE arena\.leaderboard_rank_generation_claims\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE arena\.leaderboard_rank_generation_heads\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.claim_leaderboard_rank_generation\([\s\S]*?FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_leaderboard_rank_generation\([\s\S]*?TO service_role;/
    )
    expect(migration).toContain('generation claim RPC EXECUTE ACL is not a closed set')
    expect(migration).toContain('generation table trigger, rule, policy, or ACL drifted')
  })

  it('attests exact callable identity and preserves it across replay', () => {
    expect(migration).toContain('leaderboard_generation_install_state')
    expect(migration).toContain('claim_function_oid')
    expect(migration).toContain('claim_function_source')
    expect(migration).toContain('generation claim RPC body drifted before migration replay')
    expect(migration).toContain('generation claim RPC identity or overload postflight failed')
    expect(migration).toContain('generation claim RPC catalog postflight failed')
    expect(migration).toContain('generation table constraint contract drifted')
    expect(migration).toContain('generation table index contract drifted')
    expect(migration).toContain('generation foreign-key trigger contract drifted')
    expect(migration).toContain('attribute.attacl IS NOT NULL')
    expect(migration).toContain('FROM pg_catalog.pg_inherits AS inheritance')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('ships a PostgreSQL 17 proof for replay, fencing, ACLs, and races', () => {
    for (const marker of [
      'generation migration accepted a partial table install',
      'generation migration accepted a same-name rogue overload',
      'generation callable or durable state changed across replay',
      'generation replay retained a rogue grant',
      'generation migration accepted a rogue column grant',
      'same generation UUID replay was not frozen',
      'active-phase generation replay was not frozen',
      'active generation accepted a null lease',
      'drifted active generation lease was trusted',
      'same generation UUID accepted a different payload',
      'generation UUID was accepted across seasons',
      'active generation accepted a competing cohort',
      'expired generation did not permit monotonic takeover',
      'generation claim accepted REPEATABLE READ',
      'rolled-back generation claim left durable state',
      'generation head no-op trigger left an orphan claim',
      'concurrent generation waiter did not block on the season head',
      'concurrent generation loser did not observe the active lease',
      'concurrent identical generation replay was not frozen',
      'post-lock authorization clock did not permit expired takeover',
      'cross-season generation UUID race persisted more than one winner',
      'generation sequence overflow changed durable state',
      'inherited generation claims polluted runtime lookup',
      'generation migration accepted an inherited claim child',
      'generation migration accepted disabled FK triggers',
      'generation migration accepted a rogue head trigger',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
