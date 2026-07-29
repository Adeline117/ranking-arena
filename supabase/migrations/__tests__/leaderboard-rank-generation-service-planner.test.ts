import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260729054500_leaderboard_rank_generation_service_planner.sql'
  ),
  'utf8'
)

const sql = migration.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('leaderboard rank generation service planner', () => {
  it('adds planning authority without touching live ranks or generation heads', () => {
    expect(sql).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(?:ONLY\s+)?public\.leaderboard_ranks/i
    )
    expect(sql).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(?:ONLY\s+)?arena\.leaderboard_rank_generation_heads/i
    )
    expect(migration).toContain('These RPCs do not mutate leaderboard_ranks or generation heads')
  })

  it('strictly decodes the complete typed row object and bytewise order', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION arena.decode_leaderboard_rank_batch_rows_v1'
    )
    expect(migration).toContain('pg_catalog.jsonb_array_length(p_rows) > 1000')
    expect(migration).toContain(') > 67108864')
    expect(migration).toContain('NOT item.value ?& ARRAY[')
    expect(migration).toContain(') <> 33')
    expect(migration).toContain('NULL::arena.leaderboard_rank_batch_row_v1')
    expect(migration).toContain('rank batch identities are not in strict bytewise order')
    expect(migration).toContain('COLLATE pg_catalog."C"')
  })

  it('uses the private PG17 scorer and canonical evidence builders as authorities', () => {
    expect(migration).toContain('arena.seal_leaderboard_score_input_manifest_v1(')
    expect(migration).toContain('arena.build_leaderboard_rank_typed_batch_evidence_v1(')
    expect(migration).toContain('arena.build_leaderboard_rank_generation_write_set_sha256_v1(')
    expect(migration).toContain("'leaderboard-rank-generation-write-set-plan@1'")
  })

  it('exposes only the three exact service-role RPCs', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\./g)).toHaveLength(3)
    for (const name of [
      'prepare_leaderboard_score_input_manifest_v1',
      'plan_leaderboard_rank_generation_batch_v1',
      'plan_leaderboard_rank_generation_write_set_v1',
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role;`
        )
      )
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?TO service_role;`)
      )
    }
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.decode_leaderboard_rank_batch_rows_v1\(jsonb\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    )
  })

  it('pins security-definer search paths and reloads PostgREST', () => {
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(3)
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)?.length).toBeGreaterThanOrEqual(4)
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
