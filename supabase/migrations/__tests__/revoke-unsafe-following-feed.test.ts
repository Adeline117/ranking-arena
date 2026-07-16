import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715224500_revoke_unsafe_following_feed.sql'),
  'utf8'
)

describe('unsafe following feed RPC retirement', () => {
  it('is atomic, replayable, and reloads the PostgREST schema cache', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
    expect(migration).not.toMatch(/DROP FUNCTION/)
  })

  it('revokes every production overload from every application role', () => {
    expect(migration).toMatch(/procedure\.proname = 'get_following_feed'/)
    expect(migration).toMatch(/procedure\.prokind = 'f'/)
    expect(migration).toMatch(/procedure\.oid::regprocedure AS signature/)
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role/
    )
  })

  it('fails closed if inherited or direct execute privilege remains', () => {
    expect(migration).toMatch(/pg_catalog\.aclexplode\(/)
    expect(migration).toMatch(/privilege\.grantee = 0/)
    expect(migration).toMatch(/privilege\.privilege_type = 'EXECUTE'/)
    expect(migration).toMatch(/pg_catalog\.has_function_privilege\(/)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(migration).toContain(`('${role}'::name)`)
    }
    expect(migration).toContain('get_following_feed remains executable by an application role')
  })
})
