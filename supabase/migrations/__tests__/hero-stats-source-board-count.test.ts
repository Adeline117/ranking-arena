import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260717130000_hero_stats_count_live_source_boards.sql'),
  'utf8'
)

describe('hero stats live source-board count', () => {
  it('is an atomic, bounded migration accepted by the launch runner', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('counts one positive cache row per live ranking board', () => {
    expect(migration).toContain('SELECT COUNT(*) INTO v_source_board_count')
    expect(migration).toContain("RIGHT(source, 4) = '_gt0'")
    expect(migration).toContain("source <> '_all_gt0'")
    expect(migration).not.toContain("split_part(source, '_', 1)")
  })

  it('uses the same 90D visibility threshold when the cache is cold', () => {
    expect(migration).toContain('COUNT(DISTINCT source)')
    expect(migration).toContain("season_id = '90D'")
    expect(migration).toContain('arena_score > 0')
    expect(migration).toContain('(is_outlier IS NULL OR is_outlier = false)')
  })

  it('preserves the legacy RPC return shape for existing API clients', () => {
    expect(migration).toContain('RETURNS TABLE(exchange_count bigint, trader_count bigint)')
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_hero_stats() TO anon, authenticated, service_role'
    )
  })
})
