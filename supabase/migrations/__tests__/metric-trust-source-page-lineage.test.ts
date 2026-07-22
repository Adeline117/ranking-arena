import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260722054000_metric_trust_source_page_lineage.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(
  join(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)

const lineageFunction = migration.slice(
  migration.indexOf('CREATE FUNCTION arena.validate_metric_trust_source_page_lineage()'),
  migration.indexOf('ALTER FUNCTION arena.validate_metric_trust_source_page_lineage()')
)
const readinessFunction = migration.slice(
  migration.indexOf('CREATE FUNCTION public.arena_metric_trust_release_readiness()'),
  migration.indexOf('ALTER FUNCTION public.arena_metric_trust_release_readiness()')
)

describe('metric-trust source-page lineage migration', () => {
  it('is a forward-only additive migration with no guessed legacy backfill', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    expect(migration).toMatch(
      /ALTER TABLE arena\.metric_trust_observations\s+ADD COLUMN source_page_ordinal integer;/
    )
    expect(migration).not.toMatch(/ADD COLUMN source_page_ordinal integer\s+(?:NOT NULL|DEFAULT)/)
    expect(migration).not.toMatch(/\bUPDATE\s+arena\.metric_trust_observations\b/i)
    expect(migration).not.toMatch(/\bINSERT\s+INTO\s+arena\.metric_trust_observations\b/i)
    expect(migration).not.toMatch(/\bDROP\s+(?:COLUMN|TABLE|FUNCTION|TRIGGER|VIEW)\b/i)
    expect(migration).toContain('Existing append-only observations are never')
    expect(migration).toContain(
      'legacy verified observations require a reviewed forward quarantine before source-page lineage'
    )
  })

  it('accepts only positive ordinals and binds every newly verified lineage bidirectionally', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT metric_trust_observations_source_page_ordinal_positive\s+CHECK \(source_page_ordinal IS NULL OR source_page_ordinal > 0\) NOT VALID;/
    )
    expect(migration).toMatch(
      /VALIDATE CONSTRAINT metric_trust_observations_source_page_ordinal_positive;/
    )
    expect(migration).toMatch(
      /ADD CONSTRAINT metric_trust_observations_verified_source_page_lineage\s+CHECK \(\s*\(freshness_state = 'verified'\) = \(source_page_ordinal IS NOT NULL\)\s*\) NOT VALID;/
    )
    expect(migration).toMatch(
      /VALIDATE CONSTRAINT metric_trust_observations_verified_source_page_lineage;/
    )
    expect(lineageFunction).toContain("NEW.freshness_state := 'unknown'")
    expect(lineageFunction).toContain("NEW.quality := 'unknown'")
    expect(lineageFunction).toContain("'code', 'source_page_lineage_missing'")
    expect(migration).toContain(
      'source-page ordinal requires verified freshness and a positive ordinal'
    )
  })

  it('binds the ordinal to exact immutable parser source-page lineage', () => {
    expect(lineageFunction).toMatch(
      /RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    for (const binding of [
      'run.source_run_id = NEW.source_run_id',
      'run.source_id = NEW.source_id',
      'run.timeframe = NEW.timeframe',
      'run.snapshot_id = NEW.snapshot_id',
      'population.source_run_id = NEW.source_run_id',
      "population.trust_artifact_role = 'source_payload'",
      'NOT population.quarantined',
    ]) {
      expect(lineageFunction).toContain(binding)
    }
    expect(lineageFunction).toContain("population.meta->>'pageCount'")
    expect(lineageFunction).toContain("population.meta->>'parserPageCount'")
    expect(lineageFunction).toContain("population.meta->'parserSourcePageOrdinals'")
    expect(lineageFunction).toContain("v_page_count_text !~ '^[1-9][0-9]*$'")
    expect(lineageFunction).toContain('v_page_count > 2147483647')
    expect(lineageFunction).toContain(
      'v_parser_page_count IS DISTINCT FROM\n        pg_catalog.jsonb_array_length(v_parser_source_page_ordinals)::numeric'
    )
    expect(lineageFunction).toContain('WITH ORDINALITY AS parser_ordinal(value, position)')
    expect(lineageFunction).toContain(
      'parser_ordinal.value::text::numeric = NEW.source_page_ordinal::numeric'
    )
    expect(lineageFunction).toContain(
      'source-page ordinal is not present in immutable parser source-page lineage'
    )

    expect(migration).toMatch(
      /CREATE TRIGGER metric_trust_observations_source_page_lineage_before_insert\s+BEFORE INSERT ON arena\.metric_trust_observations\s+FOR EACH ROW EXECUTE FUNCTION arena\.validate_metric_trust_source_page_lineage\(\);/
    )
    expect(migration).toMatch(
      /ALTER FUNCTION arena\.validate_metric_trust_source_page_lineage\(\)\s+OWNER TO postgres;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.validate_metric_trust_source_page_lineage\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
  })

  it('installs a service-role-only readiness RPC that fails closed on legacy lineage', () => {
    expect(readinessFunction).toMatch(
      /RETURNS jsonb\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    for (const field of [
      "'contract', 'arena.metric-trust-release-readiness@1'",
      "'ready'",
      "'missing'",
      "'legacy_complete_verified_count'",
      "'release_migration_sha256'",
      "'source_page_lineage_column'",
    ]) {
      expect(readinessFunction).toContain(field)
    }
    expect(readinessFunction).toContain('v_legacy_complete integer := 0')
    expect(readinessFunction).toContain('AND v_legacy_complete = 0')
    expect(readinessFunction).toContain('AND v_lineage_column')
    expect(readinessFunction).toContain("WHERE ledger.name = 'metric_trust_source_page_lineage'")
    expect(readinessFunction).not.toContain("ledger.version = '20260722054000'")

    for (const requiredContract of [
      'arena.validate_metric_trust_attempt_outcome_authority()',
      'arena.serialize_leaderboard_terminal_publication()',
      'arena.encode_leaderboard_score_input_manifest_v1(',
      'arena.seal_leaderboard_score_input_manifest_v1(',
      'arena.verify_leaderboard_score_input_manifest_v1(uuid)',
      'leaderboard_score_input_manifest_rank_eligible_pnl',
      'metric_trust_observations_verified_source_page_lineage',
      'metric_trust_observations_source_page_lineage_before_insert',
    ]) {
      expect(readinessFunction).toContain(requiredContract)
    }

    expect(migration).toMatch(
      /ALTER FUNCTION public\.arena_metric_trust_release_readiness\(\)\s+OWNER TO postgres;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_metric_trust_release_readiness\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.arena_metric_trust_release_readiness\(\)\s+TO service_role;/
    )
    expect(migration).toContain(
      'privilege_row.grantee NOT IN (function_row.proowner, v_service_role)'
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
  })

  it('runs only after the exact 050 through 053 predeploy chain', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('TIP_CHECKOUT_CUTOVER_VERSIONS=(')
    )
    const ordered = [
      '20260722050000_metric_trust_attempt_outcome_authority.sql',
      '20260722051000_leaderboard_score_input_manifest_contract.sql',
      '20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql',
      '20260722053000_binance_spot_metric_source_contract.sql',
      migrationName,
    ]

    for (const migrationFile of ordered) expect(predeploy).toContain(migrationFile)
    for (let index = 1; index < ordered.length; index += 1) {
      expect(predeploy.indexOf(ordered[index - 1])).toBeLessThan(predeploy.indexOf(ordered[index]))
    }
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(migration).toContain("ledger.name = 'binance_spot_metric_source_contract'")
    expect(migration).toContain('1f4ce27a0a44cfc6f9c1d11c113dc2db7aa5eed170ef3b38b1469c0a1c758abc')
  })
})
