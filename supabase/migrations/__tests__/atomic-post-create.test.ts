import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729184500_atomic_post_create.sql'),
  'utf8'
)

const functionBody = migration.match(
  /CREATE OR REPLACE FUNCTION public\.create_post_atomic\([\s\S]*?\n\$function\$;/
)?.[0]

describe('atomic post create migration', () => {
  it('publishes one service-only security-definer transaction boundary', () => {
    expect(functionBody).toBeDefined()
    expect(functionBody).toMatch(/RETURNS jsonb[\s\S]*SECURITY DEFINER/)
    expect(functionBody).toContain('SET search_path = pg_catalog, pg_temp')
    expect(functionBody).toContain('SET row_security = off')
    expect(functionBody).toContain('service role required')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_post_atomic\([\s\S]*?\) TO service_role;/
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON FUNCTION public\.create_post_atomic\([\s\S]*?FROM PUBLIC, anon, authenticated, authenticator;/
    )
  })

  it('uses a permanent no-FK replay ledger with a global operation key', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.post_create_operation_results')
    expect(migration).toContain('PRIMARY KEY (operation_id)')
    expect(migration).not.toMatch(/post_create_operation_results[\s\S]{0,1200}FOREIGN KEY/)
    expect(functionBody).toContain("'post-create-operation:' || p_operation_id::text")
    expect(functionBody).toContain('v_existing_fingerprint')
    expect(functionBody).toContain("'status', 'operation_conflict'")
    expect(functionBody).toContain('pg_catalog.sha256')
  })

  it('takes group and account lifecycle locks in canonical order', () => {
    const groupLock = functionBody!.indexOf("'group-membership:'")
    const accountLock = functionBody!.indexOf("'account-recovery-admission:'")
    const profileLock = functionBody!.indexOf('FROM public.user_profiles AS profile')
    expect(groupLock).toBeGreaterThan(0)
    expect(accountLock).toBeGreaterThan(groupLock)
    expect(profileLock).toBeGreaterThan(accountLock)
  })

  it('binds custom polls in the same transaction without advancing content revision', () => {
    expect(functionBody).toContain('INSERT INTO public.posts')
    expect(functionBody).toContain('INSERT INTO public.polls')
    expect(functionBody).toContain('SET poll_id = v_poll.id')
    expect(functionBody).toContain('v_poll.post_id IS DISTINCT FROM v_post.id')
    expect(functionBody).toContain('v_post.content_version <> 0')
    expect(functionBody).toContain('p_poll_duration_hours NOT BETWEEN 0 AND 168')
    expect(functionBody).toContain('pg_catalog.char_length(option_text) NOT BETWEEN 1 AND 100')
  })

  it('synchronizes mentions and hashtags before recording the success', () => {
    expect(functionBody).toContain('v_mentions')
    expect(functionBody).toContain('INSERT INTO public.hashtags')
    expect(functionBody).toContain('INSERT INTO public.post_hashtags')
    expect(functionBody).toContain('SET post_count = (')
    expect(functionBody!.indexOf('INSERT INTO public.post_hashtags')).toBeLessThan(
      functionBody!.indexOf('INSERT INTO public.post_create_operation_results')
    )
  })

  it('attests relationships by catalog identity instead of constraint names', () => {
    expect(migration).toContain("constraint_row.conrelid = 'public.posts'::regclass")
    expect(migration).toContain("constraint_row.confrelid = 'public.polls'::regclass")
    expect(migration).toContain("constraint_row.conrelid = 'public.polls'::regclass")
    expect(migration).toContain("constraint_row.confrelid = 'public.posts'::regclass")
    expect(migration).toContain("constraint_row.conrelid = 'public.post_hashtags'::regclass")
    expect(migration).toContain("'post_create_operation_fingerprint_check'")
    expect(migration).toContain("'post_create_operation_result_check'")
    expect(migration).toContain('constraint_row.convalidated')
  })

  it('returns exact failure statuses and nested success acknowledgements', () => {
    for (const status of [
      'invalid',
      'operation_conflict',
      'account_inactive',
      'group_unavailable',
      'membership_required',
      'group_muted',
      'group_banned',
      'entitlement_required',
    ]) {
      expect(functionBody).toContain(`'status', '${status}'`)
    }
    expect(functionBody).toContain("'status', 'created'")
    expect(functionBody).toContain("'applied', true")
    expect(functionBody).toContain("'{applied}'")
    expect(functionBody).toContain("'{status}'")
    expect(functionBody).toContain("'post', pg_catalog.jsonb_build_object")
    expect(functionBody).toContain("'poll', CASE WHEN v_poll.id IS NULL")
  })
})
