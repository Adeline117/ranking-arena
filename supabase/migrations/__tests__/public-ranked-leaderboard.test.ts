import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260816151614_public_ranked_leaderboard.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

function viewBody(): string {
  const start = migration.indexOf('CREATE VIEW public.public_ranked_leaderboard')
  const end = migration.indexOf('ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('public ranked leaderboard view body is missing')
  }
  return migration.slice(start, end)
}

function sourceAuthorityWrapper(): string {
  const start = migration.indexOf(
    'CREATE FUNCTION arena.public_ranked_leaderboard_source_is_expected'
  )
  const end = migration.indexOf(
    '-- The row-level eligibility authority is likewise private.',
    start
  )
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('public ranked leaderboard source authority wrapper is missing')
  }
  return migration.slice(start, end)
}

function rowEligibilityWrapper(): string {
  const start = migration.indexOf('CREATE FUNCTION arena.public_ranked_leaderboard_row_is_eligible')
  const end = migration.indexOf('-- `security_invoker = false` is deliberate.', start)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('public ranked leaderboard row eligibility wrapper is missing')
  }
  return migration.slice(start, end)
}

describe('public ranked leaderboard migration', () => {
  const view = viewBody()
  const sourceAuthority = sourceAuthorityWrapper()
  const rowEligibility = rowEligibilityWrapper()

  it('uses one modern, bounded, additive migration after the copier trust publisher', () => {
    expect(migrationName).toMatch(/^\d{14}_public_ranked_leaderboard\.sql$/)
    expect(migrationName > '20260808021000_publish_copier_snapshot_trust_v2.sql').toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain("pg_catalog.has_schema_privilege('anon', 'arena', 'USAGE')")
    expect(migration).toContain(
      "pg_catalog.has_schema_privilege('authenticated', 'arena', 'USAGE')"
    )
    expect(migration).toContain(
      "pg_catalog.hashtextextended(\n    '20260816-public-ranked-leaderboard',"
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b[\s\S]*public\.leaderboard_ranks/i)
  })

  it('creates one security-barrier public projection with an explicit stable shape', () => {
    expect(view).toContain('WITH (security_barrier = true, security_invoker = false)')
    expect(view).not.toMatch(/rank_row\.\*/)
    expect(view).not.toMatch(/\bOFFSET\b/i)

    for (const column of [
      'id',
      'season_id',
      'source',
      'source_type',
      'source_trader_id',
      'rank',
      'arena_score',
      'arena_score_v3',
      'arena_score_v4',
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'followers',
      'copiers',
      'trades_count',
      'handle',
      'avatar_url',
      'computed_at',
      'profitability_score',
      'risk_control_score',
      'execution_score',
      'score_completeness',
      'trading_style',
      'avg_holding_hours',
      'style_confidence',
      'sharpe_ratio',
      'sortino_ratio',
      'profit_factor',
      'calmar_ratio',
      'trader_type',
      'is_outlier',
      'metrics_estimated',
      'rank_change',
      'is_new',
    ]) {
      expect(view).toContain(`rank_row.${column}`)
    }

    expect(migration).toContain("'leaderboard rank public projection contract is incomplete'")
    expect(view).not.toContain('rank_row.score_factors')
  })

  it('requires rank, current row eligibility, and a narrow expected-source check for the same season', () => {
    expect(view).toContain('WHERE rank_row.rank IS NOT NULL')
    expect(view).toContain('arena.public_ranked_leaderboard_row_is_eligible(')
    expect(view).toContain('pg_catalog.statement_timestamp()')
    expect(view).toContain('arena.public_ranked_leaderboard_source_is_expected(')
    expect(view).toContain('rank_row.source')
    expect(view).toContain('rank_row.season_id')

    expect(sourceAuthority).toContain('RETURNS boolean')
    expect(sourceAuthority).toContain('STRICT')
    expect(sourceAuthority).toContain('SECURITY DEFINER')
    expect(sourceAuthority).toContain('SET search_path = pg_catalog, pg_temp')
    expect(sourceAuthority).toContain('SET row_security = off')
    expect(sourceAuthority).toContain(
      'FROM public.arena_freshness_expected_sources() AS expected_source'
    )
    expect(sourceAuthority).toContain('expected_source.filter_source = p_source')
    expect(sourceAuthority).toContain('expected_source.season_id = p_season_id')
    expect(sourceAuthority).toMatch(
      /AND EXISTS \(\s*SELECT 1\s*FROM public\.arena_freshness_expected_sources\(\) AS expected_source[\s\S]*expected_source\.filter_source = p_source[\s\S]*expected_source\.season_id = p_season_id/s
    )

    expect(rowEligibility).toContain('RETURNS boolean')
    expect(rowEligibility).toContain('STRICT')
    expect(rowEligibility).toContain('SECURITY DEFINER')
    expect(rowEligibility).toContain('SET search_path = pg_catalog, pg_temp')
    expect(rowEligibility).toContain('SET row_security = off')
    expect(rowEligibility).toContain('arena.leaderboard_rank_row_is_public_eligible(')
  })

  it('uses a postgres-owned definer view and only exposes the pair-scoped source capability', () => {
    expect(migration).toContain('ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;')
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.public_ranked_leaderboard\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT SELECT ON TABLE public\.public_ranked_leaderboard\s+TO anon, authenticated, service_role;/
    )
    expect(migration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON FUNCTION public\.arena_freshness_expected_sources\(\)\s+TO\s+(?:PUBLIC|anon|authenticated)/i
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.public_ranked_leaderboard_source_is_expected\(\s*text,\s*text\s*\) FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.public_ranked_leaderboard_source_is_expected\(\s*text,\s*text\s*\) TO anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.public_ranked_leaderboard_row_is_eligible\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.public_ranked_leaderboard_row_is_eligible\([\s\S]*?\) TO anon, authenticated, service_role;/
    )
  })

  it('stays additive until the separately reviewed public-reader cutover', () => {
    expect(migration).not.toMatch(
      /REVOKE SELECT ON TABLE public\.leaderboard_ranks\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).not.toContain("'REVOKE SELECT ON TABLE %s FROM PUBLIC, anon, authenticated'")
    expect(migration).toContain('GRANT SELECT ON TABLE public.public_ranked_leaderboard')
    expect(migration).toContain('existing browser raw')
    expect(migration).toContain('separately reviewed cutover')
  })
})
