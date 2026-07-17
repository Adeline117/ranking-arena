import fs from 'fs'
import path from 'path'

const migration = fs.readFileSync(
  path.join(__dirname, '..', '20260716178100_atomic_post_child_interactions.sql'),
  'utf8'
)
const canonicalInteraction = fs.readFileSync(
  path.join(__dirname, '..', '20260715224000_post_interaction_authorization.sql'),
  'utf8'
)
const premiumEntitlement = fs.readFileSync(
  path.join(__dirname, '..', '20260716176100_group_premium_entitlement.sql'),
  'utf8'
)
const commentAuthorization = fs.readFileSync(
  path.join(__dirname, '..', '20260716114500_atomic_comment_block_authorization.sql'),
  'utf8'
)

function functionBody(name: string, nextMarker: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  const end = migration.indexOf(nextMarker, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('atomic post child interaction migration', () => {
  it('guards every service-written child table at the database mutation boundary', () => {
    for (const trigger of [
      'trg_post_likes_15_current_interaction',
      'trg_post_votes_15_current_interaction',
      'trg_post_bookmarks_15_current_interaction',
      'trg_post_emoji_15_current_interaction',
      'trg_comments_15_current_interaction',
      'trg_comment_likes_15_current_interaction',
      'trg_poll_votes_15_current_interaction',
      'trg_repost_10_current_interaction',
    ]) {
      expect(migration).toContain(`CREATE TRIGGER ${trigger}`)
    }

    expect(migration).toMatch(
      /enforce_current_post_child_interaction[\s\S]*public\.lock_actor_can_interact_with_post\(NEW\.post_id, NEW\.user_id\)/
    )
    expect(migration).toMatch(
      /enforce_current_poll_vote_interaction[\s\S]*public\.lock_actor_can_interact_with_post\(v_post_id, NEW\.user_id\)/
    )
    expect(migration).toMatch(
      /enforce_current_repost_interaction[\s\S]*public\.lock_actor_can_interact_with_post\([\s\S]*NEW\.original_post_id,[\s\S]*NEW\.author_id/
    )
  })

  it('puts the canonical lock in front of the preserved owned-comment delete', () => {
    const body = functionBody(
      'delete_own_comment',
      'CREATE OR REPLACE FUNCTION public.toggle_post_reaction'
    )
    expect(body.indexOf('public.lock_actor_can_interact_with_post')).toBeLessThan(
      body.indexOf('public.delete_own_comment_locked_impl')
    )
    expect(migration).toContain(
      'ALTER FUNCTION public.delete_own_comment(uuid, uuid, uuid)\n      RENAME TO delete_own_comment_locked_impl'
    )
  })

  it.each([
    ['toggle_post_reaction', 'CREATE OR REPLACE FUNCTION public.toggle_post_vote_atomic'],
    ['toggle_post_vote_atomic', 'CREATE OR REPLACE FUNCTION public.toggle_post_bookmark_atomic'],
    [
      'toggle_post_bookmark_atomic',
      'CREATE OR REPLACE FUNCTION public.toggle_post_emoji_reaction_atomic',
    ],
    [
      'toggle_post_emoji_reaction_atomic',
      'CREATE OR REPLACE FUNCTION public.cast_post_poll_vote_atomic',
    ],
    ['cast_post_poll_vote_atomic', 'DO $postflight$'],
  ])('%s locks canonical audience before its first child mutation', (name, nextMarker) => {
    const body = functionBody(name, nextMarker)
    const authorization = body.indexOf('public.lock_actor_can_interact_with_post')
    const firstMutation = Math.min(
      ...['INSERT INTO public.', 'UPDATE public.', 'DELETE FROM public.']
        .map((needle) => body.indexOf(needle))
        .filter((index) => index >= 0)
    )

    expect(authorization).toBeGreaterThanOrEqual(0)
    expect(firstMutation).toBeGreaterThan(authorization)
    expect(body).toContain("COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role'")
  })

  it('publishes each mutation RPC only to service_role', () => {
    expect(migration).toContain('DO $converge_function_authority$')
    expect(migration).toContain('pg_catalog.aclexplode')
    for (const signature of [
      'public.delete_own_comment(uuid, uuid, uuid)',
      'public.toggle_post_reaction(uuid, uuid, text)',
      'public.toggle_post_vote_atomic(uuid, uuid, text)',
      'public.toggle_post_bookmark_atomic(uuid, uuid, uuid)',
      'public.toggle_post_emoji_reaction_atomic(uuid, uuid, text)',
      'public.cast_post_poll_vote_atomic(uuid, uuid, integer[])',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature}`)
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION ${signature.replace(/[()[\].]/g, '\\$&')}[\\s\\S]*?TO service_role;`
        )
      )
    }
  })

  it('preserves the proven canonical authorization inside comment reaction and edit RPCs', () => {
    expect(canonicalInteraction).toMatch(
      /CREATE OR REPLACE FUNCTION public\.lock_actor_can_interact_with_post[\s\S]*RETURN public\.can_actor_read_post_id\(p_post_id, p_actor_id\)/
    )
    expect(commentAuthorization).toMatch(
      /CREATE OR REPLACE FUNCTION public\.toggle_comment_reaction[\s\S]*public\.toggle_comment_reaction_locked_impl/
    )
    expect(commentAuthorization).toMatch(
      /CREATE OR REPLACE FUNCTION public\.update_own_comment[\s\S]*public\.update_own_comment_locked_impl/
    )
    expect(premiumEntitlement).toMatch(
      /CREATE OR REPLACE FUNCTION public\.can_actor_read_post_fields[\s\S]*public\.has_current_group_entitlement/
    )
  })
})
