import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729223000_rerank_public_eligible_rows_only.sql'),
  'utf8'
)

describe('eligibility-aware leaderboard rerank migration', () => {
  it('installs only the new fail-closed identity before the atomic cutover migration', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.rerank_public_eligible_leaderboard('
    )
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.rerank_leaderboard(')
    expect(migration).not.toContain('RETURN public.rerank_public_eligible_leaderboard(p_season_id)')
  })

  it('uses the reviewed source and row authorities in one set-based rewrite', () => {
    expect(migration).toContain('public.arena_freshness_expected_sources()')
    expect(migration).toContain('arena.leaderboard_rank_row_is_public_eligible(')
    expect(migration).toContain('rank_authority.source IS NOT NULL')
    expect(migration).toMatch(/FROM classified\s+WHERE classified\.is_eligible/)
    expect(migration).toMatch(/FROM classified\s+LEFT JOIN ordered/)
    expect(migration).toContain('rank = desired.expected_rank')
    expect(migration).toContain('NULL::integer AS expected_rank_change')
    expect(migration).toContain('false AS expected_is_new')
    expect(migration).toContain('rank_change = desired.expected_rank_change')
    expect(migration).toContain('is_new = desired.expected_is_new')
    expect(migration).toContain('ranks.rank IS DISTINCT FROM desired.expected_rank')
  })

  it('pins the post-quarantine expected-source authority before installing', () => {
    expect(migration).toContain("'bitget-bot-cumulative-rank-quarantine@1'")
    expect(migration).toContain("function_row.proowner = 'postgres'::pg_catalog.regrole")
    expect(migration).toContain("function_row.provolatile = 's'")
    expect(migration).toContain('function_row.proretset')
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]")
    expect(migration).toContain('leaderboard_ranks_block_cumulative_bitget_bot_authority')
    expect(migration).toContain('constraint_row.convalidated')
    expect(migration).toContain('pg_catalog.pg_get_constraintdef(constraint_row.oid, true)')
    expect(migration).toContain("''bitget_bots_futures''::text")
    expect(migration).toContain("''bitget_bots_spot''::text")
  })

  it('uses the established proof-authority tie order and composite row identity', () => {
    expect(migration).toContain('classified.arena_score DESC NULLS LAST')
    expect(migration).not.toContain('classified.source COLLATE "C"')
    expect(migration).not.toContain('classified.source_trader_id COLLATE "C"')
    expect(migration).toContain('ordered.season_id = classified.season_id')
    expect(migration).toContain('ranks.id = desired.id')
    expect(migration).toContain('ranks.season_id = desired.season_id')
  })

  it('locks in publication order and rejects unknown seasons', () => {
    const registryLock = migration.indexOf(
      'LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE'
    )
    const rankLock = migration.indexOf(
      'LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE'
    )

    expect(registryLock).toBeGreaterThan(-1)
    expect(rankLock).toBeGreaterThan(registryLock)
    expect(migration).toContain("p_season_id NOT IN ('7D', '30D', '90D')")
    expect(migration).toContain("USING ERRCODE = '22023'")
  })

  it('removes every inherited non-owner ACL from the new identity only', () => {
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('OWNER TO postgres')
    expect(migration).toContain('DO $close_acl$')
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain("pg_catalog.acldefault('f', function_row.proowner)")
    expect(migration).toContain("('public.rerank_public_eligible_leaderboard(text)'::text)")
    expect(migration).not.toContain("('public.rerank_leaderboard(text)'::text)")
    expect(migration).toContain('acl_row.grantee <> v_owner')
    expect(migration).toContain('FROM PUBLIC CASCADE')
    expect(migration).toContain('FROM %I CASCADE')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.rerank_public_eligible_leaderboard\(text\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.rerank_public_eligible_leaderboard\(text\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('acl_row.grantee <> function_row.proowner')
    expect(migration).toContain('acl_row.grantee <> v_service_role')
    expect(migration).toContain('AND NOT acl_row.is_grantable')
  })

  it('installs authority without a cross-transaction live-data repair', () => {
    expect(migration).not.toMatch(
      /SELECT public\.rerank_public_eligible_leaderboard\(season\.season_id\)/
    )
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('rerank function catalog postflight failed')
  })
})
