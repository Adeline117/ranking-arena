/**
 * Exhaustion completeness (`completeness_mode: 'exhausted'`).
 *
 * The reported-total mode proves a board complete when the accepted rows equal
 * an upstream-reported population. Many sources report no total and instead
 * signal the end of the board by exhaustion: a continuation flag, a reported
 * page count, or a short final page. This module is the second, equally strict
 * proof. A capture carries one `completeness` block; it holds only when every
 * condition below holds, and fails closed otherwise:
 *
 *  - the block binds every source page (ordinal, request hash, response hash,
 *    row count) of the manifest, contiguously from page one;
 *  - the declared end signal says "more" on every page but the last and "end"
 *    on the last (page_count: every page reports the same N and the capture
 *    stopped at page N; short_page: every page but the last is full);
 *  - cross-page row identity: duplicates = observed - distinct keys, never
 *    above the declared allowance, and distinct keys = accepted population with
 *    zero rejected rows;
 *  - board stability: every page carries the same version token, or page one
 *    re-read after the last page yields identical row keys; or, for a live
 *    board that keeps moving while it is paged, bounded drift: the total each
 *    page reports, the distinct rows against the last reported total, and the
 *    duplicate rows each stay within the declared share of the board;
 *  - one ranked row per identity (`identity_merge`, bitget_cfd): the rows
 *    (portfolios) are each read exactly once and equal the last reported
 *    total, and the only rows dropped are those merged into the best-ranked
 *    row of the same identity. Declarations without it are judged as before.
 *
 * The declaration is the per-source capture contract. The database holds the
 * reviewed copy (arena.leaderboard_exhaustion_contracts) and re-checks the same
 * conditions (arena.leaderboard_exhaustion_completeness_holds) before an
 * outcome may be `complete` without a reported total, and again inside
 * public.rank_publication_trust_evidence.
 */

import { z } from 'zod'

export const LEADERBOARD_EXHAUSTION_COMPLETENESS_CONTRACT =
  'arena.ingest.leaderboard-exhaustion-completeness@1' as const

const SHA256 = /^[0-9a-f]{64}$/

/** A live-board contract may tolerate at most 1% of the board moving. */
export const MAX_REPORTED_TOTAL_DRIFT_BPS = 100

const sha256Schema = z
  .string()
  .regex(SHA256, 'must be a lowercase SHA-256 digest')
  .refine((value) => !/^0+$/.test(value), 'digest must not be all zeroes')
const safeNonNegativeIntegerSchema = z
  .number()
  .refine(
    (value) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0,
    'must be a non-negative safe integer'
  )
const safePositiveIntegerSchema = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 1, 'must be a positive safe integer')
const pathSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value, 'path segments must be canonical')
const payloadPathSchema = z.array(pathSegmentSchema).min(1).max(8)
/** End-signal values are JSON scalars with an exact canonical form. */
const signalScalarSchema = z.union([
  z.string().max(256),
  z
    .number()
    .refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0), 'integer only'),
  z.boolean(),
  z.null(),
])

export const leaderboardExhaustionEndSignalSchema = z.discriminatedUnion('kind', [
  /** A per-page continuation flag at `path` (e.g. data.nextFlag); `end_values` mean "no more". */
  z
    .object({
      kind: z.literal('flag'),
      path: payloadPathSchema,
      end_values: z.array(signalScalarSchema).min(1).max(8),
    })
    .strict(),
  /** A per-page reported page count at `path`; the board ends at that page. */
  z.object({ kind: z.literal('page_count'), path: payloadPathSchema }).strict(),
  /** The board ends at the first page with fewer rows than the configured page size. */
  z.object({ kind: z.literal('short_page') }).strict(),
])

export const leaderboardExhaustionBoardVersionSchema = z.discriminatedUnion('kind', [
  /** Every page carries one board version token at `path` (e.g. okx dataVer). */
  z.object({ kind: z.literal('token'), path: payloadPathSchema }).strict(),
  /** No token: page one is re-read after the last page and must yield identical row keys. */
  z.object({ kind: z.literal('first_page_reread') }).strict(),
  /**
   * A live board: members and ranks change while it is paged, so no snapshot
   * can be frozen. Every page reports the board total at `path`; the proof
   * bounds how far the board moved during the capture instead of denying it.
   */
  z
    .object({
      kind: z.literal('reported_total_drift'),
      path: payloadPathSchema,
      /**
       * The allowance in basis points of the last reported total (100 = 1%,
       * the most a contract may declare). Relative, because a registered
       * declaration is immutable while the board keeps growing; the
       * declaration's max_duplicate_rows caps it in absolute rows.
       */
      max_drift_bps: z
        .number()
        .refine(
          (value) =>
            Number.isSafeInteger(value) &&
            !Object.is(value, -0) &&
            value >= 0 &&
            value <= MAX_REPORTED_TOTAL_DRIFT_BPS,
          'must be an integer between 0 and 100 basis points'
        ),
    })
    .strict(),
])

/**
 * One ranked row per identity (bitget_cfd: one trader, several portfolios).
 * Each board row is one portfolio (`row_key_path`); several rows may belong
 * to one trader (`identity_path`). The board is proven complete by portfolio
 * (every portfolio read exactly once, as many as the board reports) and the
 * capture then keeps, for each identity, its best-ranked row: the staging
 * dedupe (lib/ingest/staging/validate.ts) keeps the lower rank. The kept row
 * is one real portfolio's figures, not the trader's combined performance.
 *
 * Only with a reported_total_drift board version and max_duplicate_rows 0:
 * a portfolio read twice is never tolerated, and the portfolio count must
 * equal the last reported total exactly.
 */
export const leaderboardExhaustionIdentityMergeSchema = z
  .object({
    kind: z.literal('best_rank'),
    /** Path, inside one row, of the identity the ranking keeps one row for. */
    identity_path: payloadPathSchema,
  })
  .strict()

/** The per-source capture contract for exhausted completeness (reviewed, DB-registered). */
export const leaderboardExhaustionDeclarationSchema = z
  .object({
    completeness_mode: z.literal('exhausted'),
    /** Payload path of the upstream row array. */
    list_path: payloadPathSchema,
    /** Path, inside one row, of its stable key (one per board row). */
    row_key_path: payloadPathSchema,
    end_signal: leaderboardExhaustionEndSignalSchema,
    board_version: leaderboardExhaustionBoardVersionSchema,
    /** Cross-page duplicate rows the contract tolerates (0 = none). */
    max_duplicate_rows: safeNonNegativeIntegerSchema,
    /** Absent: one ranked row per row key (every contract before bitget_cfd). */
    identity_merge: leaderboardExhaustionIdentityMergeSchema.optional(),
  })
  .strict()
  .refine(
    (declaration) =>
      declaration.identity_merge === undefined ||
      (declaration.board_version.kind === 'reported_total_drift' &&
        declaration.max_duplicate_rows === 0),
    'identity_merge requires a reported_total_drift board version and max_duplicate_rows 0'
  )

export type LeaderboardExhaustionDeclaration = z.infer<
  typeof leaderboardExhaustionDeclarationSchema
>

const exhaustionPageSchema = z
  .object({
    ordinal: safePositiveIntegerSchema,
    request_sha256: sha256Schema,
    response_sha256: sha256Schema,
    row_count: safeNonNegativeIntegerSchema,
    /** sha256 of the strict-canonical JSON array of this page's row keys, in order. */
    row_keys_sha256: sha256Schema,
    /** The end-signal value read from this page; null for short_page. */
    end_signal_value: signalScalarSchema,
    /** sha256 of the canonical version token; null unless board_version is token. */
    version_token_sha256: sha256Schema.nullable(),
  })
  .strict()

const rereadSchema = z
  .object({
    request_sha256: sha256Schema,
    response_sha256: sha256Schema,
    http_status: z
      .number()
      .refine((value) => Number.isSafeInteger(value) && value >= 100 && value <= 599),
    row_keys_sha256: sha256Schema,
  })
  .strict()

export const leaderboardExhaustionCompletenessSchema = z
  .object({
    data_contract: z.literal(LEADERBOARD_EXHAUSTION_COMPLETENESS_CONTRACT),
    declaration: leaderboardExhaustionDeclarationSchema,
    pages: z.array(exhaustionPageSchema).min(1),
    row_keys: z
      .object({
        observed: safeNonNegativeIntegerSchema,
        distinct: safeNonNegativeIntegerSchema,
        duplicate: safeNonNegativeIntegerSchema,
      })
      .strict(),
    /**
     * Present exactly when the declaration has identity_merge: the distinct
     * identities among the rows, and the rows merged into another row of the
     * same identity (distinct row keys - identities).
     */
    identity_merge: z
      .object({
        identities: safeNonNegativeIntegerSchema,
        merged_rows: safeNonNegativeIntegerSchema,
      })
      .strict()
      .optional(),
    board_version: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('token') }).strict(),
      z
        .object({
          kind: z.literal('first_page_reread'),
          /** null when the re-read request failed: stability is then unproven. */
          reread: rereadSchema.nullable(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('reported_total_drift'),
          /** The board total each page reported: smallest, largest, and the last page's. */
          reported_totals: z
            .object({
              min: safeNonNegativeIntegerSchema,
              max: safeNonNegativeIntegerSchema,
              last: safeNonNegativeIntegerSchema,
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict()

export type LeaderboardExhaustionCompleteness = z.infer<
  typeof leaderboardExhaustionCompletenessSchema
>

/** The manifest facts the completeness block is checked against. */
export interface LeaderboardExhaustionManifestFacts {
  termination_reason: string
  configured_page_size: number | null
  population_report_state: 'consistent' | 'conflicting' | 'unknown'
  source_pages: ReadonlyArray<{
    ordinal: number
    request_sha256: string | null
    payload_sha256: string
    source_row_count: number
  }>
  observed_row_count: number
  accepted_population: number
  rejected_row_count: number
  deduplicated_row_count: number
}

/**
 * Structural binding: the block describes exactly the manifest's pages. A
 * violation makes the manifest itself invalid (it cannot be built).
 */
export function exhaustionBindingIssues(
  completeness: LeaderboardExhaustionCompleteness,
  facts: LeaderboardExhaustionManifestFacts
): string[] {
  const issues: string[] = []
  if (completeness.pages.length !== facts.source_pages.length) {
    issues.push('completeness pages must bind every source page')
    return issues
  }
  for (const [index, page] of completeness.pages.entries()) {
    const source = facts.source_pages[index]
    if (
      page.ordinal !== index + 1 ||
      source.ordinal !== index + 1 ||
      page.request_sha256 !== source.request_sha256 ||
      page.response_sha256 !== source.payload_sha256 ||
      page.row_count !== source.source_row_count
    ) {
      issues.push(`completeness page ${index + 1} does not bind its source page`)
    }
  }
  const declaration = completeness.declaration
  for (const page of completeness.pages) {
    if (declaration.end_signal.kind === 'short_page' && page.end_signal_value !== null) {
      issues.push('short_page completeness records no end-signal value')
      break
    }
    if ((declaration.board_version.kind === 'token') !== (page.version_token_sha256 !== null)) {
      issues.push('version tokens are recorded exactly when the board version is a token')
      break
    }
  }
  if (completeness.board_version.kind !== declaration.board_version.kind) {
    issues.push('board version evidence must follow the declaration')
  }
  if ((declaration.identity_merge === undefined) !== (completeness.identity_merge === undefined)) {
    issues.push(
      'identity merge evidence is recorded exactly when the declaration merges identities'
    )
  }
  if (completeness.row_keys.observed !== facts.observed_row_count) {
    issues.push('row-key observations must equal the observed row count')
  }
  if (
    completeness.row_keys.distinct > completeness.row_keys.observed ||
    completeness.row_keys.duplicate !==
      completeness.row_keys.observed - completeness.row_keys.distinct
  ) {
    issues.push('duplicate row keys must equal observed minus distinct keys')
  }
  return issues
}

/** The declared end signal says "more" on every page but the last and "end" on the last. */
export function exhaustionEndSignalHolds(
  completeness: LeaderboardExhaustionCompleteness,
  facts: LeaderboardExhaustionManifestFacts
): boolean {
  const pages = completeness.pages
  const last = pages[pages.length - 1]
  const signal = completeness.declaration.end_signal
  switch (signal.kind) {
    case 'flag': {
      const isEnd = (value: unknown) => signal.end_values.some((end) => Object.is(end, value))
      if (!isEnd(last.end_signal_value)) return false
      if (pages.slice(0, -1).some((page) => isEnd(page.end_signal_value))) return false
      return (
        (facts.termination_reason === 'cursor_exhausted' && last.row_count > 0) ||
        (facts.termination_reason === 'empty_page' && last.row_count === 0)
      )
    }
    case 'page_count':
      return (
        facts.termination_reason === 'reported_page_count_reached' &&
        last.row_count > 0 &&
        pages.every((page) => page.end_signal_value === pages.length)
      )
    case 'short_page': {
      const pageSize = facts.configured_page_size
      if (pageSize === null) return false
      if (pages.slice(0, -1).some((page) => page.row_count !== pageSize)) return false
      return (
        (facts.termination_reason === 'short_page' &&
          last.row_count > 0 &&
          last.row_count < pageSize) ||
        (facts.termination_reason === 'empty_page' && last.row_count === 0)
      )
    }
  }
}

function boardVersionHolds(completeness: LeaderboardExhaustionCompleteness): boolean {
  const pages = completeness.pages
  if (completeness.board_version.kind === 'token') {
    const token = pages[0].version_token_sha256
    return token !== null && pages.every((page) => page.version_token_sha256 === token)
  }
  if (completeness.board_version.kind === 'reported_total_drift') {
    const declared = completeness.declaration.board_version
    if (declared.kind !== 'reported_total_drift') return false
    const totals = completeness.board_version.reported_totals
    const allowance = Math.min(
      Math.floor((totals.last * declared.max_drift_bps) / 10_000),
      completeness.declaration.max_duplicate_rows
    )
    return (
      totals.min <= totals.last &&
      totals.last <= totals.max &&
      totals.max - totals.min <= allowance &&
      Math.abs(totals.last - completeness.row_keys.distinct) <= allowance &&
      completeness.row_keys.duplicate <= allowance
    )
  }
  const reread = completeness.board_version.reread
  return (
    reread !== null &&
    reread.http_status >= 200 &&
    reread.http_status <= 299 &&
    reread.row_keys_sha256 === pages[0].row_keys_sha256
  )
}

/**
 * True only when exhaustion proves the board complete. Mirrors
 * arena.leaderboard_exhaustion_completeness_holds (the DB also requires the
 * declaration to equal the source's registered contract).
 */
export function exhaustionCompletenessHolds(
  completeness: LeaderboardExhaustionCompleteness,
  facts: LeaderboardExhaustionManifestFacts
): boolean {
  if (exhaustionBindingIssues(completeness, facts).length > 0) return false
  const rows = completeness.row_keys
  const merge = completeness.identity_merge
  if (completeness.declaration.identity_merge !== undefined) {
    return merge !== undefined && identityMergeHolds(completeness, merge, facts)
  }
  return (
    facts.population_report_state === 'unknown' &&
    facts.rejected_row_count === 0 &&
    facts.accepted_population > 0 &&
    rows.distinct === facts.accepted_population &&
    rows.duplicate === facts.deduplicated_row_count &&
    rows.duplicate <= completeness.declaration.max_duplicate_rows &&
    exhaustionEndSignalHolds(completeness, facts) &&
    boardVersionHolds(completeness)
  )
}

/**
 * The identity_merge proof: every row (portfolio) read exactly once, as many
 * as the last reported total, and the only rows the capture drops are those
 * merged into a better-ranked row of the same identity. A portfolio read twice
 * is never tolerated, whatever the board's drift allowance.
 */
function identityMergeHolds(
  completeness: LeaderboardExhaustionCompleteness,
  merge: { identities: number; merged_rows: number },
  facts: LeaderboardExhaustionManifestFacts
): boolean {
  const rows = completeness.row_keys
  const version = completeness.board_version
  return (
    completeness.declaration.max_duplicate_rows === 0 &&
    version.kind === 'reported_total_drift' &&
    facts.population_report_state === 'unknown' &&
    facts.rejected_row_count === 0 &&
    facts.accepted_population > 0 &&
    rows.duplicate === 0 &&
    rows.distinct === version.reported_totals.last &&
    merge.identities === facts.accepted_population &&
    merge.identities >= 1 &&
    merge.identities <= rows.distinct &&
    merge.merged_rows === rows.distinct - merge.identities &&
    facts.deduplicated_row_count === merge.merged_rows &&
    exhaustionEndSignalHolds(completeness, facts) &&
    boardVersionHolds(completeness)
  )
}
