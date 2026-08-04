import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationName = '20260803109000_close_legacy_comment_reaction_desired_state.sql'
const migration = readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  join(root, 'supabase/migrations/__tests__/close-legacy-comment-reaction-desired-state.pg17.sh'),
  'utf8'
)

const legacySignature = 'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'
const causalSignatures = [
  'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
  'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
  'public.cleanup_comment_reaction_intents_atomic(integer)',
]

describe('legacy comment reaction desired-state postdeploy closure', () => {
  it('is one PG17 transaction behind the shared exclusive migration gate', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("server_version_num')::integer / 10000 <> 17")
    expect(migration).toContain("'public.comment-reaction-count-repair:migration'")
    expect(migration).toContain('pg_catalog.pg_try_advisory_xact_lock(')
    expect(migration).toContain('IN SHARE ROW EXCLUSIVE MODE')
    for (const relation of [
      'auth.users',
      'public.comments',
      'public.comment_likes',
      'public.comment_reaction_count_repair_queue',
      'public.comment_reaction_intent_heads',
      'public.comment_reaction_intent_operations',
    ]) {
      expect(migration).toContain(relation)
    }
  })

  it('fail-closes on exact 1080 private table shape, RLS and both ACL layers', () => {
    for (const marker of [
      'causal comment reaction table columns drifted',
      'causal comment reaction table defaults drifted',
      '7c5eaa3f9fc4a9a682ce5ede3fd1a6ca',
      '7c85c4c638d898935eec524084a73b6e',
      '6db551c8f0e870195efb3e5341e0050a',
      '1a0886f337f4c19cdd9b46c42a130b2b',
      'relation.relrowsecurity',
      'relation.relforcerowsecurity',
      'pg_catalog.pg_policy',
      'pg_catalog.pg_trigger',
      'pg_catalog.pg_inherits',
      'pg_catalog.aclexplode(',
      'pg_catalog.aclexplode(attribute.attacl)',
      'acl_entry.grantee <> relation.relowner',
    ]) {
      expect(migration).toContain(marker)
    }
  })

  it('attests the four-function surface, exact metadata, ACLs and source seals', () => {
    expect(migration).toContain(legacySignature)
    for (const signature of causalSignatures) {
      expect(migration).toContain(signature)
    }
    expect(migration).toContain(') <> 4 OR EXISTS (')
    expect(migration).toContain('function surface is not the reviewed closed set')
    for (const marker of [
      "function_row.prokind = 'f'",
      "function_row.prorettype = 'jsonb'::pg_catalog.regtype",
      'function_row.proowner = v_postgres',
      'function_row.prosecdef',
      "function_row.provolatile = 'v'",
      "function_row.proparallel = 'u'",
      'function_row.pronargdefaults = v_expected.argument_defaults',
      'function_row.proargnames = v_expected.argument_names',
      'pg_catalog.cardinality(function_row.proconfig) = 4',
      "'search_path=pg_catalog, pg_temp'",
      "'row_security=off'",
      "'lock_timeout=5s'",
      "'statement_timeout=15s'",
      'pg_catalog.md5(v_source) IS DISTINCT FROM v_expected.source_digest',
      'v_expected.source_prefix || v_expected.source_digest',
      'acl_entry.grantee NOT IN (function_row.proowner, v_service)',
      'AND NOT acl_entry.is_grantable',
    ]) {
      expect(migration).toContain(marker)
    }
    for (const prefix of [
      'comment-reaction-desired-state:v1:',
      'comment-reaction-causal-intent:reserve-v1:',
      'comment-reaction-causal-intent:apply-v1:',
      'comment-reaction-causal-intent:cleanup-v1:',
    ]) {
      expect(migration).toContain(prefix)
    }
    for (const digest of [
      '2c40ab0522cd0afceb7bbc6a44e29a09',
      '2fdaa03887397d4e3c0222d771328c1b',
      'bd71579634a5312dd8af6093235b2bf8',
      'c9d0d109b295740e1f6b47d45e523c6b',
    ]) {
      expect(migration).toContain(digest)
    }
  })

  it('retains the legacy object but converges every non-owner grant with cascade', () => {
    expect(migration).toContain('DO $close_legacy_execute$')
    expect(migration).toContain('acl_entry.grantee <> v_owner')
    expect(migration).toContain("WHEN v_grantee.grantee = 0 THEN 'PUBLIC'")
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE')
    expect(migration).toContain('legacy comment reaction desired-state authority is not owner-only')
    expect(migration).not.toMatch(/DROP\s+FUNCTION/i)
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION public.set_comment_reaction_desired_state_atomic'
    )
    expect(migration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.set_comment_reaction_desired_state_atomic/i
    )
  })

  it('keeps causal service execution and pins its owner-only composition', () => {
    expect(
      migration.match(/public\.set_comment_reaction_desired_state_atomic\('/g)?.length
    ).toBeGreaterThanOrEqual(2)
    expect(migration).toContain("'public.set_comment_reaction_desired_state_atomic('")
    expect(migration).toContain(
      'causal comment reaction apply no longer composes the sealed owner function'
    )
    expect(migration).toContain(
      'causal comment reaction composition changed during contract publication'
    )
    expect(migration).toContain('acl_entry.grantee = v_service')
    expect(migration).toContain('NOTIFY pgrst')
  })

  it('ships real PG17 direct-denial, owner-composition, replay and drift proofs', () => {
    for (const marker of [
      'legacy_grant_chain_converged',
      'legacy_service_execute_closed',
      'causal_owner_composition_survives',
      'contract_migration_replay',
      'private_column_acl_drift_rejected',
      'causal_acl_drift_rejected',
      'causal_source_seal_drift_rejected',
      'resealed_body_drift_rejected',
      'unexpected_overload_rejected',
      'legacy comment reaction desired-state closure PG17 proof passed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
