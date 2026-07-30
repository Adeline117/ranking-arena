import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260729173000_atomic_bookmark_folder_subscription.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

const authority = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.mutate_bookmark_folder_subscription_atomic'),
  migration.indexOf('ALTER FUNCTION public.mutate_bookmark_folder_subscription_atomic')
)
const privacyTrigger = migration.slice(
  migration.indexOf(
    'CREATE OR REPLACE FUNCTION public.purge_bookmark_folder_subscriptions_after_scope_change'
  ),
  migration.indexOf('ALTER FUNCTION public.purge_bookmark_folder_subscriptions_after_scope_change')
)

describe('atomic bookmark folder subscription migration', () => {
  it('requires the exact composite identity and canonical cascading parent', () => {
    expect(migration).toContain("ARRAY['user_id', 'folder_id']::name[]")
    expect(migration).toContain("constraint_row.confdeltype = 'c'")
    expect(migration).toContain('constraint_row.convalidated')
    expect(migration).toContain('folder subscriptions require exact actor/folder uniqueness')
  })

  it('purges legacy private and self subscriptions before closing the write surface', () => {
    expect(migration).toMatch(
      /DELETE FROM public\.folder_subscriptions AS subscription[\s\S]*folder\.is_public IS DISTINCT FROM true[\s\S]*folder\.user_id = subscription\.user_id/
    )
    expect(migration).toContain("policy.polcmd <> 'r'")
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.folder_subscriptions[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)/)
  })

  it('preserves only own and public-folder reads for existing exact count consumers', () => {
    expect(migration).toMatch(
      /CREATE POLICY folder_subscriptions_select_own[\s\S]*TO authenticated[\s\S]*user_id = \(SELECT auth\.uid\(\)\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY folder_subscriptions_select_public_folder[\s\S]*TO anon, authenticated[\s\S]*folder\.is_public IS TRUE/
    )
    expect(migration).toMatch(
      /GRANT SELECT ON TABLE public\.folder_subscriptions[\s\S]*TO anon, authenticated, service_role/
    )
  })

  it('serializes account admission before the folder privacy row lock', () => {
    expect(authority).toContain("'account-recovery-admission:' || v_actor_id::text")
    expect(authority).toContain('profile.deleted_at IS NULL')
    expect(authority).toContain('profile.banned_at IS NULL')
    expect(authority).toMatch(
      /PERFORM pg_catalog\.pg_advisory_xact_lock[\s\S]*FROM public\.user_profiles[\s\S]*FROM public\.bookmark_folders[\s\S]*FOR UPDATE/
    )
  })

  it('validates current ownership and privacy under the same lock as add', () => {
    expect(authority).toContain("'owner_forbidden'")
    expect(authority).toContain("'folder_private'")
    expect(authority).toContain('ON CONFLICT (user_id, folder_id) DO NOTHING')
    expect(authority).toContain("v_status := 'already_subscribed'")
    expect(authority).toContain("v_status := 'not_subscribed'")
  })

  it('returns an exact same-transaction acknowledgement and is authenticated-only', () => {
    expect(authority).toMatch(
      /SELECT pg_catalog\.count\(\*\)[\s\S]*WHERE subscription\.folder_id = p_folder_id/
    )
    for (const field of ['user_id', 'folder_id', 'is_subscribed', 'subscriber_count']) {
      expect(authority).toContain(`'${field}'`)
    }
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.mutate_bookmark_folder_subscription_atomic\(uuid, text\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.mutate_bookmark_folder_subscription_atomic\(uuid, text\)[\s\S]*TO authenticated/
    )
  })

  it('purges subscriptions in the folder privacy or owner transaction', () => {
    expect(privacyTrigger).toContain("TG_WHEN IS DISTINCT FROM 'AFTER'")
    expect(privacyTrigger).toContain('NEW.is_public IS DISTINCT FROM true')
    expect(privacyTrigger).toContain('OLD.user_id IS DISTINCT FROM NEW.user_id')
    expect(privacyTrigger).toContain('DELETE FROM public.folder_subscriptions')
    expect(migration).toMatch(
      /CREATE TRIGGER trg_bookmark_folders_80_purge_subscriptions[\s\S]*AFTER UPDATE OF is_public, user_id/
    )
  })
})
