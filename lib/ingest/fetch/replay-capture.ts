/**
 * Generic attempt-bound Tier-A capture for adapters whose leaderboard is a
 * numeric-page JSON replay (the `replayPaged` family).
 *
 * The adapter keeps its existing request builder. This module adds the three
 * things a durable capture needs and the legacy stream never recorded: an
 * explicit public allowlist of the request (persisted in RAW), the request
 * field that binds the 1-based page, and per-page source reports (row count
 * before parser validation plus the upstream-reported population).
 *
 * Nothing here decides trust. The manifest assessment
 * (acquisition-manifest.ts) still requires natural termination and either a
 * consistent reported population equal to the accepted rows with zero
 * rejected or deduplicated rows (total mode), or a holding exhaustion proof
 * (`exhaustion`, acquisition-exhaustion.ts) before an attempt can finish
 * `complete`.
 */

import {
  captureNumericLeaderboard,
  type JsonFetcher,
  type LeaderboardCapture,
  type LeaderboardNumericPageBinding,
  type LeaderboardPublicRequestProjectionInput,
  type NumericLeaderboardPageMeta,
} from './capture'
import type { FetchSession, ReplayRequestTemplate } from './types'
import type { SourceRow } from '../core/types'
import type { LeaderboardExhaustionDeclaration } from '../acquisition-exhaustion'

/** Request fields that are public, non-credential board semantics. */
export interface PublicLeaderboardRequestAllowlist {
  /** Query parameters copied into RAW, in actual-request order. */
  query?: readonly string[]
  /** Top-level POST body fields copied into RAW. Each must be present. */
  body?: readonly string[]
}

export interface ReplayLeaderboardCaptureSpec {
  /**
   * The adapter's existing per-page request builder (1-based page index).
   * `context.firstPagePayload` is page one's response (null for page one).
   */
  buildRequest: (pageIndex: number, context: { firstPagePayload: unknown }) => ReplayRequestTemplate
  publicRequest: PublicLeaderboardRequestAllowlist
  pageBinding: LeaderboardNumericPageBinding
  extractMeta: (payload: unknown, requestPageIndex: number) => NumericLeaderboardPageMeta
  /** Request page size; must equal arena.sources.page_size for short-page proof. */
  pageSize: number
  isDegenerate?: (payload: unknown) => boolean
  /**
   * Completeness mode. Absent: the board is complete only when its accepted
   * rows equal the reported total (`extractMeta` reports a population).
   * Present: `completeness_mode: 'exhausted'` (no reported total; see
   * acquisition-exhaustion.ts). It must equal the source's reviewed
   * arena.leaderboard_exhaustion_contracts row or publication refuses it.
   */
  exhaustion?: LeaderboardExhaustionDeclaration
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Project only allowlisted public request semantics; headers never enter RAW. */
export function allowlistedPublicRequest(
  allowlist: PublicLeaderboardRequestAllowlist
): (actual: ReplayRequestTemplate) => LeaderboardPublicRequestProjectionInput {
  const queryKeys = new Set(allowlist.query ?? [])
  const bodyKeys = allowlist.body ?? []
  return (actual) => {
    const url = new URL(actual.url)
    const publicUrl = new URL(`${url.origin}${url.pathname}`)
    for (const [key, value] of url.searchParams.entries()) {
      if (queryKeys.has(key)) publicUrl.searchParams.append(key, value)
    }
    if (actual.method === 'GET') {
      return { method: 'GET', url: publicUrl.href }
    }
    const body = recordOf(actual.body)
    if (bodyKeys.length > 0 && !body) {
      throw new TypeError('[ingest] allowlisted POST leaderboard request requires a JSON body')
    }
    const publicBody: Record<string, unknown> = {}
    for (const key of bodyKeys) {
      if (!body || !Object.prototype.hasOwnProperty.call(body, key)) {
        throw new TypeError(`[ingest] allowlisted POST leaderboard body field ${key} is missing`)
      }
      publicBody[key] = body[key]
    }
    return { method: 'POST', url: publicUrl.href, body: bodyKeys.length > 0 ? publicBody : null }
  }
}

/** meta.max_pages is a smoke-run cap; a capped capture can never verify population. */
export function replayCaptureCallerPageCap(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null
  const numeric = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (
    typeof numeric !== 'number' ||
    !Number.isSafeInteger(numeric) ||
    Object.is(numeric, -0) ||
    numeric < 1
  ) {
    throw new TypeError(`[${label}] meta.max_pages must be a positive safe integer`)
  }
  return numeric
}

/** Resolve a dotted payload path; undefined when any segment is absent. */
export function payloadPath(payload: unknown, path: readonly string[]): unknown {
  let value = payload
  for (const segment of path) {
    const record = recordOf(value)
    if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) return undefined
    value = record[segment]
  }
  return value
}

/** Envelope success check: `path` must equal one of `accepted` exactly. */
export function requireEnvelopeValue(
  label: string,
  path: readonly string[],
  accepted: readonly unknown[]
): (payload: unknown) => void {
  return (payload) => {
    const value = payloadPath(payload, path)
    if (!accepted.some((candidate) => Object.is(candidate, value))) {
      throw new TypeError(
        `[${label}] leaderboard response ${path.join('.')}=${JSON.stringify(value)} is not a success answer`
      )
    }
  }
}

function reportedCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null
  const numeric =
    typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric) || numeric < 0) {
    throw new TypeError(`${label} must be a non-negative integer when reported`)
  }
  return numeric
}

export interface CollectionMetaSpec {
  label: string
  /** Throws when the response envelope is not a success answer. */
  assertSuccess: (payload: unknown) => void
  /** Path to the upstream row array (counted before parser validation). */
  list: readonly string[]
  /** Path to the upstream-reported board population, if the source has one. */
  total?: readonly string[]
  /** Path to the upstream-reported page count, if the source has one. */
  pageCount?: readonly string[]
}

/**
 * Page meta from fixed payload paths. A missing row array is an upstream
 * error, never an empty page: an anti-bot answer must not read as the end.
 */
export function collectionMeta(
  spec: CollectionMetaSpec
): (payload: unknown) => NumericLeaderboardPageMeta {
  return (payload) => {
    spec.assertSuccess(payload)
    const list = payloadPath(payload, spec.list)
    if (!Array.isArray(list)) {
      throw new TypeError(
        `[${spec.label}] leaderboard response must contain ${spec.list.join('.')}`
      )
    }
    return {
      rowCount: list.length,
      reportedPopulation: spec.total
        ? reportedCount(payloadPath(payload, spec.total), `[${spec.label}] ${spec.total.join('.')}`)
        : null,
      reportedPageCount: spec.pageCount
        ? reportedCount(
            payloadPath(payload, spec.pageCount),
            `[${spec.label}] ${spec.pageCount.join('.')}`
          )
        : null,
      reportedCurrentPage: null,
      reportedPageSize: null,
    }
  }
}

/** Evidence-preserving capture over an adapter's existing replay request builder. */
export function captureReplayLeaderboard(
  input: {
    session: FetchSession
    fetcher: JsonFetcher
    src: SourceRow
    label: string
    signal?: AbortSignal
  },
  spec: ReplayLeaderboardCaptureSpec
): Promise<LeaderboardCapture> {
  return captureNumericLeaderboard({
    session: input.session,
    fetcher: input.fetcher,
    signal: input.signal,
    buildRequest: spec.buildRequest,
    projectPublicRequest: allowlistedPublicRequest(spec.publicRequest),
    pageBinding: spec.pageBinding,
    extractMeta: spec.extractMeta,
    pageSize: spec.pageSize,
    isDegenerate: spec.isDegenerate,
    exhaustion: spec.exhaustion ?? null,
    callerPageCap: replayCaptureCallerPageCap(input.src.meta.max_pages, input.label),
  })
}
