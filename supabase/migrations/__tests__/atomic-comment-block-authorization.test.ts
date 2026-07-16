import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716114500_atomic_comment_block_authorization.sql'),
  'utf8'
)

describe('atomic comment block authorization migration', () => {
  it('is transactional, bounded, and freezes every trigger source atomically', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('LOCK TABLE public.posts IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE public.comments IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE public.comment_likes IN ACCESS EXCLUSIVE MODE')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('locks the complete immutable wrapper, root, and target author set first', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.lock_post_interaction_block_edges('
    )
    expect(migration).toContain('v_wrapper_author_id')
    expect(migration).toContain('v_root_author_id')
    expect(migration).toContain('v_target_author_id')
    expect(migration).toContain('ORDER BY affected_pair')
    expect(migration).toContain("'post-audience:block:' || v_pair")
    expect(migration).toContain('post author and repost root identity are immutable')
  })

  it('serializes direct creates and every reaction add/change event before validation', () => {
    expect(migration).toContain('trg_comments_09_serialize_block_authorization')
    expect(migration).toContain('trg_comments_10_validate_integrity')
    expect(migration).toContain('trg_comment_likes_09_serialize_block_authorization')
    expect(migration).toContain('UPDATE OF comment_id, user_id, reaction_type')
    expect(migration).toContain('trg_comment_likes_10_validate_integrity')
    expect(migration).toContain('a root-author block prevents this comment interaction')
    expect(migration).toContain('a root-author block prevents comment edits on this post')
    expect(migration).toContain(
      'users may still withdraw an\n  -- existing reaction after either side creates a block edge'
    )
  })

  it('wraps mature post, reaction, and edit implementations advisory-first', () => {
    for (const implementation of [
      'lock_actor_can_interact_with_post_locked_impl',
      'toggle_comment_reaction_locked_impl',
      'update_own_comment_locked_impl',
    ]) {
      expect(migration).toContain(implementation)
    }
    expect(migration.match(/public\.lock_post_interaction_block_edges\(/g).length).toBeGreaterThan(
      5
    )
    expect(migration).toContain('comment wrappers do not acquire block edges first')
  })

  it('distinguishes fresh cutover from replay and seals every preserved implementation', () => {
    expect(migration).toContain("v_deploy_state := 'fresh'")
    expect(migration).toContain("v_deploy_state := 'replay'")
    expect(migration).toContain('partial atomic comment authorization state')
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS\n      public.lock_actor_can_interact_with_post_locked_impl'
    )
    expect(migration).toContain('atomic-comment-block-authorization:v1:')
    expect(migration).toContain('sealed internal comment implementation has drifted')
    expect(migration).toContain("pg_catalog.obj_description(function_row.oid, 'pg_proc')")
    expect(migration).toContain('pg_catalog.md5(function_row.prosrc)')
  })

  it('keeps helpers and implementations internal while exposing only canonical RPCs', () => {
    expect(migration).toContain('DO $converge_function_acls$')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.toggle_comment_reaction(')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.update_own_comment(')
    expect(migration).toContain('comment authorization ACLs did not converge')
    expect(migration).toContain('unexpected comment authorization overload remains')
  })

  it('requires the deployed OLD+NEW block serializer and immutable comment identities', () => {
    expect(migration).toContain("TG_OP IN ('UPDATE', 'DELETE')")
    expect(migration).toContain("TG_OP IN ('INSERT', 'UPDATE')")
    expect(migration).toContain('comment post_id, parent_id, and user_id are immutable')
    expect(migration).toContain('comment reaction identity is immutable')
    expect(migration).toContain('block-edge serialization contract has drifted')
    expect(migration.match(/trigger_row\.tgqual IS NULL/g)?.length).toBeGreaterThanOrEqual(6)
    expect(migration).toContain('WHERE trigger_row.tgfoid = v_block_serializer')
    expect(migration).toContain('WHERE trigger_row.tgfoid = v_comment_validator')
    expect(migration).toContain('WHERE trigger_row.tgfoid = v_reaction_validator')
    expect(migration).toContain(
      '20260716113800 report target authorization must call the post helper before target row locks'
    )
  })

  it('rejects incompatible relation and dependency shapes before cutover', () => {
    expect(migration).toContain("relation.relkind = 'r'")
    expect(migration).toContain("relation.relpersistence = 'p'")
    expect(migration).toContain('NOT relation.relispartition')
    expect(migration).toContain('FROM pg_catalog.pg_rewrite AS rewrite_rule')
    expect(migration).toContain('must not have rewrite rules before comment authorization cutover')
    expect(migration).toContain('function_row.prolang = v_plpgsql_oid')
    expect(migration).toContain(
      "function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype"
    )
    expect(migration).toContain(
      "pg_catalog.strpos(v_comment_validator_source, 'FROM public.posts')"
    )
    expect(migration).toContain(
      "pg_catalog.strpos(v_reaction_validator_source, 'FROM public.blocked_users')"
    )
    expect(migration).toContain("v_block_serializer_source ~* 'RETURN[[:space:]]+NEW[[:space:]]*;'")
  })
})
