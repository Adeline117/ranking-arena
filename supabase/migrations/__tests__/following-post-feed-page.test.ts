import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715224300_following_post_feed_page.sql'),
  'utf8'
)

const functionBody = migration.match(
  /CREATE OR REPLACE FUNCTION public\.get_following_posts_page\([\s\S]*?\n\$\$;\n/
)?.[0]

describe('following post feed page migration', () => {
  it('retires every legacy overload and exposes the replacement only to service_role', () => {
    expect(migration).toMatch(/function_row\.proname = 'get_following_feed'/)
    expect(migration).toMatch(/function_row\.prokind = 'f'/)
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(/auth\.role\(\)[\s\S]*IS DISTINCT FROM 'service_role'/)
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_following_posts_page\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_following_posts_page\([\s\S]*TO service_role/
    )
  })

  it('evaluates the whole feed boundary in one business-data statement snapshot', () => {
    expect(functionBody).toBeDefined()
    expect(functionBody).toMatch(/WITH active_viewer AS MATERIALIZED/)
    expect(functionBody).toMatch(/following_total AS MATERIALIZED/)
    expect(functionBody).toMatch(/candidates AS MATERIALIZED/)
    expect(functionBody?.match(/\bWITH\b/g)).toHaveLength(1)

    expect(functionBody).toMatch(
      /EXISTS \([\s\S]*FROM public\.user_follows AS followed_author[\s\S]*followed_author\.follower_id = p_viewer_id[\s\S]*followed_author\.following_id = wrapper\.author_id/
    )
    expect(functionBody).not.toMatch(/author_ids|\.in\(|p_offset/)
  })

  it('applies the canonical audience decision to both wrapper and ordinary root', () => {
    expect(functionBody).toMatch(
      /public\.can_actor_read_post_fields\([\s\S]*wrapper\.author_id[\s\S]*wrapper\.status[\s\S]*wrapper\.deleted_at/
    )
    expect(functionBody).toMatch(/root\.id = wrapper\.original_post_id/)
    expect(functionBody).toMatch(/root\.original_post_id IS NULL/)
    expect(functionBody).toMatch(
      /public\.can_actor_read_post_fields\([\s\S]*root\.author_id[\s\S]*root\.status[\s\S]*root\.deleted_at/
    )
    expect(functionBody).toMatch(/COALESCE\(root\.is_sensitive, false\)/)
    expect(functionBody).toMatch(/COALESCE\(wrapper\.content_warning, root\.content_warning\)/)
  })

  it('uses a deterministic look-ahead keyset and derives the cursor from the returned tail', () => {
    expect(functionBody).toMatch(
      /\(wrapper\.created_at, wrapper\.id\) < \(p_before_created_at, p_before_id\)/
    )
    expect(functionBody).toMatch(
      /ORDER BY wrapper\.created_at DESC, wrapper\.id DESC\s+LIMIT p_limit \+ 1/
    )
    expect(functionBody).toMatch(/SELECT \*\s+FROM candidates[\s\S]*LIMIT p_limit/)
    expect(functionBody).toMatch(/count\(\*\) FROM candidates\) > p_limit AS has_more/)
    expect(functionBody).toMatch(
      /jsonb_build_object\('created_at', page_tail\.created_at, 'id', page_tail\.id\)/
    )
  })

  it('returns an explicit UI projection without moderation or serving internals', () => {
    expect(functionBody).not.toMatch(/wrapper\.\*|root\.\*|posts\.\*|SETOF public\.posts/)
    expect(functionBody).toMatch(/'posts'[\s\S]*jsonb_agg\(to_jsonb\(page_row\)/)
    expect(functionBody).toMatch(/'following_count'/)
    expect(functionBody).toMatch(/'has_more'/)
    expect(functionBody).toMatch(/'next_cursor'/)

    for (const privateField of [
      'deleted_by',
      'delete_reason',
      'report_count',
      'impression_count',
      'click_count',
      'search_hit_count',
      'locked_reason',
      'last_hot_refresh_at',
      'velocity_updated_at',
    ]) {
      expect(functionBody).not.toContain(privateField)
    }
  })

  it('fails closed for inactive viewers, malformed cursor pairs, and unbounded inputs', () => {
    expect(functionBody).toMatch(/viewer_profile\.banned_at IS NULL/)
    expect(functionBody).toMatch(/viewer_profile\.deleted_at IS NULL/)
    expect(functionBody).toMatch(/p_limit NOT BETWEEN 1 AND 100/)
    expect(functionBody).toMatch(/\(\(p_before_created_at IS NULL\) <> \(p_before_id IS NULL\)\)/)
    expect(functionBody).toMatch(/cardinality\(p_group_ids\) > 100/)
  })
})
