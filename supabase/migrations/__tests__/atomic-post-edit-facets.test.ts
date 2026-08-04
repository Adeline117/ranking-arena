import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729186500_atomic_post_edit_facets.sql'),
  'utf8'
)
const closure = readFileSync(
  resolve(root, 'supabase/migrations/20260729187000_close_legacy_post_edit_signature.sql'),
  'utf8'
)
const server = readFileSync(resolve(root, 'lib/posts/post-edit-server.ts'), 'utf8')
const contract = readFileSync(resolve(root, 'lib/posts/post-edit-contract.ts'), 'utf8')
const standaloneEditor = readFileSync(resolve(root, 'app/(app)/post/[id]/edit/page.tsx'), 'utf8')
const groupEditor = readFileSync(
  resolve(root, 'app/(app)/groups/[id]/hooks/useGroupPosts.ts'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-post-edit-facets.pg17.sh'),
  'utf8'
)

describe('atomic post edit facets migration', () => {
  it('is a bounded replayable predeploy authority independent of postdeploy closure', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.posts:atomic-post-edit-facets:migration'")
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toContain('maintain_post_hashtag_count')
    expect(migration).not.toContain('20260729185000')
    expect(migration).not.toContain('20260729186000')
  })

  it('additively publishes an exact service-only facet-aware edit signature', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.edit_post_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_post_id uuid,[\s\S]*p_expected_version bigint,[\s\S]*p_title text,[\s\S]*p_content text,[\s\S]*p_update_images boolean,[\s\S]*p_images text\[\],[\s\S]*p_language text,[\s\S]*p_mention_handles text\[\],[\s\S]*p_hashtag_tags text\[\][\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).not.toContain('DROP FUNCTION IF EXISTS public.edit_post_atomic(')
    expect(migration).toContain('old application instances keep editing')
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.edit_post_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.edit_post_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-post-edit-facets:v2:')
  })

  it('closes only the legacy signature after the count-trigger postdeploy gate', () => {
    expect(closure).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(closure).toContain("SET LOCAL lock_timeout = '5s'")
    expect(closure).toContain("'public.posts:close-legacy-post-edit-signature:migration'")
    expect(closure).toContain("'public.maintain_post_hashtag_count()'")
    expect(closure).toContain('trg_post_hashtags_90_maintain_post_count')
    expect(closure).toContain('DROP FUNCTION IF EXISTS public.edit_post_atomic(')
    expect(closure).toContain('uuid, uuid, bigint, text, text, boolean, text[]')
    expect(closure).toContain('DO $converge_new_acl$')
    expect(closure).toContain('DO $postflight$')
    expect(closure).toContain("NOTIFY pgrst, 'reload schema'")
    expect(closure.trimEnd()).toMatch(/COMMIT;$/)
    expect(closure).not.toMatch(
      /DROP FUNCTION IF EXISTS public\.edit_post_atomic\(\s*uuid, uuid, bigint, text, text, boolean, text\[\], text/
    )
  })

  it('derives facets only from final sanitized title/content and verifies them in the ACK', () => {
    expect(server).toContain(".normalize('NFC')")
    expect(server).toContain('const derivedText = `${title} ${content}`')
    expect(server).toContain('detectPostLanguage(derivedText)')
    expect(server).toContain('extractMentionHandles(derivedText)')
    expect(server).toContain('extractHashtags(derivedText)')
    expect(server).toContain('p_language: input.language')
    expect(server).toContain('p_mention_handles: input.mentionHandles')
    expect(server).toContain('p_hashtag_tags: input.hashtagTags')
    expect(server).toContain('acknowledgement.post.language !== input.language')
    expect(server).toContain('acknowledgement.post.hashtags')
    for (const field of ["'language'", "'mentions'", "'hashtags'"]) {
      expect(contract).toContain(field)
    }
  })

  it('keeps both editors submitting raw editable fields plus the rendered CAS token', () => {
    for (const editor of [standaloneEditor, groupEditor]) {
      expect(editor).toContain('expected_version:')
      expect(editor).not.toContain('p_mention_handles')
      expect(editor).not.toContain('p_hashtag_tags')
      expect(editor).not.toContain('p_language')
    }
  })

  it('uses create-compatible tag locks, exact join replacement, and exact count convergence', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.edit_post_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const revisionCheck = body!.indexOf(
      'v_post.content_version IS DISTINCT FROM p_expected_version'
    )
    const tagLock = body!.indexOf('ORDER BY hashtag.tag COLLATE "C"\n  FOR UPDATE')
    const postUpdate = body!.indexOf('UPDATE public.posts AS target')
    const joinDelete = body!.indexOf('DELETE FROM public.post_hashtags')
    const joinInsert = body!.indexOf('INSERT INTO public.post_hashtags')
    const exactCount = body!.indexOf('UPDATE public.hashtags AS hashtag')
    const acknowledgement = body!.indexOf("'status', 'updated'")

    expect(revisionCheck).toBeGreaterThan(0)
    expect(revisionCheck).toBeLessThan(tagLock)
    expect(tagLock).toBeLessThan(postUpdate)
    expect(postUpdate).toBeLessThan(joinDelete)
    expect(joinDelete).toBeLessThan(joinInsert)
    expect(joinInsert).toBeLessThan(exactCount)
    expect(exactCount).toBeLessThan(acknowledgement)
    expect(body).toContain("'status', 'unchanged'")
    expect(body).toContain("'revision_advanced', v_revision_advanced")
    expect(body).not.toContain('SET post_count = hashtag.post_count +')
  })

  it('acknowledges only canonical mentions added by the locked revision', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.edit_post_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const postLock = body!.indexOf('SELECT target.*\n  INTO v_post')
    const delta = body!.indexOf('INTO v_added_mentions')
    const postUpdate = body!.indexOf('UPDATE public.posts AS target')
    expect(postLock).toBeGreaterThan(0)
    expect(delta).toBeGreaterThan(postLock)
    expect(delta).toBeLessThan(postUpdate)
    expect(body).toContain('COALESCE(v_post.mentions, ARRAY[]::text[])')
    expect(body).toContain('pg_catalog.lower(normalize(previous.handle, NFC))')
    expect(body).toContain("'added_mentions', ARRAY[]::text[]")
    expect(body).toContain("'added_mentions', v_added_mentions")
  })

  it('advances revisions for rendered facets and carries them in exact acknowledgements', () => {
    for (const field of ['language', 'mentions', 'hashtags']) {
      expect(migration).toContain(`NEW.${field} IS DISTINCT FROM OLD.${field}`)
      expect(migration).toContain(`'${field}', v_updated_post.${field}`)
    }
    expect(migration).toContain('post-content-version:v2:')
    expect(migration).toContain('v_updated_post.content_version IS DISTINCT FROM')
  })

  it('has a PostgreSQL 17 proof before and after the count trigger cutover', () => {
    for (const marker of [
      'facet authority replay before closure',
      'predeploy legacy editor compatibility',
      'add replace remove facets before count trigger',
      'transactional newly-added mention acknowledgement',
      'unchanged content repaired count drift before trigger',
      'lost acknowledgement retry',
      'concurrent facet edit compare-and-swap',
      'transaction rollback preserves facets and counts',
      'early legacy closure failed closed',
      'hashtag count trigger cutover',
      'facet edits after count trigger avoid double count',
      'legacy edit signature postdeploy closure',
      'facet edit remains available after closure',
      'service-only facet edit ACL',
      'atomic post edit facets PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
