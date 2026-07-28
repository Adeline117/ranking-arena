import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260725016000_leaderboard_rank_generation_receipt_substrate.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-generation-receipt-substrate.pg17.sh'
  ),
  'utf8'
)

describe('leaderboard rank generation receipt substrate', () => {
  it('binds one claim to one exact manifest identity, digest, and period', () => {
    expect(migration).toContain('CREATE TABLE arena.leaderboard_rank_generation_manifest_bindings')
    expect(migration).toContain('FOREIGN KEY (season_id, generation_seq, score_cohort_id)')
    expect(migration).toContain('validate_leaderboard_rank_generation_manifest_binding()')
    expect(migration).toContain('FOR SHARE')
    expect(migration).toContain("(v_manifest - 'manifestDigest')::text")
    expect(migration).toContain('generation manifest binding requires a live manifest')
    expect(migration).not.toContain('rank_generation_manifest_binding_manifest_fkey')
    expect(migration).toContain('rank_generation_batch_receipt_binding_fkey')
    expect(pg17Proof).toContain('manifest binding accepted a cross-manifest digest')
    expect(pg17Proof).toContain('manifest binding accepted a cross-period manifest')
    expect(pg17Proof).toContain('manifest binding accepted content outside its digest')
    expect(pg17Proof).toContain('manifest binding accepted an expired manifest')
    expect(pg17Proof).toContain('manifest payload delete bypassed binding lock')
    expect(pg17Proof).toContain('manifest pruning removed compact generation evidence')
    expect(pg17Proof).toContain('batch accepted a different valid generation manifest')
  })

  it('installs bounded C-collated write-phase batch and source fence receipts', () => {
    expect(migration).toContain('CREATE TABLE arena.leaderboard_rank_generation_batch_receipts')
    expect(migration).toContain(
      'CREATE TABLE arena.leaderboard_rank_generation_source_fence_receipts'
    )
    expect(migration.match(/COLLATE pg_catalog\."C"/g)).toHaveLength(5)
    expect(migration).toContain('CHECK (batch_index >= 0 AND batch_index < 4096)')
    expect(migration).toContain('CHECK (row_count > 0 AND row_count <= 1000)')
    expect(migration).toContain('pg_catalog.char_length(first_source_trader_id) <= 512')
    expect(migration).toContain('pg_catalog.char_length(source) <= 128')
    expect(migration).toContain('mutation_seq_after - mutation_seq_before IN (1, 2)')
    expect(migration).toContain('rank_generation_source_fence_receipt_fence_fkey')
    expect(migration).not.toContain('source_fence_receipt_authority_fkey')
  })

  it('states the dormant boundary and never exposes or mutates leaderboard ranks', () => {
    expect(migration).toContain('This substrate authorizes no leaderboard DML')
    expect(migration).toContain('write-phase audit records')
    expect(migration).toContain('never terminal publication proof')
    expect(migration).toContain('Not source authority')
    expect(migration).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./)
    expect(migration).not.toMatch(/GRANT\s+EXECUTE/i)
    expect(migration).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM)\s+public\.leaderboard_ranks/i
    )
    expect(migration).not.toMatch(/ON\s+DELETE\s+CASCADE/i)
  })

  it('is owner-only, RLS protected, immutable, and sequence-free', () => {
    expect(migration.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(3)
    expect(migration.match(/OWNER TO postgres/g)).toHaveLength(4)
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(3)
    expect(migration.match(/BEFORE TRUNCATE/g)).toHaveLength(3)
    expect(
      migration.match(/reject_leaderboard_rank_publication_mutation\(\)/g).length
    ).toBeGreaterThanOrEqual(8)
    expect(migration).toContain('generation receipt substrate created an implicit sequence')
    expect(migration).not.toMatch(/\bserial\b/i)
    expect(migration).not.toMatch(/GENERATED\s+(?:ALWAYS|BY DEFAULT)\s+AS IDENTITY/i)
  })

  it('fails closed on partial install, catalog drift, and replay mutation', () => {
    expect(migration).toContain(
      'leaderboard generation receipt objects are only partially installed'
    )
    expect(migration).toContain('generation receipt object identity postflight failed')
    expect(migration).toContain('function_row.proargnames = ARRAY[')
    expect(migration).toContain("'service_role', v_claim_function, 'EXECUTE'")
    expect(migration).toContain('AND function_row.oid IS DISTINCT FROM v_claim_function')
    expect(pg17Proof).toContain('receipt migration accepted anon claim execute')
    expect(pg17Proof).toContain('receipt migration accepted a parent column grant')
    expect(pg17Proof).toContain('receipt migration accepted a hostile fence default')
    expect(pg17Proof).toContain('receipt migration accepted a cascading generation-head FK')
    expect(migration).toContain('f8d3d164f4385f81dfe942b3d0fe85cfe3207e3783e6fc51f5705ee3ef319926')
    expect(migration).toContain('0000a4d62237d0cd9a65f388cbca4c83b7a8795e435a91f38abd3e1df000c89f')
    expect(migration).not.toMatch(/__[A-Z0-9_]+__/)
    expect(pg17Proof).toContain(
      'receipt replay changed object identity, physical rows, or sequences'
    )
    expect(pg17Proof).toContain('receipt replay silently repaired a rogue grant')
    expect(pg17Proof).toContain('receipt replay accepted a validator function grant')
    expect(pg17Proof).toContain('receipt replay accepted a disabled manifest validator')
    expect(pg17Proof).toContain('receipt replay accepted a column-restricted immutable trigger')
    expect(pg17Proof).toContain('receipt replay accepted a disabled FK trigger')
  })

  it('has one outer transaction and no converging same-name table DDL', () => {
    expect(migration.trimStart().startsWith('-- Dormant owner-only')).toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).not.toMatch(/CREATE TABLE IF NOT EXISTS/i)
    expect(migration).not.toMatch(/DROP TABLE/i)
    expect(migration).not.toMatch(/DROP CONSTRAINT/i)
  })
})
