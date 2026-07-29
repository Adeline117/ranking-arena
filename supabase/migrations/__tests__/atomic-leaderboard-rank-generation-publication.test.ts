import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260729054600_atomic_leaderboard_rank_generation_publication.sql'
  ),
  'utf8'
)

const sql = migration.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const functionBody = (name: string): string =>
  migration.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$body\\$([\\s\\S]*?)\\$body\\$;`
    )
  )?.[1] ?? ''

const stage = functionBody('stage_leaderboard_rank_generation_batch_v1')
const finalize = functionBody('finalize_leaderboard_rank_generation_v1')

describe('atomic leaderboard rank generation publication', () => {
  it('stages typed batches without mutating the live board or public proofs', () => {
    expect(stage).not.toBe('')
    expect(stage).toContain('arena.decode_leaderboard_rank_batch_rows_v1')
    expect(stage).toContain('arena.build_leaderboard_rank_typed_batch_evidence_v1')
    expect(stage).toContain('arena.leaderboard_rank_generation_stage_batches')
    expect(stage).toContain('arena.leaderboard_rank_generation_stage_rows')
    expect(stage).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.leaderboard_ranks/i)
    expect(stage).not.toContain('public.seal_leaderboard_rank_publication(')
    expect(stage).not.toContain('public.leaderboard_source_freshness')
  })

  it('binds batch zero to the verified scorer manifest and all attestation chunks', () => {
    expect(stage).toContain('arena.verify_leaderboard_score_input_manifest_v1')
    expect(stage).toContain('leaderboard-score-input-manifest-verification@1')
    expect(stage).toContain('arena.build_leaderboard_rank_manifest_field_commitment_v1')
    expect(stage).toContain('arena.build_leaderboard_rank_manifest_chunk_sha256_v1')
    expect(stage).toContain('arena.build_leaderboard_rank_manifest_chunks_sha256_v1')
    expect(stage).toContain('arena.leaderboard_rank_generation_manifest_bindings')
    expect(stage).toContain('arena.leaderboard_rank_generation_batch_receipts')
    expect(stage).toContain('arena.leaderboard_rank_manifest_attestations')
    expect(stage).toContain('arena.leaderboard_rank_manifest_attestation_chunks')
  })

  it('admits only a contiguous exact generation under the live lease', () => {
    expect(stage).toContain('v_head.phase IS DISTINCT FROM v_expected_phase')
    expect(stage).toContain('v_head.lease_expires_at <= v_staged_at')
    expect(stage).toContain('v_prior_batch_count IS DISTINCT FROM p_batch_index')
    expect(stage).toContain('v_prior_row_count IS DISTINCT FROM p_batch_index * 1000')
    expect(stage).toContain('p_batch_sha256_plan[p_batch_index + 1]')
    expect(stage).toContain('v_expected_write_set IS DISTINCT FROM v_claim.write_set_sha256')
    expect(stage).toContain('rank batch staging head compare-and-set failed')
  })

  it('validates the complete stage and source authority before the first live write', () => {
    expect(finalize).not.toBe('')
    const headLock = finalize.indexOf('FOR UPDATE')
    const manifest = finalize.indexOf('arena.verify_leaderboard_score_input_manifest_v1')
    const allBatches = finalize.indexOf(
      'v_stage_batch_count IS DISTINCT FROM v_claim.expected_batch_count'
    )
    const authority = finalize.indexOf('final publication sources do not exactly cover authority')
    const identities = finalize.indexOf('final publication identities do not exactly match stage')
    const firstLiveWrite = finalize.indexOf('INSERT INTO public.leaderboard_ranks')

    expect(headLock).toBeGreaterThan(-1)
    expect(manifest).toBeGreaterThan(headLock)
    expect(allBatches).toBeGreaterThan(manifest)
    expect(authority).toBeGreaterThan(allBatches)
    expect(identities).toBeGreaterThan(authority)
    expect(firstLiveWrite).toBeGreaterThan(identities)
    expect(finalize.slice(0, firstLiveWrite)).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.leaderboard_ranks/i
    )
  })

  it('cuts over live rows, cleanup, rerank, seal, and head phases in one RPC body', () => {
    const upsert = finalize.indexOf('INSERT INTO public.leaderboard_ranks')
    const cleanup = finalize.indexOf('public.cleanup_leaderboard_rank_publication(', upsert)
    const cleaned = finalize.indexOf("SET phase = 'cleaned'", cleanup)
    const rerank = finalize.indexOf('public.rerank_leaderboard_publication(', cleaned)
    const reranked = finalize.indexOf("SET phase = 'reranked'", rerank)
    const seal = finalize.indexOf('public.seal_leaderboard_rank_publication(', reranked)
    const sealed = finalize.indexOf("SET phase = 'sealed'", seal)

    expect(upsert).toBeGreaterThan(-1)
    expect(cleanup).toBeGreaterThan(upsert)
    expect(cleaned).toBeGreaterThan(cleanup)
    expect(rerank).toBeGreaterThan(cleaned)
    expect(reranked).toBeGreaterThan(rerank)
    expect(seal).toBeGreaterThan(reranked)
    expect(sealed).toBeGreaterThan(seal)
    expect(finalize).toContain('lease_expires_at = NULL')
    expect(finalize.match(/GET DIAGNOSTICS v_updated_count = ROW_COUNT/g)).toHaveLength(3)
  })

  it('fails closed on live-writer evidence and supports only sealed replay', () => {
    expect(finalize).toContain('leaderboard_rank_generation_source_fence_receipts')
    expect(finalize).toContain('active staged cohort already affected live publication state')
    expect(finalize).toContain("v_head.phase = 'sealed'")
    expect(finalize).toContain("'replayed', true")
    expect(finalize).toContain('The seal RPC revalidates')
  })

  it('closes both security-definer RPCs to service role', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\./g)).toHaveLength(2)
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(2)
    for (const name of [
      'stage_leaderboard_rank_generation_batch_v1',
      'finalize_leaderboard_rank_generation_v1',
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
  })
})
