/**
 * Bitget Bots pure parsers (spec §11.5) — work on stored RAW payloads only.
 * Shapes verified by live capture 2026-06-11 (see bots.ts header).
 *
 * Money/percent semantics on the strategyPlatform family: profitRate is
 * already percent (cumulative since creation on board cards / inception
 * block; per-TF inside performances[]); amounts are quote-currency (USDT).
 * runTime / followerTime are MILLISECOND durations.
 */

import { createHash } from 'crypto'
import { LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT } from '../../acquisition-manifest'
import type {
  ParseCtx,
  ParsedCopierRow,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedProfile,
  ParsedStats,
  RankingTimeframe,
  SourceRow,
  Timeframe,
} from '../../core/types'

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

function isoFromMs(v: unknown): string | null {
  const n = num(v)
  return n === null ? null : new Date(n).toISOString()
}

function botsHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

const BOARD_FIELDS: Record<
  string,
  { strategy: 'grid' | 'martingale'; product: 'spot' | 'futures'; strategyType: number }
> = {
  spot_grid: { strategy: 'grid', product: 'spot', strategyType: 1 },
  futures_grid: { strategy: 'grid', product: 'futures', strategyType: 2 },
  spot_martingale: { strategy: 'martingale', product: 'spot', strategyType: 3 },
  futures_martingale: { strategy: 'martingale', product: 'futures', strategyType: 4 },
}

const BOT_SOURCE_CONTRACT = {
  bitget_bots_futures: {
    product: 'futures',
    boards: ['futures_grid', 'futures_martingale'],
  },
  bitget_bots_spot: {
    product: 'spot',
    boards: ['spot_grid', 'spot_martingale'],
  },
} as const

const BOT_META_FIELDS = [
  'exchange_bot_id',
  'product_id',
  'owner_account_id',
  'owner_name',
  'pair',
  'product_type',
  'strategy',
  'direction',
  'created_at_origin',
  'runtime_days',
  'profit_share_rate',
  'status',
] as const

const BOT_ENTRY_RAW_FIELDS = [
  'strategyId',
  'strategyType',
  'productId',
  'strAccountId',
  'status',
] as const

function publicationContractError(reason: string): never {
  throw new TypeError(`[bitget_bots] leaderboard publication contract failed: ${reason}`)
}

function dataRecord(value: unknown, label: string): Dict {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return publicationContractError(`${label} must be a plain data object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return publicationContractError(`${label} must be a plain data object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      return publicationContractError(`${label} cannot contain symbol properties`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      return publicationContractError(`${label}.${key} must be an enumerable data property`)
    }
  }
  return value as Dict
}

function exactDataFields(value: Dict, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    publicationContractError(`${label} fields must match the reviewed contract exactly`)
  }
}

function exactArray(value: unknown, expected: readonly unknown[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    publicationContractError(`${label} must match the reviewed contract exactly`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const enumerableKeys = Object.keys(value)
  if (
    enumerableKeys.length !== expected.length ||
    enumerableKeys.some((key, index) => key !== String(index))
  ) {
    publicationContractError(`${label} must be a dense data array`)
  }
  for (const [index, expectedValue] of expected.entries()) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || descriptor.value !== expectedValue) {
      publicationContractError(`${label} must match the reviewed contract exactly`)
    }
  }
}

function canonicalRequiredString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return publicationContractError(`${label} must be a non-empty canonical string`)
  }
  return value
}

function canonicalNullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  return canonicalRequiredString(value, label)
}

function canonicalIsoOrNull(value: unknown, label: string): string | null {
  if (value === null) return null
  const text = canonicalRequiredString(value, label)
  const millis = Date.parse(text)
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    publicationContractError(`${label} must be a canonical ISO timestamp or null`)
  }
  return text
}

function canonicalNonNegativeInteger(value: unknown, label: string): number {
  const numeric =
    typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value
  if (
    typeof numeric !== 'number' ||
    !Number.isSafeInteger(numeric) ||
    numeric < 0 ||
    Object.is(numeric, -0)
  ) {
    return publicationContractError(`${label} must be a non-negative canonical integer`)
  }
  return numeric
}

function canonicalPositiveSafeNumber(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    Object.is(value, -0)
  ) {
    return publicationContractError(`${label} must be a positive safe-integer number`)
  }
  return value
}

export function assertCanonicalBitgetBotsSource(
  src: SourceRow,
  timeframe: RankingTimeframe
): {
  product: 'spot' | 'futures'
  boards: readonly string[]
} {
  const contract = BOT_SOURCE_CONTRACT[src.slug as keyof typeof BOT_SOURCE_CONTRACT]
  if (!contract) publicationContractError(`unexpected source slug ${src.slug}`)
  if (
    src.status !== 'active' ||
    src.adapter_slug !== 'bitget_bots' ||
    src.trader_kind_scope !== 'bot' ||
    src.product_type !== contract.product ||
    src.currency !== 'USDT' ||
    src.serving_mode !== 'serving' ||
    src.page_size !== 20 ||
    src.pagination_kind !== 'numeric' ||
    timeframe !== 30
  ) {
    publicationContractError(`source ${src.slug} is outside the canonical 30D bot contract`)
  }
  exactArray(src.timeframes_native, [30], 'source.timeframes_native')
  exactArray(src.timeframes_derived, [], 'source.timeframes_derived')
  const meta = dataRecord(src.meta, 'source.meta')
  exactArray(meta.boards, contract.boards, 'source.meta.boards')
  return contract
}

/**
 * Bitget bot cards carry the only durable metadata used by the bot header.
 * Generic staging intentionally does not schema-check traderMeta and silently
 * deduplicates repeated identities, so this whole-board gate must reject any
 * partial/malformed window before RAW trust or serving publication can pass.
 */
export function assertBitgetBotsLeaderboardPublication(
  result: Readonly<{
    parsedRows: readonly ParsedLeaderboardRow[]
    validRows: readonly ParsedLeaderboardRow[]
    rejectedRowCount: number
  }>,
  src: SourceRow,
  timeframe: RankingTimeframe
): void {
  const contract = assertCanonicalBitgetBotsSource(src, timeframe)
  if (!Number.isSafeInteger(result.rejectedRowCount) || result.rejectedRowCount !== 0) {
    publicationContractError('the complete board must have zero rejected rows')
  }
  if (result.parsedRows.length === 0) {
    publicationContractError('the complete board cannot be empty')
  }
  if (result.parsedRows.length !== result.validRows.length) {
    publicationContractError('generic validation or deduplication changed the board population')
  }

  const exchangeIds = new Set<string>()
  const ranks = new Set<number>()
  const strategies = new Set<'grid' | 'martingale'>()
  for (const row of result.validRows) {
    const exchangeId = canonicalRequiredString(row.exchangeTraderId, 'exchange_trader_id')
    if (!/^[0-9]+$/.test(exchangeId)) {
      publicationContractError('exchange_trader_id must be a decimal Bitget strategy id')
    }
    if (exchangeIds.has(exchangeId)) {
      publicationContractError(`duplicate exchange_trader_id ${exchangeId}`)
    }
    exchangeIds.add(exchangeId)
    if (!Number.isSafeInteger(row.rank) || row.rank < 1 || Object.is(row.rank, -0)) {
      publicationContractError(`rank for ${exchangeId} must be a positive safe integer`)
    }
    if (ranks.has(row.rank)) publicationContractError(`duplicate rank ${row.rank}`)
    ranks.add(row.rank)

    if (
      row.traderKind !== 'bot' ||
      (row.botStrategy !== 'grid' && row.botStrategy !== 'martingale')
    ) {
      publicationContractError(`row ${exchangeId} is not a reviewed bot strategy`)
    }
    strategies.add(row.botStrategy)

    // This board is cumulative and timeframe-less. Preserve its full card only
    // in the immutable RAW capture; any headline scalar or copied card field in
    // serving storage would be mislabeled as the canonical 30D source window.
    if (row.headlineRoi !== null || row.headlinePnl !== null || row.headlineWinRate !== null) {
      publicationContractError(
        `row ${exchangeId} cumulative ROI/PnL/win-rate headlines must remain null`
      )
    }

    const traderMeta = dataRecord(row.traderMeta, `row ${exchangeId} traderMeta`)
    exactDataFields(traderMeta, ['bot'], `row ${exchangeId} traderMeta`)
    const bot = dataRecord(traderMeta.bot, `row ${exchangeId} traderMeta.bot`)
    exactDataFields(bot, BOT_META_FIELDS, `row ${exchangeId} traderMeta.bot`)

    const botId = canonicalRequiredString(bot.exchange_bot_id, 'bot.exchange_bot_id')
    if (botId.length > 512 || botId !== exchangeId) {
      publicationContractError(`row ${exchangeId} bot identity mismatch`)
    }
    const productId = canonicalNullableString(bot.product_id, 'bot.product_id')
    if (productId !== null && (productId.length > 512 || !/^[0-9]+$/.test(productId))) {
      publicationContractError(`row ${exchangeId} product_id must be a decimal id or null`)
    }
    const ownerAccountId = canonicalNullableString(bot.owner_account_id, 'bot.owner_account_id')
    if (ownerAccountId !== null && ownerAccountId.length > 256) {
      publicationContractError(`row ${exchangeId} owner_account_id is too long`)
    }
    const ownerName = canonicalNullableString(bot.owner_name, 'bot.owner_name')
    if (ownerName !== null && ownerName.length > 256) {
      publicationContractError(`row ${exchangeId} owner_name is too long`)
    }
    const pair = canonicalRequiredString(bot.pair, 'bot.pair')
    if (pair.length > 64 || row.nickname !== pair) {
      publicationContractError(`row ${exchangeId} pair/title mismatch`)
    }
    if (bot.product_type !== contract.product || bot.strategy !== row.botStrategy) {
      publicationContractError(`row ${exchangeId} product/strategy metadata mismatch`)
    }
    if (bot.direction !== null && bot.direction !== 'long' && bot.direction !== 'short') {
      publicationContractError(`row ${exchangeId} direction is outside the reviewed enum`)
    }
    canonicalIsoOrNull(bot.created_at_origin, 'bot.created_at_origin')
    if (
      bot.runtime_days !== null &&
      (!Number.isSafeInteger(bot.runtime_days) ||
        (bot.runtime_days as number) < 0 ||
        Object.is(bot.runtime_days, -0))
    ) {
      publicationContractError(`row ${exchangeId} runtime_days must be non-negative or null`)
    }
    if (
      bot.profit_share_rate !== null &&
      (typeof bot.profit_share_rate !== 'number' ||
        !Number.isFinite(bot.profit_share_rate) ||
        bot.profit_share_rate < 0 ||
        bot.profit_share_rate > 100)
    ) {
      publicationContractError(`row ${exchangeId} profit_share_rate must be 0..100 or null`)
    }
    const status = canonicalNullableString(bot.status, 'bot.status')
    if (status !== null && status.length > 64) {
      publicationContractError(`row ${exchangeId} status is too long`)
    }

    const raw = dataRecord(row.raw, `row ${exchangeId} raw`)
    exactDataFields(raw, BOT_ENTRY_RAW_FIELDS, `row ${exchangeId} raw`)
    const expectedStrategyType =
      contract.product === 'spot'
        ? row.botStrategy === 'grid'
          ? 1
          : 3
        : row.botStrategy === 'grid'
          ? 2
          : 4
    if (raw.strategyType !== expectedStrategyType) {
      publicationContractError(`row ${exchangeId} raw strategyType mismatch`)
    }
    if (raw.strategyId !== exchangeId) {
      publicationContractError(`row ${exchangeId} raw strategyId mismatch`)
    }
    if ((raw.productId ?? null) !== productId) {
      publicationContractError(`row ${exchangeId} raw productId mismatch`)
    }
    if ((raw.strAccountId ?? null) !== bot.owner_account_id) {
      publicationContractError(`row ${exchangeId} raw owner identity mismatch`)
    }
    if ((raw.status === undefined ? null : String(raw.status)) !== bot.status) {
      publicationContractError(`row ${exchangeId} raw status mismatch`)
    }
  }
  if (!strategies.has('grid') || !strategies.has('martingale')) {
    publicationContractError('the complete board must include both configured strategy partitions')
  }
}

/** direction: 1 = 做多 (long), 2 = 做空 (short), others kept verbatim. */
function botDirection(v: unknown): string | null {
  const n = num(v)
  if (n === 1) return 'long'
  if (n === 2) return 'short'
  return n === null ? null : String(n)
}

function pairOf(item: Dict): string | null {
  const dtos = item.symbolDtos
  if (Array.isArray(dtos) && dtos.length > 0) {
    const name = (dtos[0] as Dict).symbolDisplayName
    if (typeof name === 'string') return name
  }
  const sid = item.symbolId
  return typeof sid === 'string' ? sid.replace(/_[A-Z]+$/, '') : null
}

export interface DecodedBitgetBotsBoardPage {
  page: ParsedLeaderboardPage
  reportedCurrentPage: number
}

/**
 * V4 parser pages carry deterministic partition metadata around the exact
 * upstream payload. The legacy {board, payload} wrapper remains parseable for
 * historical RAW replay, but canonical capture never writes that wrapper into
 * source RAW.
 */
function decodeBitgetBotsBoardPage(raw: unknown): DecodedBitgetBotsBoardPage {
  const wrapper = dataRecord(raw, 'board page wrapper')
  const partitioned = Object.hasOwn(wrapper, 'data_contract')
  let board: string
  let requestPageIndex: number | null = null
  let requestPageSize: number | null = null
  if (partitioned) {
    exactDataFields(
      wrapper,
      ['data_contract', 'partition_id', 'request_page_index', 'request_page_size', 'payload'],
      'partitioned board page wrapper'
    )
    if (wrapper.data_contract !== LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT) {
      publicationContractError('partitioned board page data contract is unsupported')
    }
    board = canonicalRequiredString(wrapper.partition_id, 'board page wrapper.partition_id')
    requestPageIndex = canonicalPositiveSafeNumber(
      wrapper.request_page_index,
      'board page request_page_index'
    )
    requestPageSize = canonicalPositiveSafeNumber(
      wrapper.request_page_size,
      'board page request_page_size'
    )
  } else {
    board = canonicalRequiredString(wrapper.board, 'board page wrapper.board')
    if (wrapper.requestPageIndex !== undefined) {
      requestPageIndex = canonicalNonNegativeInteger(
        wrapper.requestPageIndex,
        'board page requestPageIndex'
      )
    }
    if (wrapper.requestPageSize !== undefined) {
      requestPageSize = canonicalNonNegativeInteger(
        wrapper.requestPageSize,
        'board page requestPageSize'
      )
    }
  }
  const info = BOARD_FIELDS[board]
  if (!info) publicationContractError(`unreviewed board ${board}`)
  const payload = dataRecord(wrapper.payload, 'board page payload')
  if (payload.code !== '200') publicationContractError('board page response code must be 200')
  const data = dataRecord(payload.data, 'board page payload.data')
  if (!Array.isArray(data.data)) publicationContractError('board page data.data must be an array')
  const items = data.data as unknown[]
  const pageNo = canonicalNonNegativeInteger(data.pageNo, 'board page pageNo')
  if (pageNo < 1) publicationContractError('board page pageNo must be positive')
  if (requestPageIndex !== null) {
    if (requestPageIndex < 1 || requestPageIndex !== pageNo) {
      publicationContractError('board page pageNo must match its exact request')
    }
  }
  const reportedTotal = canonicalNonNegativeInteger(data.totalRecord, 'board page totalRecord')
  if (reportedTotal < items.length) {
    publicationContractError('board page totalRecord cannot be smaller than its row count')
  }
  if (typeof data.nextFlag !== 'boolean') {
    publicationContractError('board page nextFlag must be boolean')
  }
  if (requestPageSize !== null) {
    const pageSize = requestPageSize
    if (pageSize < 1) publicationContractError('board page requestPageSize must be positive')
    const rowsBeforePage = (pageNo - 1) * pageSize
    const pageCapacity = pageNo * pageSize
    if (!Number.isSafeInteger(rowsBeforePage) || !Number.isSafeInteger(pageCapacity)) {
      publicationContractError('board page population offset exceeds the safe integer range')
    }
    const expectedRows = Math.max(0, Math.min(pageSize, reportedTotal - rowsBeforePage))
    const expectedNextFlag = pageCapacity < reportedTotal
    if (
      items.length !== expectedRows ||
      data.nextFlag !== expectedNextFlag ||
      items.length > pageSize
    ) {
      publicationContractError('board page row count and nextFlag must exactly cover totalRecord')
    }
  }

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = dataRecord(items[i], `board page card ${i + 1}`)
    const id = item.strategyId
    if (typeof id !== 'string' || !/^[0-9]+$/.test(id)) {
      throw new TypeError('[bitget_bots] every board card requires a decimal strategyId string')
    }
    if (item.strategyType !== info.strategyType) {
      throw new TypeError('[bitget_bots] board identity and card strategyType must match')
    }
    const runtimeMs = num(item.runTime)
    rows.push({
      exchangeTraderId: String(id),
      rank: i + 1,
      // Bots have no name of their own — the pair is the card title.
      nickname: pairOf(item),
      avatarUrlOrigin: (item.accountUrl as string) ?? null,
      walletAddress: null,
      traderKind: 'bot',
      botStrategy: info.strategy,
      // The strategyPlatform board is timeframe-less: profitRate and
      // profitAmount are cumulative since creation, not 30D. The complete
      // provider card remains in the immutable RAW capture; serving keeps only
      // the identity fields needed to prove this row belongs to that capture.
      headlineRoi: null,
      headlinePnl: null,
      headlineWinRate: null,
      // 最大回撤 shown on every bot card (spec §11.5) — thirtyMaxDrawdown is the
      // 30d MDD, already in percent. Was dropped (board had no MDD field, profile
      // set mdd:null), so bot risk was uncaptured everywhere.
      headlineMdd: num(item.thirtyMaxDrawdown),
      traderMeta: {
        bot: {
          exchange_bot_id: String(id),
          product_id: item.productId ?? null,
          owner_account_id: item.strAccountId ?? null,
          owner_name: (item.userDisplayName as string) ?? (item.userName as string) ?? null,
          pair: pairOf(item),
          product_type: info.product,
          strategy: info.strategy,
          direction: botDirection(item.direction),
          created_at_origin: isoFromMs(item.createTime),
          runtime_days: runtimeMs === null ? null : Math.round(runtimeMs / 86_400_000),
          profit_share_rate: num(item.profitSharingRate),
          status: item.status === undefined ? null : String(item.status),
        },
      },
      raw: {
        strategyId: String(id),
        strategyType: item.strategyType,
        productId: item.productId ?? null,
        strAccountId: item.strAccountId ?? null,
        status: item.status === undefined ? null : String(item.status),
      },
    })
  }
  return { page: { rows, reportedTotal }, reportedCurrentPage: pageNo }
}

export function parseBitgetBotsBoardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  return decodeBitgetBotsBoardPage(raw).page
}

export function inspectBitgetBotsBoardPage(raw: unknown): DecodedBitgetBotsBoardPage {
  return decodeBitgetBotsBoardPage(raw)
}

/** profitData rows: {amount, profitRate, fullTime "YYYY-MM-DD HH:mm:ss"}.
 *  fullTime carries no zone — stored as UTC per the §5.9 UTC-everywhere rule
 *  (session timezone is pinned to UTC when capturing). */
function chartPoints(
  node: unknown,
  key: 'amount' | 'profitRate'
): Array<{ ts: string; value: number }> {
  const rows = (node as Dict)?.profitData
  if (!Array.isArray(rows)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of rows as Dict[]) {
    const full = row.fullTime
    const value = num(row[key])
    if (typeof full !== 'string' || value === null) continue
    points.push({ ts: `${full.replace(' ', 'T')}Z`, value })
  }
  return points
}

/**
 * Bot profile = tradeStrategyInfo payload. One payload covers everything:
 *   performances[]: per-TF stats (performanceType 7/30/90)
 *   top level: cumulative (inception) stats → stored as timeframe 0
 *              (profile only, NEVER ranked — spec §1.1/§11.5)
 *   strategySelfProfitChartDto: ~30d daily roi/pnl chart → timeframe 30
 */
export function parseBitgetBotsProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as { strategyInfo?: Dict; timeframe?: number }
  const info = ((bundle.strategyInfo as Dict)?.data ?? null) as Dict | null
  if (!info) return { stats: [], series: [], nickname: null, avatarUrlOrigin: null }

  const sharedExtras: Record<string, unknown> = {
    bot_strategy_id: info.strategyId ?? null,
    symbol: pairOf(info),
    owner_name: (info.userDisplayName as string) ?? (info.userName as string) ?? null,
  }
  if (info.leverage !== undefined) sharedExtras.leverage = num(info.leverage)

  const base = {
    asOf: ctx.scrapedAt,
    sharpe: null,
    mdd: null,
    winRate: null,
    winPositions: null,
    totalPositions: null,
    volume: null,
    holdingDurationAvgHours: null,
    tradingPreferences: null,
  }

  const stats: ParsedStats[] = []
  const perfs = Array.isArray(info.performances) ? (info.performances as Dict[]) : []
  for (const perf of perfs) {
    const tf = int(perf.performanceType)
    if (tf !== 7 && tf !== 30 && tf !== 90) continue
    stats.push({
      ...base,
      timeframe: tf as Timeframe,
      roi: num(perf.profitRate),
      pnl: num(perf.profitAmount),
      copierPnl: null,
      copierCount: null,
      aum: null,
      profitShareRate: num(info.profitSharingRate),
      extras: { ...sharedExtras, investment_amount: num(perf.investmentAmount) },
    })
  }

  // Inception block (timeframe 0): cumulative since createTime.
  const runtimeMs = num(info.runTime)
  stats.push({
    ...base,
    timeframe: 0,
    roi: num(info.profitRate),
    pnl: num(info.profitAmount),
    copierPnl: num(info.followerTotalProfit),
    copierCount: int(info.traceTotalCount),
    aum: num(info.followerInvestmentAmount),
    profitShareRate: num(info.profitSharingRate),
    extras: {
      ...sharedExtras,
      investment_amount: num(info.investmentAmount),
      created_at_origin: isoFromMs(info.createTime),
      runtime_days: runtimeMs === null ? null : Math.round(runtimeMs / 86_400_000),
    },
  })

  const series: ParsedProfile['series'] = []
  // Bot's own performance chart (board cards carry it; the profile payload
  // sometimes returns it null) → roi/pnl, daily, ~30d window.
  const roiPoints = chartPoints(info.strategySelfProfitChartDto, 'profitRate')
  if (roiPoints.length > 0) series.push({ timeframe: 30, metric: 'roi', points: roiPoints })
  const pnlPoints = chartPoints(info.strategySelfProfitChartDto, 'amount')
  if (pnlPoints.length > 0) series.push({ timeframe: 30, metric: 'pnl', points: pnlPoints })
  // 跟单收益额走势 (spec §11.5): copier profit trend — separate metric so
  // the UI's scope toggle can tell bot-own pnl from copier pnl.
  const copierPnlPoints = chartPoints(info.profitChartDto, 'amount')
  if (copierPnlPoints.length > 0) {
    series.push({ timeframe: 30, metric: 'copier_pnl', points: copierPnlPoints })
  }

  return {
    stats,
    series,
    nickname: pairOf(info),
    avatarUrlOrigin: (info.accountUrl as string) ?? null,
  }
}

/**
 * 跟单者榜单 (followRank): followers[] + lastUpdateTime. The page-disclosed
 * lastUpdateTime is the true as_of (spec §5.7) → row ts. followerTime is a
 * millisecond DURATION (time spent copying) → copy_duration_days.
 * copier_label stored for dedupe/aggregates only — NEVER rendered (§6 PII).
 */
export function parseBitgetBotsCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const data = ((raw as Dict)?.data ?? null) as Dict | null
  const followers = Array.isArray(data?.followers) ? (data.followers as Dict[]) : []
  const ts = isoFromMs(data?.lastUpdateTime) ?? ctx.scrapedAt

  const out: ParsedCopierRow[] = []
  for (const f of followers) {
    const label = (f.followerUserName ?? f.followerUserDisplayName) as string | undefined
    if (!label) continue
    const durMs = num(f.followerTime)
    out.push({
      kind: 'copiers',
      ts,
      copierLabel: String(label),
      copierPnl: num(f.followerProfitAmount),
      copierInvested: num(f.followerInvestmentAmount),
      copyDurationDays: durMs === null ? null : Math.round(durMs / 86_400_000),
      dedupeHash: botsHash(
        'bitget_bot_cp',
        label,
        f.followerProfitAmount,
        f.followerInvestmentAmount
      ),
      raw: f,
    })
  }
  return out
}
