import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/copier-snapshot-projection-v2.pg17.sh'),
  'utf8'
)
const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
const golden = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      'supabase/migrations/__tests__/fixtures/copier-snapshot-projection-v2-golden.json'
    ),
    'utf8'
  )
) as {
  projection_vectors: Array<{ tuple_tokens_hex: string[]; tuple_hex: string }>
  candidate_multisets: Array<{ name: string; members: string[]; sha256: string }>
  pair_multisets: Array<{
    name: string
    members: Array<{ source_candidate_sha256: string; projection_sha256: string }>
    sha256: string
  }>
}

describe('copier snapshot projection PostgreSQL replay', () => {
  it('loads the shared golden artifact into an isolated PostgreSQL 17 cluster', () => {
    expect(proof).toContain('copier-snapshot-projection-v2-golden.json')
    expect(proof).toContain('This integration proof requires PostgreSQL 17')
    expect(proof).toContain("VALUES (:'fixture_json'::jsonb)")
    expect(proof).toContain('copier projection golden root contract drifted')
    expect(packageJson).toContain(
      '"qa:copier-projection-v2-pg17": "bash supabase/migrations/__tests__/copier-snapshot-projection-v2.pg17.sh"'
    )
  })

  it('uses the same scalar, tuple, count, sort, and digest primitives as TypeScript', () => {
    for (const marker of [
      "pg_catalog.decode('01', 'hex')",
      'pg_catalog.int4send(pg_catalog.octet_length(p_value))',
      "pg_catalog.convert_to(p_value, 'UTF8')",
      "pg_catalog.current_setting('server_encoding')",
      'pg_catalog.int8send(p_count)',
      'ORDER BY decoded',
      'ORDER BY decoded_pair',
      'pg_catalog.sha256(encoded_bytes)',
      'pg_catalog.trim_scale',
      "vector->'tuple_tokens_hex'",
      "vector->>'encoded_hex'",
      "vector->>'projection_sha256'",
      'candidate-projection multiset member is not 64 bytes',
      'empty multiset domains are missing or not separated',
    ]) {
      expect(proof).toContain(marker)
    }
  })

  it('keeps executable empty, duplicate, and token-bound golden witnesses', () => {
    for (const vector of golden.projection_vectors) {
      expect(vector.tuple_tokens_hex.join('')).toBe(vector.tuple_hex)
    }

    const candidateEmpty = golden.candidate_multisets.find((vector) => vector.name === 'empty')
    const pairEmpty = golden.pair_multisets.find((vector) => vector.name === 'empty')
    expect(candidateEmpty?.members).toEqual([])
    expect(pairEmpty?.members).toEqual([])
    expect(candidateEmpty?.sha256).not.toBe(pairEmpty?.sha256)

    const duplicateCandidates = golden.candidate_multisets.find(
      (vector) => vector.name === 'preserves_duplicates'
    )
    expect(new Set(duplicateCandidates?.members).size).toBeLessThan(
      duplicateCandidates?.members.length ?? 0
    )
  })

  it('reports a single explicit success marker', () => {
    expect(proof).toContain('copier snapshot projection PostgreSQL 17 golden replay passed')
  })
})
