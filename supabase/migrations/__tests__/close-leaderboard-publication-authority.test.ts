import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationName = '20260729154000_close_leaderboard_publication_authority.sql'
const migration = readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  join(root, 'supabase/migrations/__tests__/close-leaderboard-publication-authority.pg17.sh'),
  'utf8'
)
const runner = readFileSync(join(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const route = readFileSync(join(root, 'app/api/cron/compute-leaderboard/route.ts'), 'utf8')
const finalizerMigration = readFileSync(
  join(
    root,
    'supabase/migrations/20260729054600_atomic_leaderboard_rank_generation_publication.sql'
  ),
  'utf8'
)
const proofReader = readFileSync(join(root, 'lib/rankings/read-publication-proofs.ts'), 'utf8')

function migrationNames(arrayName: string): string[] {
  const body = runner.match(new RegExp(`${arrayName}=\\(([\\s\\S]*?)\\n\\)`))?.[1] ?? ''
  return [...body.matchAll(/^\s+([^\s#]+\.sql)$/gm)].map((match) => match[1])
}

describe('leaderboard publication authority postdeploy closure', () => {
  it('runs after both rank-writer cutovers in postdeploy only', () => {
    const predeploy = migrationNames('PREDEPLOY_MIGRATIONS')
    const postdeploy = migrationNames('POSTDEPLOY_MIGRATIONS')
    const recoveryPrerequisites = migrationNames('RECOVERY_PREREQUISITE_MIGRATIONS')
    const recovery = migrationNames('RECOVERY_MIGRATIONS')
    const quarantined = migrationNames('QUARANTINED_PREDEPLOY_MIGRATIONS')
    const superseded = migrationNames('SUPERSEDED_MIGRATIONS')

    expect(postdeploy.slice(-3)).toEqual([
      '20260729152000_close_leaderboard_rank_direct_writes.sql',
      '20260729153500_close_legacy_leaderboard_rank_writer_rpcs.sql',
      migrationName,
    ])
    expect(postdeploy.filter((name) => name === migrationName)).toHaveLength(1)
    for (const phase of [predeploy, recoveryPrerequisites, recovery, quarantined, superseded]) {
      expect(phase).not.toContain(migrationName)
    }
    expect(recoveryPrerequisites).toHaveLength(41)
  })

  it('makes freshness SELECT-only for every application role', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES\s+ON TABLE public\.leaderboard_source_freshness\s+FROM service_role CASCADE;/
    )
    expect(migration).toMatch(
      /GRANT SELECT\s+ON TABLE public\.leaderboard_source_freshness\s+TO service_role;/
    )
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'
    )
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role CASCADE')
    expect(migration).toContain('close_freshness_column_dml')
    expect(migration).toContain("'INSERT',\n    'UPDATE',\n    'REFERENCES'")
    expect(migration).toContain('leaderboard freshness column-level mutation ACL survived')
    expect(migration).toContain('leaderboard freshness write policy survived publication cutover')
  })

  it('keeps publication tables private and standalone seal owner-only', () => {
    for (const table of [
      'arena.leaderboard_rank_mutation_fences',
      'arena.leaderboard_rank_publications',
      'arena.leaderboard_rank_cleanup_receipts',
    ]) {
      expect(migration).toContain(table)
    }
    expect(migration).toContain('converge_private_tables')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE %s')
    expect(migration).toContain('ALTER FUNCTION public.seal_leaderboard_rank_publication')
    expect(migration).toContain('close_seal_execute')
    expect(migration).toContain('expanded.grantee <> function_row.proowner')
    expect(migration).toContain('FROM PUBLIC CASCADE')
    expect(migration).toContain('FROM %I CASCADE')
    expect(migration).toContain('leaderboard seal ACL is not owner-only')
  })

  it('preserves only finalizer write authority and the service proof reader', () => {
    expect(migration).toContain(
      "classification IN ('internal_seal', 'canonical_finalizer', 'proof_reader')"
    )
    expect(migration).toContain(
      'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
    )
    expect(migration).toContain('public.arena_leaderboard_publication_proofs(text,text[])')
    expect(migration).toContain("'canonical_finalizer',\n             'proof_reader'")
    expect(migration).toContain('finalizer/proof-reader publication contract drifted')
    expect(finalizerMigration).toContain('public.seal_leaderboard_rank_publication(')
    expect(proofReader).toContain("'arena_leaderboard_publication_proofs'")
  })

  it('keeps production route atomic and proves behavior with real PG17 roles', () => {
    expect(route).toContain("from './publish-atomic-rank-generation'")
    expect(route).toContain('await publishAtomicRankGeneration({')
    expect(route).not.toContain('seal_leaderboard_rank_publication')
    expect(route).not.toContain("from './seal-rank-publication'")
    expect(route).not.toContain("from('leaderboard_source_freshness').upsert")

    expect(pg17.match(/psql_cmd -q -f "\$MIGRATION"/g)).toHaveLength(2)
    expect(pg17).toContain('legacy direct freshness update')
    expect(pg17).toContain('standalone seal before cutover')
    expect(pg17).toContain('"$role standalone seal"')
    expect(pg17).toContain('canonical finalizer owns seal')
    expect(pg17).toContain('service proof reader')
    expect(pg17).toContain('service freshness remains read-only after finalizer')
  })

  it('is transactional, lock-drained, and replay safe on PostgreSQL 17', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("server_version_num')::integer / 10000 <> 17")
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(migration).toContain('IN ACCESS EXCLUSIVE MODE')
  })
})
