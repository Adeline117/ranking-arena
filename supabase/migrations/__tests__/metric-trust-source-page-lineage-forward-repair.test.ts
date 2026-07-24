import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260722055000_metric_trust_source_page_lineage_forward_repair.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const quarantinedMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260722054000_metric_trust_source_page_lineage.sql'),
  'utf8'
)
const runner = readFileSync(
  join(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)
const verifier = readFileSync(
  join(process.cwd(), 'scripts/ci/verify-metric-trust-release-readiness.mjs'),
  'utf8'
)
const workerGate = readFileSync(
  join(process.cwd(), 'worker/src/ingest/metric-trust-readiness.ts'),
  'utf8'
)

const lineageFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION arena.validate_metric_trust_source_page_lineage()'),
  migration.indexOf('ALTER FUNCTION arena.validate_metric_trust_source_page_lineage()')
)
const readinessFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.arena_metric_trust_release_readiness()'),
  migration.indexOf('ALTER FUNCTION public.arena_metric_trust_release_readiness()')
)

describe('metric-trust source-page lineage 055 forward repair', () => {
  it('preserves 054 bytes and accepts only wholly absent or exact-complete 054 state', () => {
    expect(createHash('sha256').update(quarantinedMigration).digest('hex')).toBe(
      '93c512791e8bb7beb00742c7b65c6d79ecdf79ea49e26a3d67c3b3c438ae42cf'
    )
    expect(migration).toContain("ledger.name = 'metric_trust_source_page_lineage'")
    expect(migration).toContain("ledger.version = '20260722054000'")
    expect(migration).toContain('93c512791e8bb7beb00742c7b65c6d79ecdf79ea49e26a3d67c3b3c438ae42cf')
    expect(migration).toContain('v_054_ledger_count = 0 AND v_054_objects_absent')
    expect(migration).toContain('v_054_ledger_exact AND v_054_objects_exact')
    expect(migration).toContain(
      'metric-trust 054 ledger/object state is neither wholly absent nor exact'
    )
    expect(migration).toContain('LOCK TABLE supabase_migrations.schema_migrations')
    expect(migration).toContain(
      'LOCK TABLE arena.metric_trust_observations IN SHARE ROW EXCLUSIVE MODE'
    )
  })

  it('locks the complete immutable 053-era prerequisite chain by unique name and body', () => {
    const prerequisites = [
      [
        'metric_trust_shadow_gate',
        '9406636f749318929b9b1b9e2032256a571ec4e8e0246b66dc31c8ed0176fe30',
      ],
      ['raw_object_gc_outbox', '700805755c7daee4b4a1df4a2f65a0d3ab593270f65e112dc1704479a3b91066'],
      [
        'metric_trust_raw_artifact_identity',
        'b4c96ec8123be5dac548962b03834ffd9a0b0e7b4797abe9349ad0bc7bfca48a',
      ],
      [
        'durable_leaderboard_acquisition_attempt_ledger',
        'd60f5e1a3c04088b04f12a883ceae16aefd36b56ad97dd09dd0084c7a758d71e',
      ],
      [
        'leaderboard_acquisition_manifest_v3_compat',
        '9e6dbed7647ca494c928eba573163b2be9fccfd0956df7ab7fbb9c81121a1f2b',
      ],
      [
        'leaderboard_terminal_publication_fence',
        'e5c4c67e6fc822ff38e36d80ffe5770f305de63c7497973ba9b956bca3520b47',
      ],
      [
        'metric_trust_attempt_outcome_authority',
        '3648ac33324eb99e476eb15dc624b37d6d086ac6eef92c9b34dc8e30399dd92f',
      ],
      [
        'leaderboard_score_input_manifest_contract',
        'fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c',
      ],
      [
        'leaderboard_score_input_manifest_rank_eligible_pnl',
        '34d1af48d66a4b3cedcee548e3438ba81fa9cc3fdca7a00f308d7f768f30150e',
      ],
      [
        'binance_spot_metric_source_contract',
        '1f4ce27a0a44cfc6f9c1d11c113dc2db7aa5eed170ef3b38b1469c0a1c758abc',
      ],
    ] as const

    for (const [name, digest] of prerequisites) {
      expect(migration).toContain(`'${name}'`)
      expect(migration).toContain(`'${digest}'`)
    }
    expect(migration).toContain('WHERE ledger.name = v_expected.name')
    expect(migration).toContain('pg_catalog.count(*)')
    expect(migration).toContain('FOR SHARE')
  })

  it('converges both accepted states without guessed observation rewrites', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS source_page_ordinal integer')
    expect(migration).toContain('metric_trust_observations_source_page_ordinal_positive')
    expect(migration).toContain('metric_trust_observations_complete_window_source_page_ordinal')
    expect(migration).toContain('metric_trust_observations_verified_source_page_lineage')
    expect(migration).toContain(
      'VALIDATE CONSTRAINT metric_trust_observations_source_page_ordinal_positive'
    )
    expect(migration).not.toMatch(/\bUPDATE\s+arena\.metric_trust_observations\b/i)
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+arena\.metric_trust_observations\b/i)
    expect(migration).not.toMatch(/\bDROP\s+(?:COLUMN|TABLE|VIEW)\b/i)
    expect(lineageFunction).toContain("NEW.freshness_state := 'unknown'")
    expect(lineageFunction).toContain("NEW.quality := 'unknown'")
    expect(lineageFunction).toContain("'code', 'source_page_lineage_missing'")
  })

  it('binds every ordinal to canonical parser membership and exact v3 terminal bounds', () => {
    for (const contract of [
      "population.meta->>'pageCount'",
      "population.meta->>'parserPageCount'",
      "population.meta->'parserSourcePageOrdinals'",
      "manifest.meta->>'data_contract'",
      'v_actual_ordinal <= v_previous_ordinal',
      'v_actual_ordinal = NEW.source_page_ordinal',
      'v_page_count <> v_terminal_page_count',
      "'arena.ingest.leaderboard-acquisition-manifest@3'",
      'terminal.source_page_count',
    ]) {
      expect(lineageFunction).toContain(contract)
    }
    expect(migration).toContain('CREATE OR REPLACE VIEW arena.metric_rankable_observations')
    expect(migration).toContain('observation.source_page_ordinal IS NOT NULL')
    expect(migration).toContain('observation.source_page_ordinal <= terminal.source_page_count')
    expect(migration).toContain('parser_lineage.observation_ordinal_is_member IS TRUE')
    expect(migration).toContain('source_lineage.parser_ordinals_are_array IS TRUE')
    expect(migration).toContain("ELSE '[]'::jsonb")
    expect(migration).not.toContain(
      "pg_catalog.jsonb_array_length(\n        population_raw.meta->'parserSourcePageOrdinals'"
    )
  })

  it('publishes an @2 six-key service-only readiness contract bound to 055 bytes', () => {
    for (const field of [
      "'contract', 'arena.metric-trust-release-readiness@2'",
      "'ready'",
      "'missing'",
      "'legacy_complete_verified_count'",
      "'release_migration_sha256'",
      "'source_page_lineage_column'",
    ]) {
      expect(readinessFunction).toContain(field)
    }
    expect(readinessFunction).toContain(
      "WHERE ledger.name = 'metric_trust_source_page_lineage_forward_repair'"
    )
    expect(readinessFunction).toContain('INTO STRICT v_legacy_complete_verified_count')
    expect(readinessFunction).toContain('AND NOT COALESCE(')
    expect(readinessFunction).toContain('parser_lineage.observation_ordinal_is_member IS TRUE')
    expect(readinessFunction).toContain('source_lineage.page_count = terminal.source_page_count')
    expect(readinessFunction).toContain('AND NOT population_raw.quarantined')
    expect(readinessFunction).toContain('AND NOT manifest_raw.quarantined')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_metric_trust_release_readiness\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.arena_metric_trust_release_readiness\(\)\s+TO service_role;/
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
  })

  it('quarantines 054 in the runner and points every exact-main gate at 055/@2', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    expect(predeploy).not.toContain('20260722054000_metric_trust_source_page_lineage.sql')
    expect(predeploy).toContain(migrationName)
    expect(runner).toContain(
      'QUARANTINED_PREDEPLOY_MIGRATIONS=(\n  20260722054000_metric_trust_source_page_lineage.sql'
    )
    for (const source of [verifier, workerGate]) {
      expect(source).toContain('arena.metric-trust-release-readiness@2')
      expect(source).toContain(migrationName)
      expect(source).not.toContain(
        "'supabase/migrations/20260722054000_metric_trust_source_page_lineage.sql'"
      )
    }
    expect(workerGate).toContain('Number.isSafeInteger')
    expect(workerGate).toContain('item.trim() !== item')
    expect(workerGate).toContain('new Set(payload.missing).size')
    expect(workerGate).toContain('QUARANTINED_READINESS_CONTRACT')
    expect(workerGate).toContain('QUARANTINED_054_MIGRATION_SHA256')
  })
})
