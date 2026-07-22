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

export const BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT =
  'arena.metric-trust.binance-native-period-request@1' as const
export const BINANCE_NATIVE_WINDOW_MAX_PAGE_SKEW_MS = 5 * 60 * 1000

export const BINANCE_LEADERBOARD_LIST_URLS = Object.freeze({
  futures:
    'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
  spot: 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list',
})

const BINANCE_DEFAULT_PAGE_SIZE = 20
const BINANCE_PAGE_BINDING = Object.freeze({
  location: 'body' as const,
  path: ['pageNumber'],
})

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

interface BinanceNativePeriodSourceContract {
  adapterSlug: 'binance'
  board: BinanceBoard
  /**
   * Reviewed provider semantics: timeRange selects the native ROI/PnL period
   * shown by the Binance board. Arena does not claim to reconstruct the
   * provider's internal trades, prices, or cost basis from this request.
   */
  windowSemantics: 'provider_native_period_aggregate'
}

const BINANCE_NATIVE_PERIOD_SOURCES: Readonly<Record<string, BinanceNativePeriodSourceContract>> =
  Object.freeze({
    binance_futures: Object.freeze({
      adapterSlug: 'binance',
      board: 'futures',
      windowSemantics: 'provider_native_period_aggregate',
    }),
    binance_spot: Object.freeze({
      adapterSlug: 'binance',
      board: 'spot',
      windowSemantics: 'provider_native_period_aggregate',
    }),
  })

export type NativeWindowRequestEvidence =
  | {
      state: 'verified'
      contractId: typeof BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT
      semantics: 'provider_native_period_aggregate'
    }
  | {
      state: 'unknown'
      reason: 'native_window_boundary_unverified'
      diagnostic:
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
  const contract = BINANCE_NATIVE_PERIOD_SOURCES[input.sourceSlug]
  if (!contract) return null
  return leaderboardPublicRequestSha256(
    {
      method: 'POST',
      url: BINANCE_LEADERBOARD_LIST_URLS[contract.board],
      body: buildBinanceLeaderboardListBody(input.pageIndex, input.pageSize, input.timeframe),
    },
    BINANCE_PAGE_BINDING
  )
}

const unknownEvidence = (
  diagnostic: Extract<NativeWindowRequestEvidence, { state: 'unknown' }>['diagnostic']
): NativeWindowRequestEvidence => ({
  state: 'unknown',
  reason: 'native_window_boundary_unverified',
  diagnostic,
})

/**
 * Verify one complete capture against the reviewed provider-native request.
 * This proves which native period was requested; history, price, and cost-basis
 * methodology remain explicitly source-owned for source-reported metrics.
 */
export function assessLeaderboardNativeWindowRequest(
  manifest: LeaderboardMetricTrustManifest
): NativeWindowRequestEvidence {
  if (
    manifest.capture_evidence_state !== 'verified' ||
    manifest.assessment.acquisition_state !== 'complete' ||
    manifest.assessment.population_state !== 'verified' ||
    manifest.caller_limited ||
    manifest.safety_limited ||
    manifest.runner_git_sha === null ||
    manifest.source_pages.length === 0
  ) {
    return unknownEvidence('capture_not_rankable')
  }
  // V2 publications have no latest-terminal attempt fence. A matching request
  // digest cannot compensate for that missing authority binding.
  if (manifest.data_contract !== LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT) {
    return unknownEvidence('attempt_binding_unavailable')
  }

  const contract = BINANCE_NATIVE_PERIOD_SOURCES[manifest.source.slug]
  if (!contract) return unknownEvidence('source_contract_unavailable')
  if (
    manifest.source.adapter_slug !== contract.adapterSlug ||
    manifest.source.configured_pagination_kind !== 'numeric'
  ) {
    return unknownEvidence('source_contract_mismatch')
  }

  const pageSize = manifest.source.configured_page_size ?? BINANCE_DEFAULT_PAGE_SIZE
  const expectedUrl = BINANCE_LEADERBOARD_LIST_URLS[contract.board]
  const pageTimes = manifest.source_pages.map((page) => Date.parse(page.fetched_at))
  if (pageTimes.some((pageTime) => !Number.isFinite(pageTime))) {
    return unknownEvidence('page_timestamp_invalid')
  }
  if (Math.max(...pageTimes) - Math.min(...pageTimes) > BINANCE_NATIVE_WINDOW_MAX_PAGE_SKEW_MS) {
    // Rows do not yet retain their source-page ordinal. Beyond the contract's
    // five-minute end-lag tolerance, one run-wide timestamp would overstate
    // the exact window of late pages, so the whole capture stays unknown.
    return unknownEvidence('page_time_span_exceeds_tolerance')
  }
  for (const [index, page] of manifest.source_pages.entries()) {
    const position = page.pagination_position
    const pageIndex = index + 1
    const reportedPageSize = page.source_reports?.page_size
    if (
      page.url !== expectedUrl ||
      page.stored_page_index !== pageIndex ||
      position?.kind !== 'page_index' ||
      position.request_page_index !== pageIndex ||
      (reportedPageSize?.state === 'reported' && reportedPageSize.value !== pageSize)
    ) {
      return unknownEvidence('page_binding_mismatch')
    }

    const expectedRequestSha256 = binanceLeaderboardListRequestSha256({
      sourceSlug: manifest.source.slug,
      pageIndex,
      pageSize,
      timeframe: manifest.timeframe,
    })
    if (expectedRequestSha256 === null || page.request_sha256 !== expectedRequestSha256) {
      return unknownEvidence('request_digest_mismatch')
    }
  }
  if (manifest.source_pages.length > 1) {
    // Binance's numeric pageNumber is a live offset, not a snapshot cursor.
    // A trader entering, leaving, or reordering between otherwise valid page
    // requests can omit one row and include another while total, page hashes,
    // and duplicate counts all remain stable. Until the capture binds every
    // page to one provider snapshot/cursor, a stitched population cannot prove
    // an exact native-window boundary and must remain outside ranking.
    return unknownEvidence('pagination_snapshot_unavailable')
  }
  // timeRange proves which provider-native label was requested, but Binance
  // does not return the aggregate's actual computed_at, start, or end boundary.
  // Treating fetch time as that boundary would falsely satisfy Arena's strict
  // max_window_end_lag contract even though the board may refresh later. Keep
  // the request evidence, but do not promote it to exact-window authority.
  return unknownEvidence('provider_window_boundary_unavailable')
}
