import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260729174000_atomic_bookmark_folder_lifecycle.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

const authority = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.mutate_bookmark_folder_atomic'),
  migration.indexOf('ALTER FUNCTION public.mutate_bookmark_folder_atomic')
)
const payloadReader = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.read_bookmark_folder_mutation_payload'),
  migration.indexOf('ALTER FUNCTION public.read_bookmark_folder_mutation_payload')
)

describe('atomic bookmark folder lifecycle migration', () => {
  it('requires canonical name/default uniqueness and the privacy purge trigger', () => {
    expect(migration).toContain("ARRAY['user_id', 'name']::name[]")
    expect(migration).toContain("= '(is_default IS TRUE)'")
    expect(migration).toContain('trg_bookmark_folders_80_purge_subscriptions')
    expect(migration).toContain('public.purge_bookmark_folder_subscriptions_after_scope_change()')
  })

  it('closes every direct authenticated and service mutation path', () => {
    expect(migration).toContain("policy.polcmd <> 'r'")
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.bookmark_folders[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT SELECT ON TABLE public\.bookmark_folders[\s\S]*TO anon, authenticated, service_role/
    )
    expect(migration).not.toMatch(/GRANT (INSERT|UPDATE|DELETE) ON TABLE/)
  })

  it('uses explicit presence bits so omitted and explicit-null updates differ', () => {
    for (const flag of [
      'p_set_name boolean',
      'p_set_description boolean',
      'p_set_avatar_url boolean',
      'p_set_is_public boolean',
    ]) {
      expect(authority).toContain(flag)
    }
    expect(authority).toContain('(NOT p_set_description AND p_description IS NOT NULL)')
    expect(authority).toContain('WHEN p_set_description THEN p_description')
    expect(authority).toContain('WHEN p_set_avatar_url THEN p_avatar_url')
  })

  it('serializes active-account admission before any folder row mutation', () => {
    expect(authority).toContain("'account-recovery-admission:' || v_actor_id::text")
    expect(authority).toContain('profile.deleted_at IS NULL')
    expect(authority).toContain('profile.banned_at IS NULL')
    expect(authority).toMatch(
      /PERFORM pg_catalog\.pg_advisory_xact_lock[\s\S]*FROM public\.user_profiles[\s\S]*INSERT INTO public\.bookmark_folders/
    )
    expect(authority).toMatch(/FROM public\.bookmark_folders AS folder[\s\S]*FOR UPDATE/)
  })

  it('keeps default folders undeletable and unrenameable in the authority', () => {
    expect(authority).toMatch(
      /IF p_action = 'delete' THEN[\s\S]*IF v_folder\.is_default THEN[\s\S]*'default_protected'/
    )
    expect(authority).toMatch(
      /IF v_folder\.is_default[\s\S]*p_name IS DISTINCT FROM v_folder\.name[\s\S]*'default_protected'/
    )
  })

  it('maps unique races to a deterministic conflict and returns same-transaction data', () => {
    expect(authority.match(/WHEN unique_violation THEN/g)).toHaveLength(2)
    expect(authority).toContain("'name_conflict'")
    expect(authority).toContain('public.read_bookmark_folder_mutation_payload(p_folder_id)')
    for (const key of ['id', 'user_id', 'post_count', 'subscriber_count']) {
      expect(payloadReader).toContain(`'${key}'`)
    }
  })

  it('keeps payload reading private and mutation execution authenticated-only', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.read_bookmark_folder_mutation_payload\(uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.mutate_bookmark_folder_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.mutate_bookmark_folder_atomic\([\s\S]*TO authenticated/
    )
  })
})
