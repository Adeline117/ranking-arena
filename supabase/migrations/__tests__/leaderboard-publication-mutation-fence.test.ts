import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260724235000_leaderboard_publication_mutation_fence.sql'
  ),
  'utf8'
)

function functionBody(name: string): string {
  return (
    migration.match(
      new RegExp(
        `CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}` +
          String.raw`\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;`
      )
    )?.[1] ?? ''
  )
}

const sealBody = functionBody('public.seal_leaderboard_rank_publication')
const proofBody = functionBody('public.arena_leaderboard_publication_proofs')
const guardBody = functionBody('arena.guard_leaderboard_source_freshness_seal')
const eligibilityBody = functionBody('arena.leaderboard_rank_row_is_public_eligible')

describe('leaderboard publication mutation fence migration', () => {
  it('expands nullable proof state without inventing a seal for legacy rows', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS score_cohort_id uuid')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rank_mutation_seq bigint')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS published_rank_count integer')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS published_identity_sha256 text')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rank_publication_id uuid')
    expect(migration).toContain('leaderboard_source_freshness_proof_tuple_check')
    expect(migration).toContain('FOREIGN KEY (score_cohort_id, season_id)')
    expect(migration).not.toMatch(
      /UPDATE\s+public\.leaderboard_source_freshness[\s\S]*rank_mutation_seq\s*=/i
    )
  })

  it('keeps legacy freshness upserts rollout-compatible but strips every old seal', () => {
    expect(guardBody).not.toBe('')
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE\s+ON public\.leaderboard_source_freshness TO service_role;/
    )
    expect(guardBody).toContain("'arena.leaderboard_seal_cohort'")
    expect(guardBody).toContain('NEW.source_as_of < OLD.source_as_of')
    expect(guardBody).toContain('NEW.score_cohort_id IS NOT DISTINCT FROM OLD.score_cohort_id')
    expect(guardBody).toMatch(/NEW\.score_cohort_id := NULL;[\s\S]*NEW\.rank_mutation_seq := NULL;/)
    expect(guardBody).toContain('arena.leaderboard_rank_publications')
    expect(guardBody).toContain('audit.proof = v_exact_proof')
  })

  it('advances one ordered durable fence for every parent DML statement', () => {
    expect(migration).toMatch(
      /AFTER INSERT ON public\.leaderboard_ranks\s+REFERENCING NEW TABLE AS new_rank_rows\s+FOR EACH STATEMENT/
    )
    expect(migration).toMatch(
      /AFTER UPDATE ON public\.leaderboard_ranks\s+REFERENCING OLD TABLE AS old_rank_rows NEW TABLE AS new_rank_rows\s+FOR EACH STATEMENT/
    )
    expect(migration).toMatch(
      /AFTER DELETE ON public\.leaderboard_ranks\s+REFERENCING OLD TABLE AS old_rank_rows\s+FOR EACH STATEMENT/
    )
    expect(
      migration.match(/mutation_seq = arena\.leaderboard_rank_mutation_fences\.mutation_seq \+ 1/g)
    ).toHaveLength(3)
    expect(migration.match(/ORDER BY changed\.season_id, changed\.source/g)).toHaveLength(3)
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %s'
    )
  })

  it('validates canonical bounded authority input before the receipt replay lookup', () => {
    expect(sealBody).not.toBe('')
    expect(sealBody).toContain('pg_catalog.jsonb_array_length(p_source_publications) > 256')
    expect(sealBody).toContain('publication exceeds 250000 trader identities')
    expect(sealBody).toContain('source publication request exceeds 64 MiB')
    expect(sealBody).toContain('public.arena_freshness_expected_sources()')
    expect(sealBody).toContain('v_canonical_sources')
    expect(sealBody).toContain('identity.value COLLATE "C"')
    expect(sealBody.indexOf('v_request_sha256 :=')).toBeLessThan(
      sealBody.indexOf('SELECT publication.*')
    )
    expect(sealBody).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(sealBody).toContain('LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE')
    expect(sealBody).toContain('LOCK TABLE public.leaderboard_ranks IN SHARE MODE')
    expect(
      sealBody.indexOf('LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE')
    ).toBeLessThan(sealBody.indexOf('LOCK TABLE public.leaderboard_ranks IN SHARE MODE'))
    expect(sealBody.indexOf('LOCK TABLE public.leaderboard_ranks IN SHARE MODE')).toBeLessThan(
      sealBody.indexOf('SELECT publication.*')
    )
  })

  it('locks every source before all mutable-state checks', () => {
    const fenceLock = sealBody.indexOf('FOR UPDATE;')
    const watermarkCheck = sealBody.indexOf('publication cannot regress a source watermark')
    const cohortCheck = sealBody.indexOf(
      'leaderboard rows were not fully written by the score cohort'
    )
    const eligibilityCheck = sealBody.indexOf(
      'leaderboard publication contains a non-rank-eligible row'
    )
    const rankOrderCheck = sealBody.indexOf('leaderboard publication rank order is not current')
    const membershipCheck = sealBody.indexOf(
      'published trader identities do not match leaderboard rows'
    )

    expect(fenceLock).toBeGreaterThan(-1)
    for (const check of [
      watermarkCheck,
      cohortCheck,
      eligibilityCheck,
      rankOrderCheck,
      membershipCheck,
    ]) {
      expect(check).toBeGreaterThan(fenceLock)
    }
    expect(sealBody).toMatch(/SELECT expected\.source[\s\S]*EXCEPT[\s\S]*SELECT actual\.source/)
    expect(sealBody).toMatch(/SELECT actual\.source[\s\S]*EXCEPT[\s\S]*SELECT expected\.source/)
  })

  it('seals only full, concrete, non-outlier positive-score rows', () => {
    expect(eligibilityBody).not.toBe('')
    for (const predicate of [
      "(p_rank).score_completeness IS NOT DISTINCT FROM 'full'",
      '(p_rank).metrics_estimated IS NOT DISTINCT FROM false',
      '(p_rank).is_outlier IS NOT TRUE',
      '(p_rank).arena_score > 0',
      '(p_rank).pnl IS NOT NULL',
      '(p_rank).win_rate IS NOT NULL',
      '(p_rank).max_drawdown < 100',
      '(p_rank).computed_at IS NOT NULL',
      "p_observed_at - interval '48 hours'",
      "p_observed_at + interval '5 minutes'",
    ]) {
      expect(eligibilityBody).toContain(predicate)
    }
    expect(sealBody).toContain('arena.leaderboard_rank_row_is_public_eligible(')
    expect(proofBody).toContain('arena.leaderboard_rank_row_is_public_eligible(')
  })

  it('recomputes deterministic season-global rank order for seal, replay, and proof', () => {
    for (const body of [sealBody, proofBody]) {
      expect(body).toContain('pg_catalog.row_number() OVER (')
      expect(body).toContain('ORDER BY ranks.arena_score DESC NULLS LAST, ranks.id')
      expect(body).toContain('ranks.rank::bigint IS DISTINCT FROM ordered.expected_rank')
      expect(body).toContain('rank_authority ON rank_authority.source = ranks.source')
    }
    expect(sealBody.match(/pg_catalog\.row_number\(\) OVER \(/g)).toHaveLength(2)
    expect(proofBody).not.toMatch(
      /ranks\.source = freshness\.source[\s\S]{0,200}ranks\.rank::bigint IS DISTINCT FROM ordered\.expected_rank/
    )
  })

  it('writes the immutable receipt before moving freshness pointers', () => {
    const receiptWrite = sealBody.indexOf('INSERT INTO arena.leaderboard_rank_publications')
    const markerWrite = sealBody.indexOf("'arena.leaderboard_seal_cohort'")
    const freshnessWrite = sealBody.indexOf('INSERT INTO public.leaderboard_source_freshness')

    expect(receiptWrite).toBeGreaterThan(-1)
    expect(markerWrite).toBeGreaterThan(receiptWrite)
    expect(freshnessWrite).toBeGreaterThan(markerWrite)
    expect(sealBody).toContain('rank_mutation_seq = EXCLUDED.rank_mutation_seq')
    expect(sealBody).toContain('score_cohort_id = EXCLUDED.score_cohort_id')
    expect(sealBody).toContain(
      'WHERE EXCLUDED.source_as_of\n        >= public.leaderboard_source_freshness.source_as_of'
    )
    expect(migration).toContain('leaderboard_rank_publication_immutable')
  })

  it('replays only a still-current canonical cohort receipt', () => {
    expect(sealBody).toContain("'contract', 'leaderboard-rank-publication@1'")
    expect(sealBody).toContain('v_existing.request_sha256 IS DISTINCT FROM v_request_sha256')
    expect(sealBody).toContain('score cohort id was reused with different publication input')
    expect(sealBody).toContain('score cohort receipt is no longer the current sealed publication')
    expect(sealBody).toContain('freshness.rank_mutation_seq IS DISTINCT FROM')
    expect(sealBody).toContain('ranks.rank_publication_id IS DISTINCT FROM v_existing.id')
    expect(sealBody).toMatch(
      /ranks\.rank_publication_id IS DISTINCT FROM v_existing\.id[\s\S]*leaderboard_rank_row_is_public_eligible/
    )
  })

  it('anchors proof truth to the receipt, fence, exact count, token, and eligibility', () => {
    expect(proofBody).not.toBe('')
    expect(proofBody).toContain('publication.id IS NOT NULL')
    expect(proofBody).toContain('audit.proof = pg_catalog.jsonb_build_object')
    expect(proofBody).toContain('freshness.rank_mutation_seq = COALESCE(fence.mutation_seq, 0)')
    expect(proofBody).toContain('freshness.published_rank_count = (')
    expect(proofBody).toContain('FROM rank_authority')
    expect(proofBody).toContain('rank_authority.source = freshness.source')
    expect(proofBody).toContain(
      'ranks.rank_publication_id IS DISTINCT FROM freshness.score_cohort_id'
    )
    expect(proofBody).toMatch(/COALESCE\([\s\S]*false\) AS is_sealed/)
  })

  it('uses owner-held definers and complete expand-phase ACL postflight', () => {
    expect(migration).toContain(
      'ALTER FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb)'
    )
    expect(migration).toContain('OWNER TO postgres;')
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION public\.seal_leaderboard_rank_publication\(text, uuid, jsonb\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.arena_leaderboard_publication_proofs\(text, text\[\]\)\s+TO service_role;/
    )
    expect(migration).toContain("'TRUNCATE,REFERENCES,TRIGGER'")
    expect(migration).toContain("procedure.proowner <> 'postgres'::regrole")
    expect(migration).toContain(
      'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)'
    )
    expect(migration).toContain("procedure.provolatile <> 'i'")
    expect(sealBody).not.toContain('SET statement_timeout')
    expect(proofBody).not.toContain('SET statement_timeout')
    expect(migration).toContain('Callers must enforce the RPC request deadline')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
