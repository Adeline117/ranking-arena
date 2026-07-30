import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729171000_atomic_direct_message_search.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = [
  'supabase/migrations/__tests__/atomic-direct-message-search.pg17.sh',
  'supabase/migrations/__tests__/atomic-direct-message-search.proof.pg17.sh',
]
  .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
  .join('\n')

describe('atomic direct-message conversation search authority', () => {
  it('is bounded, replayable, transactional, and reinstalls lifecycle barriers', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.direct_messages:atomic-conversation-search:migration'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain(
      'SELECT public.install_active_authenticated_subject_mutation_barriers()'
    )
    expect(migration).toContain(
      'SELECT public.assert_active_authenticated_subject_mutation_barriers()'
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('publishes one exact typed service-only search RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.search_direct_message_conversation_atomic\([\s\S]*p_conversation_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_query text,[\s\S]*p_before_created_at timestamptz,[\s\S]*p_before_id uuid,[\s\S]*p_from_created_at timestamptz,[\s\S]*p_to_created_at timestamptz,[\s\S]*p_limit integer[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.search_direct_message_conversation_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.search_direct_message_conversation_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous direct-message search overload exists')
    expect(migration).toContain('atomic-direct-message-conversation-search:v1:')
    expect(databaseTypes).toContain('search_direct_message_conversation_atomic: {')
    expect(databaseTypes).toContain('p_before_id: string | null')
  })

  it('combines membership, clear boundary, candidates, and cursor in one snapshot', () => {
    expect(migration).toContain("'account-recovery-admission:' || p_actor_id::text")
    expect(migration).toContain('one MVCC snapshot')
    expect(migration).toContain('WITH authority AS MATERIALIZED')
    expect(migration).toContain('candidates AS MATERIALIZED')
    expect(migration).toContain('page AS MATERIALIZED')
    expect(migration).toContain('message_row.deleted_at IS NULL')
    expect(migration).toContain('message_row.created_at > authority.cleared_before')
  })

  it('uses literal substring search, strict bounds, and a total cursor', () => {
    expect(migration).toContain('pg_catalog.char_length(v_query) NOT BETWEEN 1 AND 100')
    expect(migration).toContain('((p_before_created_at IS NULL) <> (p_before_id IS NULL))')
    expect(migration).toContain('p_from_created_at > p_to_created_at')
    expect(migration).toContain(String.raw`pg_catalog.replace(v_like_pattern, '%', E'\\%')`)
    expect(migration).toContain(String.raw`pg_catalog.replace(v_like_pattern, '_', E'\\_')`)
    expect(migration).toContain("ESCAPE E'\\\\'")
    expect(migration).toContain('message_row.created_at = p_before_created_at')
    expect(migration).toContain('message_row.id < p_before_id')
    expect(migration).toContain('ORDER BY message_row.created_at DESC, message_row.id DESC')
    expect(migration).toContain('LIMIT p_limit + 1')
  })

  it('ships an isolated PostgreSQL 17 privacy and concurrency proof', () => {
    for (const marker of [
      'same-timestamp search pagination skipped or duplicated messages',
      'cleared or deleted search history leaked',
      'search LIKE metacharacters were not literal',
      'uncommitted send crossed search snapshot',
      'uncommitted clear crossed search snapshot',
      'actor lifecycle admission failed to serialize search',
      'atomic direct-message search PostgreSQL 17 checks passed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
