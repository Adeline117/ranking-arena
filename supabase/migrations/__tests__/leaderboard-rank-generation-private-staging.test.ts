import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729054400_leaderboard_rank_generation_private_staging.sql'
  ),
  'utf8'
)

const sql = migration.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const functionSource = (name: string): string =>
  migration.match(
    new RegExp(
      `CREATE FUNCTION arena\\.${name.replace(/\./g, '\\.')}\\(\\)[\\s\\S]*?AS \\$body\\$([\\s\\S]*?)\\$body\\$;`
    )
  )?.[1] ?? ''

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const guard = functionSource('guard_leaderboard_rank_generation_stage_row_insert_v1')
const validator = functionSource('validate_leaderboard_rank_generation_stage_batch_v1')

describe('leaderboard rank generation private staging', () => {
  it('is an inert expansion and does not replace or expose a live writer', () => {
    expect(migration).toContain('A future')
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION arena\.write_leaderboard_rank_generation_batch_v1/i
    )
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./i)
    expect(sql).not.toMatch(/^\s*GRANT\s+/im)
    expect(sql).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(?:ONLY\s+)?public\.leaderboard_ranks/i
    )
    expect(sql).not.toContain('leaderboard_rank_mutation_fences')
    expect(sql).not.toContain('leaderboard_rank_generation_source_fence_receipts')
  })

  it('drains the old writer at the head before locking downstream evidence', () => {
    const head = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE'
    )
    const claim = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_claims IN SHARE MODE'
    )
    const binding = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_manifest_bindings'
    )
    const header = sql.indexOf('LOCK TABLE ONLY arena.leaderboard_rank_manifest_attestations')
    const chunks = sql.indexOf('LOCK TABLE ONLY arena.leaderboard_rank_manifest_attestation_chunks')

    expect(head).toBeGreaterThan(-1)
    expect(claim).toBeGreaterThan(head)
    expect(binding).toBeGreaterThan(claim)
    expect(header).toBeGreaterThan(binding)
    expect(chunks).toBeGreaterThan(header)
    expect(sql).not.toMatch(
      /LOCK TABLE ONLY arena\.leaderboard_rank_generation_heads IN SHARE MODE/
    )
    expect(sql).not.toMatch(/LOCK TABLE (?:ONLY )?public\.leaderboard_ranks/i)
  })

  it('creates two explicit LOGGED owner-only RLS relations without policies', () => {
    for (const relation of [
      'arena.leaderboard_rank_generation_stage_batches',
      'arena.leaderboard_rank_generation_stage_rows',
    ]) {
      const escaped = relation.replace(/\./g, '\\.')
      expect(sql).toContain(`CREATE TABLE ${relation}`)
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${escaped} OWNER TO postgres;`))
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE ${escaped}[\\s\\S]{0,120}ENABLE ROW LEVEL SECURITY;`)
      )
    }

    expect(sql).not.toMatch(/CREATE\s+(?:UNLOGGED|TEMP(?:ORARY)?)\s+TABLE/i)
    expect(sql).not.toMatch(/CREATE\s+POLICY/i)
    expect(sql).toContain('privilege_row.grantee <> table_row.relowner')
    expect(sql).toContain('pg_catalog.has_any_column_privilege')
    expect(sql).toContain('attribute.attacl')
    expect(sql).toContain("table_row.relpersistence <> 'p'")
  })

  it('keys every stage batch to the exact claim, binding, and attestation chunk', () => {
    const batches = sql.match(
      /CREATE TABLE arena\.leaderboard_rank_generation_stage_batches\s*\(([\s\S]*?)\n\);/
    )?.[1]

    expect(batches).toBeDefined()
    expect(batches).toContain('PRIMARY KEY (season_id, generation_seq, batch_index)')
    expect(batches).toContain('UNIQUE (score_cohort_id, batch_index)')
    expect(batches).toMatch(
      /FOREIGN KEY \(season_id, generation_seq, score_cohort_id\)[\s\S]*?REFERENCES arena\.leaderboard_rank_generation_claims/
    )
    expect(batches).toMatch(
      /FOREIGN KEY \([\s\S]*?score_input_manifest_digest[\s\S]*?\)[\s\S]*?REFERENCES arena\.leaderboard_rank_generation_manifest_bindings[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    )
    expect(batches).toMatch(
      /CONSTRAINT rank_generation_stage_batch_attestation_fkey[\s\S]*?REFERENCES arena\.leaderboard_rank_manifest_attestation_chunks[\s\S]*?chunk_index[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    )
    expect(batches).toContain('batch_index >= 0 AND batch_index < 64')
    expect(batches).toContain('row_count > 0 AND row_count <= 1000')
    expect(batches).toContain("batch_sha256 ~ '^[0-9a-f]{64}$'")
    expect(batches).toContain('batch_sha256_plan text[] NOT NULL')
    expect(batches).toContain('COLLATE pg_catalog."C"')
  })

  it('stores unique typed identities but refuses provisional rank authority', () => {
    const rows = sql.match(
      /CREATE TABLE arena\.leaderboard_rank_generation_stage_rows\s*\(([\s\S]*?)\n\);/
    )?.[1]

    expect(rows).toBeDefined()
    expect(rows).toContain('row_payload arena.leaderboard_rank_batch_row_v1 NOT NULL')
    expect(rows).toContain('UNIQUE (season_id, generation_seq, source, source_trader_id)')
    expect(rows).toContain('UNIQUE (score_cohort_id, source, source_trader_id)')
    expect(rows).toContain("pg_catalog.convert_to(source, 'UTF8')")
    expect(rows).toContain("pg_catalog.convert_to((row_payload).source, 'UTF8')")
    expect(rows).toMatch(/\(row_payload\)\.rank IS NULL/)
    expect(rows).toMatch(/\(row_payload\)\.rank_change IS NULL/)
    expect(rows).toMatch(/\(row_payload\)\.is_new IS NULL/)
    expect(rows).toContain('batch_position >= 1 AND batch_position <= 1000')
  })

  it('forbids appending rows after their batch transaction commits', () => {
    expect(guard).not.toBe('')
    expect(guard).toContain('FROM new_stage_rows AS staged')
    expect(guard).toContain('batch.xmin::text::xid8')
    expect(guard).toContain('pg_catalog.pg_current_xact_id()')
    expect(guard).toContain('batch.staged_at IS DISTINCT FROM staged.staged_at')
    expect(sql).toContain('REFERENCING NEW TABLE AS new_stage_rows')
    expect(sql).toContain('FOR EACH STATEMENT')
    expect(sql).toContain('exact batch header from the current transaction')
  })

  it('defers completeness until it can rebind the entire typed batch', () => {
    expect(validator).not.toBe('')
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER leaderboard_rank_generation_stage_batches_complete'
    )
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(validator).toContain('v_header_xid IS DISTINCT FROM v_current_xid')
    expect(validator).toContain('FOR SHARE')
    expect(validator).toContain("v_head.phase NOT IN ('claimed', 'writing')")
    expect(validator).toContain('v_head.lease_expires_at <= v_now')
    expect(validator).toContain('arena.build_leaderboard_rank_generation_write_set_sha256_v1')
    expect(validator).toContain('NEW.batch_sha256_plan[NEW.batch_index + 1] IS DISTINCT FROM')
    expect(validator).toContain('v_expected_write_set IS DISTINCT FROM v_claim.write_set_sha256')
    expect(validator).toContain('prior.batch_sha256_plan IS DISTINCT FROM NEW.batch_sha256_plan')
    expect(validator).toContain('arena.build_leaderboard_rank_typed_batch_evidence_v1')
    expect(validator).toContain('arena.build_leaderboard_rank_typed_field_commitment_v1')
    expect(validator).toContain('v_chunk.identities IS DISTINCT FROM v_identities')
    expect(validator).toContain('v_chunk.field_commitments IS DISTINCT FROM v_field_commitments')
    expect(validator).toContain('v_prior_row_count IS DISTINCT FROM NEW.batch_index * 1000')
    expect(validator).toContain('stage batch identity range overlaps its predecessor')
  })

  it('makes both private relations update, delete, and truncate immutable', () => {
    for (const relation of [
      'arena.leaderboard_rank_generation_stage_batches',
      'arena.leaderboard_rank_generation_stage_rows',
    ]) {
      const escaped = relation.replace(/\./g, '\\.')
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE[\\s\\S]{0,160}ON ${escaped}`))
      expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE[\\s\\S]{0,160}ON ${escaped}`))
    }
    expect(
      sql.match(/reject_leaderboard_rank_publication_mutation\(\)/g)?.length
    ).toBeGreaterThanOrEqual(4)
  })

  it('pins the trigger bodies and exact catalog cardinalities', () => {
    expect(sha256(guard)).toBe('ba9030dfdd0431721903561fdfa02c106fcedc66cbb32ab20acf5ebd33958dc9')
    expect(sha256(validator)).toBe(
      '14063ba832d2bd0a5de0d5975eaf4ea8a68093e63b27f78107770cd8766184b0'
    )
    expect(sql).toContain('constraints %, indexes %, triggers %')
    expect(sql).toMatch(/\) <> 33 OR/)
    expect(sql).toMatch(/\) <> 5 OR/)
    expect(sql).toMatch(/\) <> 6 THEN/)
    expect(sql).toContain("'TimeZone=UTC'")
    expect(sql).toContain("'lock_timeout=10s'")
    expect(sql).toContain("trigger_row.tgnewtable = 'new_stage_rows'")
    expect(sql).toContain('trigger_row.tgdeferrable')
    expect(sql).toContain('trigger_row.tginitdeferred')
  })
})
