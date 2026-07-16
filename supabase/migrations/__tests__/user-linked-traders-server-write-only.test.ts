import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260716093000_user_linked_traders_server_write_only.sql'
  ),
  'utf8'
)

describe('linked trader server-write-only migration', () => {
  it('is bounded and refuses to run before the atomic RPC migration', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("to_regprocedure('public.set_primary_linked_trader(uuid,uuid)')")
    expect(migration).toContain("to_regprocedure('public.unlink_linked_trader(uuid,uuid)')")
  })

  it('removes browser writes while preserving authenticated own-row reads', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.user_linked_traders[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('GRANT SELECT ON TABLE public.user_linked_traders TO authenticated')
    expect(migration).toMatch(
      /CREATE POLICY "Authenticated users can view own linked traders"[\s\S]*FOR SELECT[\s\S]*TO authenticated[\s\S]*auth\.uid\(\)/
    )
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*TO authenticated/)
  })

  it('keeps table mutations and both RPCs service-only', () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*ON TABLE public\.user_linked_traders[\s\S]*TO service_role/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages linked traders"[\s\S]*FOR ALL[\s\S]*TO service_role/
    )
    for (const functionName of ['set_primary_linked_trader', 'unlink_linked_trader']) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\(uuid, uuid\\)[\\s\\S]*FROM PUBLIC, anon, authenticated`
        )
      )
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\(uuid, uuid\\)[\\s\\S]*TO service_role`
        )
      )
    }
  })
})
