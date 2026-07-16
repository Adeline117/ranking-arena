import type { DexGoldenSource, DexGoldenWalletCandidate } from './dex-golden-wallets'

export const DEX_GOLDEN_SOURCES: readonly DexGoldenSource[] = [
  'binance_web3_bsc',
  'okx_web3_solana',
]

export interface DexGoldenWalletQueryRow {
  source_slug: string
  snapshot_id: string
  snapshot_scraped_at: Date | string
  snapshot_actual_count: number
  source_currency: string
  entry_currency: string
  source_chain_id: string | null
  is_derived: boolean
  wallet_address: string | null
  exchange_trader_id: string
  source_rank: number
  pnl_90d_raw: string | null
  activity_json_type: string | null
  activity_total_raw: string | null
  activity_buy_json_type: string | null
  activity_buy_raw: string | null
  activity_sell_json_type: string | null
  activity_sell_raw: string | null
  period_type: string | null
  raw_chain_id: string | null
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

function isDexGoldenSource(value: string): value is DexGoldenSource {
  return DEX_GOLDEN_SOURCES.some((source) => source === value)
}

function canonicalTimestamp(value: Date | string, label: string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a timestamp`)
  return parsed.toISOString()
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function sourceReportedCount(value: string | null, label: string): number {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a non-negative base-10 integer`)
  }
  const parsed = BigInt(value)
  if (parsed > MAX_SAFE_INTEGER_BIGINT) {
    throw new Error(`${label} exceeds Number.MAX_SAFE_INTEGER`)
  }
  return Number(parsed)
}

function canonicalIdentity(source: DexGoldenSource, value: string): string {
  return source === 'binance_web3_bsc' ? value.toLowerCase() : value
}

function expectedPnlCurrency(source: DexGoldenSource): 'USDT' | 'USDC' {
  return source === 'binance_web3_bsc' ? 'USDT' : 'USDC'
}

function expectedSourceChainId(source: DexGoldenSource): '56' | '501' {
  return source === 'binance_web3_bsc' ? '56' : '501'
}

function finitePnl(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`)
  return parsed
}

export function buildDexGoldenWalletCandidates(
  rows: readonly DexGoldenWalletQueryRow[]
): DexGoldenWalletCandidate[] {
  const bySource = new Map<DexGoldenSource, DexGoldenWalletQueryRow[]>(
    DEX_GOLDEN_SOURCES.map((source) => [source, []])
  )
  for (const row of rows) {
    if (!isDexGoldenSource(row.source_slug)) {
      throw new Error(`unexpected golden-wallet source: ${row.source_slug}`)
    }
    bySource.get(row.source_slug)!.push(row)
  }

  const candidates: DexGoldenWalletCandidate[] = []
  for (const source of DEX_GOLDEN_SOURCES) {
    const sourceRows = bySource.get(source)!
    if (sourceRows.length === 0) throw new Error(`missing passed 90D snapshot for ${source}`)

    const snapshotIds = new Set<string>()
    const snapshotTimes = new Set<string>()
    const snapshotActualCounts = new Set<number>()
    const sourceRanks = new Set<number>()
    const wallets = new Set<string>()

    for (const row of sourceRows) {
      if (!/^[1-9]\d*$/.test(row.snapshot_id)) {
        throw new Error(`${source} snapshot id must be a positive decimal string`)
      }
      snapshotIds.add(row.snapshot_id)
      const snapshotScrapedAt = canonicalTimestamp(
        row.snapshot_scraped_at,
        `${source} snapshot scraped_at`
      )
      snapshotTimes.add(snapshotScrapedAt)
      snapshotActualCounts.add(
        positiveSafeInteger(row.snapshot_actual_count, `${source} snapshot actual_count`)
      )
      if (row.is_derived) throw new Error(`${source} golden snapshot must not be derived`)
      const pnlCurrency = expectedPnlCurrency(source)
      if (row.source_currency !== pnlCurrency || row.entry_currency !== pnlCurrency) {
        throw new Error(`${source} snapshot PnL currency does not match its source contract`)
      }
      if (row.source_chain_id !== expectedSourceChainId(source)) {
        throw new Error(`${source} source chain id does not match its chain contract`)
      }
      if (source === 'okx_web3_solana') {
        if (row.raw_chain_id !== '501' || row.period_type !== '5') {
          throw new Error(`${source} raw row is not a Solana 90D observation`)
        }
      }

      const sourceRank = positiveSafeInteger(row.source_rank, `${source} source rank`)
      if (sourceRanks.has(sourceRank)) throw new Error(`${source} has duplicate source rank`)
      sourceRanks.add(sourceRank)

      if (!row.wallet_address || !row.exchange_trader_id) {
        throw new Error(`${source} snapshot row is missing wallet identity`)
      }
      const wallet = canonicalIdentity(source, row.wallet_address)
      const exchangeTraderId = canonicalIdentity(source, row.exchange_trader_id)
      if (wallet !== exchangeTraderId) {
        throw new Error(`${source} wallet address does not match exchange trader id`)
      }
      if (wallets.has(wallet)) throw new Error(`${source} has duplicate wallet identity`)
      wallets.add(wallet)

      if (row.activity_json_type !== 'number') {
        throw new Error(`${source} activity total must be a JSON number`)
      }
      const activityProxyCount = sourceReportedCount(
        row.activity_total_raw,
        `${source} activity total`
      )
      if (source === 'binance_web3_bsc') {
        if (row.activity_buy_json_type !== 'number' || row.activity_sell_json_type !== 'number') {
          throw new Error(`${source} activity buy and sell counts must be JSON numbers`)
        }
        const buyCount = sourceReportedCount(row.activity_buy_raw, `${source} activity buys`)
        const sellCount = sourceReportedCount(row.activity_sell_raw, `${source} activity sells`)
        if (activityProxyCount !== buyCount + sellCount) {
          throw new Error(`${source} activity total does not equal buy plus sell counts`)
        }
      }

      if (row.pnl_90d_raw !== null) {
        candidates.push({
          sourceSlug: source,
          wallet,
          snapshotId: row.snapshot_id,
          snapshotScrapedAt,
          snapshotActualCount: row.snapshot_actual_count,
          sourceRank,
          arenaScore: null,
          pnl90d: finitePnl(row.pnl_90d_raw, `${source} 90D headline PnL`),
          pnlCurrency,
          activityProxyCount,
        })
      }
    }

    if (snapshotIds.size !== 1 || snapshotTimes.size !== 1 || snapshotActualCounts.size !== 1) {
      throw new Error(`${source} query rows must come from one source snapshot`)
    }
    const [snapshotActualCount] = snapshotActualCounts
    if (sourceRows.length !== snapshotActualCount) {
      throw new Error(`${source} snapshot row count does not equal actual_count`)
    }
  }

  return candidates.sort(
    (a, b) =>
      a.sourceSlug.localeCompare(b.sourceSlug) ||
      (a.sourceRank ?? Number.POSITIVE_INFINITY) - (b.sourceRank ?? Number.POSITIVE_INFINITY) ||
      a.wallet.localeCompare(b.wallet)
  )
}
