import { createHash } from 'node:crypto'

import type { ParsedCopierRow } from './core/types'

export const COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT =
  'arena.ingest.copier-projection-tuple@1' as const
export const COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT =
  'arena.ingest.length-prefixed-utf8.uint32be@1' as const
export const COPIER_SNAPSHOT_CANDIDATE_MULTISET_CONTRACT =
  'arena.ingest.copier-candidate-sha256-multiset.fixed-bytes@1' as const
export const COPIER_SNAPSHOT_CANDIDATE_PROJECTION_MULTISET_CONTRACT =
  'arena.ingest.copier-candidate-projection-sha256-multiset.fixed-bytes@1' as const

/** `copy_duration_days` is stored as a PostgreSQL `integer`. */
export const COPIER_SNAPSHOT_MAX_DURATION_DAYS = 2_147_483_647

export const COPIER_SNAPSHOT_PROJECTION_TUPLE_FIELDS = Object.freeze([
  'contract',
  'source_candidate_sha256',
  'source_event_at',
  'copier_label',
  'copier_pnl',
  'copier_invested',
  'copy_duration_days',
  'dedupe_hash',
] as const)

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const CANONICAL_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/
const MAX_TEXT_CODE_POINTS = 512

export interface CanonicalCopierSnapshotProjectionTuple {
  readonly contract: typeof COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT
  readonly source_candidate_sha256: string
  /** V1 has no reviewed per-copier source event clock. It must remain null. */
  readonly source_event_at: null
  readonly copier_label: string | null
  /** Plain, exponent-free, shortest round-tripping JavaScript decimal. */
  readonly copier_pnl: string | null
  /** Plain, exponent-free, shortest round-tripping JavaScript decimal. */
  readonly copier_invested: string | null
  /** Canonical nonnegative PostgreSQL integer text. */
  readonly copy_duration_days: string | null
  readonly dedupe_hash: string
}

export interface CopierSnapshotProjectionDigest {
  readonly tuple: CanonicalCopierSnapshotProjectionTuple
  readonly tupleBytesHex: string
  readonly projectionSha256: string
}

export interface CopierSnapshotCandidateProjectionPair {
  readonly source_candidate_sha256: string
  readonly projection_sha256: string
}

type CopierProjectionRow = Pick<
  ParsedCopierRow,
  'kind' | 'copierLabel' | 'copierPnl' | 'copierInvested' | 'copyDurationDays' | 'dedupeHash'
>

function projectionError(detail: string): Error {
  return new Error(`[ingest] copier snapshot projection failed: ${detail}`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw projectionError('projection tuple must have the exact contract fields')
  }
}

function assertUnicodeScalarText(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw projectionError(`${label} contains an isolated Unicode surrogate`)
      }
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw projectionError(`${label} contains an isolated Unicode surrogate`)
    }
  }
  if (value.includes('\u0000')) {
    throw projectionError(`${label} contains U+0000, which PostgreSQL text cannot represent`)
  }
}

function assertCanonicalProjectionText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw projectionError(`${label} must be text`)
  assertUnicodeScalarText(value, label)
  const codePointLength = Array.from(value).length
  if (codePointLength < 1 || codePointLength > MAX_TEXT_CODE_POINTS || value.trim() !== value) {
    throw projectionError(`${label} must be nonempty, trimmed, and at most 512 code points`)
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw projectionError(`${label} must be a lowercase SHA-256 digest`)
  }
}

function expandExponentialDecimal(value: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?[eE]([+-]?[0-9]+)$/.exec(value)
  if (!match) return value

  const [, sign, integerPart, fractionalPart = '', rawExponent] = match
  const digits = `${integerPart}${fractionalPart}`
  const decimalIndex = integerPart.length + Number(rawExponent)
  if (decimalIndex <= 0) return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
}

/**
 * Convert one already-decoded JavaScript number to the only decimal spelling
 * accepted by projection V1. The source wire spelling cannot be recovered from
 * a Number, so magnitudes outside JavaScript's safe integer range fail closed.
 * The result is the shortest round-tripping Number spelling expanded to plain
 * decimal notation, with no exponent, plus sign, leading zero, or trailing
 * fractional zero.
 */
export function canonicalCopierSnapshotDecimal(value: number, label = 'decimal'): string {
  if (!Number.isFinite(value)) throw projectionError(`${label} must be finite`)
  if (Object.is(value, -0)) throw projectionError(`${label} must not be negative zero`)
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw projectionError(`${label} integer exceeds JavaScript safe precision`)
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw projectionError(`${label} magnitude exceeds JavaScript safe precision`)
  }

  const canonical = expandExponentialDecimal(value.toString())
  if (!CANONICAL_DECIMAL_PATTERN.test(canonical) || canonical === '-0') {
    throw projectionError(`${label} could not be represented as a canonical decimal`)
  }
  return canonical
}

function assertCanonicalDecimalText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL_PATTERN.test(value) || value === '-0') {
    throw projectionError(`${label} must be a canonical exponent-free decimal`)
  }
  const decoded = Number(value)
  if (!Number.isFinite(decoded) || canonicalCopierSnapshotDecimal(decoded, label) !== value) {
    throw projectionError(`${label} is not an exact canonical JavaScript decimal`)
  }
}

function canonicalDurationDays(value: number, label: string): string {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > COPIER_SNAPSHOT_MAX_DURATION_DAYS
  ) {
    throw projectionError(
      `${label} must be a nonnegative PostgreSQL integer without precision loss`
    )
  }
  return value.toString()
}

function assertCanonicalDurationText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw projectionError(`${label} must be canonical nonnegative integer text`)
  }
  const decoded = Number(value)
  if (canonicalDurationDays(decoded, label) !== value) {
    throw projectionError(`${label} is outside the projection integer contract`)
  }
}

function freezeTuple(
  tuple: CanonicalCopierSnapshotProjectionTuple
): CanonicalCopierSnapshotProjectionTuple {
  return Object.freeze(tuple)
}

/** Revalidate an untrusted tuple before hashing or crossing the SQL boundary. */
export function revalidateCopierSnapshotProjectionTuple(
  value: unknown
): CanonicalCopierSnapshotProjectionTuple {
  if (!isPlainRecord(value)) throw projectionError('projection tuple must be an object')
  assertExactKeys(value, COPIER_SNAPSHOT_PROJECTION_TUPLE_FIELDS)
  if (value.contract !== COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT) {
    throw projectionError('projection tuple contract is invalid')
  }
  assertSha256(value.source_candidate_sha256, 'source candidate SHA-256')
  if (value.source_event_at !== null) {
    throw projectionError('source_event_at must be null in projection V1')
  }

  if (value.copier_label !== null) {
    assertCanonicalProjectionText(value.copier_label, 'copier_label')
  }
  if (value.copier_pnl !== null) {
    assertCanonicalDecimalText(value.copier_pnl, 'copier_pnl')
  }
  if (value.copier_invested !== null) {
    assertCanonicalDecimalText(value.copier_invested, 'copier_invested')
    if (Number(value.copier_invested) < 0) {
      throw projectionError('copier_invested must be nonnegative')
    }
  }
  if (value.copy_duration_days !== null) {
    assertCanonicalDurationText(value.copy_duration_days, 'copy_duration_days')
  }
  assertCanonicalProjectionText(value.dedupe_hash, 'dedupe_hash')

  return freezeTuple({
    contract: COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT,
    source_candidate_sha256: value.source_candidate_sha256,
    source_event_at: null,
    copier_label: value.copier_label as string | null,
    copier_pnl: value.copier_pnl as string | null,
    copier_invested: value.copier_invested as string | null,
    copy_duration_days: value.copy_duration_days as string | null,
    dedupe_hash: value.dedupe_hash,
  })
}

/**
 * Encode one nullable UTF-8 scalar as either `00` for null or
 * `01 || uint32be(byte_length) || UTF8(value)`. Empty text is therefore
 * `0100000000`, distinct from null. PostgreSQL 17 can reproduce the length
 * prefix with `pg_catalog.int4send(pg_catalog.octet_length(value))`.
 */
export function encodeCopierSnapshotNullableUtf8(value: string | null): Buffer {
  if (value === null) return Buffer.from([0])
  if (typeof value !== 'string') throw projectionError('UTF-8 token must be text or null')
  assertUnicodeScalarText(value, 'UTF-8 token')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength > 0x7fffffff) {
    throw projectionError('UTF-8 token exceeds PostgreSQL int4 length')
  }
  const encoded = Buffer.allocUnsafe(5 + bytes.byteLength)
  encoded[0] = 1
  encoded.writeUInt32BE(bytes.byteLength, 1)
  bytes.copy(encoded, 5)
  return encoded
}

/** Fixed-field tuple; field names are versioned by the contract and not encoded. */
export function encodeCopierSnapshotProjectionTuple(value: unknown): Buffer {
  const tuple = revalidateCopierSnapshotProjectionTuple(value)
  return Buffer.concat([
    encodeCopierSnapshotNullableUtf8(tuple.contract),
    encodeCopierSnapshotNullableUtf8(tuple.source_candidate_sha256),
    encodeCopierSnapshotNullableUtf8(tuple.source_event_at),
    encodeCopierSnapshotNullableUtf8(tuple.copier_label),
    encodeCopierSnapshotNullableUtf8(tuple.copier_pnl),
    encodeCopierSnapshotNullableUtf8(tuple.copier_invested),
    encodeCopierSnapshotNullableUtf8(tuple.copy_duration_days),
    encodeCopierSnapshotNullableUtf8(tuple.dedupe_hash),
  ])
}

export function copierSnapshotProjectionSha256(value: unknown): string {
  return createHash('sha256').update(encodeCopierSnapshotProjectionTuple(value)).digest('hex')
}

/** Build the exact V1 projection of one ParsedCopierRow and bind its RAW candidate SHA. */
export function buildCopierSnapshotProjection(input: {
  sourceCandidateSha256: string
  row: CopierProjectionRow
}): CopierSnapshotProjectionDigest {
  assertSha256(input.sourceCandidateSha256, 'source candidate SHA-256')
  if (!isPlainRecord(input.row) || input.row.kind !== 'copiers') {
    throw projectionError('parsed row kind must be copiers')
  }
  if (input.row.copierPnl !== null && typeof input.row.copierPnl !== 'number') {
    throw projectionError('copier_pnl must be a number or null')
  }
  if (input.row.copierInvested !== null && typeof input.row.copierInvested !== 'number') {
    throw projectionError('copier_invested must be a number or null')
  }
  if (input.row.copyDurationDays !== null && typeof input.row.copyDurationDays !== 'number') {
    throw projectionError('copy_duration_days must be a number or null')
  }

  const tuple = revalidateCopierSnapshotProjectionTuple({
    contract: COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT,
    source_candidate_sha256: input.sourceCandidateSha256,
    source_event_at: null,
    copier_label: input.row.copierLabel,
    copier_pnl:
      input.row.copierPnl === null
        ? null
        : canonicalCopierSnapshotDecimal(input.row.copierPnl, 'copier_pnl'),
    copier_invested:
      input.row.copierInvested === null
        ? null
        : canonicalCopierSnapshotDecimal(input.row.copierInvested, 'copier_invested'),
    copy_duration_days:
      input.row.copyDurationDays === null
        ? null
        : canonicalDurationDays(input.row.copyDurationDays, 'copy_duration_days'),
    dedupe_hash: input.row.dedupeHash,
  })
  const tupleBytes = encodeCopierSnapshotProjectionTuple(tuple)
  return Object.freeze({
    tuple,
    tupleBytesHex: tupleBytes.toString('hex'),
    projectionSha256: createHash('sha256').update(tupleBytes).digest('hex'),
  })
}

function sortedSha256Bytes(hashes: readonly string[], label: string): Buffer {
  if (!Array.isArray(hashes)) throw projectionError(`${label} must be an array`)
  const normalized = hashes.map((hash, index) => {
    assertSha256(hash, `${label} member ${index}`)
    return hash
  })
  normalized.sort()
  return Buffer.concat(normalized.map((hash) => Buffer.from(hash, 'hex')))
}

/**
 * Sort lowercase digest text by raw byte order, retain duplicate occurrences,
 * concatenate each decoded 32-byte digest, then SHA-256 the exact bytes. Empty
 * input hashes the empty byte string.
 */
export function encodeCopierSnapshotCandidateMultiset(hashes: readonly string[]): Buffer {
  return sortedSha256Bytes(hashes, 'candidate multiset')
}

export function copierSnapshotCandidateMultisetSha256(hashes: readonly string[]): string {
  return createHash('sha256').update(encodeCopierSnapshotCandidateMultiset(hashes)).digest('hex')
}

/**
 * Sort by the raw 64-byte `candidate || projection` pair, retain duplicates,
 * concatenate, then SHA-256. No JSON or PostgreSQL jsonb rendering participates.
 */
export function encodeCopierSnapshotCandidateProjectionMultiset(
  pairs: readonly CopierSnapshotCandidateProjectionPair[]
): Buffer {
  if (!Array.isArray(pairs)) throw projectionError('candidate-projection multiset must be an array')
  const pairHex = pairs.map((pair, index) => {
    if (!isPlainRecord(pair)) {
      throw projectionError(`candidate-projection pair ${index} must be an object`)
    }
    assertExactKeys(pair, ['source_candidate_sha256', 'projection_sha256'])
    assertSha256(pair.source_candidate_sha256, `candidate-projection pair ${index} candidate`)
    assertSha256(pair.projection_sha256, `candidate-projection pair ${index} projection`)
    return `${pair.source_candidate_sha256}${pair.projection_sha256}`
  })
  pairHex.sort()
  return Buffer.concat(pairHex.map((pair) => Buffer.from(pair, 'hex')))
}

export function copierSnapshotCandidateProjectionMultisetSha256(
  pairs: readonly CopierSnapshotCandidateProjectionPair[]
): string {
  return createHash('sha256')
    .update(encodeCopierSnapshotCandidateProjectionMultiset(pairs))
    .digest('hex')
}
