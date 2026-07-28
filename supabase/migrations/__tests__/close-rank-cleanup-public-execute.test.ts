import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260725014500_close_rank_cleanup_public_execute.sql'),
  'utf8'
)

describe('legacy rank cleanup EXECUTE boundary', () => {
  it('targets the one exact legacy SECURITY DEFINER callable', () => {
    expect(migration).toContain("'public.cleanup_stale_platform_rows(text,text,text[])'")
    expect(migration).toContain("function_row.prorettype = 'pg_catalog.int4'::pg_catalog.regtype")
    expect(migration).toContain('function_row.prosecdef')
    expect(migration).toContain("function_row.provolatile = 'v'")
    expect(migration).toContain("ARRAY['search_path=public']::pg_catalog.text[]")
    expect(migration).toContain('legacy rank cleanup callable contract drifted')
    expect(migration).toContain('unsupported overload')
  })

  it('refuses to bless a drifted destructive function body', () => {
    expect(migration).toContain("function_row.prosrc,\n          '[[:space:]]+',")
    expect(migration).toContain(
      'DELETE FROM leaderboard_ranks WHERE season_id = p_season_id AND source = p_source'
    )
    expect(migration).toContain('source_trader_id != ALL(p_keep_trader_ids)')
  })

  it('removes PUBLIC and arbitrary delegated grants before granting service role', () => {
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('expanded.grantee <> function_row.proowner')
    expect(migration).toContain("expanded.grantee <> 'service_role'::pg_catalog.regrole")
    expect(migration).toContain('FROM PUBLIC CASCADE')
    expect(migration).toContain('FROM %I CASCADE')
    expect(migration).toContain('REVOKE GRANT OPTION FOR EXECUTE')
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.cleanup_stale_platform_rows\(text, text, text\[\]\)\s+TO service_role;/
    )
  })

  it('postflights effective and direct ACLs as a closed set', () => {
    expect(migration).toContain("pg_catalog.has_function_privilege('anon', v_after, 'EXECUTE')")
    expect(migration).toContain("'authenticated', v_after, 'EXECUTE'")
    expect(migration).toContain('expanded.is_grantable')
    expect(migration).toContain('legacy rank cleanup EXECUTE ACL is not a closed set')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
