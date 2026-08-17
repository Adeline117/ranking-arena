import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260816184500_public_ranked_leaderboard_source_freshness_gate.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}
const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = migration.indexOf(startMarker)
  const end = migration.indexOf(endMarker, start)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`missing migration block: ${startMarker}`)
  }
  return migration.slice(start, end)
}

const captureAuthority = sliceBetween(
  'CREATE FUNCTION arena.capture_public_ranked_leaderboard_serving_authority()',
  '-- Browser callers may learn only whether a season has a current authority;'
)
const servingSeasons = sliceBetween(
  'CREATE FUNCTION arena.public_ranked_leaderboard_serving_seasons(',
  '-- Materialize one statement clock and the bounded season authority before the'
)
const view = sliceBetween(
  'CREATE OR REPLACE VIEW public.public_ranked_leaderboard',
  'ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;'
)

describe('public ranked leaderboard source freshness gate migration', () => {
  it('is a forward, transactional replacement after the public cohort view', () => {
    expect(migrationName).toMatch(/^\d{14}_public_ranked_leaderboard_source_freshness_gate\.sql$/)
    expect(migrationName > '20260816151614_public_ranked_leaderboard.sql').toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('keeps the detailed full proof service-only and out of the public read path', () => {
    expect(migration).toContain("'public.arena_leaderboard_publication_proofs(text,text[])'")
    expect(migration).toContain("has_function_privilege('anon', v_proof, 'EXECUTE')")
    expect(migration).toContain("has_function_privilege('authenticated', v_proof, 'EXECUTE')")
    expect(migration).toContain("has_function_privilege('service_role', v_proof, 'EXECUTE')")
    expect(migration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON FUNCTION public\.arena_leaderboard_publication_proofs\s*\(/i
    )
    expect(servingSeasons).not.toContain('arena_leaderboard_publication_proofs')
    expect(view).not.toContain('arena_leaderboard_publication_proofs')
    expect(migration).toContain('No full proof/ROW_NUMBER path is reachable from this view.')
  })

  it('creates private, postgres-owned RLS serving authorities rather than public tokens', () => {
    for (const relation of [
      'arena.leaderboard_rank_season_mutation_fences',
      'arena.public_ranked_leaderboard_serving_heads',
      'arena.public_ranked_leaderboard_serving_sources',
    ]) {
      expect(migration).toContain(`CREATE TABLE ${relation}`)
      expect(migration).toContain(`ALTER TABLE ${relation} OWNER TO postgres;`)
      expect(migration).toContain(`ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY;`)
    }

    expect(migration).toContain(
      'REVOKE ALL ON TABLE arena.leaderboard_rank_season_mutation_fences,'
    )
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role;')
    expect(migration).toContain('DROP POLICY IF EXISTS "leaderboard_source_freshness_public_read"')
    expect(migration).toContain('REVOKE SELECT ON public.leaderboard_source_freshness')
    expect(migration).toContain('source freshness proof tuples remain publicly readable')
  })

  it('adds a season-global parent-DML fence for every rank write shape', () => {
    expect(migration).toContain('CREATE FUNCTION arena.bump_leaderboard_rank_season_insert_fence()')
    expect(migration).toContain('CREATE FUNCTION arena.bump_leaderboard_rank_season_update_fence()')
    expect(migration).toContain('CREATE FUNCTION arena.bump_leaderboard_rank_season_delete_fence()')
    expect(migration).toContain('CREATE TRIGGER leaderboard_rank_season_insert_fence')
    expect(migration).toContain('CREATE TRIGGER leaderboard_rank_season_update_fence')
    expect(migration).toContain('CREATE TRIGGER leaderboard_rank_season_delete_fence')
    expect(migration).toContain('REFERENCING NEW TABLE AS new_rank_rows')
    expect(migration).toContain('REFERENCING OLD TABLE AS old_rank_rows NEW TABLE AS new_rank_rows')
    expect(migration).toContain('REFERENCING OLD TABLE AS old_rank_rows')
    expect(migration).toContain(
      "a mutation in source B changes source A's global rank position too."
    )
  })

  it('captures authority only from the same transaction as an actual full seal', () => {
    expect(captureAuthority).toContain("'arena.leaderboard_seal_cohort'")
    expect(captureAuthority).toContain('v_score_cohort_id := v_marker::uuid')
    expect(captureAuthority).toContain(
      'publication.xmin = pg_catalog.pg_current_xact_id()::pg_catalog.xid'
    )
    expect(captureAuthority).toContain('old receipt cannot be raw-backfilled')
    expect(captureAuthority).toContain('public.arena_freshness_expected_sources()')
    expect(captureAuthority).toContain(
      'v_publication.source_count IS DISTINCT FROM v_expected_count'
    )
    expect(captureAuthority).toContain(
      'freshness.rank_mutation_seq IS DISTINCT FROM fence.mutation_seq'
    )
    expect(captureAuthority).toContain(
      "'published_identity_sha256', freshness.published_identity_sha256"
    )
    expect(captureAuthority).toContain('arena.leaderboard_rank_row_is_public_eligible(')
    expect(captureAuthority).toContain("rank_row.computed_at + interval '48 hours'")
    expect(captureAuthority).toContain('INSERT INTO arena.public_ranked_leaderboard_serving_heads')
    expect(captureAuthority).toContain(
      'INSERT INTO arena.public_ranked_leaderboard_serving_sources'
    )
    expect(migration).toContain(
      'CREATE TRIGGER leaderboard_source_freshness_capture_serving_authority'
    )
    expect(migration).toContain('AFTER INSERT OR UPDATE ON public.leaderboard_source_freshness')
  })

  it('exposes only a season-level bounded read capability', () => {
    expect(servingSeasons).toMatch(/RETURNS TABLE \(\s*season_id text\s*\)/s)
    expect(servingSeasons).toContain('LANGUAGE plpgsql')
    expect(servingSeasons).toContain('STABLE')
    expect(servingSeasons).toContain('STRICT')
    expect(servingSeasons).toContain('SECURITY DEFINER')
    expect(servingSeasons).toContain('SET search_path = pg_catalog, pg_temp')
    expect(servingSeasons).toContain('SET row_security = off')
    expect(servingSeasons).toContain('expected.sources = head.expected_sources')
    expect(servingSeasons).toContain('season_fence.mutation_seq = head.rank_mutation_epoch')
    expect(servingSeasons).toContain('head.rank_valid_until >= p_observed_at')
    expect(servingSeasons).toContain(
      'source_fence.mutation_seq IS DISTINCT FROM serving.rank_mutation_seq'
    )
    expect(servingSeasons).toContain("serving.source_as_of <= p_observed_at - interval '48 hours'")
    expect(servingSeasons).toContain("serving.source_as_of > p_observed_at + interval '5 minutes'")
    expect(servingSeasons).toContain(
      'publication.published_at IS DISTINCT FROM serving.recorded_at'
    )
    expect(servingSeasons).toContain('pg_catalog.jsonb_array_elements(publication.proofs)')
    expect(servingSeasons).not.toContain('score_cohort_id uuid')

    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.public_ranked_leaderboard_serving_seasons\([\s\S]*?\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.public_ranked_leaderboard_serving_seasons\([^\n]*\)\s+TO anon, authenticated, service_role;/
    )
  })

  it('joins a valid full-season authority and exact source cohort before caller paging', () => {
    expect(view).toContain('WITH (security_barrier = true, security_invoker = false)')
    expect(view).toContain('WITH observed AS MATERIALIZED')
    expect(view).toContain('serving_seasons AS MATERIALIZED')
    expect(view).toContain('pg_catalog.statement_timestamp() AS observed_at')
    expect(view).toContain('arena.public_ranked_leaderboard_serving_seasons(')
    expect(view).toMatch(
      /JOIN ONLY arena\.public_ranked_leaderboard_serving_heads AS head\s+ON head\.season_id = rank_row\.season_id\s+AND head\.score_cohort_id = rank_row\.rank_publication_id/s
    )
    expect(view).toMatch(
      /JOIN ONLY arena\.public_ranked_leaderboard_serving_sources AS source_witness\s+ON source_witness\.season_id = rank_row\.season_id\s+AND source_witness\.source = rank_row\.source\s+AND source_witness\.score_cohort_id = rank_row\.rank_publication_id/s
    )
    expect(view).toContain('WHERE rank_row.rank IS NOT NULL')
    expect(view).toContain('arena.public_ranked_leaderboard_row_is_eligible(')
    expect(view).not.toMatch(/\b(?:OFFSET|LIMIT)\b/i)
  })

  it('preserves the explicit public projection and keeps internal cohort ids private', () => {
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
    expect(view).not.toContain('rank_row.score_factors')
    expect(view).not.toContain('rank_row.rank_publication_id,')
    expect(migration).toContain("attribute.attname IN ('rank_publication_id', 'score_factors')")
    expect(migration).toContain(
      'public ranked leaderboard security barrier or projection regressed'
    )
  })

  it('runs the disposable source-freshness proof in CI', () => {
    expect(packageJson.scripts?.['qa:public-ranked-leaderboard-pg17']).toBe(
      'bash supabase/migrations/__tests__/public-ranked-leaderboard.pg17.sh'
    )
    expect(ciWorkflow).toContain('name: Prove public ranked leaderboard source freshness')
    expect(ciWorkflow).toContain('run: npm run qa:public-ranked-leaderboard-pg17')
    expect(ciWorkflow).toContain('PG17_BIN: /usr/lib/postgresql/17/bin')
  })
})
