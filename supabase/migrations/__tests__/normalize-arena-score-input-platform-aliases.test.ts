import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729065000_normalize_arena_score_input_platform_aliases.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/bitget-bot-rank-authority-quarantine.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

describe('arena score-input platform alias normalization', () => {
  it('rewrites only the exact reviewed post-quarantine function body', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain('ac4d96ea0e3bdbf00a544d13337e2ec59d6f7074db3a36387f6e864792f05ebc')
    expect(migration).toContain('0af935aaa1278d39bce84cec1f87efb8373e094f00a847ef455698ff43b8497d')
    expect(migration).toContain('pg_catalog.pg_get_functiondef(v_function)')
    expect(migration).toContain("IF v_count <> 2 THEN\n    RAISE EXCEPTION 'watermark alias")
    expect(migration).toContain("IF v_count <> 2 THEN\n    RAISE EXCEPTION 'score-row alias")
    expect(migration).toContain("IF v_count <> 2 THEN\n    RAISE EXCEPTION 'null-sentinel rewrite")
    expect(migration).not.toMatch(/DROP\s+FUNCTION/i)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('uses the bundle/trust canonical alias and trimmed null sentinel', () => {
    expect(migration).toContain("NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), '')")
    expect(migration).toContain(
      "$replacement$COALESCE(\n        NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),\n        source.slug\n      )$replacement$"
    )
    expect(migration).toContain(
      "$replacement$pg_catalog.btrim(\n        COALESCE(source.meta->>'legacy_platform', '')\n      ) <> 'null'$replacement$"
    )
    expect(migration).toContain('OR v_count <> 4')
  })

  it('preserves every catalog field, comment, ACL and later quarantine guard', () => {
    expect(migration).toContain("pg_catalog.to_jsonb(function_row) - 'prosrc'")
    expect(migration).toContain("pg_catalog.to_jsonb(v_after) - 'prosrc'")
    expect(migration).toContain("pg_catalog.obj_description(function_row.oid, 'pg_proc')")
    expect(migration).toContain('bitget-bot-cumulative-rank-quarantine@1')
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]")
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION public\.arena_score_inputs_json\(text, int, int\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.arena_score_inputs_json\(text, int, int\)\s+TO service_role;/
    )
  })

  it('has a PG17 proof for padded, blank, JSON-null and string-null aliases plus replay', () => {
    expect(pg17).toContain(`ALIAS_MIGRATION="$ROOT_DIR/supabase/migrations/${migrationName}"`)
    expect(pg17.match(/psql_cmd -q -f "\$ALIAS_MIGRATION"/g)).toHaveLength(2)
    expect(pg17).toContain(`'{"legacy_platform":"  human_alias  "}'::jsonb`)
    expect(pg17).toContain(`'{"legacy_platform":"   "}'::jsonb`)
    expect(pg17).toContain(`'{"legacy_platform":null}'::jsonb`)
    expect(pg17).toContain(`'{"legacy_platform":" null "}'::jsonb`)
    expect(pg17).toContain('alias rewrite removed human rows or reopened bot ranks')
  })

  it('is the next predeploy migration and remains outside frozen recovery', () => {
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
      predeploy.indexOf('20260729064500_leaderboard_rank_generation_publication_plan.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(recovery).not.toContain(migrationName)
  })
})
