import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260721150000_metric_trust_raw_artifact_identity.sql'),
  'utf8'
)

describe('metric trust RAW artifact identity migration', () => {
  it('is atomic and fails closed on missing foundations or prior duplicates', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("to_regclass('arena.metric_trust_runs')")
    expect(migration).toContain('duplicate population manifests already exist')
    expect(migration).toContain('duplicate Tier-A population payloads already exist')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('allows only one manifest and one Tier-A population payload per source run', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX uidx_raw_population_manifest_per_run[\s\S]*ON arena\.raw_objects \(source_run_id\)[\s\S]*trust_artifact_role = 'population_manifest'/
    )
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX uidx_raw_tier_a_population_per_run[\s\S]*ON arena\.raw_objects \(source_run_id\)[\s\S]*trust_artifact_role = 'source_payload'[\s\S]*job_type = 'tier_a'[\s\S]*trader_id IS NULL/
    )
    expect(migration).not.toMatch(
      /UNIQUE[^;]*trust_artifact_role[^;]*source_payload(?![\s\S]*job_type = 'tier_a')/
    )
  })
})
