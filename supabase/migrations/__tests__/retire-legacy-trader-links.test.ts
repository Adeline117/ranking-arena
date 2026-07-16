import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716111500_retire_legacy_trader_links.sql'),
  'utf8'
)

describe('retired trader_links ACL migration', () => {
  it('is bounded, replayable, and fails before changing a missing relation', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("to_regclass('public.trader_links')")
    expect(migration).toContain('DROP POLICY %I ON public.trader_links')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('removes both table and column privileges from browser roles', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.trader_links[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
    )
    expect(migration).toContain('SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    expect(migration).toContain('SELECT,INSERT,UPDATE,REFERENCES')
    expect(migration).toContain('browser privilege remains on retired public.trader_links')
  })

  it('keeps exactly one service read path and no service mutation capability', () => {
    expect(migration).toContain('GRANT SELECT ON TABLE public.trader_links TO service_role')
    expect(migration).toMatch(
      /CREATE POLICY legacy_trader_links_service_read[\s\S]*FOR SELECT[\s\S]*TO service_role[\s\S]*USING \(true\)/
    )
    expect(migration).toContain('policy.polroles = ARRAY[service_oid]')
    expect(migration).toContain('service read-only ACL is incomplete on public.trader_links')
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE).*service_role/)
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
