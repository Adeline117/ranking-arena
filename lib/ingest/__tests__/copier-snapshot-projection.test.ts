import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  COPIER_SNAPSHOT_CANDIDATE_PROJECTION_FIXED_MULTISET_CONTRACT,
  COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT,
  COPIER_SNAPSHOT_MAX_DURATION_DAYS,
  COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT,
  COPIER_SNAPSHOT_PROJECTION_TUPLE_FIELDS,
  COPIER_SNAPSHOT_SOURCE_CANDIDATE_FIXED_MULTISET_CONTRACT,
  buildCopierSnapshotProjection,
  canonicalCopierSnapshotDecimal,
  copierSnapshotCandidateProjectionFixedMultisetSha256,
  copierSnapshotSourceCandidateFixedMultisetSha256,
  copierSnapshotProjectionSha256,
  encodeCopierSnapshotCandidateProjectionFixedMultiset,
  encodeCopierSnapshotNullableUtf8,
  encodeCopierSnapshotProjectionTuple,
  encodeCopierSnapshotSourceCandidateFixedMultiset,
  revalidateCopierSnapshotProjectionTuple,
} from '../copier-snapshot-projection'
import { strictCanonicalSha256 } from '../strict-canonical-json'

interface EncodingVector {
  name: string
  value: string | null
  utf8_hex: string | null
  token_hex: string
}

interface DecimalVector {
  input_js_number_text: string
  canonical_decimal: string
}

interface ProjectionVector {
  name: string
  tuple: unknown
  tuple_tokens_hex: string[]
  tuple_hex: string
  projection_sha256: string
}

interface CandidateMultisetVector {
  name: string
  members: string[]
  encoded_hex: string
  sha256: string
}

interface PairMultisetVector {
  name: string
  members: Array<{
    source_candidate_sha256: string
    projection_sha256: string
  }>
  encoded_hex: string
  sha256: string
}

interface GoldenFixture {
  contract: string
  projection_tuple_contract: string
  length_prefixed_utf8_contract: string
  source_candidate_fixed_multiset_contract: string
  candidate_projection_fixed_multiset_contract: string
  hash_algorithm: string
  encoding_spec: {
    null_token_hex: string
    nonnull_marker_hex: string
    length_bytes: number
    length_byte_order: string
    length_scope: string
    postgres_length_primitive: string
  }
  multiset_encoding_spec: {
    domain_token_contract: string
    count_bytes: number
    count_byte_order: string
    count_range: string
    postgres_count_primitive: string
    member_sort: string
    duplicates: string
  }
  tuple_field_order: string[]
  encoding_vectors: EncodingVector[]
  decimal_vectors: DecimalVector[]
  projection_vectors: ProjectionVector[]
  candidate_multisets: CandidateMultisetVector[]
  pair_multisets: PairMultisetVector[]
  invalid_vectors: {
    number_inputs: string[]
    decimal_text: string[]
    duration_text: string[]
    text_cases: string[]
    sha256_text: string[]
  }
}

const fixturePath = join(
  process.cwd(),
  'supabase/migrations/__tests__/fixtures/copier-snapshot-projection-v2-golden.json'
)
const golden = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFixture

function projectionVector(name: string): ProjectionVector {
  const vector = golden.projection_vectors.find((candidate) => candidate.name === name)
  if (!vector) throw new Error(`missing projection golden vector ${name}`)
  return vector
}

function tupleTokens(value: unknown): string[] {
  const tuple = revalidateCopierSnapshotProjectionTuple(value)
  return [
    tuple.contract,
    tuple.source_candidate_sha256,
    tuple.source_event_at,
    tuple.copier_label,
    tuple.copier_pnl,
    tuple.copier_invested,
    tuple.copy_duration_days,
    tuple.dedupe_hash,
  ].map((field) => encodeCopierSnapshotNullableUtf8(field).toString('hex'))
}

function tupleWith(overrides: Record<string, unknown>): Record<string, unknown> {
  const tuple = revalidateCopierSnapshotProjectionTuple(
    projectionVector('unicode_zero_and_positive_decimal').tuple
  )
  return { ...tuple, ...overrides }
}

describe('copier snapshot projection byte contract', () => {
  it('pins contracts, SQL primitives, and fixed tuple field order', () => {
    expect(golden).toMatchObject({
      contract: 'arena.ingest.copier-projection-v2-golden@2',
      projection_tuple_contract: COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT,
      length_prefixed_utf8_contract: COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT,
      source_candidate_fixed_multiset_contract:
        COPIER_SNAPSHOT_SOURCE_CANDIDATE_FIXED_MULTISET_CONTRACT,
      candidate_projection_fixed_multiset_contract:
        COPIER_SNAPSHOT_CANDIDATE_PROJECTION_FIXED_MULTISET_CONTRACT,
      hash_algorithm: 'sha256',
      encoding_spec: {
        null_token_hex: '00',
        nonnull_marker_hex: '01',
        length_bytes: 4,
        length_byte_order: 'big_endian',
        length_scope: 'utf8_value_bytes',
        postgres_length_primitive: 'pg_catalog.int4send(pg_catalog.octet_length(value))',
      },
      multiset_encoding_spec: {
        domain_token_contract: COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT,
        count_bytes: 8,
        count_byte_order: 'big_endian',
        count_range: 'nonnegative_postgresql_bigint',
        postgres_count_primitive: 'pg_catalog.int8send(count)',
        member_sort: 'decoded_bytea_ascending',
        duplicates: 'preserve_occurrences',
      },
    })
    expect(golden.tuple_field_order).toEqual(COPIER_SNAPSHOT_PROJECTION_TUPLE_FIELDS)
  })

  it.each(golden.encoding_vectors)(
    'matches the $name nullable UTF-8 token byte for byte',
    ({ value, utf8_hex: utf8Hex, token_hex: tokenHex }) => {
      expect(value === null ? null : Buffer.from(value, 'utf8').toString('hex')).toBe(utf8Hex)
      expect(encodeCopierSnapshotNullableUtf8(value).toString('hex')).toBe(tokenHex)
    }
  )

  it('distinguishes null from empty text before applying field-level nonempty rules', () => {
    const nullToken = encodeCopierSnapshotNullableUtf8(null)
    const emptyToken = encodeCopierSnapshotNullableUtf8('')

    expect(nullToken.toString('hex')).toBe('00')
    expect(emptyToken.toString('hex')).toBe('0100000000')
    expect(emptyToken.equals(nullToken)).toBe(false)
  })

  it.each(golden.decimal_vectors)(
    'normalizes $input_js_number_text to exponent-free decimal text',
    ({ input_js_number_text: input, canonical_decimal: expected }) => {
      expect(canonicalCopierSnapshotDecimal(Number(input))).toBe(expected)
      expect(expected).not.toMatch(/[eE+]/)
    }
  )

  it.each(golden.projection_vectors)(
    'recomputes the $name tuple and SHA without JSON serialization',
    (vector) => {
      const tuple = revalidateCopierSnapshotProjectionTuple(vector.tuple)
      const tokens = tupleTokens(tuple)
      const tupleBytes = encodeCopierSnapshotProjectionTuple(tuple)

      expect(Object.isFrozen(tuple)).toBe(true)
      expect(tokens).toEqual(vector.tuple_tokens_hex)
      expect(tokens.join('')).toBe(vector.tuple_hex)
      expect(tupleBytes.toString('hex')).toBe(vector.tuple_hex)
      expect(copierSnapshotProjectionSha256(tuple)).toBe(vector.projection_sha256)
    }
  )

  it('derives the source candidate SHA from exact row.raw bytes', () => {
    const firstRaw = { id: 'candidate-a', pnl: 1.25 }
    const secondRaw = { id: 'candidate-b', pnl: 1.25 }
    const row = {
      kind: 'copiers' as const,
      ts: '2026-08-04T00:00:00.000Z',
      copierLabel: 'private-a',
      copierPnl: 1.25,
      copierInvested: 100,
      copyDurationDays: 3,
      dedupeHash: 'row-a',
      raw: firstRaw,
    }
    const first = buildCopierSnapshotProjection(row)
    const second = buildCopierSnapshotProjection({ ...row, raw: secondRaw })

    expect(first.tuple.source_candidate_sha256).toBe(strictCanonicalSha256(firstRaw))
    expect(second.tuple.source_candidate_sha256).toBe(strictCanonicalSha256(secondRaw))
    expect(first.projectionSha256).not.toBe(second.projectionSha256)
    expect(first.tupleBytesHex).not.toBe(second.tupleBytesHex)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it('keeps source_event_at null and rejects shape or contract drift', () => {
    expect(() =>
      revalidateCopierSnapshotProjectionTuple(
        tupleWith({ source_event_at: '2026-08-04T00:00:00.000Z' })
      )
    ).toThrow('source_event_at must be null')
    expect(() =>
      revalidateCopierSnapshotProjectionTuple(tupleWith({ contract: 'future@2' }))
    ).toThrow('projection tuple contract is invalid')
    expect(() =>
      revalidateCopierSnapshotProjectionTuple({ ...tupleWith({}), extra: true })
    ).toThrow('exact contract fields')

    const missing = tupleWith({})
    delete missing.copier_pnl
    expect(() => revalidateCopierSnapshotProjectionTuple(missing)).toThrow('exact contract fields')
  })

  it('snapshots data properties and rejects accessors or hidden shape drift before hashing', () => {
    const accessor = tupleWith({})
    Object.defineProperty(accessor, 'copier_pnl', {
      enumerable: true,
      get: () => '1',
    })
    expect(() => encodeCopierSnapshotProjectionTuple(accessor)).toThrow('object accessors')

    const nonenumerable = tupleWith({})
    Object.defineProperty(nonenumerable, 'hidden', { enumerable: false, value: true })
    expect(() => copierSnapshotProjectionSha256(nonenumerable)).toThrow(
      'non-enumerable object properties'
    )

    const symbolKey = tupleWith({})
    Object.defineProperty(symbolKey, Symbol('hidden'), { enumerable: true, value: true })
    expect(() => revalidateCopierSnapshotProjectionTuple(symbolKey)).toThrow('symbol keys')
  })

  it('rejects mutable row accessors and caller-supplied source identity fields', () => {
    const row = {
      kind: 'copiers' as const,
      ts: '2026-08-04T00:00:00.000Z',
      copierLabel: null,
      copierPnl: 1,
      copierInvested: 1,
      copyDurationDays: 1,
      dedupeHash: 'row',
      raw: { id: 'candidate' },
    }
    const accessor = { ...row }
    Object.defineProperty(accessor, 'raw', {
      enumerable: true,
      get: () => ({ id: 'candidate' }),
    })
    expect(() => buildCopierSnapshotProjection(accessor)).toThrow('object accessors')
    expect(() =>
      buildCopierSnapshotProjection({
        ...row,
        sourceCandidateSha256: '11'.repeat(32),
      } as never)
    ).toThrow('exact contract fields')
  })

  it.each(golden.invalid_vectors.number_inputs)(
    'fails closed for unsafe JavaScript numeric input $numberText',
    (numberText) => {
      expect(() => canonicalCopierSnapshotDecimal(Number(numberText))).toThrow(
        'copier snapshot projection failed'
      )
    }
  )

  it.each(golden.invalid_vectors.decimal_text)(
    'rejects noncanonical decimal tuple text $decimalText',
    (decimalText) => {
      expect(() =>
        revalidateCopierSnapshotProjectionTuple(tupleWith({ copier_pnl: decimalText }))
      ).toThrow('copier snapshot projection failed')
    }
  )

  it.each(golden.invalid_vectors.duration_text)(
    'rejects noncanonical or out-of-range duration text $durationText',
    (durationText) => {
      expect(() =>
        revalidateCopierSnapshotProjectionTuple(tupleWith({ copy_duration_days: durationText }))
      ).toThrow('copier snapshot projection failed')
    }
  )

  it('rejects negative invested capital and invalid numeric row values', () => {
    const row = {
      kind: 'copiers' as const,
      ts: '2026-08-04T00:00:00.000Z',
      copierLabel: null,
      copierPnl: 1,
      copierInvested: 1,
      copyDurationDays: 1,
      dedupeHash: 'row',
      raw: { id: 'candidate' },
    }
    const build = (overrides: Partial<typeof row>) =>
      buildCopierSnapshotProjection({ ...row, ...overrides })

    expect(() => build({ copierInvested: -1 })).toThrow('copier_invested must be nonnegative')
    expect(() => build({ copierPnl: -0 })).toThrow('negative zero')
    expect(() => build({ copierPnl: Number.NaN })).toThrow('non-finite numbers')
    expect(() => build({ copierPnl: Number.POSITIVE_INFINITY })).toThrow('non-finite numbers')
    expect(() => build({ copierPnl: Number.MAX_SAFE_INTEGER + 1 })).toThrow('safe precision')
    expect(() => build({ copyDurationDays: -0 })).toThrow('negative zero')
    expect(() => build({ copyDurationDays: -1 })).toThrow('PostgreSQL integer')
    expect(() => build({ copyDurationDays: 1.5 })).toThrow('PostgreSQL integer')
    expect(() => build({ copyDurationDays: COPIER_SNAPSHOT_MAX_DURATION_DAYS + 1 })).toThrow(
      'PostgreSQL integer'
    )
    expect(() => build({ copyDurationDays: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      'PostgreSQL integer'
    )
  })

  it('preserves distinct valid Unicode spellings instead of silently normalizing labels', () => {
    const precomposed = revalidateCopierSnapshotProjectionTuple(
      tupleWith({ copier_label: '\u00e9' })
    )
    const decomposed = revalidateCopierSnapshotProjectionTuple(
      tupleWith({ copier_label: 'e\u0301' })
    )

    expect(precomposed.copier_label?.normalize('NFC')).toBe(
      decomposed.copier_label?.normalize('NFC')
    )
    expect(
      encodeCopierSnapshotProjectionTuple(precomposed).equals(
        encodeCopierSnapshotProjectionTuple(decomposed)
      )
    ).toBe(false)
    expect(copierSnapshotProjectionSha256(precomposed)).not.toBe(
      copierSnapshotProjectionSha256(decomposed)
    )
  })

  it('rejects empty, untrimmed, invalid Unicode, and oversized text', () => {
    const invalidText = ['', ' leading', 'trailing ', '\u0000', '\ud800', 'x'.repeat(513)]
    expect(golden.invalid_vectors.text_cases).toEqual([
      'empty',
      'surrounding_whitespace',
      'u0000',
      'isolated_surrogate',
      'over_512_code_points',
    ])

    for (const value of invalidText) {
      expect(() =>
        revalidateCopierSnapshotProjectionTuple(tupleWith({ copier_label: value }))
      ).toThrow('copier snapshot projection failed')
      expect(() =>
        revalidateCopierSnapshotProjectionTuple(tupleWith({ dedupe_hash: value }))
      ).toThrow('copier snapshot projection failed')
    }
    expect(encodeCopierSnapshotNullableUtf8('e\u0301').toString('hex')).toBe('010000000365cc81')
    expect(() => encodeCopierSnapshotNullableUtf8('\ud800')).toThrow('isolated Unicode')
  })

  it.each(golden.invalid_vectors.sha256_text)(
    'rejects invalid candidate SHA text %#',
    (candidateSha256) => {
      expect(() =>
        revalidateCopierSnapshotProjectionTuple(
          tupleWith({ source_candidate_sha256: candidateSha256 })
        )
      ).toThrow('lowercase SHA-256')
    }
  )
})

describe('copier snapshot projection multiset digests', () => {
  it('domain-separates even true-empty candidate and candidate-projection multisets', () => {
    const candidates = encodeCopierSnapshotSourceCandidateFixedMultiset([])
    const pairs = encodeCopierSnapshotCandidateProjectionFixedMultiset([])

    expect(candidates.byteLength).toBeGreaterThan(8)
    expect(pairs.byteLength).toBeGreaterThan(8)
    expect(candidates.equals(pairs)).toBe(false)
    expect(copierSnapshotSourceCandidateFixedMultisetSha256([])).not.toBe(
      copierSnapshotCandidateProjectionFixedMultisetSha256([])
    )
  })

  it.each(golden.candidate_multisets)(
    'recomputes candidate multiset $name with fixed decoded bytes',
    ({ members, encoded_hex: encodedHex, sha256 }) => {
      expect(encodeCopierSnapshotSourceCandidateFixedMultiset(members).toString('hex')).toBe(
        encodedHex
      )
      expect(copierSnapshotSourceCandidateFixedMultisetSha256(members)).toBe(sha256)
      expect(copierSnapshotSourceCandidateFixedMultisetSha256([...members].reverse())).toBe(sha256)
    }
  )

  it.each(golden.pair_multisets)(
    'recomputes candidate-to-projection multiset $name with fixed pair bytes',
    ({ members, encoded_hex: encodedHex, sha256 }) => {
      expect(encodeCopierSnapshotCandidateProjectionFixedMultiset(members).toString('hex')).toBe(
        encodedHex
      )
      expect(copierSnapshotCandidateProjectionFixedMultisetSha256(members)).toBe(sha256)
      expect(copierSnapshotCandidateProjectionFixedMultisetSha256([...members].reverse())).toBe(
        sha256
      )
    }
  )

  it('retains duplicate occurrences instead of collapsing to a set', () => {
    const candidate = 'ab'.repeat(32)
    const projection = 'cd'.repeat(32)

    expect(copierSnapshotSourceCandidateFixedMultisetSha256([candidate])).not.toBe(
      copierSnapshotSourceCandidateFixedMultisetSha256([candidate, candidate])
    )
    expect(
      copierSnapshotCandidateProjectionFixedMultisetSha256([
        { source_candidate_sha256: candidate, projection_sha256: projection },
      ])
    ).not.toBe(
      copierSnapshotCandidateProjectionFixedMultisetSha256([
        { source_candidate_sha256: candidate, projection_sha256: projection },
        { source_candidate_sha256: candidate, projection_sha256: projection },
      ])
    )
  })

  it('rejects malformed digest members and pair shape drift', () => {
    expect(() => encodeCopierSnapshotSourceCandidateFixedMultiset(['ABC'])).toThrow(
      'lowercase SHA-256'
    )
    expect(() =>
      encodeCopierSnapshotCandidateProjectionFixedMultiset([
        { source_candidate_sha256: '11'.repeat(32), projection_sha256: 'nope' },
      ])
    ).toThrow('lowercase SHA-256')
    expect(() =>
      encodeCopierSnapshotCandidateProjectionFixedMultiset([
        {
          source_candidate_sha256: '11'.repeat(32),
          projection_sha256: '22'.repeat(32),
          extra: true,
        } as never,
      ])
    ).toThrow('exact contract fields')

    const accessorPair = {
      source_candidate_sha256: '11'.repeat(32),
      projection_sha256: '22'.repeat(32),
    }
    Object.defineProperty(accessorPair, 'projection_sha256', {
      enumerable: true,
      get: () => '22'.repeat(32),
    })
    expect(() => encodeCopierSnapshotCandidateProjectionFixedMultiset([accessorPair])).toThrow(
      'object accessors'
    )

    const accessorCandidates = ['11'.repeat(32)]
    Object.defineProperty(accessorCandidates, '0', {
      enumerable: true,
      get: () => '11'.repeat(32),
    })
    expect(() => encodeCopierSnapshotSourceCandidateFixedMultiset(accessorCandidates)).toThrow(
      'array accessors'
    )
  })
})
