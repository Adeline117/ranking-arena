import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260803180000_hashtag_read_authority.sql'),
  'utf8'
)

function functionDefinition(name: string): string {
  const definition = migration.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`)
  )?.[0]

  if (!definition) throw new Error(`missing ${name} definition`)
  return definition
}

const recountFunction = functionDefinition('recount_hashtag_posts')
const trendingFunction = functionDefinition('get_trending_hashtags_public')
const pageFunction = functionDefinition('get_hashtag_posts_page')

describe('hashtag read authority migration', () => {
  it('fails closed on prerequisite drift and bounds migration locking', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '120s'")
    expect(migration).toMatch(
      /pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\('ranking-arena:hashtag-read-authority:v1', 0\)/
    )
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain(
      "pg_catalog.to_regprocedure('public.can_actor_read_post_id(uuid,uuid)')"
    )
    expect(migration).toContain(
      "'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'"
    )
    expect(migration).toContain("pg_catalog.to_regprocedure('auth.role()')")
    expect(migration).toMatch(/relation\.relkind <> 'r'/)
    expect(migration).toContain("relation.relpersistence <> 'p'")
    expect(migration).toContain('relation.relispartition')
    expect(migration).toContain('FROM pg_catalog.pg_inherits AS inheritance')
    expect(migration).toContain(
      'LOCK TABLE public.hashtags, public.post_hashtags IN ACCESS EXCLUSIVE MODE'
    )
    expect(migration).toMatch(
      /LOCK TABLE public\.posts, public\.post_likes, public\.post_votes\s+IN ACCESS SHARE MODE/
    )
    expect(migration).toContain('post interaction identity uniqueness is incompatible')
  })

  it('removes public table bypasses while preserving service synchronization', () => {
    expect(migration).toMatch(
      /FROM pg_catalog\.pg_policy[\s\S]*policy_table\.relname IN \('hashtags', 'post_hashtags'\)[\s\S]*DROP POLICY %I ON %I\.%I/
    )

    for (const table of ['hashtags', 'post_hashtags']) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`)
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_service_sync[\\s\\S]*ON public\\.${table}[\\s\\S]*FOR ALL[\\s\\S]*TO service_role[\\s\\S]*USING \\(true\\)[\\s\\S]*WITH CHECK \\(true\\)`
        )
      )
    }

    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.hashtags, public\.post_hashtags\s+FROM PUBLIC, anon, authenticated, service_role, postgres/
    )
    expect(migration).toContain('DO $revoke_column_privileges$')
    expect(migration).toMatch(
      /string_agg\([\s\S]*attribute_row\.attrelid = v_table[\s\S]*REVOKE SELECT \(%1\$s\), INSERT \(%1\$s\), UPDATE \(%1\$s\), '[\s\S]*REFERENCES \(%1\$s\) ON TABLE %2\$s '[\s\S]*FROM PUBLIC, anon, authenticated, service_role, postgres/
    )
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.hashtags, public\.post_hashtags\s+TO service_role/
    )
    expect(migration).toContain('CREATE POLICY hashtags_postgres_read')
    expect(migration).toContain('CREATE POLICY hashtags_postgres_recount')
    expect(migration).toContain('CREATE POLICY post_hashtags_postgres_read')
    expect(migration).toContain('GRANT SELECT, UPDATE ON TABLE public.hashtags TO postgres')
    expect(migration).toContain('GRANT SELECT, DELETE ON TABLE public.post_hashtags TO postgres')
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.post_likes, public.post_votes TO postgres'
    )
    expect(migration).toMatch(
      /COMMENT ON COLUMN public\.hashtags\.post_count IS\s+'Internal raw post_hashtags cardinality maintained for synchronization only; never public read authority\.'/
    )
  })

  it('removes historical invalid tags and validates one canonical registry constraint', () => {
    expect(migration).toContain(
      'GRANT DELETE ON TABLE public.hashtags, public.post_hashtags TO postgres'
    )
    expect(migration).toContain('ALTER TABLE public.hashtags NO FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('ALTER TABLE public.post_hashtags NO FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('ADD CONSTRAINT hashtags_tag_canonical_check')
    expect(migration).toContain(') NOT VALID')
    expect(migration).toMatch(
      /DELETE FROM public\.hashtags AS hashtag[\s\S]*char_length\(hashtag\.tag\) BETWEEN 1 AND 30/
    )
    expect(migration).toContain('VALIDATE CONSTRAINT hashtags_tag_canonical_check')
    expect(migration).toContain('canonical hashtag constraint is incomplete')
    expect(migration.indexOf('DELETE FROM public.hashtags AS hashtag')).toBeLessThan(
      migration.indexOf('DO $policy_convergence$')
    )
  })

  it('recounts exact raw mappings as a bounded service-only zero-reset', () => {
    expect(recountFunction).toMatch(/auth\.role\(\)[\s\S]*IS DISTINCT FROM 'service_role'/)
    expect(recountFunction).toContain('SET search_path = pg_catalog, pg_temp')
    expect(recountFunction).toMatch(/cardinality\(hashtag_ids\) NOT BETWEEN 1 AND 500/)
    expect(recountFunction).toMatch(/array_position\(hashtag_ids, NULL::uuid\) IS NOT NULL/)
    expect(recountFunction).toMatch(/WITH requested AS MATERIALIZED/)
    expect(recountFunction).toMatch(
      /UPDATE public\.hashtags AS hashtag[\s\S]*SET post_count = \([\s\S]*count\(\*\)::integer[\s\S]*FROM public\.post_hashtags AS mapping[\s\S]*mapping\.hashtag_id = hashtag\.id[\s\S]*WHERE hashtag\.id IN/
    )
    expect(recountFunction).not.toMatch(/UPDATE[\s\S]*FROM\s*\([\s\S]*GROUP BY/)
  })

  it('derives trending tag names and counts only from anonymous-readable posts', () => {
    expect(trendingFunction).toMatch(/auth\.role\(\)[\s\S]*IS DISTINCT FROM 'service_role'/)
    expect(trendingFunction).toMatch(/p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100/)
    expect(trendingFunction).toMatch(/WITH readable_mappings AS MATERIALIZED/)
    expect(trendingFunction).toMatch(/JOIN public\.posts AS post\s+ON post\.id = mapping\.post_id/)
    expect(trendingFunction).toMatch(/public\.can_actor_read_post_id\(post\.id, NULL::uuid\)/)
    expect(trendingFunction.match(/public\.can_actor_read_post_id\(/g)).toHaveLength(1)
    expect(trendingFunction).not.toContain('can_actor_read_post_fields')
    expect(trendingFunction).not.toContain('hashtag.post_count')
    expect(trendingFunction).toMatch(
      /hashtag\.tag COLLATE pg_catalog\."C" =\s+pg_catalog\.btrim\(hashtag\.tag\) COLLATE pg_catalog\."C"/
    )
    expect(trendingFunction).toMatch(/pg_catalog\.char_length\(hashtag\.tag\) BETWEEN 1 AND 30/)
    expect(trendingFunction).toMatch(
      /pg_catalog\.concat_ws\(' ', post\.title, post\.content\)[\s\S]*'#\(\[\[:alnum:\]_\]\{1,30\}\)\(\?!\[\[:alnum:\]_\]\)'/
    )
    expect(trendingFunction).toMatch(
      /pg_catalog\.lower\([\s\S]*extracted\.tag_match\[1\][\s\S]*= hashtag\.tag/
    )
    expect(trendingFunction).toMatch(
      /GROUP BY readable\.id, readable\.tag[\s\S]*ORDER BY\s*visible\.post_count DESC,\s*visible\.tag COLLATE pg_catalog\."C" ASC,\s*visible\.id ASC[\s\S]*LIMIT p_limit/
    )
    expect(trendingFunction).toMatch(
      /ORDER BY\s*page\.post_count DESC,\s*page\.tag COLLATE pg_catalog\."C" ASC,\s*page\.id ASC/
    )
    expect(trendingFunction).toMatch(
      /'contract', 'hashtag_trending_v1'[\s\S]*'viewer_id', NULL::uuid[\s\S]*'limit', p_limit[\s\S]*'hashtags'/
    )
    expect(trendingFunction).toMatch(
      /'id', page\.id,[\s\S]*'tag', page\.tag,[\s\S]*'post_count', page\.post_count/
    )
  })

  it('filters the complete hashtag relation before total and offset pagination', () => {
    expect(pageFunction).toMatch(
      /public\.get_hashtag_posts_page\(\s*p_viewer_id uuid,\s*p_tag text,\s*p_limit integer,\s*p_offset integer,\s*p_sort_by text/
    )
    expect(pageFunction).toMatch(/auth\.role\(\)[\s\S]*IS DISTINCT FROM 'service_role'/)
    expect(pageFunction).toMatch(
      /v_tag := pg_catalog\.lower\(\s*pg_catalog\.btrim\(p_tag\) COLLATE pg_catalog\."und-x-icu"\s*\)/
    )
    expect(pageFunction).toMatch(/char_length\(v_tag\) NOT BETWEEN 1 AND 30/)
    expect(pageFunction).toContain('COLLATE pg_catalog."und-x-icu"')
    expect(pageFunction).toMatch(/p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100/)
    expect(pageFunction).toMatch(/p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 10000/)
    expect(pageFunction).toMatch(
      /p_sort_by IS NULL OR p_sort_by NOT IN \('created_at', 'hot_score'\)/
    )

    expect(pageFunction).toMatch(/WITH effective_viewer AS MATERIALIZED/)
    expect(pageFunction).toMatch(
      /public\.can_actor_read_post_fields\(\s*p_viewer_id,\s*p_viewer_id,\s*NULL::uuid,\s*'followers'::text,\s*'active'::public\.post_status,\s*NULL::timestamptz\s*\)/
    )
    expect(pageFunction.match(/public\.can_actor_read_post_fields\(/g)).toHaveLength(1)
    expect(pageFunction).toMatch(/readable AS MATERIALIZED/)
    expect(pageFunction).toMatch(
      /CROSS JOIN effective_viewer AS viewer[\s\S]*WHERE hashtag\.tag[\s\S]*AND \(p_viewer_id IS NULL OR viewer\.id IS NOT NULL\)[\s\S]*AND public\.can_actor_read_post_id\(post\.id, viewer\.id\)/
    )
    expect(pageFunction.match(/public\.can_actor_read_post_id\(/g)).toHaveLength(1)
    expect(pageFunction).not.toMatch(/post\.deleted_at|post\.status\s*[=IN]|root\./)
    expect(pageFunction).toMatch(
      /pg_catalog\.concat_ws\(' ', post\.title, post\.content\)[\s\S]*'#\(\[\[:alnum:\]_\]\{1,30\}\)\(\?!\[\[:alnum:\]_\]\)'/
    )

    expect(pageFunction).toMatch(
      /page_rows AS MATERIALIZED \([\s\S]*FROM readable[\s\S]*OFFSET p_offset[\s\S]*LIMIT p_limit/
    )
    expect(pageFunction).toMatch(
      /enriched_page AS MATERIALIZED \([\s\S]*FROM public\.post_likes AS reaction[\s\S]*reaction\.post_id = page\.id[\s\S]*reaction\.user_id = viewer\.id[\s\S]*FROM public\.post_votes AS vote[\s\S]*vote\.post_id = page\.id[\s\S]*vote\.user_id = viewer\.id[\s\S]*FROM page_rows AS page[\s\S]*CROSS JOIN effective_viewer AS viewer/
    )
    expect(pageFunction.indexOf('page_rows AS MATERIALIZED')).toBeLessThan(
      pageFunction.indexOf('enriched_page AS MATERIALIZED')
    )
    expect(pageFunction).not.toMatch(/reaction_type\s+IN|choice\s+IN/)
    expect(pageFunction).toMatch(
      /page_state AS MATERIALIZED \([\s\S]*count\(\*\)::integer AS total\s+FROM readable/
    )
    expect(pageFunction.match(/\bWITH\b/g)).toHaveLength(1)
  })

  it('uses complete deterministic created-at and hot-score orders', () => {
    const fullOrder =
      /CASE WHEN p_sort_by = 'hot_score' THEN (?:readable|page)\.hot_score END DESC NULLS LAST,\s*(?:readable|page)\.created_at DESC NULLS LAST,\s*(?:readable|page)\.id DESC/g

    expect(pageFunction.match(fullOrder)).toHaveLength(2)
  })

  it('returns only the fixed minimal post projection', () => {
    const projection = [
      'id',
      'title',
      'content',
      'author_id',
      'author_handle',
      'author_avatar_url',
      'author_is_verified',
      'group_id',
      'poll_enabled',
      'poll_id',
      'poll_bull',
      'poll_bear',
      'poll_wait',
      'like_count',
      'dislike_count',
      'comment_count',
      'bookmark_count',
      'repost_count',
      'view_count',
      'hot_score',
      'is_pinned',
      'images',
      'created_at',
      'updated_at',
      'original_post_id',
      'visibility',
      'is_sensitive',
      'content_warning',
      'language',
      'user_reaction',
      'user_vote',
    ]

    for (const field of projection) {
      expect(pageFunction).toContain(`'${field}', page.${field}`)
    }

    expect(pageFunction).not.toMatch(/to_jsonb|post\.\*|page\.\*|readable\.\*|SELECT \*/)
    for (const privateField of [
      'deleted_at',
      'deleted_by',
      'delete_reason',
      'report_count',
      'impression_count',
      'click_count',
      'search_hit_count',
      'locked_reason',
      'velocity_updated_at',
    ]) {
      expect(pageFunction).not.toContain(`'${privateField}'`)
    }
  })

  it('echoes an exact viewer-bound page request and pagination acknowledgement', () => {
    expect(pageFunction).toMatch(
      /'contract', 'hashtag_posts_page_v1',[\s\S]*'viewer_state', CASE\s*WHEN p_viewer_id IS NULL THEN 'anonymous'\s*WHEN \(SELECT viewer\.id FROM effective_viewer AS viewer\) IS NULL\s*THEN 'invalid'\s*ELSE 'active'\s*END,[\s\S]*'request', pg_catalog\.jsonb_build_object\(\s*'viewer_id', p_viewer_id,\s*'tag', v_tag,\s*'limit', p_limit,\s*'offset', p_offset,\s*'sort_by', p_sort_by\s*\)/
    )
    expect(pageFunction).toMatch(/'total', \(SELECT state\.total FROM page_state AS state\)/)
    expect(pageFunction).toMatch(/'has_more',[\s\S]*state\.total > \(p_offset \+ p_limit\)/)
    expect(pageFunction).toContain("'next_cursor', NULL::jsonb")
  })

  it('owns, seals, and postflight-checks canonical and phantom functions', () => {
    for (const signature of [
      'public.recount_hashtag_posts(uuid[])',
      'public.get_trending_hashtags_public(integer)',
      'public.get_hashtag_posts_page(uuid,text,integer,integer,text)',
    ]) {
      const [functionName, argumentList] = signature.slice(0, -1).split('(')
      const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const escapedArguments = argumentList
        .split(',')
        .map((argument) => argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s*,\\s*')
      const signaturePattern = `${escapedName}\\(\\s*${escapedArguments}\\s*\\)`

      expect(migration).toMatch(
        new RegExp(`ALTER FUNCTION ${signaturePattern}[\\s\\S]*OWNER TO postgres`)
      )
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION ${signaturePattern}[\\s\\S]*FROM PUBLIC, anon, authenticated, service_role`
        )
      )
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${signaturePattern}[\\s\\S]*TO service_role`)
      )
    }

    expect(migration.match(/function_row\.prokind = 'f'/g)?.length).toBeGreaterThanOrEqual(3)
    expect(migration).toContain(
      "EXECUTE pg_catalog.format('DROP FUNCTION %s RESTRICT', v_function)"
    )
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("pg_catalog.acldefault('f', function_row.proowner)")
    expect(migration).toContain('pg_catalog.has_any_column_privilege(')
    expect(migration).toMatch(
      /ARRAY\[\s*'TRUNCATE', 'REFERENCES', 'TRIGGER'\s*\][\s\S]*service_role unexpectedly has/
    )
    expect(migration).toContain('function_row.provolatile = CASE')
    expect(migration).toContain('function_row.prorettype = CASE')
    expect(migration).toContain('function_row.proargnames IS NOT DISTINCT FROM CASE')
    expect(migration).toContain('function_row.proconfig IS NOT DISTINCT FROM ARRAY[')
    expect(migration).toContain("'search_path=pg_catalog, pg_temp'")
    expect(migration).toContain('phantom hashtag function overload remains')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
