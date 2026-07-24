/**
 * Reviewed public-request contracts for provider-native leaderboard windows.
 *
 * A manifest timeframe label alone is not evidence that the upstream was
 * asked for that timeframe. These contracts independently reconstruct the
 * credential-free request projection captured by the adapter and compare its
 * digest page by page. Unknown sources and any drift fail closed.
 */

import type {
  LeaderboardAcquisitionManifest,
  LeaderboardAcquisitionManifestV3,
} from './acquisition-manifest'
import { LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT } from './acquisition-manifest'
import type { RankingTimeframe } from './core/types'
import {
  leaderboardPublicRequestSha256,
  type LeaderboardPublicRequestProjectionInput,
} from './fetch/capture'
import type { ReplayRequestTemplate } from './fetch/types'
import { buildOkxWeb3LeaderboardListUrl } from './adapters/okx-web3/request-evidence'

export const BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT =
  'arena.metric-trust.binance-native-period-request@1' as const
export const BINANCE_SINGLE_RESPONSE_POPULATION_CONTRACT =
  'arena.metric-trust.binance-single-response-population@1' as const
export const OKX_WEB3_SOLANA_NATIVE_PERIOD_REQUEST_CONTRACT =
  'arena.metric-trust.okx-web3-solana-native-period-request@1' as const
export const OKX_WEB3_SOLANA_SINGLE_RESPONSE_POPULATION_CONTRACT =
  'arena.metric-trust.okx-web3-solana-single-response-population@1' as const
export const BINANCE_NATIVE_WINDOW_MAX_PAGE_SKEW_MS = 5 * 60 * 1000

export const BINANCE_LEADERBOARD_LIST_URLS = Object.freeze({
  futures:
    'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
  spot: 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list',
})

const BINANCE_DEFAULT_PAGE_SIZE = 20
const OKX_WEB3_DEFAULT_PAGE_SIZE = 20
const BINANCE_PAGE_BINDING = Object.freeze({
  location: 'body' as const,
  path: ['pageNumber'],
})

type NativePeriodRequestContractId =
  | typeof BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT
  | typeof OKX_WEB3_SOLANA_NATIVE_PERIOD_REQUEST_CONTRACT

type SingleResponsePopulationContractId =
  | typeof BINANCE_SINGLE_RESPONSE_POPULATION_CONTRACT
  | typeof OKX_WEB3_SOLANA_SINGLE_RESPONSE_POPULATION_CONTRACT

export interface BinanceLeaderboardListBody {
  pageNumber: number
  pageSize: number
  timeRange: `${RankingTimeframe}D`
  dataType: 'ROI'
  favoriteOnly: false
  hideFull: false
  nickname: ''
  order: 'DESC'
  userAsset: 0
  portfolioType: 'ALL'
  useAiRecommended: false
}

const PUBLIC_LIST_BODY_FIELDS = [
  'pageNumber',
  'pageSize',
  'timeRange',
  'dataType',
  'favoriteOnly',
  'hideFull',
  'nickname',
  'order',
  'userAsset',
  'portfolioType',
  'useAiRecommended',
] as const satisfies readonly (keyof BinanceLeaderboardListBody)[]

type LeaderboardMetricTrustManifest =
  | LeaderboardAcquisitionManifest
  | LeaderboardAcquisitionManifestV3

type BinanceBoard = keyof typeof BINANCE_LEADERBOARD_LIST_URLS

interface NativePeriodExpectedPageInput {
  pageIndex: number
  pageSize: number
  timeframe: RankingTimeframe
}

interface ReviewedNativePeriodSourceContract {
  adapterSlug: 'binance' | 'okx_web3'
  defaultPageSize: number
  requestContractId: NativePeriodRequestContractId
  populationContractId: SingleResponsePopulationContractId
  maxPageSkewMs: number
  paginationSnapshot: 'live_offset'
  requireReportedPageBinding: boolean
  /**
   * Reviewed provider semantics: the request selects the native ROI/PnL period
   * shown by the provider board. Arena does not claim to reconstruct the
   * provider's internal trades, prices, or cost basis from this request.
   */
  windowSemantics: 'provider_native_period_aggregate'
  buildExpectedPage(
    input: NativePeriodExpectedPageInput
  ): Readonly<{ url: string; requestSha256: string }>
}

function binanceSourceContract(board: BinanceBoard): ReviewedNativePeriodSourceContract {
  return Object.freeze({
    adapterSlug: 'binance' as const,
    defaultPageSize: BINANCE_DEFAULT_PAGE_SIZE,
    requestContractId: BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT,
    populationContractId: BINANCE_SINGLE_RESPONSE_POPULATION_CONTRACT,
    maxPageSkewMs: BINANCE_NATIVE_WINDOW_MAX_PAGE_SKEW_MS,
    paginationSnapshot: 'live_offset' as const,
    requireReportedPageBinding: false,
    windowSemantics: 'provider_native_period_aggregate' as const,
    buildExpectedPage: (input: NativePeriodExpectedPageInput) => {
      const url = BINANCE_LEADERBOARD_LIST_URLS[board]
      return Object.freeze({
        url,
        requestSha256: leaderboardPublicRequestSha256(
          {
            method: 'POST',
            url,
            body: buildBinanceLeaderboardListBody(input.pageIndex, input.pageSize, input.timeframe),
          },
          BINANCE_PAGE_BINDING
        ),
      })
    },
  })
}

const REVIEWED_NATIVE_PERIOD_SOURCES: Readonly<Record<string, ReviewedNativePeriodSourceContract>> =
  Object.freeze({
    binance_futures: binanceSourceContract('futures'),
    binance_spot: binanceSourceContract('spot'),
    okx_web3_solana: Object.freeze({
      adapterSlug: 'okx_web3',
      defaultPageSize: OKX_WEB3_DEFAULT_PAGE_SIZE,
      requestContractId: OKX_WEB3_SOLANA_NATIVE_PERIOD_REQUEST_CONTRACT,
      populationContractId: OKX_WEB3_SOLANA_SINGLE_RESPONSE_POPULATION_CONTRACT,
      maxPageSkewMs: BINANCE_NATIVE_WINDOW_MAX_PAGE_SKEW_MS,
      paginationSnapshot: 'live_offset',
      requireReportedPageBinding: true,
      windowSemantics: 'provider_native_period_aggregate',
      buildExpectedPage: (input: NativePeriodExpectedPageInput) => {
        const url = buildOkxWeb3LeaderboardListUrl(input)
        return Object.freeze({
          url,
          requestSha256: okxWeb3LeaderboardListRequestSha256(input),
        })
      },
    }),
  })

function reviewedNativePeriodSourceContract(
  sourceSlug: string
): ReviewedNativePeriodSourceContract | null {
  return Object.prototype.hasOwnProperty.call(REVIEWED_NATIVE_PERIOD_SOURCES, sourceSlug)
    ? REVIEWED_NATIVE_PERIOD_SOURCES[sourceSlug]
    : null
}

export type LeaderboardCaptureDiagnostic =
  | 'capture_not_rankable'
  | 'attempt_binding_unavailable'
  | 'source_contract_unavailable'
  | 'source_contract_mismatch'
  | 'page_binding_mismatch'
  | 'page_timestamp_invalid'
  | 'page_time_span_exceeds_tolerance'
  | 'pagination_snapshot_unavailable'
  | 'provider_window_boundary_unavailable'
  | 'request_digest_mismatch'

/** Compatibility alias retained for existing consumers. */
export type BinanceLeaderboardCaptureDiagnostic = LeaderboardCaptureDiagnostic

export type NativeWindowRequestEvidence =
  | {
      /** The public request projection matched; this is not provider boundary authority. */
      state: 'request_verified'
      contractId: NativePeriodRequestContractId
      semantics: 'provider_native_period_aggregate'
      reason: 'native_window_boundary_unverified'
      diagnostic: 'provider_window_boundary_unavailable'
    }
  | {
      state: 'unknown'
      reason: 'native_window_boundary_unverified'
      diagnostic: LeaderboardCaptureDiagnostic
    }

export type CaptureAuthorityDiagnostic = Exclude<
  BinanceLeaderboardCaptureDiagnostic,
  'provider_window_boundary_unavailable'
>

export type PopulationAuthorityDiagnostic = Exclude<
  CaptureAuthorityDiagnostic,
  'page_timestamp_invalid' | 'page_time_span_exceeds_tolerance'
>

export type PopulationAuthorityEvidence =
  | {
      state: 'verified'
      contractId: SingleResponsePopulationContractId
      semantics: 'reviewed_board_single_response_population'
    }
  | {
      state: 'unknown'
      diagnostics: readonly PopulationAuthorityDiagnostic[]
    }

export type RequestAuthorityDiagnostic = Extract<
  LeaderboardCaptureDiagnostic,
  | 'capture_not_rankable'
  | 'source_contract_unavailable'
  | 'source_contract_mismatch'
  | 'page_binding_mismatch'
  | 'request_digest_mismatch'
>

export type RequestAuthorityEvidence =
  | {
      state: 'verified'
      contractId: NativePeriodRequestContractId
      semantics: 'provider_native_period_aggregate'
    }
  | {
      state: 'unknown'
      diagnostics: readonly RequestAuthorityDiagnostic[]
    }

export interface LeaderboardMetricAuthorities {
  /** Exact reviewed endpoint/body/page request binding. */
  request: RequestAuthorityEvidence
  /** Whether the rows are one complete instance of the reviewed board population. */
  population: PopulationAuthorityEvidence
  /** Provider-native period request plus exact boundary authority. */
  window: NativeWindowRequestEvidence
  /** Stable, de-duplicated diagnostics for observation blockers. */
  diagnostics: readonly CaptureAuthorityDiagnostic[]
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && value > 0
}

function rankingTimeframe(value: number): value is RankingTimeframe {
  return value === 7 || value === 30 || value === 90
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function buildBinanceLeaderboardListBody(
  pageIndex: number,
  pageSize: number,
  timeframe: RankingTimeframe
): BinanceLeaderboardListBody {
  if (!positiveSafeInteger(pageIndex)) {
    throw new TypeError('[binance] leaderboard page index must be a positive safe integer')
  }
  if (!positiveSafeInteger(pageSize)) {
    throw new TypeError('[binance] leaderboard page size must be a positive safe integer')
  }
  if (!rankingTimeframe(timeframe)) {
    throw new TypeError('[binance] leaderboard timeframe must be 7, 30, or 90 days')
  }
  return Object.freeze({
    pageNumber: pageIndex,
    pageSize,
    timeRange: `${timeframe}D`,
    dataType: 'ROI',
    favoriteOnly: false,
    hideFull: false,
    nickname: '',
    order: 'DESC',
    userAsset: 0,
    portfolioType: 'ALL',
    useAiRecommended: false,
  })
}

/** Explicit allowlist: credentials and adapter-only fields never enter RAW provenance. */
export function projectBinanceLeaderboardRequest(
  request: ReplayRequestTemplate
): LeaderboardPublicRequestProjectionInput {
  if (request.method !== 'POST') {
    throw new TypeError('[binance] leaderboard request must be POST')
  }
  const publicUrl = new URL(request.url)
  if ([...publicUrl.searchParams].length > 0) {
    throw new TypeError('[binance] leaderboard list endpoint must not contain query parameters')
  }
  const body = recordOf(request.body)
  if (!body) throw new TypeError('[binance] leaderboard request body must be an object')
  const unknownFields = Object.keys(body).filter(
    (field) => !PUBLIC_LIST_BODY_FIELDS.includes(field as (typeof PUBLIC_LIST_BODY_FIELDS)[number])
  )
  if (unknownFields.length > 0) {
    throw new TypeError(
      `[binance] leaderboard request contains non-public fields: ${unknownFields.join(', ')}`
    )
  }

  const publicBody: Record<string, unknown> = {}
  for (const field of PUBLIC_LIST_BODY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      throw new TypeError(`[binance] leaderboard request is missing public field ${field}`)
    }
    publicBody[field] = body[field]
  }
  publicUrl.hash = ''
  return { method: 'POST', url: publicUrl.href, body: publicBody }
}

export function binanceLeaderboardListRequestSha256(input: {
  sourceSlug: string
  pageIndex: number
  pageSize: number
  timeframe: RankingTimeframe
}): string | null {
  if (input.sourceSlug !== 'binance_futures' && input.sourceSlug !== 'binance_spot') return null
  return (
    reviewedNativePeriodSourceContract(input.sourceSlug)?.buildExpectedPage(input).requestSha256 ??
    null
  )
}

export function okxWeb3LeaderboardListRequestSha256(input: {
  pageIndex: number
  pageSize: number
  timeframe: RankingTimeframe
}): string {
  const url = buildOkxWeb3LeaderboardListUrl(input)
  return leaderboardPublicRequestSha256(
    { method: 'GET', url },
    { location: 'query_offset', key: 'rankStart', page_size: input.pageSize }
  )
}

const unknownEvidence = (
  diagnostic: Extract<NativeWindowRequestEvidence, { state: 'unknown' }>['diagnostic']
): NativeWindowRequestEvidence => ({
  state: 'unknown',
  reason: 'native_window_boundary_unverified',
  diagnostic,
})

interface LeaderboardCaptureInspection {
  contract: ReviewedNativePeriodSourceContract | null
  diagnostics: CaptureAuthorityDiagnostic[]
  requestDiagnostics: RequestAuthorityDiagnostic[]
  populationDiagnostics: PopulationAuthorityDiagnostic[]
}

function addDiagnostic<T extends string>(diagnostics: T[], diagnostic: T): void {
  if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic)
}

function addCaptureDiagnostic(
  inspection: LeaderboardCaptureInspection,
  diagnostic: CaptureAuthorityDiagnostic
): void {
  addDiagnostic(inspection.diagnostics, diagnostic)
}

type RequestPopulationDiagnostic = RequestAuthorityDiagnostic & PopulationAuthorityDiagnostic

function addRequestPopulationDiagnostic(
  inspection: LeaderboardCaptureInspection,
  diagnostic: RequestPopulationDiagnostic
): void {
  addCaptureDiagnostic(inspection, diagnostic)
  addDiagnostic(inspection.requestDiagnostics, diagnostic)
  addDiagnostic(inspection.populationDiagnostics, diagnostic)
}

function addPopulationDiagnostic(
  inspection: LeaderboardCaptureInspection,
  diagnostic: PopulationAuthorityDiagnostic
): void {
  addCaptureDiagnostic(inspection, diagnostic)
  addDiagnostic(inspection.populationDiagnostics, diagnostic)
}

/**
 * Independently assess request binding and population snapshot authority.
 * Multiple diagnostics are retained because a v2 multi-page run can lack both
 * an attempt fence and a provider snapshot cursor at the same time.
 */
function inspectLeaderboardCapture(
  manifest: LeaderboardMetricTrustManifest
): LeaderboardCaptureInspection {
  const inspection: LeaderboardCaptureInspection = {
    contract: null,
    diagnostics: [],
    requestDiagnostics: [],
    populationDiagnostics: [],
  }
  const captureEvidenceUnavailable =
    manifest.capture_evidence_state !== 'verified' ||
    manifest.runner_git_sha === null ||
    manifest.source_pages.length === 0
  if (
    captureEvidenceUnavailable ||
    manifest.assessment.acquisition_state !== 'complete' ||
    manifest.assessment.population_state !== 'verified' ||
    manifest.caller_limited ||
    manifest.safety_limited
  ) {
    if (captureEvidenceUnavailable) {
      addRequestPopulationDiagnostic(inspection, 'capture_not_rankable')
    } else {
      addPopulationDiagnostic(inspection, 'capture_not_rankable')
    }
  }

  if (manifest.data_contract !== LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT) {
    addPopulationDiagnostic(inspection, 'attempt_binding_unavailable')
  }

  const contract = reviewedNativePeriodSourceContract(manifest.source.slug)
  if (!contract) {
    addRequestPopulationDiagnostic(inspection, 'source_contract_unavailable')
    return inspection
  }
  inspection.contract = contract
  if (
    manifest.source.adapter_slug !== contract.adapterSlug ||
    manifest.source.configured_pagination_kind !== 'numeric'
  ) {
    addRequestPopulationDiagnostic(inspection, 'source_contract_mismatch')
    return inspection
  }

  const pageSize = manifest.source.configured_page_size ?? contract.defaultPageSize
  const pageTimes = manifest.source_pages.map((page) => Date.parse(page.fetched_at))
  if (pageTimes.some((pageTime) => !Number.isFinite(pageTime))) {
    addCaptureDiagnostic(inspection, 'page_timestamp_invalid')
  } else if (Math.max(...pageTimes) - Math.min(...pageTimes) > contract.maxPageSkewMs) {
    // One run-wide timestamp would overstate both temporal coherence and the
    // exact native window of late pages.
    addCaptureDiagnostic(inspection, 'page_time_span_exceeds_tolerance')
  }

  for (const [index, page] of manifest.source_pages.entries()) {
    const position = page.pagination_position
    const pageIndex = index + 1
    let expectedPage: Readonly<{ url: string; requestSha256: string }>
    try {
      expectedPage = contract.buildExpectedPage({
        pageIndex,
        pageSize,
        timeframe: manifest.timeframe,
      })
    } catch {
      addRequestPopulationDiagnostic(inspection, 'source_contract_mismatch')
      continue
    }
    const reportedCurrentPage = page.source_reports?.current_page
    const reportedPageSize = page.source_reports?.page_size
    const reportedPageBindingMismatch = contract.requireReportedPageBinding
      ? reportedCurrentPage?.state !== 'reported' ||
        reportedCurrentPage.value !== pageIndex ||
        reportedPageSize?.state !== 'reported' ||
        reportedPageSize.value !== pageSize
      : reportedPageSize?.state === 'reported' && reportedPageSize.value !== pageSize
    if (
      page.url !== expectedPage.url ||
      page.stored_page_index !== pageIndex ||
      position?.kind !== 'page_index' ||
      position.request_page_index !== pageIndex ||
      reportedPageBindingMismatch
    ) {
      addRequestPopulationDiagnostic(inspection, 'page_binding_mismatch')
    }

    if (page.request_sha256 !== expectedPage.requestSha256) {
      addRequestPopulationDiagnostic(inspection, 'request_digest_mismatch')
    }
  }

  if (manifest.source_pages.length > 1 && contract.paginationSnapshot === 'live_offset') {
    // Live numeric offsets are not snapshot cursors. Stable totals, request
    // hashes, and duplicate counts cannot prove one stitched population.
    addPopulationDiagnostic(inspection, 'pagination_snapshot_unavailable')
  }
  return inspection
}

function frozenUnknownRequest(
  diagnostics: readonly RequestAuthorityDiagnostic[]
): RequestAuthorityEvidence {
  return Object.freeze({
    state: 'unknown' as const,
    diagnostics: Object.freeze([...diagnostics]),
  })
}

function frozenUnknownPopulation(
  diagnostics: readonly PopulationAuthorityDiagnostic[]
): PopulationAuthorityEvidence {
  return Object.freeze({
    state: 'unknown' as const,
    diagnostics: Object.freeze([...diagnostics]),
  })
}

/**
 * Assess request, population, and window independently while retaining one
 * deterministic diagnostic order for persistence. A complete manifest count
 * is not, by itself, provider population authority.
 */
export function assessLeaderboardMetricAuthorities(
  manifest: LeaderboardMetricTrustManifest
): LeaderboardMetricAuthorities {
  const inspection = inspectLeaderboardCapture(manifest)
  const contract = inspection.contract
  const request: RequestAuthorityEvidence =
    contract && inspection.requestDiagnostics.length === 0
      ? Object.freeze({
          state: 'verified' as const,
          contractId: contract.requestContractId,
          semantics: contract.windowSemantics,
        })
      : frozenUnknownRequest(
          inspection.requestDiagnostics.length > 0
            ? inspection.requestDiagnostics
            : ['source_contract_unavailable']
        )
  const population: PopulationAuthorityEvidence =
    contract && inspection.populationDiagnostics.length === 0
      ? Object.freeze({
          state: 'verified' as const,
          contractId: contract.populationContractId,
          semantics: 'reviewed_board_single_response_population' as const,
        })
      : frozenUnknownPopulation(
          inspection.populationDiagnostics.length > 0
            ? inspection.populationDiagnostics
            : ['source_contract_unavailable']
        )
  const window: NativeWindowRequestEvidence =
    inspection.diagnostics.length > 0
      ? Object.freeze(unknownEvidence(inspection.diagnostics[0]))
      : request.state === 'verified'
        ? Object.freeze({
            state: 'request_verified' as const,
            contractId: request.contractId,
            semantics: request.semantics,
            reason: 'native_window_boundary_unverified' as const,
            diagnostic: 'provider_window_boundary_unavailable' as const,
          })
        : Object.freeze(unknownEvidence(request.diagnostics[0] ?? 'source_contract_unavailable'))

  return Object.freeze({
    request,
    population,
    window,
    diagnostics: Object.freeze([...inspection.diagnostics]),
  })
}

/**
 * Population authority is distinct from the manifest's count check. One exact
 * v3 response to the reviewed unfiltered request can bind one population;
 * request/filter drift and stitched numeric pages cannot. The latter remains
 * unknown until the provider exposes a snapshot/cursor contract.
 */
export function assessLeaderboardPopulationAuthority(
  manifest: LeaderboardMetricTrustManifest
): PopulationAuthorityEvidence {
  return assessLeaderboardMetricAuthorities(manifest).population
}

/**
 * Verify one complete capture against the reviewed provider-native request.
 * This proves which native period was requested; history, price, and cost-basis
 * methodology remain explicitly source-owned for source-reported metrics.
 */
export function assessLeaderboardNativeWindowRequest(
  manifest: LeaderboardMetricTrustManifest
): NativeWindowRequestEvidence {
  return assessLeaderboardMetricAuthorities(manifest).window
}
