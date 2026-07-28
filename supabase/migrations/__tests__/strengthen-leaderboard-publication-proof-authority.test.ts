import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260725014000_strengthen_leaderboard_publication_proof_authority.sql'
  ),
  'utf8'
)

const proofBody =
  migration.match(
    /CREATE OR REPLACE FUNCTION public\.arena_leaderboard_publication_proofs\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
  )?.[1] ?? ''

describe('leaderboard publication proof full-authority strengthening', () => {
  it('is a forward replacement of the one exact STABLE proof callable', () => {
    expect(proofBody).not.toBe('')
    expect(migration).toContain(
      "pg_catalog.to_regprocedure(\n    'public.arena_leaderboard_publication_proofs(text,text[])'"
    )
    expect(migration).toContain("function_row.provolatile = 's'")
    expect(migration).toContain('function_row.prosecdef')
    expect(migration).toContain("function_row.proowner = 'postgres'::pg_catalog.regrole")
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]")
    expect(migration).toContain("function_row.proname = 'arena_leaderboard_publication_proofs'")
    expect(migration).toContain('unsupported overload')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('preserves the exact ten-column proof return schema', () => {
    for (const declaration of [
      'season_id text',
      'source text',
      'source_as_of timestamptz',
      'recorded_at timestamptz',
      'score_cohort_id uuid',
      'rank_mutation_seq bigint',
      'current_mutation_seq bigint',
      'published_rank_count integer',
      'published_identity_sha256 text',
      'is_sealed boolean',
    ]) {
      expect(migration).toContain(declaration)
    }
    expect(migration).toContain("function_row.prorettype = 'pg_catalog.record'::pg_catalog.regtype")
    expect(migration).toContain('function_row.proretset')
    expect(migration).toContain('function_row.proallargtypes = ARRAY[')
    expect(migration).toContain('function_row.proargmodes = ARRAY[')
    expect(migration).toContain('function_row.proargnames = ARRAY[')
  })

  it('strictly bounds and canonicalizes the requested source array', () => {
    expect(proofBody).toContain('pg_catalog.array_ndims(p_sources) IS DISTINCT FROM 1')
    expect(proofBody).toContain('pg_catalog.array_lower(p_sources, 1) IS DISTINCT FROM 1')
    expect(proofBody).toContain('pg_catalog.cardinality(p_sources) < 1')
    expect(proofBody).toContain('pg_catalog.cardinality(p_sources) > 256')
    expect(proofBody).toContain('pg_catalog.char_length(requested.value) > 128')
    expect(proofBody).toContain("!~ '^[a-z0-9]+(_[a-z0-9]+)*$'")
    expect(proofBody).toContain('pg_catalog.count(DISTINCT requested.value COLLATE "C")')
    expect(proofBody).toContain("pg_catalog.convert_to(requested.value, 'UTF8')")
    expect(proofBody).toContain(') > 65536')
    expect(proofBody).toContain("USING ERRCODE = '22023'")
  })

  it('materializes the distinct complete authority exactly once', () => {
    expect(proofBody.match(/public\.arena_freshness_expected_sources\(\)/g)).toHaveLength(1)
    expect(proofBody).toContain('SELECT DISTINCT authority.filter_source COLLATE "C" AS source')
    expect(proofBody).toContain('INTO v_authority_sources')
    expect(proofBody).toContain('ORDER BY authority_source.source COLLATE "C"')
    expect(proofBody).toContain('v_authority_count < 1')
    expect(proofBody).toContain('v_authority_count > 256')
    expect(proofBody).toContain('pg_catalog.char_length(authority.source) > 128')
  })

  it('requires bidirectional set equality before reading proof state', () => {
    const firstExcept = proofBody.indexOf('EXCEPT')
    const secondExcept = proofBody.indexOf('EXCEPT', firstExcept + 1)
    const proofQuery = proofBody.indexOf('RETURN QUERY')

    expect(firstExcept).toBeGreaterThan(-1)
    expect(secondExcept).toBeGreaterThan(firstExcept)
    expect(secondExcept).toBeLessThan(proofQuery)
    expect(proofBody).toContain('proof sources do not exactly match the season authority')
    expect(proofBody.slice(proofQuery)).not.toContain('p_sources')
    expect(proofBody.slice(proofQuery)).not.toContain('arena_freshness_expected_sources()')
  })

  it('uses only frozen authority rows in canonical order for all later proofs', () => {
    const proofQuery = proofBody.slice(proofBody.indexOf('RETURN QUERY'))
    expect(proofQuery).toContain('WITH rank_authority AS MATERIALIZED')
    expect(proofQuery).toContain('pg_catalog.unnest(v_authority_sources) AS authority(source)')
    expect(proofQuery).toContain('JOIN rank_authority ON rank_authority.source = ranks.source')
    expect(proofQuery).toContain('FROM rank_authority AS requested')
    expect(proofQuery).toContain('ORDER BY requested.source COLLATE "C"')
  })

  it('retains receipt, fence, count, cohort, eligibility, and global-rerank proof gates', () => {
    for (const predicate of [
      'publication.id IS NOT NULL',
      'publication.source_count =',
      'pg_catalog.jsonb_array_length(publication.proofs)',
      'publication.source_count = v_authority_count',
      "rank_authority.source = audit.proof->>'source'",
      'freshness.rank_mutation_seq = COALESCE(fence.mutation_seq, 0)',
      'freshness.published_rank_count = (',
      'ranks.rank_publication_id IS DISTINCT FROM freshness.score_cohort_id',
      'arena.leaderboard_rank_row_is_public_eligible(',
      'pg_catalog.row_number() OVER (',
      'ORDER BY ranks.arena_score DESC NULLS LAST, ranks.id',
      'ranks.rank::bigint IS DISTINCT FROM ordered.expected_rank',
      'COALESCE((',
      'false) AS is_sealed',
    ]) {
      expect(proofBody).toContain(predicate)
    }
  })

  it('converges arbitrary historical EXECUTE ACLs to owner plus service role', () => {
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('expanded.grantee <> function_row.proowner')
    expect(migration).toContain("expanded.grantee <> 'service_role'::pg_catalog.regrole")
    expect(migration).toContain('FROM PUBLIC CASCADE')
    expect(migration).toContain('FROM %I CASCADE')
    expect(migration).toContain('REVOKE GRANT OPTION FOR EXECUTE')
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.arena_leaderboard_publication_proofs\(text, text\[\]\)\s+TO service_role;/
    )
    expect(migration).toContain('expanded.is_grantable')
    expect(migration).toContain('leaderboard publication proof EXECUTE ACL is not a closed set')
  })
})
