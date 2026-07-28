import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260725013000_cleanup_leaderboard_rank_publication.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/cleanup-leaderboard-rank-publication.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

const functionMatch = migration.match(
  /CREATE OR REPLACE FUNCTION public\.cleanup_leaderboard_rank_publication\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
)
const functionBody = functionMatch?.[1] ?? ''
const deleteIndex = functionBody.indexOf('DELETE FROM public.leaderboard_ranks AS ranks')
const deleteStatement = functionBody.slice(
  functionBody.lastIndexOf('WITH authority AS MATERIALIZED (', deleteIndex),
  functionBody.indexOf('GET DIAGNOSTICS v_deleted_count')
)
const response = functionBody.slice(
  functionBody.lastIndexOf('RETURN pg_catalog.jsonb_build_object('),
  functionBody.lastIndexOf('END;')
)

describe('publication-scoped leaderboard rank cleanup', () => {
  it('adds one dormant forward RPC on top of the mutation-fence dependency', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.cleanup_leaderboard_rank_publication\(\s*p_season_id text,\s*p_score_cohort_id uuid,\s*p_source_publications jsonb\s*\)\s*RETURNS jsonb/
    )
    expect(migration.match(/^CREATE TABLE IF NOT EXISTS/gm)).toHaveLength(1)
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_cleanup_receipts'
    )
    expect(migration).not.toMatch(/DROP\s+(?:FUNCTION|TABLE|VIEW)/i)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('persists one closed immutable cleanup receipt contract', () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS arena\.leaderboard_rank_cleanup_receipts \([\s\S]*?season_id text NOT NULL,[\s\S]*?score_cohort_id uuid NOT NULL,[\s\S]*?contract text NOT NULL,[\s\S]*?request_sha256 text NOT NULL,[\s\S]*?source_count integer NOT NULL,[\s\S]*?kept_count bigint NOT NULL,[\s\S]*?deleted_count bigint NOT NULL,[\s\S]*?completed_at timestamptz NOT NULL,/
    )
    expect(migration).toContain('PRIMARY KEY (season_id, score_cohort_id)')
    expect(migration).toContain('UNIQUE (score_cohort_id)')
    expect(migration).toContain("CHECK (contract = 'leaderboard-rank-publication-cleanup@1')")
    expect(migration).toContain("CHECK (request_sha256 ~ '^[0-9a-f]{64}$')")
    expect(migration).toContain('CHECK (pg_catalog.isfinite(completed_at))')
    expect(migration).toContain(
      'ALTER TABLE arena.leaderboard_rank_cleanup_receipts OWNER TO postgres'
    )
    expect(migration).toContain(
      'ALTER TABLE arena.leaderboard_rank_cleanup_receipts ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toMatch(
      /REVOKE ALL ON arena\.leaderboard_rank_cleanup_receipts\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER leaderboard_rank_cleanup_receipt_immutable\s+BEFORE UPDATE OR DELETE ON arena\.leaderboard_rank_cleanup_receipts[\s\S]*?EXECUTE FUNCTION arena\.reject_leaderboard_rank_publication_mutation\(\);/
    )
    expect(
      migration.match(
        /pg_catalog\.count\(\*\)[\s\S]*?FROM pg_catalog\.pg_trigger AS trigger_row[\s\S]*?AND NOT trigger_row\.tgisinternal[\s\S]*?\) <> 1/g
      )
    ).toHaveLength(2)
    expect(migration.match(/FROM pg_catalog\.pg_rewrite AS rule_row/g)).toHaveLength(2)
    expect(migration.match(/FROM pg_catalog\.pg_policy AS policy_row/g)).toHaveLength(2)
    expect(migration.match(/trigger_row\.tgqual IS NULL/g)).toHaveLength(2)
    expect(migration.match(/trigger_row\.tgenabled = 'O'/g)).toHaveLength(2)
    expect(migration).toContain('leaderboard rank cleanup receipt table drifted')
    expect(migration).toContain('leaderboard rank cleanup receipt table postflight failed')
    expect(migration).toContain(
      "('completed_at', 'pg_catalog.timestamptz'::pg_catalog.regtype, true)"
    )
  })

  it('fails preflight unless the publication mutation fence is complete', () => {
    for (const dependency of [
      "'arena.leaderboard_rank_mutation_fences'",
      "'public.arena_freshness_expected_sources()'",
      "'public.rerank_leaderboard_publication(text,uuid)'",
      "'public.seal_leaderboard_rank_publication(text,uuid,jsonb)'",
      "'arena.bump_leaderboard_rank_delete_fences()'",
      "attribute.attname = 'rank_publication_id'",
      "attribute.atttypid = 'pg_catalog.uuid'",
      "trigger_row.tgname = 'leaderboard_rank_delete_fence'",
      "trigger_row.tgoldtable = 'old_rank_rows'",
      'trigger_row.tgtype = 8',
      `trigger_row.tgenabled = ANY (ARRAY['O', 'A']::"char"[])`,
    ]) {
      expect(migration).toContain(dependency)
    }
    expect(migration).toContain(
      'leaderboard publication mutation fence must exist before cleanup RPC'
    )
    expect(migration).toContain('leaderboard parent DELETE mutation fence function drifted')
    expect(migration.match(/language_row\.lanname = 'plpgsql'/g)).toHaveLength(2)
    expect(migration.match(/function_row\.prorettype = 'pg_catalog\.trigger'/g)).toHaveLength(2)
    expect(migration.match(/function_row\.provolatile = 'v'/g)).toHaveLength(3)
    expect(migration.match(/function_row\.proparallel = 'u'/g)).toHaveLength(2)
    expect(migration.match(/function_row\.prosrc/g)).toHaveLength(2)
    expect(migration.match(/leaderboard publication receipts are immutable/g)).toHaveLength(2)
    expect(migration).toContain(
      'leaderboard publication receipt immutability guard postflight failed'
    )
    expect(migration).toContain('leaderboard publication cleanup has an unsupported overload')
    expect(migration).toContain('leaderboard publication cleanup overload postflight failed')
  })

  it('accepts only exact canonical bounded source and identity members', () => {
    expect(functionBody).not.toBe('')
    expect(functionBody).toContain('pg_catalog.jsonb_array_length(p_source_publications) > 256')
    expect(functionBody).toContain('source publication request exceeds 64 MiB')
    expect(functionBody).toContain('cleanup publication exceeds 250000 trader identities')
    expect(functionBody).toMatch(
      /NOT item\.value \?& ARRAY\['source', 'trader_ids'\][\s\S]*?pg_catalog\.count\(\*\)[\s\S]*?<> 2/
    )
    expect(functionBody).toContain("item.value->>'source' !~ '^[a-z0-9]+(_[a-z0-9]+)*$'")
    expect(functionBody).toContain("pg_catalog.length(item.value->>'source') > 128")
    expect(functionBody).toContain("pg_catalog.length(trader.value #>> '{}') > 512")
    expect(functionBody).toMatch(
      /GROUP BY item\.value->>'source'[\s\S]*?HAVING pg_catalog\.count\(\*\) <> 1/
    )
    expect(functionBody).toMatch(
      /GROUP BY item\.value->>'source', trader\.value #>> '\{\}'[\s\S]*?HAVING pg_catalog\.count\(\*\) <> 1/
    )
    expect(
      functionBody.indexOf('cleanup publication exceeds 250000 trader identities')
    ).toBeLessThan(
      functionBody.indexOf('cleanup publication contains invalid or duplicate trader identities')
    )
    expect(functionBody).toContain('identity.value ORDER BY identity.value COLLATE "C"')
  })

  it('freezes registry authority and requires an exact two-way source cover', () => {
    const registryLock = functionBody.indexOf(
      'LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE'
    )
    const authorityCheck = functionBody.indexOf(
      'cleanup source publications must exactly cover season authority'
    )
    const rankLock = functionBody.indexOf(
      'LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE'
    )

    expect(registryLock).toBeGreaterThan(-1)
    expect(authorityCheck).toBeGreaterThan(registryLock)
    expect(rankLock).toBeGreaterThan(authorityCheck)
    expect(functionBody).toContain('SELECT DISTINCT authority.filter_source')
    expect(functionBody).toContain('season source authority is empty; cleanup refused')
    expect(functionBody).toMatch(
      /SELECT requested\.source FROM requested[\s\S]*?EXCEPT[\s\S]*?SELECT authority\.source FROM authority/
    )
    expect(functionBody).toMatch(
      /SELECT authority\.source FROM authority[\s\S]*?EXCEPT[\s\S]*?SELECT requested\.source FROM requested/
    )
  })

  it('linearizes exact-input replay before observing mutable authority rows', () => {
    const digest = functionBody.indexOf('v_request_sha256 := pg_catalog.encode(')
    const advisory = functionBody.indexOf('pg_catalog.pg_advisory_xact_lock(')
    const receiptLookup = functionBody.indexOf(
      'FROM arena.leaderboard_rank_cleanup_receipts AS receipt'
    )
    const receiptReturn = functionBody.indexOf("'contract', v_existing.contract", receiptLookup)
    const registryLock = functionBody.indexOf(
      'LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE'
    )
    const deletion = functionBody.indexOf('DELETE FROM public.leaderboard_ranks AS ranks')
    const receiptInsert = functionBody.indexOf(
      'INSERT INTO arena.leaderboard_rank_cleanup_receipts ('
    )

    expect(digest).toBeGreaterThan(-1)
    expect(advisory).toBeGreaterThan(digest)
    expect(receiptLookup).toBeGreaterThan(advisory)
    expect(receiptReturn).toBeGreaterThan(receiptLookup)
    expect(receiptReturn).toBeLessThan(registryLock)
    expect(functionBody.slice(digest, advisory)).toContain(
      "'contract', 'leaderboard-rank-publication-cleanup@1'"
    )
    expect(functionBody.slice(digest, advisory)).toContain("'sources', v_canonical_sources")
    expect(functionBody.slice(digest, advisory)).not.toContain('completed_at')
    expect(functionBody).toContain('score cohort id was reused with different cleanup input')
    expect(functionBody).toContain("'deleted_count', v_existing.deleted_count")
    expect(receiptInsert).toBeGreaterThan(deletion)
    expect(functionBody.slice(receiptInsert)).toContain('pg_catalog.clock_timestamp()')
  })

  it('validates every expected identity and cohort before the only DELETE', () => {
    const rankLock = functionBody.indexOf(
      'LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE'
    )
    const missing = functionBody.indexOf(
      'cleanup expected publication identity is missing from leaderboard rows'
    )
    const wrongCohort = functionBody.indexOf(
      'cleanup expected publication identity has the wrong score cohort'
    )
    const oneToOne = functionBody.indexOf(
      'cleanup expected publication identities are not one-to-one leaderboard rows'
    )
    const deletion = functionBody.indexOf('DELETE FROM public.leaderboard_ranks AS ranks')

    expect(functionBody.match(/DELETE FROM public\.leaderboard_ranks AS ranks/g)).toHaveLength(1)
    for (const check of [missing, wrongCohort, oneToOne]) {
      expect(check).toBeGreaterThan(rankLock)
      expect(check).toBeLessThan(deletion)
    }
    expect(functionBody).toContain('ranks.rank_publication_id IS DISTINCT FROM p_score_cohort_id')
    expect(functionBody).toContain(
      'ranks.rank_publication_id IS NOT DISTINCT FROM p_score_cohort_id'
    )
  })

  it('deletes only non-exact rows in current-season authority sources', () => {
    expect(deleteStatement).toContain('DELETE FROM public.leaderboard_ranks AS ranks')
    expect(deleteStatement).toContain('USING authority')
    expect(deleteStatement).toContain('ranks.season_id = p_season_id')
    expect(deleteStatement).toContain('ranks.source = authority.source')
    expect(deleteStatement).toContain('NOT EXISTS (')
    expect(deleteStatement).toContain('expected.source_trader_id = ranks.source_trader_id')
    expect(deleteStatement).toContain(
      'ranks.rank_publication_id IS NOT DISTINCT FROM p_score_cohort_id'
    )
    expect(functionBody).toContain('leaderboard cleanup postcondition failed')
    expect(functionBody).toMatch(
      /SELECT expected\.source, expected\.source_trader_id FROM expected[\s\S]*?EXCEPT[\s\S]*?SELECT actual\.source, actual\.source_trader_id FROM actual/
    )
    expect(functionBody).toMatch(
      /SELECT actual\.source, actual\.source_trader_id FROM actual[\s\S]*?EXCEPT[\s\S]*?SELECT expected\.source, expected\.source_trader_id FROM expected/
    )
  })

  it('returns one strict replay-safe cleanup response', () => {
    for (const [key, value] of [
      ['contract', "'leaderboard-rank-publication-cleanup@1'"],
      ['season_id', 'p_season_id'],
      ['score_cohort_id', 'p_score_cohort_id'],
      ['source_count', 'v_source_count'],
      ['kept_count', 'v_kept_count'],
      ['deleted_count', 'v_deleted_count'],
    ]) {
      expect(response).toContain(`'${key}', ${value}`)
    }
    expect(
      response.match(
        /'contract'|'season_id'|'score_cohort_id'|'source_count'|'kept_count'|'deleted_count'/g
      )
    ).toHaveLength(6)
  })

  it('is postgres-owned, hardened, deadline-documented and service-role-only', () => {
    expect(migration).toMatch(
      /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp\s+SET lock_timeout = '10s'/
    )
    expect(migration).toMatch(
      /ALTER FUNCTION public\.cleanup_leaderboard_rank_publication\(text, uuid, jsonb\)\s+OWNER TO postgres;/
    )
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain("pg_catalog.acldefault('f', function_row.proowner)")
    expect(migration).toContain('IF v_grantee = 0 THEN')
    expect(migration).toContain('FROM PUBLIC CASCADE')
    expect(migration).toContain('FROM %I CASCADE')
    expect(migration).toContain("expanded.grantee <> 'service_role'::pg_catalog.regrole")
    expect(migration).toMatch(
      /REVOKE EXECUTE\s+ON FUNCTION public\.cleanup_leaderboard_rank_publication\(text, uuid, jsonb\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /REVOKE GRANT OPTION FOR EXECUTE\s+ON FUNCTION public\.cleanup_leaderboard_rank_publication\(text, uuid, jsonb\)\s+FROM service_role CASCADE;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.cleanup_leaderboard_rank_publication\(text, uuid, jsonb\)\s+TO service_role;/
    )
    expect(migration).toContain('Callers must enforce the RPC request deadline')
    expect(migration).toContain('leaderboard publication cleanup ACL postflight failed')
    expect(migration).toContain('leaderboard publication cleanup EXECUTE ACL is not a closed set')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('ships a real dependency-backed PostgreSQL 17 proof', () => {
    expect(pg17).toContain(
      'DEPENDENCY="$ROOT_DIR/supabase/migrations/20260724235000_leaderboard_publication_mutation_fence.sql"'
    )
    expect(pg17.match(/psql_cmd -q -f "\$MIGRATION"/g)).toHaveLength(7)
    expect(pg17).toContain('cleanup response-loss replay was not idempotent')
    expect(pg17).toContain('cleanup migration accepted a same-name rogue overload')
    expect(pg17).toContain('rogue-overload rejection did not roll back the migration transaction')
    expect(pg17).toContain('CREATE ROLE fixture_rogue NOLOGIN')
    expect(pg17).toContain('cleanup RPC replay retained fixture_rogue EXECUTE')
    expect(pg17).toContain('cleanup migration accepted a drifted same-name receipt table')
    expect(pg17).toContain('receipt-table drift rejection did not roll back the migration')
    expect(pg17).toContain('cleanup migration accepted a rogue receipt INSERT trigger')
    expect(pg17).toContain('rogue receipt trigger rejection did not roll back the migration')
    expect(pg17).toContain('cleanup migration accepted a rogue receipt INSERT rule')
    expect(pg17).toContain('rogue receipt rule rejection did not roll back the migration')
    expect(pg17).toContain('cleanup migration accepted a no-op receipt immutability guard')
    expect(pg17).toContain('no-op immutability guard rejection did not roll back the migration')
    expect(pg17).toContain('authority rows were not reduced to the exact identity set')
    expect(pg17).toContain('cleanup deleted a non-authority or other-season row')
    expect(pg17).toContain('missing expected identity did not roll back cleanup')
    expect(pg17).toContain('wrong expected cohort rollback')
    expect(pg17).toContain('cleanup RPC callable contract changed across replay')
    expect(pg17).toContain('service_role cleanup replay drifted')
    expect(pg17).toContain('cleanup did not wait on parent rank DML')
    expect(pg17).toContain('cleanup partially deleted rows before acquiring its rank lock')
    expect(pg17).toContain('cleanup did not resume atomically after rank DML')
    expect(pg17).toContain('delayed cleanup replay deleted the newer cohort')
    expect(pg17).toContain('same cleanup cohort accepted a different payload')
    expect(pg17).toContain('concurrent duplicate cleanup did not wait on its cohort receipt')
    expect(pg17).toContain('concurrent duplicate cleanup did not return the frozen receipt')
    expect(pg17).toContain('cleanup transaction rollback left partial state')
    expect(pg17).toContain('cleanup receipt did not freeze the first result')
    expect(pg17).toContain('pg_catalog.isfinite(completed_at)')
  })

  it('is the final ordered PREDEPLOY after mutation fence and evidence strengthener', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    const recovery = runner.slice(
      runner.indexOf('RECOVERY_PREREQUISITE_MIGRATIONS=('),
      runner.indexOf('CONCURRENT_RECOVERY_MIGRATIONS=(')
    )

    expect(predeploy).toContain(migrationName)
    expect(
      predeploy.indexOf('20260724235000_leaderboard_publication_mutation_fence.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(
      predeploy.indexOf('20260725012000_strengthen_arena_score_publish_evidence.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(recovery).not.toContain(migrationName)
  })
})
