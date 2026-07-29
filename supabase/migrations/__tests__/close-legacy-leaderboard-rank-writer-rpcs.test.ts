import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationName = '20260729153500_close_legacy_leaderboard_rank_writer_rpcs.sql'
const migration = readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  join(root, 'supabase/migrations/__tests__/close-legacy-leaderboard-rank-writer-rpcs.pg17.sh'),
  'utf8'
)
const runner = readFileSync(join(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const route = readFileSync(join(root, 'app/api/cron/compute-leaderboard/route.ts'), 'utf8')
const publisher = readFileSync(
  join(root, 'app/api/cron/compute-leaderboard/publish-atomic-rank-generation.ts'),
  'utf8'
)
const claim = readFileSync(
  join(root, 'app/api/cron/compute-leaderboard/claim-rank-generation.ts'),
  'utf8'
)

function migrationNames(arrayName: string): string[] {
  const body = runner.match(new RegExp(`${arrayName}=\\(([\\s\\S]*?)\\n\\)`))?.[1] ?? ''
  return [...body.matchAll(/^\s+([^\s#]+\.sql)$/gm)].map((match) => match[1])
}

const legacyWriters = [
  'public.rerank_leaderboard(text)',
  'public.cleanup_stale_platform_rows(text,text,text[])',
  'public.rerank_leaderboard_publication(text,uuid)',
  'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)',
  'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])',
]

const canonicalPublisher = [
  'prepare_leaderboard_score_input_manifest_v1',
  'plan_leaderboard_rank_generation_batch_v1',
  'plan_leaderboard_rank_generation_write_set_v1',
  'claim_leaderboard_rank_generation',
  'stage_leaderboard_rank_generation_batch_v1',
  'finalize_leaderboard_rank_generation_v1',
]

describe('legacy leaderboard rank writer RPC closure', () => {
  it('runs after the table ACL closure in postdeploy only', () => {
    const predeploy = migrationNames('PREDEPLOY_MIGRATIONS')
    const postdeploy = migrationNames('POSTDEPLOY_MIGRATIONS')
    const recoveryPrerequisites = migrationNames('RECOVERY_PREREQUISITE_MIGRATIONS')
    const recovery = migrationNames('RECOVERY_MIGRATIONS')
    const quarantined = migrationNames('QUARANTINED_PREDEPLOY_MIGRATIONS')
    const superseded = migrationNames('SUPERSEDED_MIGRATIONS')

    expect(postdeploy.slice(-2)).toEqual([
      '20260729152000_close_leaderboard_rank_direct_writes.sql',
      migrationName,
    ])
    expect(postdeploy.filter((name) => name === migrationName)).toHaveLength(1)
    for (const phase of [predeploy, recoveryPrerequisites, recovery, quarantined, superseded]) {
      expect(phase).not.toContain(migrationName)
    }
    expect(recoveryPrerequisites).toHaveLength(41)
  })

  it('defines the reviewed direct-writer catalog and rejects unknown writers', () => {
    for (const signature of legacyWriters) {
      expect(migration).toContain(signature)
    }
    expect(migration).toContain(
      'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
    )
    expect(migration).toContain('observed_leaderboard_rank_writer_surface')
    expect(migration).toContain('(insert[[:space:]]+into)')
    expect(migration).toContain('(delete[[:space:]]+from)')
    expect(migration).toContain('(merge[[:space:]]+into)')
    expect(migration).toContain(
      'leaderboard rank direct-writer catalog is not the reviewed closed set'
    )
    expect(migration).toContain('an unknown externally executable indirect rank writer exists')
  })

  it('converges every legacy function to a postgres-owner-only ACL', () => {
    expect(migration).toContain("classification IN ('canonical', 'legacy')")
    expect(migration).toContain("WHERE expected.classification = 'legacy'")
    expect(migration).toContain('ALTER FUNCTION %s OWNER TO postgres')
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('expanded.grantee <> function_row.proowner')
    expect(migration).toContain('FROM PUBLIC CASCADE')
    expect(migration).toContain('FROM %I CASCADE')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role CASCADE')
    expect(migration).toContain('legacy leaderboard rank writer ACL is not owner-only')
    expect(migration).toContain('LOCK TABLE public.leaderboard_ranks IN ACCESS EXCLUSIVE MODE')
  })

  it('preserves the six canonical RPCs and only service_role finalizer write execution', () => {
    for (const name of canonicalPublisher) {
      expect(migration).toContain(name)
    }
    expect(migration).toContain('canonical_leaderboard_publisher_authority')
    expect(migration).toContain('NOT function_row.prosecdef')
    expect(migration).toContain("'service_role', authority.function_oid, 'EXECUTE'")
    expect(migration).toContain("'anon', authority.function_oid, 'EXECUTE'")
    expect(migration).toContain("'authenticated', authority.function_oid, 'EXECUTE'")
    expect(migration).toContain(
      "v_expected.classification = 'canonical'\n           AND v_role = 'service_role'::name"
    )
    expect(migration).toContain('canonical leaderboard publisher authority changed during cutover')
  })

  it('keeps production on the atomic publisher and proves real PG17 role behavior', () => {
    expect(route).toContain("from './publish-atomic-rank-generation'")
    expect(route).toContain('await publishAtomicRankGeneration({')
    for (const legacyName of [
      'rerankAllRows',
      'cleanupStaleRows',
      'cleanup_leaderboard_rank_publication',
      'rerank_leaderboard_publication',
      'seal_leaderboard_rank_publication',
    ]) {
      expect(route).not.toContain(legacyName)
    }
    for (const canonicalName of canonicalPublisher) {
      expect(`${publisher}\n${claim}`).toContain(canonicalName)
    }

    expect(pg17.match(/psql_cmd -q -f "\$RPC_CUTOVER"/g)).toHaveLength(2)
    expect(pg17).toContain('legacy security-definer bypass before cutover')
    expect(pg17).toContain('publication cleanup helper closed')
    expect(pg17).toContain('superseded invoker writer closed')
    expect(pg17).toContain('canonical finalizer with owner-only helpers')
    expect(pg17).toContain('service table DML remains closed')
  })

  it('is one replay-safe PostgreSQL 17 transaction', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("server_version_num')::integer / 10000 <> 17")
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock')
  })
})
