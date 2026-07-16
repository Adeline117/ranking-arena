import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716175000_atomic_group_dissolution.sql'),
  'utf8'
)

function functionBody(name: string, nextMarker: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  const end = migration.indexOf(nextMarker, start)
  if (start < 0 || end < 0) throw new Error(`missing function boundary for ${name}`)
  return migration.slice(start, end)
}

const guard = functionBody(
  'enforce_group_dissolution_write',
  'ALTER FUNCTION public.enforce_group_dissolution_write()'
)
const dissolve = functionBody(
  'dissolve_group_atomic',
  'ALTER FUNCTION public.dissolve_group_atomic(uuid, uuid)'
)

describe('atomic group dissolution migration', () => {
  it('is transactional, replay-serialized and schema reloading', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("hashtextextended('group-application-authority-migrations', 0)")
    expect(migration).toContain('LOCK TABLE public.group_audit_log IN ACCESS EXCLUSIVE MODE NOWAIT')
    expect(migration).toContain('LOCK TABLE public.groups IN ACCESS EXCLUSIVE MODE NOWAIT')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
  })

  it('makes dissolved_at one-way and rejects pre-dissolved inserts', () => {
    expect(guard).toContain("TG_OP = 'INSERT'")
    expect(guard).toContain('NEW.dissolved_at IS NOT NULL')
    expect(guard).toContain('NEW.dissolved_at IS NOT DISTINCT FROM OLD.dissolved_at')
    expect(guard).toContain('OLD.dissolved_at IS NOT NULL OR NEW.dissolved_at IS NULL')
    expect(guard).toContain("'arena.group_dissolution_path'")
    expect(guard).toContain("'dissolve_group_atomic'")
    expect(migration).toContain('trg_groups_99_guard_dissolution')
  })

  it('removes direct dissolved_at updates while preserving bounded service writes', () => {
    expect(migration).toContain("attribute.attname <> 'dissolved_at'")
    expect(migration).toContain("'GRANT UPDATE (%s) ON TABLE public.groups TO service_role'")
    expect(migration).toContain("'dissolved_at',\n    'UPDATE'")
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.groups')
    expect(migration).toContain('FROM %I CASCADE')
  })

  it('locks active actor and ownership before updating state and audit together', () => {
    expect(dissolve).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(dissolve).toContain("'group-dissolution:' || p_group_id::text")
    expect(dissolve).toMatch(/FROM auth\.users AS auth_user[\s\S]*?FOR SHARE;/)
    expect(dissolve).toMatch(/FROM public\.user_profiles AS profile[\s\S]*?FOR UPDATE;/)
    expect(dissolve).toMatch(/FROM public\.groups AS target_group[\s\S]*?FOR UPDATE;/)
    expect(dissolve).toContain('v_group.created_by IS DISTINCT FROM p_actor_id')
    expect(dissolve).toMatch(
      /UPDATE public\.groups AS target_group[\s\S]*?SET dissolved_at = v_now/
    )
    expect(dissolve).toMatch(/INSERT INTO public\.group_audit_log[\s\S]*?'dissolve'/)
    expect(dissolve.indexOf('UPDATE public.groups')).toBeLessThan(
      dissolve.indexOf('INSERT INTO public.group_audit_log')
    )
  })

  it('requires the private audit boundary and preserves account-purge count repair', () => {
    expect(migration).toContain("'public.group_audit_log'::pg_catalog.regclass")
    expect(migration).toContain('AND NOT relation.relforcerowsecurity')
    expect(migration).toContain('v_audit_target_attnum = ANY(constraint_row.conkey)')
    expect(migration).toContain(
      "'public.purge_deleted_account_group_edges(uuid)'::pg_catalog.regprocedure"
    )
    expect(guard).toContain('NEW.dissolved_at IS NOT DISTINCT FROM OLD.dissolved_at')
  })

  it('uses the one-way group row for replay and emits one audit only on first apply', () => {
    expect(dissolve).toContain("'status', 'already_dissolved'")
    expect(dissolve.indexOf("'status', 'already_dissolved'")).toBeLessThan(
      dissolve.indexOf('INSERT INTO public.group_audit_log')
    )
    expect(dissolve).toContain("'status', 'dissolved'")
    expect(dissolve).toContain("'audit_log_id', v_audit_id")
  })

  it('converges arbitrary ACL/policy drift and exposes only the service RPC', () => {
    expect(migration).toContain('DROP POLICY %I ON public.groups')
    expect(migration).toContain('CREATE POLICY browser_read')
    expect(migration).toContain('CREATE POLICY server_role_mutation')
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.dissolve_group_atomic(uuid, uuid)'
    )
    expect(migration).toContain('service_role has an unsafe effective authority edge')
    expect(migration).toContain('acl_entry.grantor = v_postgres_oid')
  })
})
