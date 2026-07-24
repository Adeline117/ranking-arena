import type { RankingTimeframe } from '../../core/types'
import type { LeaderboardPublicRequestProjectionInput } from '../../fetch/capture'
import type { ReplayRequestTemplate } from '../../fetch/types'

export const OKX_WEB3_LEADERBOARD_LIST_URL =
  'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content' as const
export const OKX_WEB3_LEADERBOARD_PAGE_SIZE_CAP = 20
export const OKX_WEB3_CHAIN_ID = '501' as const

export const OKX_WEB3_PERIOD_TYPE: Readonly<Record<RankingTimeframe, string>> = Object.freeze({
  7: '3',
  30: '4',
  90: '5',
})

const PUBLIC_QUERY_FIELDS = [
  'rankStart',
  'rankEnd',
  'periodType',
  'rankBy',
  'label',
  'desc',
  'chainId',
] as const

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw new TypeError(`[okx_web3] ${label} must be a positive safe integer`)
  }
}

function rankingTimeframe(value: unknown): value is RankingTimeframe {
  return value === 7 || value === 30 || value === 90
}

function canonicalNonNegativeInteger(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`[okx_web3] ${label} must be a canonical non-negative integer`)
  }
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric)) {
    throw new TypeError(`[okx_web3] ${label} must be a safe integer`)
  }
  return numeric
}

function endpointUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('[okx_web3] leaderboard endpoint must be an absolute HTTP(S) URL')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('[okx_web3] leaderboard endpoint must be a public HTTP(S) URL')
  }
  return url
}

export function buildOkxWeb3LeaderboardListUrl(input: {
  endpoint?: string
  pageIndex: number
  pageSize: number
  timeframe: RankingTimeframe
}): string {
  positiveSafeInteger(input.pageIndex, 'leaderboard page index')
  positiveSafeInteger(input.pageSize, 'leaderboard page size')
  if (input.pageSize > OKX_WEB3_LEADERBOARD_PAGE_SIZE_CAP) {
    throw new TypeError(
      `[okx_web3] leaderboard page size must not exceed ${OKX_WEB3_LEADERBOARD_PAGE_SIZE_CAP}`
    )
  }
  if (!rankingTimeframe(input.timeframe)) {
    throw new TypeError('[okx_web3] leaderboard timeframe must be 7, 30, or 90 days')
  }
  const periodType = OKX_WEB3_PERIOD_TYPE[input.timeframe]

  const url = endpointUrl(input.endpoint ?? OKX_WEB3_LEADERBOARD_LIST_URL)
  if ([...url.searchParams].length > 0) {
    throw new TypeError('[okx_web3] leaderboard endpoint must not contain query parameters')
  }
  const rankStart = (input.pageIndex - 1) * input.pageSize
  const rankEnd = rankStart + input.pageSize
  if (!Number.isSafeInteger(rankStart) || !Number.isSafeInteger(rankEnd)) {
    throw new TypeError('[okx_web3] leaderboard rank bounds must be safe integers')
  }
  url.search = new URLSearchParams([
    ['rankStart', String(rankStart)],
    ['rankEnd', String(rankEnd)],
    ['periodType', periodType],
    ['rankBy', '1'],
    ['label', 'all'],
    ['desc', 'true'],
    ['chainId', OKX_WEB3_CHAIN_ID],
  ]).toString()
  return url.href
}

/** Credential-free, exact query projection shared by capture and trust verification. */
export function projectOkxWeb3LeaderboardRequest(
  request: ReplayRequestTemplate
): LeaderboardPublicRequestProjectionInput {
  if (request.method !== 'GET') {
    throw new TypeError('[okx_web3] leaderboard request must be GET')
  }
  if (request.body !== undefined && request.body !== null) {
    throw new TypeError('[okx_web3] leaderboard GET request must not contain a body')
  }
  const actualUrl = endpointUrl(request.url)
  const unknownFields = [...actualUrl.searchParams.keys()].filter(
    (field) => !PUBLIC_QUERY_FIELDS.includes(field as (typeof PUBLIC_QUERY_FIELDS)[number])
  )
  if (unknownFields.length > 0) {
    throw new TypeError(
      `[okx_web3] leaderboard request contains non-public fields: ${unknownFields.join(', ')}`
    )
  }

  const query: Record<(typeof PUBLIC_QUERY_FIELDS)[number], string> = {} as Record<
    (typeof PUBLIC_QUERY_FIELDS)[number],
    string
  >
  for (const field of PUBLIC_QUERY_FIELDS) {
    const values = actualUrl.searchParams.getAll(field)
    if (values.length !== 1) {
      throw new TypeError(`[okx_web3] leaderboard request must contain ${field} exactly once`)
    }
    query[field] = values[0]
  }

  const rankStart = canonicalNonNegativeInteger(query.rankStart, 'rankStart')
  const rankEnd = canonicalNonNegativeInteger(query.rankEnd, 'rankEnd')
  const pageSize = rankEnd - rankStart
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > OKX_WEB3_LEADERBOARD_PAGE_SIZE_CAP ||
    rankStart % pageSize !== 0
  ) {
    throw new TypeError('[okx_web3] leaderboard rank bounds must define an aligned page of 1-20')
  }
  if (!Object.values(OKX_WEB3_PERIOD_TYPE).includes(query.periodType)) {
    throw new TypeError('[okx_web3] leaderboard periodType must be 3, 4, or 5')
  }
  if (
    query.rankBy !== '1' ||
    query.label !== 'all' ||
    query.desc !== 'true' ||
    query.chainId !== OKX_WEB3_CHAIN_ID
  ) {
    throw new TypeError(
      '[okx_web3] leaderboard request filters must match the Solana all-wallet board'
    )
  }

  const publicUrl = new URL(`${actualUrl.origin}${actualUrl.pathname}`)
  for (const field of PUBLIC_QUERY_FIELDS) publicUrl.searchParams.append(field, query[field])
  return Object.freeze({ method: 'GET' as const, url: publicUrl.href })
}
