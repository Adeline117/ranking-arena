import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729070000_pure_arena_score_v5_zero_metric_scorer.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const v4Migration = readFileSync(
  resolve(root, 'supabase/migrations/20260722041000_pure_arena_score_v4_scorer.sql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/pure-arena-score-v5-zero-metrics.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')

describe('pure Arena Score v5 zero-metric scorer migration', () => {
  it('adds a versioned shadow scorer without rewriting v4', () => {
    expect(migration).toContain('arena.compute_arena_scores_v5_json(text,jsonb)')
    expect(migration).toContain('pg_catalog.pg_get_functiondef(v_v4_scorer)')
    expect(migration).toContain('V4 remains byte-for-byte')
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION\s+arena\.compute_arena_scores_v4_json/i
    )
    expect(migration).not.toMatch(/DROP\s+FUNCTION/i)
    expect(v4Migration).not.toContain('arena-score-v5-pg17@1')
  })

  it('hash-fences the full inherited scorer and exact unchanged round2 helper', () => {
    expect(migration).toContain('a3c245893d5a939020f70c70d09e41bf2e5b28e3ad640daf619c264c3bb530ba')
    expect(migration).toContain('412f6e18ad5f311baae7420a3e0298cd2bfd7490533c282d8d46f7d2aa1c40d3')
    expect(migration).toContain('166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae')
    expect(migration).toContain("pg_catalog.replace(v_definition, 'v4', 'v5')")
    expect(migration).toContain("'arena.arena_score_v5_round2'")
    expect(migration).toContain("'arena.arena_score_v4_round2'")
    expect(migration).not.toContain('CREATE FUNCTION arena.arena_score_v5_round2')
  })

  it('removes exactly the two zero-as-missing clauses', () => {
    expect(migration).toContain('v_old_mdd_zero constant text')
    expect(migration).toContain('v_old_win_zero constant text')
    expect(migration).toContain('v5 maximum-drawdown zero rewrite anchor drifted: %/1')
    expect(migration).toContain('v5 win-rate zero rewrite anchor drifted: %/1')
    expect(migration).toContain('only null is missing')
  })

  it('remains immutable, owner-only and replay-safe', () => {
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION arena\.compute_arena_scores_v5_json\(text, jsonb\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toContain('privilege_row.grantee NOT IN (0, function_row.proowner)')
    expect(migration).toContain("v_v4_scorer_row.provolatile <> 'i'")
    expect(migration).toContain("v_v4_scorer_row.proparallel <> 's'")
    expect(migration).toContain('v_v4_scorer_row.prosecdef')
    expect(migration).toContain("- 'oid' - 'proname' - 'prosrc' - 'proacl'")
    expect(migration).toContain("v_v4_scorer_row.prorettype <> 'jsonb'::pg_catalog.regtype")
    expect(migration).toContain('OR v_v4_scorer_row.proisstrict')
    expect(migration).toContain('OR NOT v_round2_row.proisstrict')
    expect(migration).toContain('OR v_v4_scorer_row.proleakproof')
    expect(migration).toContain('IF v_v5_scorer IS NOT NULL THEN')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('has a PG17 proof for zero/null semantics, ACL, replay and drift', () => {
    expect(pg17).toContain(`V5_MIGRATION="$ROOT_DIR/supabase/migrations/${migrationName}"`)
    expect(pg17.match(/psql_cmd -q -f "\$V5_MIGRATION"/g)).toHaveLength(3)
    expect(pg17).toContain('trusted zero metrics were not ranked as known values')
    expect(pg17).toContain('+0/-0 canonicalization or zero/null distinction drifted')
    expect(pg17).toContain('v5 installation changed historical v4 zero semantics')
    expect(pg17).toContain('leaked_default_role')
    expect(pg17).toContain('v5 replay changed the scorer OID')
    expect(pg17).toContain('compute_arena_scores_v5_json(text,jsonb) STRICT')
    expect(pg17).toContain('existing Arena Score v5 scorer contract drifted')
    expect(pg17).toContain(`'{"max_drawdown":100}'::jsonb`)
    expect(ci).toContain('name: Prove Arena Score v5 trusted-zero semantics')
    expect(ci).toContain('run: npm run qa:score-v5-pg17')
  })

  it('is ordered after the v4 scorer and publication-plan alias normalization', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    const recovery = runner.slice(
      runner.indexOf('RECOVERY_PREREQUISITE_MIGRATIONS=('),
      runner.indexOf('CONCURRENT_RECOVERY_MIGRATIONS=(')
    )
    expect(predeploy).toContain(migrationName)
    expect(predeploy.indexOf('20260722041000_pure_arena_score_v4_scorer.sql')).toBeLessThan(
      predeploy.indexOf(migrationName)
    )
    expect(
      predeploy.indexOf('20260729065000_normalize_arena_score_input_platform_aliases.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(recovery).not.toContain(migrationName)
  })
})
