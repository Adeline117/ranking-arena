import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationName = '20260729152000_close_leaderboard_rank_direct_writes.sql'
const migration = readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  join(root, 'supabase/migrations/__tests__/close-leaderboard-rank-direct-writes.pg17.sh'),
  'utf8'
)
const runner = readFileSync(join(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

function migrationNames(arrayName: string): string[] {
  const body = runner.match(new RegExp(`${arrayName}=\\(([\\s\\S]*?)\\n\\)`))?.[1] ?? ''
  return [...body.matchAll(/^\s+([^\s#]+\.sql)$/gm)].map((match) => match[1])
}

const authoritySignatures = [
  'public.prepare_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)',
  'public.plan_leaderboard_rank_generation_batch_v1(text,uuid,timestamptz,jsonb)',
  'public.plan_leaderboard_rank_generation_write_set_v1(text,uuid,text,timestamptz,integer,text[])',
  'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)',
  'public.stage_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],jsonb)',
  'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)',
]

describe('leaderboard rank direct-write postdeploy closure', () => {
  it('runs once at the end of postdeploy and never in predeploy or recovery', () => {
    const predeploy = migrationNames('PREDEPLOY_MIGRATIONS')
    const postdeploy = migrationNames('POSTDEPLOY_MIGRATIONS')
    const recoveryPrerequisites = migrationNames('RECOVERY_PREREQUISITE_MIGRATIONS')
    const recovery = migrationNames('RECOVERY_MIGRATIONS')
    const quarantined = migrationNames('QUARANTINED_PREDEPLOY_MIGRATIONS')
    const superseded = migrationNames('SUPERSEDED_MIGRATIONS')

    expect(postdeploy.indexOf(migrationName)).toBeGreaterThanOrEqual(0)
    expect(postdeploy[postdeploy.indexOf(migrationName) + 1]).toBe(
      '20260729153500_close_legacy_leaderboard_rank_writer_rpcs.sql'
    )
    expect(postdeploy.filter((name) => name === migrationName)).toHaveLength(1)
    for (const phase of [predeploy, recoveryPrerequisites, recovery, quarantined, superseded]) {
      expect(phase).not.toContain(migrationName)
    }
    expect(recoveryPrerequisites).toHaveLength(41)
  })

  it('converges service_role to SELECT-only and closes every API mutation ACL', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES\s+ON TABLE public\.leaderboard_ranks\s+FROM service_role CASCADE;/
    )
    expect(migration).toMatch(
      /GRANT SELECT\s+ON TABLE public\.leaderboard_ranks\s+TO service_role;/
    )
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'
    )
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration.match(/service_role CASCADE/g)?.length).toBeGreaterThanOrEqual(3)
    expect(migration).toContain('pg_catalog.pg_partition_tree(')
    expect(migration).toContain('LOCK TABLE public.leaderboard_ranks IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain('pg_catalog.pg_attribute')
    expect(migration).toContain("'INSERT',\n      'UPDATE',\n      'REFERENCES'")
    expect(migration).toContain('leaderboard rank column-level mutation ACL survived cutover')
    expect(migration).toContain('service_role leaderboard_ranks ACL is not SELECT-only')
  })

  it('preserves reads and the closed postgres-owned SECURITY DEFINER RPC chain', () => {
    for (const signature of authoritySignatures) {
      expect(migration).toContain(signature)
    }
    expect(migration).toContain('relation.relowner = v_postgres')
    expect(migration).toContain('function_row.proowner IS DISTINCT FROM v_postgres')
    expect(migration).toContain('NOT function_row.prosecdef')
    expect(migration).toContain("'search_path=pg_catalog, pg_temp'")
    expect(migration).toContain("'TimeZone=UTC'")
    expect(migration).toContain("'lock_timeout=10s'")
    expect(migration).toContain("'service_role',\n            authority.function_oid")
    expect(migration).toContain("'anon',\n            authority.function_oid")
    expect(migration).toContain("'authenticated',\n            authority.function_oid")
    expect(migration).toContain('leaderboard rank read surface drifted')
    expect(migration).toContain('leaderboard publisher RPC postflight failed')
  })

  it('is transactional and has a replayed PostgreSQL 17 behavior proof', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("server_version_num')::integer / 10000 <> 17")
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock')

    expect(pg17.match(/psql_cmd -q -f "\$MIGRATION"/g)).toHaveLength(2)
    expect(pg17).toContain('GRANT ALL PRIVILEGES ON TABLE public.leaderboard_ranks')
    expect(pg17).toContain('GRANT INSERT (source_trader_id), UPDATE (marker)')
    expect(pg17).toContain('service direct partition insert')
    expect(pg17).toContain('anonymous finalizer execution')
    expect(pg17).toContain('authenticated stage execution')
    expect(pg17).toContain('finalizer response-loss replay')
    expect(pg17).toContain('service direct write after finalization')
  })
})
