import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260803100000_atomic_custom_poll_expected_identity.sql'),
  'utf8'
)
const route = readFileSync(resolve(root, 'app/api/posts/[id]/poll-vote/route.ts'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-custom-poll-expected-identity.pg17.sh'),
  'utf8'
)

function functionBody(): string {
  const match = migration.match(
    /CREATE OR REPLACE FUNCTION public\.cast_post_poll_vote_expected_atomic\([\s\S]*?\n\$function\$;/
  )
  expect(match).not.toBeNull()
  return match![0]
}

describe('atomic custom poll expected identity migration', () => {
  it('is a bounded replayable forward migration with an additive rollout surface', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.poll_votes:expected-poll-identity:migration'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toContain('DROP FUNCTION')
    expect(migration).toContain('legacy signature remains available')
  })

  it('locks the linked current poll and validates expected identity before delegating mutation', () => {
    const body = functionBody()
    const audienceLock = body.indexOf('public.lock_actor_can_interact_with_post')
    const postLock = body.indexOf('FOR SHARE')
    const pollLock = body.indexOf('FOR UPDATE')
    const expectedCheck = body.indexOf('v_locked_poll_id IS DISTINCT FROM p_expected_poll_id')
    const changedResult = body.indexOf("jsonb_build_object('status', 'poll_changed')")
    const delegate = body.indexOf('RETURN public.cast_post_poll_vote_atomic')

    expect(audienceLock).toBeGreaterThan(0)
    expect(postLock).toBeGreaterThan(audienceLock)
    expect(pollLock).toBeGreaterThan(postLock)
    expect(expectedCheck).toBeGreaterThan(pollLock)
    expect(changedResult).toBeGreaterThan(expectedCheck)
    expect(delegate).toBeGreaterThan(changedResult)
    expect(body).not.toContain('DELETE FROM public.poll_votes')
    expect(body).not.toContain('INSERT INTO public.poll_votes')
  })

  it('attests the delegated legacy authority has its poll lock before delete and insert', () => {
    expect(migration).toContain("'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])'")
    expect(migration).toContain("v_poll_lock := pg_catalog.strpos(v_vote_source, 'FOR UPDATE')")
    expect(migration).toContain("'DELETE FROM public.poll_votes'")
    expect(migration).toContain("'INSERT INTO public.poll_votes'")
    expect(migration).toContain('v_delete <= v_poll_lock')
    expect(migration).toContain('v_insert <= v_delete')
  })

  it('publishes only the exact four-argument service-role function', () => {
    const signature =
      'public.cast_post_poll_vote_expected_atomic(\n    uuid, uuid, uuid, integer[]\n  )'
    expect(migration).toContain(signature)
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*cast_post_poll_vote_expected_atomic[\s\S]*TO service_role;/
    )
    expect(migration).toContain('atomic-custom-poll-expected-identity:v1:')
  })

  it('cuts the route over to the expected-id RPC and maps poll_changed to 409', () => {
    expect(route).toContain("supabase.rpc('cast_post_poll_vote_expected_atomic'")
    expect(route).toContain('p_expected_poll_id: requestedPollId')
    expect(route).toContain("data.status === 'poll_changed'")
    expect(route).toContain("{ error: 'Poll changed; reload before voting' }, { status: 409 }")
  })

  it('keeps generated Supabase types aligned with the new RPC', () => {
    expect(databaseTypes).toMatch(
      /cast_post_poll_vote_expected_atomic: \{[\s\S]*p_actor_id: string[\s\S]*p_expected_poll_id: string[\s\S]*p_option_indexes: number\[\][\s\S]*p_post_id: string[\s\S]*Returns: Json/
    )
  })

  it('has a PostgreSQL 17 behavior and serialization proof', () => {
    for (const marker of [
      'exact expected poll vote',
      'stale expected poll rejects before mutation',
      'poll switch first returns poll_changed',
      'vote first serializes poll switch',
      'service-only expected poll RPC ACL',
      'expected poll identity migration replay',
      'atomic custom poll expected identity PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
