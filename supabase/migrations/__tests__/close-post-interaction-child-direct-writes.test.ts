import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260803101000_close_post_interaction_child_direct_writes.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/close-post-interaction-child-direct-writes.pg17.sh'),
  'utf8'
)
const productionAttestation = readFileSync(
  resolve(root, 'docs/sql/post-interaction-child-boundary-attestation.sql'),
  'utf8'
)
const postEmojiRoute = readFileSync(
  resolve(root, 'app/api/posts/[id]/emoji-react/route.ts'),
  'utf8'
)

const interactionTables = [
  'post_likes',
  'post_votes',
  'post_bookmarks',
  'post_reactions',
  'post_emoji_reactions',
  'comment_emoji_reactions',
  'poll_votes',
] as const

const allowedEmojis = ['👍', '🔥', '💎', '🚀', '❤️', '👀', '🎯', '💰', '📈', '📉', '🤔', '😂']

describe('post interaction child direct-write closure migration', () => {
  it('is a replayable transactional postdeploy boundary with fixed lock ordering', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("'public.post-interaction-child:close-direct-writes:migration'")
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    const lockOrder = [
      'comment_emoji_reactions',
      'poll_votes',
      'post_bookmarks',
      'post_emoji_reactions',
      'post_likes',
      'post_reactions',
      'post_votes',
    ]
    let cursor = migration.indexOf('DO $lock_relations$')
    for (const table of lockOrder) {
      const next = migration.indexOf(`'${table}'`, cursor)
      expect(next).toBeGreaterThan(cursor)
      cursor = next
    }
  })

  it('converges every extant source table to authenticated own-only SELECT', () => {
    for (const table of interactionTables) {
      expect(migration).toContain(`'${table}'`)
      expect(migration).toContain("v_table || '_select_own_canonical'")
    }

    expect(migration).toContain('FOR SELECT\n         TO authenticated')
    expect(migration).toContain('USING ((SELECT auth.uid()) = user_id)')
    expect(migration).toContain("v_policy.polcmd IS DISTINCT FROM 'r'")
    expect(migration).toContain('policy_row.polrelid = v_relation')
    expect(migration).toContain('pg_catalog.pg_get_expr(')
    expect(migration).toContain("'(( SELECT auth.uid() AS uid)) = user_id'")
    expect(migration).not.toContain('USING (true)')
  })

  it('removes unknown mutation policies plus table and column browser ACLs', () => {
    expect(migration).toContain('DROP POLICY %I ON public.%I')
    expect(migration).toContain(
      'REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    )
    expect(migration).toContain('REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I)')
    for (const role of ['PUBLIC', 'anon', 'authenticated', 'authenticator']) {
      expect(migration).toContain(`'${role}'`)
    }
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(migration).toContain(`'${privilege}'`)
    }
    expect(migration).toContain('pg_catalog.has_table_privilege')
    expect(migration).toContain('pg_catalog.has_column_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('Remove every direct non-owner grantee')
    expect(migration).toContain('grant_row.grantee <> v_postgres_oid')
  })

  it('fails closed on writer identity keys and account-deletion cascades', () => {
    for (const marker of [
      'index_row.indisunique',
      'index_row.indisvalid',
      'index_row.indisready',
      'index_row.indpred IS NULL',
      'index_row.indexprs IS NULL',
      'constraint_row.convalidated',
      "constraint_row.confrelid = 'auth.users'::pg_catalog.regclass",
      "constraint_row.confdeltype = 'c'",
      'constraint_row.conkey',
      'constraint_row.confkey',
    ]) {
      expect(migration).toContain(marker)
      expect(productionAttestation).toContain(marker)
    }
  })

  it('keeps owner-executed controlled RPCs viable without FORCE RLS', () => {
    expect(migration).toContain('NO FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('function_row.proowner = v_postgres_oid')
    expect(migration).toContain('function_row.prosecdef')
    expect(migration).toContain('service_role must retain BYPASSRLS for server aggregate reads')
    expect(migration).toContain(
      'browser roles must remain NOSUPERUSER NOBYPASSRLS for own-only interaction reads'
    )
    expect(migration).toContain('function_row.proconfig')
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::text[]")

    for (const signature of [
      'public.toggle_post_reaction(uuid,uuid,text)',
      'public.toggle_post_vote_atomic(uuid,uuid,text)',
      'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)',
      'public.toggle_post_emoji_reaction_atomic(uuid,uuid,text)',
      'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])',
      'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])',
      'public.save_post_bookmark_to_folder_atomic(uuid,uuid)',
      'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)',
    ]) {
      expect(migration).toContain(`'${signature}'`)
    }
  })

  it('quarantines unsupported legacy emoji before validated allowlist constraints', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.interaction_emoji_reaction_quarantine'
    )
    expect(migration).toContain('pg_catalog.to_jsonb(reaction)')
    expect(migration).toContain('payload_fingerprint')
    expect(migration).toContain('PRIMARY KEY (source_table, source_id, payload_fingerprint)')
    expect(migration).toContain('ON CONFLICT (source_table, source_id, payload_fingerprint)')
    expect(migration).toContain('evidence.payload = pg_catalog.to_jsonb(reaction)')
    expect(migration).toContain('evidence.user_id = reaction.user_id')
    expect(migration).toContain("'unsupported_emoji'")
    expect(migration).toContain('FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE')
    expect(migration).toContain("v_table || '_emoji_allowlist_check'")
    expect(migration).toContain('constraint_row.convalidated')
    for (const emoji of allowedEmojis) {
      expect(migration).toContain(`'${emoji}'`)
    }

    const routeAllowlistSource = postEmojiRoute.match(
      /const ALLOWED_EMOJIS = new Set\(\[([\s\S]*?)\]\)/
    )?.[1]
    expect(routeAllowlistSource).toBeDefined()
    const routeAllowlist = Array.from(
      routeAllowlistSource!.matchAll(/'([^']+)'/g),
      (match) => match[1]
    )
    expect(routeAllowlist).toEqual(allowedEmojis)
  })

  it('has PostgreSQL 17 behavioral proof for the security and replay contracts', () => {
    for (const marker of [
      'unsupported legacy emoji quarantined before validated allowlist',
      'authenticated own-only interaction reads retained',
      'service aggregate reads retained through explicit BYPASSRLS authority',
      'account deletion and migration use parent-to-child lock ordering',
      'browser SUPERUSER and BYPASSRLS drift fail closed',
      'controlled-writer exact unique-key drift fails closed',
      'raw browser interaction INSERT UPDATE DELETE denied',
      'table and column mutation ACLs closed',
      'all eight postgres-owner SECURITY DEFINER interaction RPCs retained',
      'exact policy and emoji allowlist semantics are attested',
      'migration replay converged arbitrary ACL policy RLS and emoji drift',
      'quarantine UUID reuse preserves versioned evidence and inherited ACL drift closes',
      'production attestation covers extant optional interaction relations',
      'optional historical interaction relations may be safely absent',
      'production read-only boundary attestation passed',
      'source and quarantined identity rows follow account hard deletion',
      'post interaction child direct-write closure PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })

  it('ships a fail-closed production catalog attestation', () => {
    for (const table of interactionTables) {
      expect(productionAttestation).toContain(`'${table}'`)
    }
    expect(productionAttestation).toContain('BEGIN TRANSACTION READ ONLY')
    expect(productionAttestation).toContain('pg_catalog.has_table_privilege')
    expect(productionAttestation).toContain('pg_catalog.has_column_privilege')
    expect(productionAttestation).toContain('pg_catalog.pg_policy')
    expect(productionAttestation).toContain('pg_catalog.pg_index')
    expect(productionAttestation).toContain('constraint_row.conkey')
    expect(productionAttestation).toContain('constraint_row.confkey')
    expect(productionAttestation).toContain('constraint_row.convalidated')
    expect(productionAttestation).toContain(
      'historical cached-count parity is outside this boundary attestation'
    )
    expect(productionAttestation).toContain(
      'post interaction child boundary production attestation passed'
    )
  })
})
