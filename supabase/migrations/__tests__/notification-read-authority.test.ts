import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const migration = read('supabase/migrations/20260717220000_notification_read_authority.sql')
const notificationsRoute = read('app/api/notifications/route.ts')
const apiMiddleware = read('lib/api/middleware.ts')
const notificationData = read('lib/data/notifications.ts')

describe('notification read authority migration', () => {
  it('installs transactionally under a bounded shared lock', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '1min'")
    expect(migration).toContain("'notification-read-authority'")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed only when the canonical RPC or auth role primitive is missing', () => {
    expect(migration).toContain(
      'canonical get_user_notifications(uuid,integer,integer,boolean) is missing'
    )
    expect(migration).toContain('auth.role() is unavailable or incompatible')
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.get_user_notifications')
    )
  })

  it('rebuilds the canonical reader with qualified data access and a runtime guard', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_user_notifications[\s\S]*?LANGUAGE plpgsql[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("auth.role() IS DISTINCT FROM 'service_role'")
    expect(migration).toContain("USING ERRCODE = '42501'")
    expect(migration).toContain('FROM public.notifications AS notification')
    expect(migration).toContain('FROM public.notifications AS unread_notification')
    expect(migration).toContain('LEFT JOIN public.user_profiles AS actor')
  })

  it('quarantines every function overload and every explicit grantee', () => {
    expect(migration).toContain('DO $converge_overload_authority$')
    expect(migration).toContain("function_row.proname = 'get_user_notifications'")
    expect(migration).toContain("function_row.prokind = 'f'")
    expect(migration).toContain("'ALTER FUNCTION %s OWNER TO postgres'")
    expect(migration).toContain("'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE'")
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain("'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE'")
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*?ON FUNCTION public\.get_user_notifications\(uuid, integer, integer, boolean\)[\s\S]*?TO service_role/
    )
    expect(migration).not.toMatch(/GRANT EXECUTE[\s\S]*?TO (?:PUBLIC|anon|authenticated)/)
  })

  it('postflights the exact canonical contract and every overload ACL', () => {
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('function_row.proargdefaults')
    expect(migration).toContain("'50, 0, false'")
    expect(migration).toContain('pg_catalog.pg_get_function_identity_arguments')
    expect(migration).toContain('pg_catalog.pg_get_function_result')
    expect(migration).toContain(
      "pg_catalog.md5(function_row.prosrc) =\n        'e65cc383873adaa2dca14b0e3eb5cac6'"
    )
    expect(migration).toContain('pg_catalog.has_function_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('pg_catalog.acldefault')
    expect(migration).toContain('acl_entry.is_grantable')
    expect(migration).toContain('get_user_notifications overload authority did not converge')
  })

  it('preserves the authenticated service-client HTTP path', () => {
    expect(notificationsRoute).toContain('export const GET = withAuth(')
    expect(apiMiddleware).toContain('const supabase = getSupabaseAdmin() as SupabaseClient')
    expect(notificationData).toContain("supabase.rpc('get_user_notifications'")
  })
})
