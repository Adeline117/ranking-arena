import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729224000_rank_eligible_leaderboard_count_cache.sql'
  ),
  'utf8'
)

describe('rank-authoritative leaderboard count cache', () => {
  it('keeps legacy baselines while requiring rank authority for both public families', () => {
    const insertStart = migration.indexOf('INSERT INTO public.leaderboard_count_cache')
    const insertEnd = migration.indexOf('END\n$function$', insertStart)
    const insertBody = migration.slice(insertStart, insertEnd)
    const publicBranches = insertBody.split('UNION ALL').slice(2)

    expect(publicBranches).toHaveLength(2)
    for (const branch of publicBranches) {
      expect(branch).toContain('ranks.rank IS NOT NULL')
      expect(branch).toContain('ranks.arena_score > 0')
      expect(branch).toContain('ranks.is_outlier IS NOT TRUE')
    }
    expect(insertBody.split('UNION ALL')[0]).not.toContain('ranks.rank IS NOT NULL')
    expect(insertBody.split('UNION ALL')[1]).not.toContain('ranks.rank IS NOT NULL')
  })

  it('uses a new fail-closed RPC and makes both legacy entry points safe wrappers', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.refresh_public_rank_count_cache_for_seasons('
    )
    expect(migration).toContain(
      'PERFORM public.refresh_public_rank_count_cache_for_seasons(p_season_ids)'
    )
    expect(migration).toContain("ARRAY['7D', '30D', '90D']::text[]")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.rerank_leaderboard(')
    expect(migration).toContain('RETURN public.rerank_public_eligible_leaderboard(p_season_id)')
  })

  it('sweeps arbitrary inherited ACLs and grants only service_role', () => {
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('privilege.grantee <> v_owner')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*refresh_public_rank_count_cache_for_seasons[\s\S]*TO service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*public\.rerank_leaderboard\(text\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
  })

  it('freezes rank membership before replacing a count generation', () => {
    const rankLock = migration.indexOf('LOCK TABLE public.leaderboard_ranks IN SHARE MODE')
    const countLock = migration.indexOf(
      'LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE'
    )
    const deletion = migration.indexOf('DELETE FROM public.leaderboard_count_cache AS cache')

    expect(rankLock).toBeGreaterThan(-1)
    expect(countLock).toBeGreaterThan(rankLock)
    expect(deletion).toBeGreaterThan(countLock)
  })

  it('repairs ranks before counts in the same transaction and verifies before commit', () => {
    const begin = migration.indexOf('BEGIN;')
    const rerank = migration.indexOf(
      'SELECT public.rerank_public_eligible_leaderboard(season.season_id)'
    )
    const legacyCutover = migration.indexOf('CREATE OR REPLACE FUNCTION public.rerank_leaderboard(')
    const refresh = migration.indexOf('SELECT public.refresh_public_rank_count_cache_for_seasons(')
    const commit = migration.lastIndexOf('COMMIT;')

    expect(begin).toBeGreaterThan(-1)
    expect(legacyCutover).toBeGreaterThan(begin)
    expect(rerank).toBeGreaterThan(legacyCutover)
    expect(refresh).toBeGreaterThan(rerank)
    expect(commit).toBeGreaterThan(refresh)
    expect(migration).toMatch(
      /SELECT public\.refresh_public_rank_count_cache_for_seasons\([\s\S]*'7D'[\s\S]*'30D'[\s\S]*'90D'/
    )
    expect(migration).toContain('FULL JOIN actual USING (season_id, source, total_count)')
    expect(migration).toContain("USING ERRCODE = '23514'")
  })
})
