import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729063000_leaderboard_rank_staging_full_xid_guard.sql'
  ),
  'utf8'
)
const atomicHarness = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh'
  ),
  'utf8'
)
const stagingProof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-generation-staging-only-writer.pg17.sh'
  ),
  'utf8'
)
const epochProof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-generation-staging-full-xid-epoch.pg17.sh'
  ),
  'utf8'
)
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')

const workflowJobBlock = (jobId: string): string => {
  const marker = `  ${jobId}:\n`
  const start = ciWorkflow.indexOf(marker)
  if (start < 0) return ''

  const remainder = ciWorkflow.slice(start + marker.length)
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\s*$/m)
  return ciWorkflow.slice(start, nextJob < 0 ? undefined : start + marker.length + nextJob)
}

const sql = migration.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const functionSource = (name: string): string =>
  migration.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION arena\\.${name.replace(/\./g, '\\.')}\\(\\)[\\s\\S]*?AS \\$body\\$([\\s\\S]*?)\\$body\\$;`
    )
  )?.[1] ?? ''

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const guard = functionSource('guard_leaderboard_rank_generation_stage_row_insert_v1')
const validator = functionSource('validate_leaderboard_rank_generation_stage_batch_v1')

describe('leaderboard rank staging full-XID guard', () => {
  it('drains the writer at the head before taking either stage lock', () => {
    const headLock = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE'
    )
    const batchLock = sql.indexOf('LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_batches')
    const rowLock = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_rows IN SHARE MODE'
    )

    expect(headLock).toBeGreaterThan(-1)
    expect(batchLock).toBeGreaterThan(headLock)
    expect(rowLock).toBeGreaterThan(batchLock)
    expect(sql).toContain('IN ACCESS EXCLUSIVE MODE')
  })

  it('pins the exact staging-only writer and broken helper baseline before repair', () => {
    expect(sql).toContain('7247740feba0f910aa010f7d9d0f79230a8438944742027a7e699240cfe7a89f')
    expect(sql).toContain('ba9030dfdd0431721903561fdfa02c106fcedc66cbb32ab20acf5ebd33958dc9')
    expect(sql).toContain('14063ba832d2bd0a5de0d5975eaf4ea8a68093e63b27f78107770cd8766184b0')
    expect(sql).toContain('3896caded6f9f7062305267ebf4d99f05f8e6299711d00b8a252d5d043b26e2e')
    expect(sql).toContain('stage helper metadata or ACL drifted before XID repair')
    expect(sql).toContain('private stage trigger topology drifted before XID repair')
    expect(sql).toContain('legacy private stage graph lacks one exact top-level xid')
  })

  it('annotates only previously complete immutable stage headers before enforcing xid8', () => {
    const addColumn = sql.indexOf('ADD COLUMN stage_write_top_xid pg_catalog.xid8')
    const disable = sql.indexOf(
      'DISABLE TRIGGER leaderboard_rank_generation_stage_batches_immutable'
    )
    const backfill = sql.indexOf('SET stage_write_top_xid = batch.xmin::text::pg_catalog.xid8')
    const enable = sql.indexOf('ENABLE TRIGGER leaderboard_rank_generation_stage_batches_immutable')
    const defaultValue = sql.indexOf('SET DEFAULT pg_catalog.pg_current_xact_id()')
    const notNull = sql.indexOf('ALTER COLUMN stage_write_top_xid SET NOT NULL')

    expect(addColumn).toBeGreaterThan(-1)
    expect(disable).toBeGreaterThan(addColumn)
    expect(backfill).toBeGreaterThan(disable)
    expect(enable).toBeGreaterThan(backfill)
    expect(defaultValue).toBeGreaterThan(enable)
    expect(notNull).toBeGreaterThan(defaultValue)
    expect(sql).toContain('staged.xmin = batch.xmin')
    expect(sql).toContain('staged.row_count IS DISTINCT FROM batch.row_count')
    expect(sql).toContain('staged.max_position IS DISTINCT FROM batch.row_count')
  })

  it('pairs the full top xid8 with direct tuple xmin and keeps subtransactions closed', () => {
    for (const source of [guard, validator]) {
      expect(source).toContain('pg_catalog.pg_current_xact_id()::xid')
      expect(source).toContain('pg_catalog.pg_current_xact_id()')
      expect(source).not.toMatch(/xmin::text::(?:pg_catalog\.)?xid8/)
    }

    expect(guard).toContain('batch.xmin IS DISTINCT FROM v_current_xid')
    expect(guard).toContain('batch.stage_write_top_xid IS DISTINCT FROM v_current_top_xid')
    expect(validator).toContain('SELECT batch.xmin, batch.stage_write_top_xid')
    expect(validator).toContain('v_header_xid IS DISTINCT FROM v_current_xid')
    expect(validator).toContain('v_header_top_xid IS DISTINCT FROM v_current_top_xid')
    expect(validator).toContain('pg_catalog.bool_and(staged.xmin = v_current_xid)')
    expect(sql).toContain('SAVEPOINT and PL/pgSQL subtransactions')
  })

  it('retains every non-transactional batch authority check', () => {
    expect(validator).toContain('FOR SHARE')
    expect(validator).toContain("v_head.phase NOT IN ('claimed', 'writing')")
    expect(validator).toContain('v_head.lease_expires_at <= v_now')
    expect(validator).toContain('arena.build_leaderboard_rank_generation_write_set_sha256_v1')
    expect(validator).toContain('NEW.batch_sha256_plan[NEW.batch_index + 1] IS DISTINCT FROM')
    expect(validator).toContain('v_expected_write_set IS DISTINCT FROM v_claim.write_set_sha256')
    expect(validator).toContain('arena.build_leaderboard_rank_typed_batch_evidence_v1')
    expect(validator).toContain('arena.build_leaderboard_rank_typed_field_commitment_v1')
    expect(validator).toContain('v_chunk.identities IS DISTINCT FROM v_identities')
    expect(validator).toContain('v_chunk.field_commitments IS DISTINCT FROM v_field_commitments')
    expect(validator).toContain('v_prior_row_count IS DISTINCT FROM NEW.batch_index * 1000')
    expect(validator).toContain('stage batch identity range overlaps its predecessor')
  })

  it('replaces exactly the two trigger helpers without changing writer identity', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION arena\.[a-z0-9_]+\(\)/g)).toHaveLength(2)
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION arena\.write_leaderboard_rank_generation_batch_v1/
    )
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./)
    expect(sql).not.toMatch(/^\s*GRANT\s+/im)
    expect(sql).toContain('function_row.proowner <>')
    expect(sql).toContain('function_row.proconfig IS DISTINCT FROM')
    expect(sql).toContain('privilege_row.grantee <> function_row.proowner')
    expect(sql).toContain('has_function_privilege')
    expect(sql).toContain('privilege_row.grantee <> relation_row.relowner')
    expect(sql).toContain('has_table_privilege')
    expect(sql).toContain('has_any_column_privilege')
    expect(sql).toContain('trigger_row.tgfoid <> expected.function_oid')
  })

  it('pins all six stage triggers before and after the repair', () => {
    const postflight = sql.slice(sql.indexOf('DO $postflight$'))
    const triggerNames = [
      'leaderboard_rank_generation_stage_batches_complete',
      'leaderboard_rank_generation_stage_batches_immutable',
      'leaderboard_rank_generation_stage_batches_no_truncate',
      'leaderboard_rank_generation_stage_rows_insert_guard',
      'leaderboard_rank_generation_stage_rows_immutable',
      'leaderboard_rank_generation_stage_rows_no_truncate',
    ]

    for (const triggerName of triggerNames) {
      expect(postflight).toContain(triggerName)
    }
    expect(postflight).toContain('(trigger_row.tgconstraint <> 0) IS DISTINCT FROM')
    expect(postflight).toContain('trigger_row.tgoldtable IS DISTINCT FROM')
    expect(postflight).toContain('trigger_row.tgnewtable IS DISTINCT FROM')
    expect(postflight).toContain('trigger_row.tgfoid <> expected.function_oid')
    expect(postflight).toContain('trigger_row.tgtype <> expected.trigger_type')
  })

  it('pins the repaired bodies and the exact xid8 column contract', () => {
    expect(sha256(guard)).toBe('d1abc770cf419bda8a1b3d92d7dc9b04e46078a1e5888dffb59597576fa21963')
    expect(sha256(validator)).toBe(
      'a0f2728c70d95c7bc55897e1e939090ec2ad741e95a545cd705f60c22cbb1202'
    )
    expect(sql).toContain("attribute.atttypid = 'pg_catalog.xid8'::regtype")
    expect(sql).toContain('attribute.attnum = 17')
    expect(sql).toContain('attribute.attnotnull')
    expect(sql).toContain("= 'pg_current_xact_id()'")
    expect(sql).toContain('batch.stage_write_top_xid::xid <> staged.xmin')
    expect(sql).toContain('full-XID stage trigger postflight drifted')
  })

  it('cannot mutate serving authority or expose the private store', () => {
    expect(sql).not.toMatch(
      /(?:INSERT INTO|UPDATE(?: ONLY)?|DELETE FROM|TRUNCATE)\s+(?:ONLY\s+)?public\.leaderboard_ranks/i
    )
    expect(sql).not.toContain('leaderboard_rank_mutation_fences')
    expect(sql).not.toContain('leaderboard_source_freshness')
    expect(sql).not.toContain('leaderboard_rank_generation_source_fence_receipts')
    expect(sql).not.toMatch(/ALTER\s+FUNCTION[\s\S]*?SECURITY\s+DEFINER/i)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
  })

  it('keeps the dynamic PG17 epoch proof wired into the required CI path', () => {
    const requiredPreflight = workflowJobBlock('pre-checks')

    expect(packageJson.scripts['qa:rank-staging-xid-pg17']).toBe(
      'bash supabase/migrations/__tests__/leaderboard-rank-generation-staging-only-writer.pg17.sh && bash supabase/migrations/__tests__/leaderboard-rank-generation-staging-full-xid-epoch.pg17.sh && bash supabase/migrations/__tests__/leaderboard-rank-generation-staging-only-writer-legacy-replay.pg17.sh'
    )
    expect(requiredPreflight).toContain('name: Pre-flight Checks')
    expect(requiredPreflight).toContain('timeout-minutes: 15')
    expect(requiredPreflight).toContain('Install isolated PostgreSQL 17 server binaries')
    expect(requiredPreflight).toContain('PG17_BIN: /usr/lib/postgresql/17/bin')
    expect(requiredPreflight).toContain('run: npm run qa:rank-staging-xid-pg17')
    expect(requiredPreflight).not.toContain('continue-on-error')
    expect(ciWorkflow).not.toMatch(/^  rank-staging-xid-pg17:\n/m)
    expect(stagingProof).toContain('ARENA_ATOMIC_WRITER_STAGING_ONLY=1')
    expect(stagingProof).toContain('ARENA_ATOMIC_WRITER_STAGING_XID_REPAIR_TIMING=after-batch-zero')
    expect(epochProof.match(/ARENA_ATOMIC_WRITER_STAGING_XID_EPOCH=1/g)).toHaveLength(2)
    expect(epochProof).toContain('ARENA_ATOMIC_WRITER_STAGING_XID_REPAIR_TIMING=after-batch-zero')
    expect(atomicHarness).toContain('"$PG_BIN/pg_resetwal" -e 1 "$DATA_DIR"')
    expect(atomicHarness).toContain('offline XID epoch advance changed staged authority')
    expect(atomicHarness).toContain('SAVEPOINT staging_batch_subtransaction')
    expect(atomicHarness).toContain('DO $staging_exception_subtransaction$')
    expect(atomicHarness).toContain('batch.stage_write_top_xid::text::numeric > 4294967295')
  })
})
