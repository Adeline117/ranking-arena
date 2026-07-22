/**
 * JSON-endpoint replay — the single biggest optimization (spec §2.2).
 *
 * After one warm page load establishes a session, adapters replay the
 * captured XHR endpoints directly with native page/cursor params instead
 * of clicking through the UI. This module provides the paginated replay
 * loop with the spec's data-quality rules built in:
 *   - completeness assertion: pages_fetched × page_size ≥ actual_count and
 *     the last page is short or empty (spec §5.6)
 *   - degenerate-page stop rule: stop when a full page fails the
 *     "non-degenerate row" predicate (the XT-spot all-zero failure mode)
 *
 * The replay loop depends only on the JsonFetcher interface so it is
 * unit-testable without Playwright; apiFetcher() adapts a Playwright
 * APIRequestContext (browser-context bound → same egress IP as session).
 */

import type { APIRequestContext } from 'playwright'
import type {
  BuildLeaderboardAcquisitionManifestInput,
  LeaderboardAcquisitionPaginationPosition,
  LeaderboardAcquisitionParserTransformation,
  LeaderboardAcquisitionReportEvidence,
} from '../acquisition-manifest'
import type { FetchSession, ReplayRequestTemplate } from './types'
import type { RawPage } from '../core/types'
import { strictCanonicalJson, strictCanonicalSha256 } from '../strict-canonical-json'
import { BlockedUpstreamError, isBlockedStatus } from './rate-limiter'
import { CircuitOpenError } from './circuit'

export interface JsonResponse {
  status: number
  json: unknown
}

export type JsonFetcher = (template: ReplayRequestTemplate) => Promise<JsonResponse>

/** Adapt a Playwright APIRequestContext into a JsonFetcher. */
export function apiFetcher(api: APIRequestContext): JsonFetcher {
  return async (template) => {
    const response =
      template.method === 'POST'
        ? await api.post(template.url, {
            headers: template.headers,
            data: template.body as Record<string, unknown> | string | undefined,
          })
        : await api.get(template.url, { headers: template.headers })
    const status = response.status()
    let json: unknown = null
    try {
      json = await response.json()
    } catch {
      // leave null — caller decides whether a non-JSON body is fatal
    }
    return { status, json }
  }
}

/**
 * JsonFetcher that executes requests INSIDE the page context (same-origin
 * fetch). Use when the external APIRequestContext is fingerprint-blocked
 * but the site accepts its own page's requests (e.g. Bitget UTA API).
 */
export function pageFetcher(session: FetchSession): JsonFetcher {
  return (template) => session.pageFetch(template)
}

/** One paced replay request; throws BlockedUpstreamError on 401/403/429. */
export async function replayJson(
  session: FetchSession,
  fetcher: JsonFetcher,
  template: ReplayRequestTemplate
): Promise<unknown> {
  return session.paced(async () => {
    const { status, json } = await fetcher(template)
    if (isBlockedStatus(status)) throw new BlockedUpstreamError(status, template.url)
    if (status < 200 || status >= 300) {
      throw new Error(`[ingest] replay ${status} for ${template.url}`)
    }
    return json
  })
}

export class IncompleteCrawlError extends Error {
  constructor(
    public readonly details: {
      pagesFetched: number
      pageSize: number | null
      reportedTotal: number | null
      rowsSeen: number
    }
  ) {
    super(
      `[ingest] incomplete crawl: ${details.rowsSeen} rows over ` +
        `${details.pagesFetched} pages vs reported total ${details.reportedTotal}`
    )
    this.name = 'IncompleteCrawlError'
  }
}

export const LEADERBOARD_PUBLIC_REQUEST_PROJECTION_CONTRACT =
  'arena.ingest.leaderboard-public-request-projection@1' as const

export interface LeaderboardPublicRequestProjection {
  data_contract: typeof LEADERBOARD_PUBLIC_REQUEST_PROJECTION_CONTRACT
  method: ReplayRequestTemplate['method']
  url: string
  body: unknown
  pagination_binding: LeaderboardNumericPageBinding
  request_page_index: number
}

export interface LeaderboardPublicRequestProjectionInput {
  method: ReplayRequestTemplate['method']
  url: string
  body?: unknown
}

export type LeaderboardNumericPageBinding =
  | { location: 'query'; key: string }
  | { location: 'body'; path: string[] }

const SENSITIVE_EVIDENCE_KEY_PARTS = [
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'csrf',
  'jwt',
  'passphrase',
  'password',
  'privatekey',
  'secret',
  'session',
  'signature',
  'token',
  'xsrf',
] as const

function isSensitiveEvidenceKey(key: string): boolean {
  const normalized = key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (normalized === 'auth' || normalized === 'key') return true
  if (normalized === 'apikey' || normalized === 'accesskey') return true
  return SENSITIVE_EVIDENCE_KEY_PARTS.some(
    (part) => normalized === part || normalized.startsWith(part) || normalized.endsWith(part)
  )
}

function assertPublicEvidenceValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicEvidenceValue(item, `${path}[${index}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveEvidenceKey(key)) {
      throw new TypeError(`[ingest] public request evidence rejects sensitive field ${path}.${key}`)
    }
    assertPublicEvidenceValue(child, `${path}.${key}`)
  }
}

/**
 * Stable caller-declared public projection of one leaderboard request. It is
 * not the wire-request identity: actual URLs, headers, and unselected request
 * fields stay outside this contract. Adapters must construct this value from
 * an explicit allowlist of public endpoint and pagination fields.
 */
export function leaderboardPublicRequestProjection(
  input: LeaderboardPublicRequestProjectionInput,
  pageBinding: LeaderboardNumericPageBinding
): LeaderboardPublicRequestProjection {
  if (input.method !== 'GET' && input.method !== 'POST') {
    throw new TypeError('[ingest] leaderboard request method must be GET or POST')
  }
  if (input.method === 'GET' && input.body !== undefined && input.body !== null) {
    throw new TypeError('[ingest] GET leaderboard requests must not declare an ignored body')
  }
  if (typeof input.url !== 'string' || input.url.trim() !== input.url) {
    throw new TypeError('[ingest] leaderboard request URL must be canonical and public')
  }
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    throw new TypeError('[ingest] leaderboard request URL must be canonical and public')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('[ingest] leaderboard request URL must be canonical and public')
  }
  for (const key of url.searchParams.keys()) {
    if (isSensitiveEvidenceKey(key)) {
      throw new TypeError(`[ingest] public request evidence rejects sensitive query field ${key}`)
    }
  }

  if (
    input.method === 'POST' &&
    input.body !== undefined &&
    input.body !== null &&
    (typeof input.body !== 'object' || Array.isArray(input.body))
  ) {
    throw new TypeError('[ingest] public POST request evidence body must be a JSON object or null')
  }

  const canonicalBody: unknown = JSON.parse(
    strictCanonicalJson(input.method === 'GET' ? null : (input.body ?? null))
  )
  assertPublicEvidenceValue(canonicalBody, 'body')
  const canonicalBinding = JSON.parse(
    strictCanonicalJson(pageBinding)
  ) as LeaderboardNumericPageBinding
  const requestPageIndex = pageIndexFromPublicProjection(url, canonicalBody, canonicalBinding)

  const projection: LeaderboardPublicRequestProjection = {
    data_contract: LEADERBOARD_PUBLIC_REQUEST_PROJECTION_CONTRACT,
    method: input.method,
    url: url.href,
    body: canonicalBody,
    pagination_binding: canonicalBinding,
    request_page_index: requestPageIndex,
  }
  return deepFreezeJson(
    JSON.parse(strictCanonicalJson(projection)) as LeaderboardPublicRequestProjection
  ) as LeaderboardPublicRequestProjection
}

export function leaderboardPublicRequestSha256(
  input: LeaderboardPublicRequestProjectionInput,
  pageBinding: LeaderboardNumericPageBinding
): string {
  return strictCanonicalSha256(leaderboardPublicRequestProjection(input, pageBinding))
}

type ManifestTerminationReason = BuildLeaderboardAcquisitionManifestInput['termination_reason']

export type NumericLeaderboardTerminationReason = Extract<
  ManifestTerminationReason,
  | 'reported_population_reached'
  | 'reported_page_count_reached'
  | 'short_page'
  | 'empty_page'
  | 'degenerate_page'
  | 'caller_limit'
  | 'safety_limit'
  | 'upstream_error'
>

type NumericPaginationPosition = Extract<
  LeaderboardAcquisitionPaginationPosition,
  { kind: 'page_index' }
>

export interface CapturedLeaderboardSourcePage {
  rawPage: RawPage
  /** Rows in the upstream collection before parser validation or dedupe. */
  sourceRowCount: number
  requestSha256: string
  httpStatus: number
  paginationPosition: NumericPaginationPosition
  sourceReports: {
    population: LeaderboardAcquisitionReportEvidence
    page_count: LeaderboardAcquisitionReportEvidence
    current_page: LeaderboardAcquisitionReportEvidence
    page_size: LeaderboardAcquisitionReportEvidence
  }
}

export interface LeaderboardCapture {
  /** Exact parsed JSON response values, including terminal/error responses. */
  sourcePages: CapturedLeaderboardSourcePage[]
  /** Successful non-empty, non-degenerate pages safe to hand to the parser. */
  parsePages: RawPage[]
  terminationReason: NumericLeaderboardTerminationReason
  captureConfig: BuildLeaderboardAcquisitionManifestInput['capture_config']
  /** Every parser page is the exact RawPage at the listed 1-based source ordinal. */
  parserTransformation: Extract<
    LeaderboardAcquisitionParserTransformation,
    { kind: 'identity_projection' }
  >
}

/**
 * An upstream transport, HTTP, or response-validation failure is both durable
 * evidence and a failed job attempt. A null status means no canonical HTTP
 * response was available. The caller persists `capture` in its failed-run
 * transaction, then rethrows so the queue retry policy remains active.
 */
export class LeaderboardCaptureUpstreamError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly publicUrl: string,
    public readonly capture: LeaderboardCapture,
    public readonly cause: Error
  ) {
    super(
      status === null
        ? `[ingest] leaderboard capture failed before a canonical response for ${publicUrl}: ${cause.message}`
        : `[ingest] leaderboard capture upstream ${status} for ${publicUrl}: ${cause.message}`
    )
    this.name = 'LeaderboardCaptureUpstreamError'
  }
}

export interface NumericLeaderboardPageMeta {
  /** Upstream collection length before parser validation or dedupe. */
  rowCount: number
  reportedPopulation: number | null
  reportedPageCount: number | null
  reportedCurrentPage: number | null
  reportedPageSize: number | null
}

export interface CaptureNumericLeaderboardOptions {
  session: FetchSession
  fetcher: JsonFetcher
  /** Actual request, which may contain credentials and is never persisted. */
  buildRequest: (pageIndex: number) => ReplayRequestTemplate
  /**
   * Required allowlisted public projection. Build this separately; never copy
   * an authenticated actual URL/body wholesale. This URL is persisted in RAW.
   */
  projectPublicRequest: (
    actualRequest: ReplayRequestTemplate,
    pageIndex: number
  ) => LeaderboardPublicRequestProjectionInput
  /** Public query/body path whose exact value binds the canonical 1-based page. */
  pageBinding: LeaderboardNumericPageBinding
  extractMeta: (payload: unknown) => NumericLeaderboardPageMeta
  pageSize: number | null
  isDegenerate?: (payload: unknown) => boolean
  /** Optional validation/smoke cap. It only counts as limiting if reached. */
  callerPageCap?: number | null
  /** Absolute loop guard, independent of source configuration. */
  safetyPageCap?: number
  /** Test hook; production uses canonical UTC timestamps from Date. */
  now?: () => string
}

function assertSafeInteger(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
    const qualifier = minimum === 0 ? 'non-negative' : 'positive'
    throw new TypeError(
      `[ingest] ${label} must be a ${qualifier} safe integer and not negative zero`
    )
  }
}

function assertOptionalReport(value: number | null, label: string): void {
  if (value !== null) assertSafeInteger(value, label, 0)
}

function reportEvidence(value: number | null): LeaderboardAcquisitionReportEvidence {
  return value === null ? { state: 'not_reported' } : { state: 'reported', value }
}

function canonicalTimestamp(now: () => string): string {
  const value = now()
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError('[ingest] capture clock must return a canonical ISO timestamp')
  }
  return value
}

function deepFreezeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child)
  return Object.freeze(value)
}

function canonicalFrozenSnapshot(value: unknown): unknown {
  return deepFreezeJson(JSON.parse(strictCanonicalJson(value)))
}

function canonicalPositivePageIndex(value: unknown): number {
  const numeric = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof numeric !== 'number') {
    throw new TypeError('[ingest] public request page binding must resolve to a positive integer')
  }
  assertSafeInteger(numeric, 'public request page binding', 1)
  return numeric
}

function pageIndexFromPublicProjection(
  url: URL,
  body: unknown,
  binding: LeaderboardNumericPageBinding
): number {
  if (binding.location === 'query') {
    if (binding.key.length === 0 || binding.key.trim() !== binding.key) {
      throw new TypeError('[ingest] public query page binding key must be canonical')
    }
    const values = url.searchParams.getAll(binding.key)
    if (values.length !== 1) {
      throw new TypeError('[ingest] public query page binding must resolve exactly once')
    }
    return canonicalPositivePageIndex(values[0])
  }

  if (
    binding.path.length === 0 ||
    binding.path.some((segment) => segment.length === 0 || segment.trim() !== segment)
  ) {
    throw new TypeError('[ingest] public body page binding path must be non-empty and canonical')
  }
  let value = body
  for (const segment of binding.path) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      throw new TypeError('[ingest] public body page binding path must exist')
    }
    value = (value as Record<string, unknown>)[segment]
  }
  return canonicalPositivePageIndex(value)
}

function canonicalRequestTemplate(input: ReplayRequestTemplate): ReplayRequestTemplate {
  const url = absoluteHttpUrl(input.url, 'actual leaderboard request URL')
  const body = input.body === undefined ? undefined : canonicalFrozenSnapshot(input.body)
  return Object.freeze({
    url: url.href,
    method: input.method,
    headers: canonicalFrozenSnapshot(input.headers) as Record<string, string>,
    ...(body === undefined ? {} : { body }),
  })
}

function absoluteHttpUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`[ingest] ${label} must be an absolute HTTP(S) URL`)
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(`[ingest] ${label} must be an absolute HTTP(S) URL without credentials`)
  }
  return url
}

function assertPublicProjectionOfActualRequest(
  actual: ReplayRequestTemplate,
  projection: LeaderboardPublicRequestProjection
): void {
  if (projection.method !== actual.method) {
    throw new TypeError('[ingest] public request method must match the actual request method')
  }
  const actualUrl = absoluteHttpUrl(actual.url, 'actual leaderboard request URL')
  const publicUrl = new URL(projection.url)
  if (publicUrl.origin !== actualUrl.origin || publicUrl.pathname !== actualUrl.pathname) {
    throw new TypeError(
      '[ingest] public request URL must retain the actual request origin and path'
    )
  }

  const remainingActualQuery = [...actualUrl.searchParams.entries()]
  for (const publicEntry of publicUrl.searchParams.entries()) {
    const index = remainingActualQuery.findIndex(
      ([key, value]) => key === publicEntry[0] && value === publicEntry[1]
    )
    if (index < 0) {
      throw new TypeError(
        '[ingest] public request query must be an exact subset of the actual query'
      )
    }
    remainingActualQuery.splice(index, 1)
  }

  if (actual.method === 'GET') {
    if (actual.body !== undefined && actual.body !== null) {
      throw new TypeError('[ingest] actual GET leaderboard requests must not declare a body')
    }
    return
  }
  const actualBody = actual.body ?? null
  if (actualBody !== null && (typeof actualBody !== 'object' || Array.isArray(actualBody))) {
    throw new TypeError(
      '[ingest] actual POST leaderboard request body must be a JSON object or null'
    )
  }
  if (projection.body === null) return
  if (actualBody === null) {
    throw new TypeError(
      '[ingest] public request body cannot add fields absent from the actual body'
    )
  }

  const actualRecord = actualBody as Record<string, unknown>
  const publicRecord = projection.body as Record<string, unknown>
  for (const [key, value] of Object.entries(publicRecord)) {
    if (
      !Object.prototype.hasOwnProperty.call(actualRecord, key) ||
      strictCanonicalJson(actualRecord[key]) !== strictCanonicalJson(value)
    ) {
      throw new TypeError(
        '[ingest] public request body must be an exact field subset of actual body'
      )
    }
  }
}

class CapturedHttpResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseJson: unknown,
    url: string
  ) {
    super(`[ingest] leaderboard replay ${status} for ${url}`)
    this.name = 'CapturedHttpResponseError'
  }
}

class CapturedBlockedHttpResponseError extends BlockedUpstreamError {
  constructor(
    status: number,
    public readonly responseJson: unknown,
    url: string
  ) {
    super(status, url)
    this.name = 'CapturedBlockedHttpResponseError'
  }
}

function capturedHttpFailure(
  error: unknown
): CapturedHttpResponseError | CapturedBlockedHttpResponseError | null {
  return error instanceof CapturedHttpResponseError ||
    error instanceof CapturedBlockedHttpResponseError
    ? error
    : null
}

interface ConsistentReport {
  value: number | null
  conflicting: boolean
}

function addReport(report: ConsistentReport, value: number | null): void {
  if (value === null || report.conflicting) return
  if (report.value === null) report.value = value
  else if (report.value !== value) report.conflicting = true
}

/**
 * Collect one numeric Tier-A board without losing the evidence needed to
 * distinguish natural completion from caller/safety truncation. This helper
 * does not publish or assess rank eligibility; it only returns captured facts.
 */
export async function captureNumericLeaderboard(
  opts: CaptureNumericLeaderboardOptions
): Promise<LeaderboardCapture> {
  const { session, fetcher, buildRequest, projectPublicRequest, extractMeta, isDegenerate } = opts
  const safetyPageCap = opts.safetyPageCap ?? 5_000
  const callerPageCap = opts.callerPageCap ?? null
  const pageSize = opts.pageSize
  const pageBinding = canonicalFrozenSnapshot(opts.pageBinding) as LeaderboardNumericPageBinding
  const now = opts.now ?? (() => new Date().toISOString())

  assertSafeInteger(safetyPageCap, 'safety page cap', 1)
  if (callerPageCap !== null) assertSafeInteger(callerPageCap, 'caller page cap', 1)
  if (pageSize !== null) assertSafeInteger(pageSize, 'page size', 1)

  const sourcePages: CapturedLeaderboardSourcePage[] = []
  const parsePages: RawPage[] = []
  const parseSourceOrdinals: number[] = []
  const populationReport: ConsistentReport = { value: null, conflicting: false }
  const pageCountReport: ConsistentReport = { value: null, conflicting: false }
  let rowsSeen = 0
  const finish = (terminationReason: NumericLeaderboardTerminationReason): LeaderboardCapture =>
    deepFreezeJson({
      sourcePages: [...sourcePages],
      parsePages: [...parsePages],
      terminationReason,
      captureConfig: {
        caller_page_cap: callerPageCap,
        safety_page_cap: safetyPageCap,
      },
      parserTransformation: {
        kind: 'identity_projection',
        source_page_ordinals: [...parseSourceOrdinals],
      },
    }) as LeaderboardCapture

  for (let pageIndex = 1; pageIndex <= safetyPageCap; pageIndex += 1) {
    const template = canonicalRequestTemplate(buildRequest(pageIndex))
    const publicRequest = leaderboardPublicRequestProjection(
      projectPublicRequest(template, pageIndex),
      pageBinding
    )
    assertPublicProjectionOfActualRequest(template, publicRequest)
    if (publicRequest.request_page_index !== pageIndex) {
      throw new TypeError('[ingest] actual request page index must match the capture page index')
    }
    const requestSha256 = strictCanonicalSha256(publicRequest)
    const paginationPosition: NumericPaginationPosition = {
      kind: 'page_index',
      request_page_index: pageIndex,
    }

    let status: number
    let payload: unknown
    const fetcherFailure: { caught: boolean; cause: unknown } = {
      caught: false,
      cause: undefined,
    }
    try {
      const response = await session.paced(async () => {
        let fetched: JsonResponse
        try {
          fetched = await fetcher(template)
        } catch (cause) {
          // Remember the exact rejected value without wrapping it inside the
          // paced callback. Rate/circuit accounting must observe the original
          // transport failure; the durable capture wrapper is added outside.
          fetcherFailure.caught = true
          fetcherFailure.cause = cause
          throw cause
        }
        assertSafeInteger(fetched.status, 'HTTP status', 1)
        if (fetched.status < 100 || fetched.status > 599) {
          throw new TypeError('[ingest] HTTP status must be between 100 and 599')
        }
        const responseJson = canonicalFrozenSnapshot(fetched.json)
        if (isBlockedStatus(fetched.status)) {
          throw new CapturedBlockedHttpResponseError(
            fetched.status,
            responseJson,
            publicRequest.url
          )
        }
        if (fetched.status < 200 || fetched.status >= 300) {
          throw new CapturedHttpResponseError(fetched.status, responseJson, publicRequest.url)
        }
        return { status: fetched.status, payload: responseJson }
      })
      status = response.status
      payload = response.payload
    } catch (error) {
      const failure = capturedHttpFailure(error)
      if (!failure) {
        const fetcherRejected = fetcherFailure.caught && error === fetcherFailure.cause
        if (!fetcherRejected && !(error instanceof CircuitOpenError)) throw error
        const transportError =
          error instanceof Error
            ? error
            : new Error(`[ingest] leaderboard transport failed: ${String(error)}`)
        throw new LeaderboardCaptureUpstreamError(
          null,
          publicRequest.url,
          finish('upstream_error'),
          transportError
        )
      }

      const rawPage: RawPage = Object.freeze({
        pageIndex,
        payload: failure.responseJson,
        url: publicRequest.url,
        fetchedAt: canonicalTimestamp(now),
      })
      sourcePages.push({
        rawPage,
        sourceRowCount: 0,
        requestSha256,
        httpStatus: failure.status,
        paginationPosition,
        sourceReports: {
          population: { state: 'not_reported' },
          page_count: { state: 'not_reported' },
          current_page: { state: 'not_reported' },
          page_size: { state: 'not_reported' },
        },
      })
      throw new LeaderboardCaptureUpstreamError(
        failure.status,
        publicRequest.url,
        finish('upstream_error'),
        failure
      )
    }

    const rawPage: RawPage = Object.freeze({
      pageIndex,
      payload,
      url: publicRequest.url,
      fetchedAt: canonicalTimestamp(now),
    })

    let meta: NumericLeaderboardPageMeta
    try {
      const extractedMeta = extractMeta(payload)
      meta = {
        rowCount: extractedMeta.rowCount,
        reportedPopulation: extractedMeta.reportedPopulation,
        reportedPageCount: extractedMeta.reportedPageCount,
        reportedCurrentPage: extractedMeta.reportedCurrentPage,
        reportedPageSize: extractedMeta.reportedPageSize,
      }
      assertSafeInteger(meta.rowCount, 'source row count', 0)
      assertOptionalReport(meta.reportedPopulation, 'reported population')
      assertOptionalReport(meta.reportedPageCount, 'reported page count')
      assertOptionalReport(meta.reportedCurrentPage, 'reported current page')
      assertOptionalReport(meta.reportedPageSize, 'reported page size')
    } catch (cause) {
      const validationError =
        cause instanceof Error
          ? cause
          : new Error(`[ingest] leaderboard response validation failed: ${String(cause)}`)
      sourcePages.push({
        rawPage,
        sourceRowCount: 0,
        requestSha256,
        httpStatus: status,
        paginationPosition,
        sourceReports: {
          population: { state: 'not_reported' },
          page_count: { state: 'not_reported' },
          current_page: { state: 'not_reported' },
          page_size: { state: 'not_reported' },
        },
      })
      throw new LeaderboardCaptureUpstreamError(
        status,
        publicRequest.url,
        finish('upstream_error'),
        validationError
      )
    }
    addReport(populationReport, meta.reportedPopulation)
    addReport(pageCountReport, meta.reportedPageCount)

    sourcePages.push({
      rawPage,
      sourceRowCount: meta.rowCount,
      requestSha256,
      httpStatus: status,
      paginationPosition,
      sourceReports: {
        population: reportEvidence(meta.reportedPopulation),
        page_count: reportEvidence(meta.reportedPageCount),
        current_page: reportEvidence(meta.reportedCurrentPage),
        page_size: reportEvidence(meta.reportedPageSize),
      },
    })

    if (meta.rowCount === 0) {
      return finish('empty_page')
    }

    if (isDegenerate?.(payload)) {
      return finish('degenerate_page')
    }

    rowsSeen += meta.rowCount
    assertSafeInteger(rowsSeen, 'cumulative source row count', 0)
    parsePages.push(rawPage)
    parseSourceOrdinals.push(sourcePages.length)

    if (
      !populationReport.conflicting &&
      populationReport.value !== null &&
      rowsSeen >= populationReport.value
    ) {
      return finish('reported_population_reached')
    }
    if (
      !pageCountReport.conflicting &&
      pageCountReport.value !== null &&
      pageIndex === pageCountReport.value
    ) {
      return finish('reported_page_count_reached')
    }
    if (pageSize !== null && meta.rowCount < pageSize) {
      return finish('short_page')
    }
    if (callerPageCap !== null && callerPageCap <= safetyPageCap && pageIndex >= callerPageCap) {
      return finish('caller_limit')
    }
    if (pageIndex >= safetyPageCap) {
      return finish('safety_limit')
    }
  }

  throw new Error('[ingest] numeric leaderboard capture exited without a termination reason')
}

export interface ReplayPagedOptions {
  session: FetchSession
  fetcher: JsonFetcher
  /** Build the request for a 1-based page index (mutate page/cursor params). */
  buildRequest: (pageIndex: number) => ReplayRequestTemplate
  /** Extract row count + source-reported total from a payload. */
  extractMeta: (payload: unknown) => { rowCount: number; reportedTotal: number | null }
  /** Expected page size (sources.page_size); null = stop only on empty page. */
  pageSize: number | null
  /** Degenerate-page predicate (spec §5.6 XT rule). */
  isDegenerate?: (payload: unknown) => boolean
  /** Consecutive degenerate pages before stopping (default 1). */
  degenerateStopAfter?: number
  /** Hard safety cap. */
  maxPages?: number
}

/**
 * Replay a paginated endpoint page by page. Yields RawPages; the caller
 * persists them to the RAW layer and parses afterwards. Randomized request
 * order within a page is NOT applied here (pagination must be sequential);
 * adapters randomize across traders instead (spec §4).
 */
export async function* replayPaged(opts: ReplayPagedOptions): AsyncGenerator<RawPage> {
  const {
    session,
    fetcher,
    buildRequest,
    extractMeta,
    pageSize,
    isDegenerate,
    degenerateStopAfter = 1,
    maxPages = 5_000,
  } = opts

  let reportedTotal: number | null = null
  let rowsSeen = 0
  let pagesFetched = 0
  let consecutiveDegenerate = 0
  let lastPageRowCount = 0

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    const template = buildRequest(pageIndex)
    const payload = await replayJson(session, fetcher, template)

    pagesFetched += 1
    const meta = extractMeta(payload)
    if (meta.reportedTotal !== null) reportedTotal = meta.reportedTotal
    lastPageRowCount = meta.rowCount

    if (meta.rowCount === 0) break

    if (isDegenerate?.(payload)) {
      consecutiveDegenerate += 1
      if (consecutiveDegenerate >= degenerateStopAfter) break
    } else {
      consecutiveDegenerate = 0
      rowsSeen += meta.rowCount
      yield {
        pageIndex,
        payload,
        url: template.url,
        fetchedAt: new Date().toISOString(),
      }
    }

    // Natural end: a short page means there is no next page.
    if (pageSize !== null && meta.rowCount < pageSize) break
    // Reported-total end: we have everything the source claims to have.
    if (reportedTotal !== null && rowsSeen >= reportedTotal) break
  }

  // Completeness assertion (spec §5.6): the crawl must end naturally — last
  // page short or empty — OR cover the reported total. Ending on a FULL page
  // while short of the total means pagination was truncated (e.g. maxPages
  // hit, or the endpoint stopped advancing). A degenerate stop is legitimate
  // truncation (XT) — reportedTotal there is meaningless.
  const endedNaturally =
    lastPageRowCount === 0 || (pageSize !== null && lastPageRowCount < pageSize)
  if (
    reportedTotal !== null &&
    consecutiveDegenerate === 0 &&
    rowsSeen < reportedTotal &&
    !endedNaturally
  ) {
    throw new IncompleteCrawlError({ pagesFetched, pageSize, reportedTotal, rowsSeen })
  }
}
