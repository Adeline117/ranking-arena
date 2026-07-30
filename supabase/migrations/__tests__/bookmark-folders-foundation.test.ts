import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260729172750_bookmark_folders_foundation.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

const ensureDefault = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.ensure_default_bookmark_folder'),
  migration.indexOf('ALTER FUNCTION public.ensure_default_bookmark_folder')
)

describe('bookmark folders canonical foundation migration', () => {
  it('restores the complete generated table contract instead of skipping a phantom parent', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.bookmark_folders')
    for (const column of [
      'description text',
      'avatar_url text',
      'is_public boolean DEFAULT false',
      'is_default boolean DEFAULT false',
      'post_count integer DEFAULT 0',
      'created_at timestamptz DEFAULT pg_catalog.now()',
      'updated_at timestamptz DEFAULT pg_catalog.now()',
    ]) {
      expect(migration).toContain(column)
    }
    expect(migration).toContain('CONSTRAINT bookmark_folders_user_id_name_key UNIQUE')
    expect(migration).toContain('REFERENCES auth.users(id) ON DELETE CASCADE')
  })

  it('repairs both generated child relationships with destructive-parent cascades', () => {
    expect(migration).toContain('ADD CONSTRAINT post_bookmarks_folder_id_fkey')
    expect(migration).toContain('ADD CONSTRAINT folder_subscriptions_folder_id_fkey')
    expect(migration).toMatch(
      /post_bookmarks_folder_id_fkey[\s\S]*REFERENCES public\.bookmark_folders\(id\) ON DELETE CASCADE/
    )
    expect(migration).toMatch(
      /folder_subscriptions_folder_id_fkey[\s\S]*REFERENCES public\.bookmark_folders\(id\) ON DELETE CASCADE/
    )
    expect(migration).toMatch(
      /UPDATE public\.post_bookmarks[\s\S]*SET folder_id = NULL[\s\S]*DELETE FROM public\.folder_subscriptions/
    )
  })

  it('installs exact owner/name and one-default-per-owner invariants', () => {
    expect(migration).toContain("ARRAY['user_id', 'name']::name[]")
    expect(migration).toContain('idx_bookmark_folders_one_default_per_user')
    expect(migration).toContain("= '(is_default IS TRUE)'")
    expect(migration).toContain('SET is_default = false')
  })

  it('keeps public reads and authenticated owner writes behind explicit RLS and ACLs', () => {
    expect(migration).toContain('ALTER TABLE public.bookmark_folders ENABLE ROW LEVEL SECURITY')
    expect(migration).toMatch(
      /CREATE POLICY bookmark_folders_select_visible[\s\S]*TO anon, authenticated[\s\S]*is_public IS TRUE/
    )
    expect(migration).toMatch(
      /CREATE POLICY bookmark_folders_insert_own[\s\S]*WITH CHECK \(user_id = \(SELECT auth\.uid\(\)\)\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY bookmark_folders_update_own[\s\S]*USING \(user_id = \(SELECT auth\.uid\(\)\)\)[\s\S]*WITH CHECK/
    )
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, authenticator, service_role')
  })

  it('creates one account-serialized authenticated default folder authority', () => {
    expect(ensureDefault).toContain("COALESCE((SELECT auth.role()), '')")
    expect(ensureDefault).toContain('p_user_id IS DISTINCT FROM v_actor_id')
    expect(ensureDefault).toContain("'account-recovery-admission:' || v_actor_id::text")
    expect(ensureDefault).toContain("'bookmark-default:' || v_actor_id::text")
    expect(ensureDefault).toContain('profile.deleted_at IS NULL')
    expect(ensureDefault).toContain('profile.banned_at IS NULL')
    expect(ensureDefault).toContain('ON CONFLICT (user_id) WHERE is_default IS TRUE DO NOTHING')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ensure_default_bookmark_folder\(uuid\)[\s\S]*TO authenticated/
    )
  })

  it('reinstalls and asserts the global inactive-account mutation barrier', () => {
    expect(migration).toContain(
      'SELECT public.install_active_authenticated_subject_mutation_barriers()'
    )
    expect(migration).toContain(
      'SELECT public.assert_active_authenticated_subject_mutation_barriers()'
    )
  })
})
