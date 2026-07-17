import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716192000_social_edge_write_contract.sql'),
  'utf8'
)

describe('social edge direct-write contract', () => {
  it('is an explicitly staged, bounded transaction after both route cutovers', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain('Deploy this migration only after')
    expect(migration).toContain('both follow and block API route commits are live')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('requires both service-only RPCs and the canonical pair triggers first', () => {
    expect(migration).toContain('public.mutate_user_follow_atomic(uuid,uuid,text)')
    expect(migration).toContain('public.mutate_user_block_atomic(uuid,uuid,text)')
    expect(migration).toContain('public.serialize_direct_message_pair_edge()')
    expect(migration).toContain('trg_serialize_dm_follow_pair')
    expect(migration).toContain('trg_serialize_dm_block_pair')
    expect(migration).toContain('trigger_row.tgtype = 31')
    expect(migration).toContain('pg_catalog.pg_inherits')
    expect(migration).toContain('pg_catalog.pg_rewrite')
    expect(migration).toContain('permanent ordinary postgres-owned tables')
    expect(migration).toContain('atomic social edge RPC execute boundary is incompatible')
  })

  it('takes one short table boundary before changing policies or privileges', () => {
    const lock = migration.indexOf(
      'LOCK TABLE public.blocked_users, public.user_follows\n  IN ACCESS EXCLUSIVE MODE'
    )
    const revoke = migration.indexOf('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    const policyDrop = migration.indexOf('DO $drop_direct_mutation_policies$')
    expect(lock).toBeGreaterThan(0)
    expect(lock).toBeLessThan(revoke)
    expect(revoke).toBeLessThan(policyDrop)
  })

  it('revokes table and column mutation grants from every application role', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*ON TABLE public\.blocked_users, public\.user_follows[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('DO $revoke_column_mutations$')
    expect(migration).toContain("'REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '")
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration).not.toMatch(/REVOKE SELECT[\s\S]*public\.(?:blocked_users|user_follows)/)
  })

  it('keeps SELECT-only policies and removes every mutation-capable policy', () => {
    expect(migration).toContain("policy.polcmd IN ('*', 'a', 'w', 'd')")
    expect(migration).toContain("'DROP POLICY %I ON %s'")
    expect(migration).toContain('Keep every SELECT-only policy untouched')
    expect(migration).not.toContain("policy.polcmd = 'r'")
  })

  it('attests effective table, column, PUBLIC, policy, and RPC authority', () => {
    expect(migration).toContain('pg_catalog.has_table_privilege')
    expect(migration).toContain('pg_catalog.has_column_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain("ARRAY['anon', 'authenticated', 'service_role']")
    expect(migration).toContain("'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'")
    expect(migration).toContain("'INSERT', 'UPDATE', 'REFERENCES'")
    expect(migration).toContain('direct social edge mutation policy survived')
    expect(migration).toContain('atomic social edge RPC boundary drifted during contract')
    expect(migration).toContain('NO FORCE ROW LEVEL SECURITY')
  })
})
