import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260725012000_strengthen_arena_score_publish_evidence.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/strengthen-arena-score-publish-evidence.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

const functionMatch = migration.match(
  /CREATE OR REPLACE FUNCTION public\.arena_score_inputs_publish_bundle_json\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
)
const functionBody = functionMatch?.[1] ?? ''
const entryCounts = functionBody.slice(
  functionBody.indexOf('passed_entry_counts AS MATERIALIZED'),
  functionBody.indexOf('physical_board_evidence AS MATERIALIZED')
)
const evidence = functionBody.slice(
  functionBody.indexOf('physical_board_evidence AS MATERIALIZED'),
  functionBody.indexOf('physical_boards_json AS MATERIALIZED')
)

describe('strengthened Arena score publication evidence', () => {
  it('forward-replaces only the existing bundle with its exact signature', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.arena_score_inputs_publish_bundle_json\(\s*p_window text,\s*p_per_platform_limit int DEFAULT 1000,\s*p_max_age_hours int DEFAULT 48\s*\)\s*RETURNS jsonb/
    )
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.arena_score_inputs_json\s*\(/)
    expect(migration).not.toMatch(/DROP\s+(?:FUNCTION|VIEW|TABLE)/i)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('preserves OID, return, defaults, owner, language, security and ACL catalog state', () => {
    for (const catalogField of [
      'oid',
      'proowner',
      'proacl',
      'prolang',
      'prokind',
      'prorettype',
      'proretset',
      'pronargs',
      'pronargdefaults',
      'proargtypes',
      'proargnames',
      'proargmodes',
      'proargdefaults',
      'prosecdef',
      'proleakproof',
      'proisstrict',
      'proconfig',
      'provolatile',
      'proparallel',
    ]) {
      expect(migration).toContain(`function_row.${catalogField}`)
      expect(migration).toContain(`v_after.${catalogField}`)
    }
    expect(migration).toContain('v_after.oid IS DISTINCT FROM v_before.oid')
    expect(migration).toContain('score-input publish bundle callable catalog contract changed')
  })

  it('stabilizes the pure legacy SQL reader before the bundle can call it', () => {
    const legacyCapture = migration.indexOf(
      'CREATE TEMP TABLE arena_score_inputs_json_catalog_before'
    )
    const stableAlter = migration.indexOf(
      'ALTER FUNCTION public.arena_score_inputs_json(text, int, int) STABLE'
    )
    const bundleDefinition = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.arena_score_inputs_publish_bundle_json'
    )
    const legacyCall = migration.indexOf("'scoreRows', public.arena_score_inputs_json(")

    expect(legacyCapture).toBeGreaterThan(-1)
    expect(stableAlter).toBeGreaterThan(legacyCapture)
    expect(stableAlter).toBeLessThan(bundleDefinition)
    expect(stableAlter).toBeLessThan(legacyCall)
    expect(migration.match(/ALTER FUNCTION/g)).toHaveLength(1)
    expect(migration).toContain('SELECT function_row.*')
    expect(migration).toContain('function_row.provolatile = ANY (')
    expect(migration).toContain(`ARRAY['v', 's']::"char"[]`)
    expect(migration).toContain("language_row.lanname = 'sql'")
    expect(migration).toContain("function_row.prorettype = 'pg_catalog.jsonb'")
    expect(migration).toContain('pg_catalog.pg_get_expr(function_row.proargdefaults, 0)')
    expect(migration).toContain("function_row.prosrc ~* '^\\s*(SELECT|WITH)\\M'")
    expect(migration).toContain("pg_catalog.to_jsonb(v_legacy_after) - 'provolatile'")
    expect(migration).toContain("v_legacy_after.provolatile <> 's'")
    expect(migration).toContain('legacy score-input JSON catalog changed beyond STABLE correction')
    expect(migration).toContain('legacy score-input JSON execution boundary drifted')
    expect(migration).toContain('legacy score-input JSON ACL postflight failed')
  })

  it('returns score rows and physical evidence from one read statement snapshot', () => {
    expect(functionMatch).not.toBeNull()
    expect(migration).toMatch(
      /LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    expect(functionBody.match(/\bRETURN\s*\(/g)).toHaveLength(1)
    expect(functionBody).toMatch(/RETURN \(\s+WITH requested_window AS MATERIALIZED/)
    expect(functionBody).toContain("'scoreRows', public.arena_score_inputs_json(")
    expect(functionBody).toContain("'physicalBoards', physical_boards.payload")
    expect(functionBody).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE)\b/)
  })

  it('counts only rank-attested rows without weakening full count audit', () => {
    expect(entryCounts).toContain('pg_catalog.count(entry.snapshot_id)::bigint AS entry_count')
    expect(entryCounts).toMatch(
      /pg_catalog\.count\(entry\.snapshot_id\) FILTER \(\s*WHERE entry\.rank <= p_per_platform_limit\s*\)::bigint AS rank_limited_entry_count/
    )
    expect(entryCounts).not.toContain('entry.rank IS NULL')
    expect(entryCounts).toContain('entry.snapshot_id = passed.snapshot_id')
    expect(entryCounts).toContain('entry.scraped_at = passed.scraped_at')
    expect(evidence).toContain('passed.actual_count::bigint')
    expect(evidence).toContain('entry_count.entry_count')
    const mismatchClause = evidence.slice(
      evidence.indexOf('WHEN passed.actual_count::bigint'),
      evidence.indexOf("THEN 'entry_count_mismatch'")
    )
    expect(mismatchClause).toContain('COALESCE(entry_count.entry_count, 0::bigint)')
    expect(mismatchClause).not.toContain('rank_limited_entry_count')
    for (const field of ['rank_limit', 'rank_limited_entry_count']) {
      expect(functionBody).toContain(`'${field}'`)
    }
  })

  it('measures latest PASSED ties and selects a deterministic diagnostic snapshot', () => {
    expect(functionBody).toMatch(
      /pg_catalog\.count\(\*\) OVER \(\s*PARTITION BY snapshot\.source_id, snapshot\.scraped_at\s*\)::bigint AS latest_passed_tie_count/
    )
    expect(functionBody).toMatch(
      /pg_catalog\.row_number\(\) OVER \(\s*PARTITION BY snapshot\.source_id\s*ORDER BY snapshot\.scraped_at DESC, snapshot\.id DESC\s*\) AS selected_order/
    )
    expect(evidence).toContain('COALESCE(passed.latest_passed_tie_count, 0::bigint)')
    expect(functionBody).toContain("'latest_passed_tie_count'")
  })

  it('fails closed on ambiguity and a later failed attempt before time validity', () => {
    const ambiguous = evidence.indexOf("THEN 'ambiguous_latest'")
    const laterFailed = evidence.indexOf("THEN 'latest_attempt_failed'")
    const future = evidence.indexOf("THEN 'future'")
    const stale = evidence.indexOf("THEN 'stale'")
    const passed = evidence.indexOf("ELSE 'passed'")

    expect(ambiguous).toBeGreaterThan(-1)
    expect(laterFailed).toBeGreaterThan(ambiguous)
    expect(laterFailed).toBeLessThan(future)
    expect(laterFailed).toBeLessThan(stale)
    expect(laterFailed).toBeLessThan(passed)
    expect(evidence).toContain('attempt.latest_attempt_passed IS FALSE')
    expect(evidence).toContain('attempt.latest_attempt_scraped_at >= passed.scraped_at')
  })

  it('keeps a service-role-only execution boundary', () => {
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION public\.arena_score_inputs_publish_bundle_json\(text, int, int\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.arena_score_inputs_publish_bundle_json\(text, int, int\)\s+TO service_role;/
    )
    expect(migration).toContain('score-input publish bundle ACL postflight failed')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('ships a replayable PostgreSQL 17 behavioral proof', () => {
    expect(pg17).toContain(`STRENGTHENER="$ROOT_DIR/supabase/migrations/${migrationName}"`)
    expect(pg17.match(/psql_cmd -q -f "\$STRENGTHENER"/g)).toHaveLength(2)
    expect(pg17).toContain('rank-gap-board rank-limited count drifted')
    expect(pg17).toContain('ambiguous_latest did not outrank future')
    expect(pg17).toContain('latest_attempt_failed did not outrank stale')
    expect(pg17).toContain('bundle callable contract changed across replay')
    expect(pg17).toMatch(
      /LANGUAGE sql\s+VOLATILE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    expect(pg17).toContain("after.provolatile = 's'")
    expect(pg17).toContain("pg_catalog.to_jsonb(after) - 'provolatile'")
    expect(pg17).toContain("application_name = 'score_publish_snapshot_probe'")
    expect(pg17).toContain('nested scoreRows escaped the caller statement snapshot')
  })

  it('is the final ordered PREDEPLOY after the JSON hot path and worker fence', () => {
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
      predeploy.indexOf('20260724234000_optimize_arena_score_inputs_json_hot_path.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(
      predeploy.indexOf('20260725011000_durable_ingest_worker_fence_substrate.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(recovery).not.toContain(migrationName)
  })
})
