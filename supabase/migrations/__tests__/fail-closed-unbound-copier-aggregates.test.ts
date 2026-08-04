import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260804052000_fail_closed_unbound_copier_aggregates.sql'
  ),
  'utf8'
)
const proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/record-provenance-clocks.pg17.sh'),
  'utf8'
)
const functionBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.arena_copier_aggregate'),
  migration.indexOf('ALTER FUNCTION public.arena_copier_aggregate')
)

describe('unbound copier aggregate containment', () => {
  it('removes private row batches from every public aggregate value', () => {
    expect(functionBody).not.toContain('arena.copier_records')
    expect(functionBody).not.toContain('batch_candidate')
    expect(functionBody).not.toContain('FROM batch')
    expect(functionBody).not.toMatch(/sum\s*\(/i)
    expect(functionBody).toContain("'pnlDistribution', '[]'::pg_catalog.jsonb")
  })

  it('accepts only exact profile-publication evidence', () => {
    expect(functionBody).toContain('trusted_profile_candidates AS (')
    expect(functionBody).toContain("stats.extras -> '_arena_profile_publication_epoch_ms'")
    expect(functionBody).toMatch(
      /CASE[\s\S]*jsonb_typeof\([\s\S]*_arena_profile_publication_epoch_ms[\s\S]*= 'number'[\s\S]*ELSE NULL::pg_catalog\.numeric[\s\S]*END = EXTRACT\(EPOCH FROM stats\.as_of\) \* 1000/
    )
    expect(functionBody).toContain('profile.timeframe = 0')
    expect(functionBody).toContain("source_row.meta->>'inception_tf' = 'true'")
  })

  it('publishes a non-bot count only when the newest profile rows agree', () => {
    expect(functionBody).toContain('latest_profile_at AS (')
    expect(functionBody).toContain('trusted_current_count AS (')
    expect(functionBody).toMatch(
      /pg_catalog\.min\(profile\.copier_count\) =\s+pg_catalog\.max\(profile\.copier_count\)/
    )
    expect(functionBody).toContain('WHERE NOT resolved.is_bitget_bot')
  })

  it('retains active-serving, canonical Bot, provenance, and ACL boundaries', () => {
    expect(functionBody).toContain("source_row.status = 'active'")
    expect(functionBody).toContain("source_row.serving_mode = 'serving'")
    expect(functionBody).toContain('resolved.canonical_bitget_bot')
    for (const clock of ['asOf', 'sourceAsOf', 'observedAt', 'publishedAt']) {
      expect(functionBody).toContain(`'${clock}', NULL::pg_catalog.timestamptz`)
    }
    expect(functionBody).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('has PG17 coverage for row-only, window-conflict, lifetime, privacy, and replay cases', () => {
    for (const marker of [
      'row-derived Gate-shaped aggregate remained public',
      'same-clock timeframe conflict remained public',
      'unmarked profile aggregate remained public',
      'trusted current copier count was not preserved',
      'window PnL escaped without an inception contract',
      'trusted lifetime copier totals were not preserved',
      'copier histogram was not quarantined',
      'copier aggregate containment replay drifted',
      'unbound copier aggregate containment PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
