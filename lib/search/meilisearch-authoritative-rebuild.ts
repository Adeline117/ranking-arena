import { createHash } from 'node:crypto'

/**
 * Pure contracts shared by a future Meilisearch blue/green rebuild runner.
 *
 * This module deliberately performs no network or environment access. A caller
 * must first freeze and exhaustively enumerate both the database source rows and
 * the candidate index documents before building reconciliation evidence here.
 */

export const MEILISEARCH_REBUILD_SEASONS = ['7D', '30D', '90D'] as const

export type MeilisearchRebuildSeason = (typeof MEILISEARCH_REBUILD_SEASONS)[number]

export interface FrozenLeaderboardIdentityRow {
  readonly source: string
  readonly source_trader_id: string
  readonly season_id: string
}

export interface MeilisearchDocumentIdentity {
  readonly id: string
  readonly season_id: MeilisearchRebuildSeason
}

export interface MeilisearchReconciliationEvidence {
  readonly contract_version: 'meilisearch-authoritative-rebuild-v1'
  readonly total_count: number
  readonly season_counts: Readonly<Record<MeilisearchRebuildSeason, number>>
  /** SHA-256 of JSON.stringify(all unique document IDs sorted by ASCII order). */
  readonly sorted_id_sha256: string
}

export interface SuccessfulMeilisearchTask {
  readonly task_uid: number
  readonly status: 'succeeded'
}

const MEILISEARCH_DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const KNOWN_TASK_STATUSES = new Set(['enqueued', 'processing', 'succeeded', 'failed', 'canceled'])
const RECONCILIATION_EVIDENCE_KEYS = [
  'contract_version',
  'season_counts',
  'sorted_id_sha256',
  'total_count',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertSeason(value: string): asserts value is MeilisearchRebuildSeason {
  if (!(MEILISEARCH_REBUILD_SEASONS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported Meilisearch rebuild season: ${value || '<empty>'}`)
  }
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function assertDocumentIdentity(document: MeilisearchDocumentIdentity, rowIndex: number): void {
  if (!MEILISEARCH_DOCUMENT_ID_PATTERN.test(document.id)) {
    throw new Error(`Invalid Meilisearch document id at row ${rowIndex}`)
  }
  assertSeason(document.season_id)
  const seasonSuffix = `--${document.season_id}`
  if (!document.id.endsWith(seasonSuffix)) {
    throw new Error(`Meilisearch document season mismatch at row ${rowIndex}`)
  }

  const compoundBody = document.id.slice(0, -seasonSuffix.length)
  const componentSeparator = compoundBody.indexOf('--')
  if (componentSeparator <= 0 || componentSeparator + 2 >= compoundBody.length) {
    throw new Error(`Invalid Meilisearch compound document id at row ${rowIndex}`)
  }
}

function assertNonNegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid Meilisearch reconciliation ${field}`)
  }
}

export function assertMeilisearchReconciliationEvidence(
  evidence: unknown,
  label = 'evidence'
): asserts evidence is MeilisearchReconciliationEvidence {
  if (!isRecord(evidence)) {
    throw new Error(`Invalid Meilisearch reconciliation ${label}: expected object`)
  }

  const evidenceKeys = Object.keys(evidence).sort(compareAscii)
  if (
    evidenceKeys.length !== RECONCILIATION_EVIDENCE_KEYS.length ||
    evidenceKeys.some((key, index) => key !== RECONCILIATION_EVIDENCE_KEYS[index])
  ) {
    throw new Error(`Invalid Meilisearch reconciliation ${label}: unexpected evidence shape`)
  }
  if (evidence.contract_version !== 'meilisearch-authoritative-rebuild-v1') {
    throw new Error(`Invalid Meilisearch reconciliation ${label}: unsupported contract version`)
  }

  assertNonNegativeSafeInteger(evidence.total_count, `${label}.total_count`)
  if (evidence.total_count === 0) {
    throw new Error(`Invalid Meilisearch reconciliation ${label}: total_count must be positive`)
  }
  if (!isRecord(evidence.season_counts)) {
    throw new Error(`Invalid Meilisearch reconciliation ${label}: season_counts must be an object`)
  }

  const seasonKeys = Object.keys(evidence.season_counts).sort(compareAscii)
  const expectedSeasonKeys = [...MEILISEARCH_REBUILD_SEASONS].sort(compareAscii)
  if (
    seasonKeys.length !== expectedSeasonKeys.length ||
    seasonKeys.some((key, index) => key !== expectedSeasonKeys[index])
  ) {
    throw new Error(`Invalid Meilisearch reconciliation ${label}: unexpected season_counts shape`)
  }

  let seasonTotal = 0
  for (const season of MEILISEARCH_REBUILD_SEASONS) {
    const count = evidence.season_counts[season]
    assertNonNegativeSafeInteger(count, `${label}.season_counts.${season}`)
    if (count === 0) {
      throw new Error(
        `Invalid Meilisearch reconciliation ${label}: season_counts.${season} must be positive`
      )
    }
    seasonTotal += count
  }
  if (!Number.isSafeInteger(seasonTotal) || seasonTotal !== evidence.total_count) {
    throw new Error(`Invalid Meilisearch reconciliation ${label}: season counts do not equal total`)
  }

  if (
    typeof evidence.sorted_id_sha256 !== 'string' ||
    !SHA256_PATTERN.test(evidence.sorted_id_sha256)
  ) {
    throw new Error(`Invalid Meilisearch reconciliation ${label}: invalid sorted_id_sha256`)
  }
}

function taskUidFromResponse(task: Record<string, unknown>): number {
  const taskUid = task.taskUid
  const uid = task.uid

  if (taskUid !== undefined && uid !== undefined && taskUid !== uid) {
    throw new Error('Meilisearch task response contains conflicting task identifiers')
  }

  const resolved = taskUid ?? uid
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 0) {
    throw new Error('Meilisearch task response is missing a valid task identifier')
  }
  return Number(resolved)
}

/**
 * Preserve the compound primary-key format already used by the live traders
 * index. Sanitization collisions are intentionally handled by the collection
 * validator rather than silently overwriting one document with another.
 */
export function buildMeilisearchCompoundId(row: FrozenLeaderboardIdentityRow): string {
  if (!MEILISEARCH_DOCUMENT_ID_PATTERN.test(row.source)) {
    throw new Error('Leaderboard source is not a valid Meilisearch id component')
  }
  if (!row.source_trader_id.trim()) {
    throw new Error('Leaderboard source_trader_id must not be empty')
  }
  if (row.source_trader_id !== row.source_trader_id.trim()) {
    throw new Error('Leaderboard source_trader_id must not have surrounding whitespace')
  }
  assertSeason(row.season_id)

  const sanitizedTraderId = row.source_trader_id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${row.source}--${sanitizedTraderId}--${row.season_id}`
}

export function leaderboardRowToMeilisearchIdentity(
  row: FrozenLeaderboardIdentityRow
): MeilisearchDocumentIdentity {
  assertSeason(row.season_id)
  return Object.freeze({
    id: buildMeilisearchCompoundId(row),
    season_id: row.season_id,
  })
}

/**
 * Return a new, stable ID-ordered array and fail before upload if any two source
 * rows map to the same primary key. The caller's input is never mutated.
 */
export function sortUniqueMeilisearchDocuments<T extends MeilisearchDocumentIdentity>(
  documents: readonly T[]
): readonly T[] {
  const sorted = [...documents].sort((left, right) => compareAscii(left.id, right.id))

  for (let index = 0; index < sorted.length; index += 1) {
    const document = sorted[index]
    assertDocumentIdentity(document, index)
    if (index > 0 && sorted[index - 1].id === document.id) {
      throw new Error(`Duplicate Meilisearch document id: ${document.id}`)
    }
  }

  return Object.freeze(sorted)
}

export function buildMeilisearchReconciliationEvidence(
  documents: readonly MeilisearchDocumentIdentity[]
): MeilisearchReconciliationEvidence {
  const sorted = sortUniqueMeilisearchDocuments(documents)
  const seasonCounts: Record<MeilisearchRebuildSeason, number> = {
    '7D': 0,
    '30D': 0,
    '90D': 0,
  }

  for (const document of sorted) {
    seasonCounts[document.season_id] += 1
  }

  const sortedIds = sorted.map((document) => document.id)
  const sortedIdSha256 = createHash('sha256')
    .update(JSON.stringify(sortedIds), 'utf8')
    .digest('hex')

  const evidence = Object.freeze({
    contract_version: 'meilisearch-authoritative-rebuild-v1',
    total_count: sorted.length,
    season_counts: Object.freeze(seasonCounts),
    sorted_id_sha256: sortedIdSha256,
  })
  assertMeilisearchReconciliationEvidence(evidence)
  return evidence
}

export function buildFrozenLeaderboardReconciliationEvidence(
  rows: readonly FrozenLeaderboardIdentityRow[]
): MeilisearchReconciliationEvidence {
  return buildMeilisearchReconciliationEvidence(rows.map(leaderboardRowToMeilisearchIdentity))
}

/** Fail closed unless the candidate index is an exact identity-set match. */
export function assertMeilisearchReconciliationMatch(
  expected: MeilisearchReconciliationEvidence,
  observed: MeilisearchReconciliationEvidence
): void {
  assertMeilisearchReconciliationEvidence(expected, 'expected')
  assertMeilisearchReconciliationEvidence(observed, 'observed')

  const mismatches: string[] = []

  if (expected.contract_version !== observed.contract_version) {
    mismatches.push('contract_version')
  }
  if (expected.total_count !== observed.total_count) {
    mismatches.push('total_count')
  }
  for (const season of MEILISEARCH_REBUILD_SEASONS) {
    if (expected.season_counts[season] !== observed.season_counts[season]) {
      mismatches.push(`season_counts.${season}`)
    }
  }
  if (expected.sorted_id_sha256 !== observed.sorted_id_sha256) {
    mismatches.push('sorted_id_sha256')
  }

  if (mismatches.length > 0) {
    throw new Error(`Meilisearch authoritative reconciliation failed: ${mismatches.join(', ')}`)
  }
}

/**
 * Meilisearch writes and swaps are asynchronous. An HTTP 202 response is not
 * completion: only a fetched task whose terminal status is exactly succeeded is
 * accepted. Error payloads are deliberately not reflected into exception text.
 */
export function assertMeilisearchTaskSucceeded(
  task: unknown,
  expectedTaskUid?: number
): SuccessfulMeilisearchTask {
  if (!isRecord(task)) {
    throw new Error('Meilisearch task response must be an object')
  }

  const taskUid = taskUidFromResponse(task)
  if (
    expectedTaskUid !== undefined &&
    (!Number.isSafeInteger(expectedTaskUid) || expectedTaskUid < 0)
  ) {
    throw new Error('Expected Meilisearch task identifier is invalid')
  }
  if (expectedTaskUid !== undefined && taskUid !== expectedTaskUid) {
    throw new Error(
      `Meilisearch task identifier mismatch: expected ${expectedTaskUid}, got ${taskUid}`
    )
  }

  const status = typeof task.status === 'string' ? task.status : '<invalid>'
  if (status !== 'succeeded') {
    const safeStatus = KNOWN_TASK_STATUSES.has(status) ? status : '<invalid>'
    throw new Error(`Meilisearch task ${taskUid} did not succeed (status: ${safeStatus})`)
  }
  if (task.error !== undefined && task.error !== null) {
    throw new Error(`Meilisearch task ${taskUid} reported an error despite succeeded status`)
  }

  return Object.freeze({ task_uid: taskUid, status: 'succeeded' })
}
