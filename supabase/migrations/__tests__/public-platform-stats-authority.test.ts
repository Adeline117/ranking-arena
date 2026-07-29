import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729065500_public_platform_stats_authority.sql'),
  'utf8'
)

describe('public platform statistics authority RPC', () => {
  it('requires an exact cohort and bounded canonical source allowlist', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_public_platform_stats(')
    expect(migration).toContain('p_score_cohort_id uuid')
    expect(migration).toContain('p_allowed_sources text[]')
    expect(migration).toContain('pg_catalog.cardinality(p_allowed_sources) > 256')
    expect(migration).toContain("input.source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'")
    expect(migration).toContain('pg_catalog.count(*) <> pg_catalog.count(DISTINCT input.source)')
  })

  it('filters authority and generation before every aggregate', () => {
    const allowedJoin = migration.indexOf('JOIN allowed')
    const cohortFence = migration.indexOf('ranks.rank_publication_id = p_score_cohort_id')
    const groupBy = migration.indexOf('GROUP BY ranks.source')

    expect(allowedJoin).toBeGreaterThan(-1)
    expect(cohortFence).toBeGreaterThan(allowedJoin)
    expect(groupBy).toBeGreaterThan(cohortFence)
    expect(migration).toContain('ON allowed.source = ranks.source')
    expect(migration).toContain('ranks.arena_score > 0')
    expect(migration).toContain('(ranks.is_outlier IS NULL OR ranks.is_outlier = false)')
  })

  it('is invoker-safe, service-only, and reloads PostgREST', () => {
    expect(migration).toContain('SECURITY INVOKER')
    expect(migration).toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(migration).toContain(') FROM PUBLIC, anon, authenticated;')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_public_platform_stats\([\s\S]*?\) TO service_role;/
    )
    expect(migration).toContain("ERRCODE = '22023'")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
