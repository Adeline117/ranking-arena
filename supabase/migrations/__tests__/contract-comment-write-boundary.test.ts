import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715100000_contract_comment_write_boundary.sql'),
  'utf8'
)

const preflight = migration.slice(
  migration.indexOf('-- Refuse to contract permissions'),
  migration.indexOf('-- Raw comment mutation')
)

describe('canonical comment write contract migration', () => {
  it('is atomic, bounded, and locks tables in canonical order', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s';")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min';")

    const postLock = migration.indexOf('LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;')
    const commentLock = migration.indexOf('LOCK TABLE public.comments IN SHARE ROW EXCLUSIVE MODE;')
    const reactionLock = migration.indexOf(
      'LOCK TABLE public.comment_likes IN SHARE ROW EXCLUSIVE MODE;'
    )
    expect(postLock).toBeGreaterThan(-1)
    expect(commentLock).toBeGreaterThan(postLock)
    expect(reactionLock).toBeGreaterThan(commentLock)
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
  })

  it('refuses partial infrastructure, widened RPC ACLs, retired writers, and count drift', () => {
    for (const signature of [
      'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
      'public.update_own_comment(uuid,uuid,uuid,text)',
      'public.delete_own_comment(uuid,uuid,uuid)',
      'public.moderate_comment(uuid,uuid,text,text)',
    ]) {
      expect(preflight).toContain(`'${signature}'`)
    }

    for (const retiredSignature of [
      'public.increment_comment_count(uuid)',
      'public.decrement_comment_count(uuid)',
      'public.increment_comment_like_count(uuid)',
      'public.decrement_comment_like_count(uuid)',
    ]) {
      expect(preflight).toContain(`'${retiredSignature}'`)
    }

    expect(preflight).toContain("has_function_privilege('service_role'")
    expect(preflight).toContain("has_function_privilege('anon'")
    expect(preflight).toContain("has_function_privilege('authenticated'")
    expect(preflight).toContain('trg_posts_05_authoritative_comment_count')
    expect(preflight).toContain('trg_comments_20_sync_post_count')
    expect(preflight).toContain('trg_comment_likes_20_sync_counts')
    expect(preflight).toMatch(
      /post_row\.comment_count IS DISTINCT FROM source_counts\.source_count/
    )
    expect(preflight).toMatch(/comment_row\.like_count IS DISTINCT FROM source_counts\.like_count/)
    expect(preflight).toMatch(
      /comment_row\.dislike_count IS DISTINCT FROM source_counts\.dislike_count/
    )
  })

  it('allows only clean comment creation and canonical marked mutations', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.guard_canonical_comment_mutation\(\)[\s\S]*?SET search_path = pg_catalog, public/
    )
    expect(migration).toMatch(/IF TG_OP = 'INSERT'[\s\S]*NEW\.deleted_at IS NOT NULL/)
    expect(migration).toMatch(/v_mutation_path IN \([\s\S]*'delete_own_comment'/)
    expect(migration).toContain("'moderate_comment'")
    expect(migration).toContain("'update_own_comment'")
    expect(migration).toMatch(
      /current_setting\('app\.comment_reaction_path', true\) = 'toggle_comment_reaction'/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER trg_comments_00_guard_canonical_mutation[\s\S]*BEFORE INSERT OR DELETE OR UPDATE OF/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER trg_comment_likes_00_guard_canonical_mutation[\s\S]*BEFORE INSERT OR UPDATE OR DELETE/
    )
  })

  it('rejects externally supplied cached counts and closes service table writes', () => {
    expect(migration).toMatch(/new posts must start with a zero comment counter/)
    expect(migration).toMatch(/direct post comment counter updates are disabled/)
    expect(migration).toMatch(/new comments must start with zero reaction counters/)
    expect(migration).toMatch(/direct comment reaction counter updates are disabled/)
    expect(migration).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*ON TABLE public\.comments[\s\S]*FROM service_role;/
    )
    expect(migration).not.toMatch(/REVOKE INSERT, UPDATE, DELETE[\s\S]*ON TABLE public\.comments/)
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*ON TABLE public\.comment_likes[\s\S]*FROM service_role;/
    )
  })
})
