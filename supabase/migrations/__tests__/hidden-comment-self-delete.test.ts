import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715093000_allow_hidden_comment_self_delete.sql'),
  'utf8'
)

const functionBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.delete_own_comment'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.delete_own_comment')
)

const preflightBody = migration.slice(
  migration.indexOf('DO $migration_order$'),
  migration.indexOf('CREATE OR REPLACE FUNCTION public.delete_own_comment')
)

describe('hidden comment self-delete migration', () => {
  it('is an atomic, cache-reloaded replacement with the stable RPC signature', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.delete_own_comment\(\s*p_comment_id uuid,\s*p_post_id uuid,\s*p_user_id uuid\s*\)/
    )
    expect(migration).toMatch(
      /RETURNS TABLE \(\s*deleted_count integer,\s*comment_count integer\s*\)/
    )
    expect(functionBody).toMatch(/SECURITY DEFINER/)
    expect(functionBody).toMatch(/SET search_path = public, pg_temp/)
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/)
  })

  it('fails closed unless the complete 091500 canonical infrastructure is installed', () => {
    expect(preflightBody).toContain('20260715091500 before 20260715093000')
    for (const signature of [
      'public.validate_comment_integrity()',
      'public.cascade_comment_soft_delete()',
      'public.sync_post_comment_count()',
      'public.bridge_legacy_post_comment_count()',
      'public.validate_comment_reaction_integrity()',
      'public.sync_comment_reaction_counts()',
      'public.bridge_legacy_comment_reaction_counts()',
      'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
      'public.update_own_comment(uuid,uuid,uuid,text)',
      'public.delete_own_comment(uuid,uuid,uuid)',
      'public.moderate_comment(uuid,uuid,text,text)',
    ]) {
      expect(preflightBody).toContain(`'${signature}'`)
    }

    for (const [triggerName, eventMask] of [
      ['trg_comments_05_authoritative_reaction_counts', 19],
      ['trg_comments_10_validate_integrity', 23],
      ['trg_comments_10_cascade_soft_delete', 17],
      ['trg_comments_20_sync_post_count', 29],
      ['trg_comment_likes_10_validate_integrity', 23],
      ['trg_comment_likes_20_sync_counts', 29],
      ['trg_posts_05_authoritative_comment_count', 19],
    ] as const) {
      expect(preflightBody).toMatch(new RegExp(`'${triggerName}'[\\s\\S]*?${eventMask}\\n\\s*\\)`))
    }
    expect(preflightBody).toMatch(/trigger_row\.tgtype = v_required_trigger\.expected_tgtype/)
    expect(preflightBody).toMatch(/trigger_row\.tgenabled = 'O'/)

    expect(preflightBody).toMatch(/comments\.parent_id ON DELETE CASCADE/)
    expect(preflightBody).toMatch(/comment_likes\.comment_id ON DELETE CASCADE/)
    expect(preflightBody).toMatch(/refuses a partial 20260715100000 contract deployment/)
    expect(preflightBody).toMatch(/pg_catalog\.pg_get_functiondef\(v_contract_function\)/)
  })

  it('uses the canonical post -> source -> complete subtree lock order', () => {
    const postLock = functionBody.indexOf('FROM public.posts AS locked_post')
    const sourceLock = functionBody.indexOf('FROM public.comments AS comment_row')
    const subtreeTraversal = functionBody.indexOf('WITH RECURSIVE comment_subtree(id)')
    const subtreeLock = functionBody.indexOf('FOR UPDATE OF subtree_comment')

    expect(postLock).toBeGreaterThan(-1)
    expect(sourceLock).toBeGreaterThan(postLock)
    expect(subtreeTraversal).toBeGreaterThan(sourceLock)
    expect(subtreeLock).toBeGreaterThan(subtreeTraversal)
    expect(functionBody.slice(postLock, sourceLock)).toMatch(/FOR UPDATE;/)
    expect(functionBody.slice(sourceLock, subtreeTraversal)).toMatch(/FOR UPDATE;/)
  })

  it('deletes an owned hidden source and counts its cycle-safe recursive physical subtree', () => {
    expect(functionBody).toMatch(/comment_row\.post_id = p_post_id/)
    expect(functionBody).not.toMatch(/comment_row\.deleted_at IS NULL/)
    expect(functionBody).toMatch(/WITH RECURSIVE comment_subtree\(id\) AS/)
    expect(functionBody).toMatch(/SELECT p_comment_id\s+UNION\s+SELECT descendant\.id/)
    expect(functionBody).not.toMatch(/SELECT p_comment_id\s+UNION ALL/)
    expect(functionBody).toMatch(/locked_subtree AS MATERIALIZED/)
    expect(functionBody).toMatch(/ORDER BY subtree_comment\.id\s+FOR UPDATE OF subtree_comment/)
    expect(functionBody).toMatch(
      /SELECT COUNT\(\*\)::integer\s+INTO deleted_count\s+FROM locked_subtree/
    )
    expect(functionBody).toMatch(
      /DELETE FROM public\.comments AS removed_comment[\s\S]*removed_comment\.post_id = p_post_id[\s\S]*removed_comment\.user_id = p_user_id/
    )
    expect(functionBody).toMatch(/GET DIAGNOSTICS v_deleted_root_count = ROW_COUNT/)
  })

  it('keeps the mutation boundary service-only', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.delete_own_comment\(uuid, uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.delete_own_comment\(uuid, uuid, uuid\)[\s\S]*TO service_role;/
    )
  })
})
