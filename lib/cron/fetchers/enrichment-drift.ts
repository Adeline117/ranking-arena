/**
 * Drift Protocol Enrichment
 *
 * Uses the public data.api.drift.trade API:
 * - /fills/{authority} — trade fills for position history
 * - /stats/user/{authority} — user stats
 *
 * Also supports S3 historical trade data:
 * - drift-historical-data-v2.s3.eu-west-1.amazonaws.com
 *
 * Computes equity curve + trading stats from fills data.
 * No auth required. Rate limiting: conservative 500ms delays.
 */

import { gunzipSync } from 'node:zlib'
import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'
import { computeStatsFromPositions, buildEquityCurveFromPositions } from './enrichment-dex'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const DATA_API = 'https://data.api.drift.trade'
const S3_BASE = 'https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com'
const DRIFT_PROGRAM = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH'

interface DriftFill {
  marketIndex?: number
  marketType?: string
  baseAssetAmount?: number
  quoteAssetAmount?: number
  ts?: number
  action?: string
  taker?: string
  maker?: string
  takerOrderDirection?: string
  fillerReward?: number
  quoteAssetAmountFilled?: number
  baseAssetAmountFilled?: number
  pnl?: number
}

interface _DriftUserStats {
  authority?: string
  pnl?: number
  volume?: number
  fees?: number
}

// Market index to symbol mapping (common Drift perp markets)
const DRIFT_MARKETS: Record<number, string> = {
  0: 'SOL', 1: 'BTC', 2: 'ETH', 3: 'APT', 4: 'BONK',
  5: 'MATIC', 6: 'ARB', 7: 'DOGE', 8: 'BNB', 9: 'SUI',
  10: 'PEPE', 11: '1KPEPE', 12: 'OP', 13: 'RNDR', 14: 'XRP',
  15: 'HNT', 16: 'INJ', 17: 'LINK', 18: 'RLB', 19: 'PYTH',
  20: 'TIA', 21: 'JTO', 22: 'SEI', 23: 'AVAX', 24: 'WIF',
  25: 'JUP', 26: 'DYM', 27: 'TAO', 28: 'W', 29: 'KMNO',
  30: 'TNSR', 31: 'DRIFT',
}

/**
 * Fetch position history from Drift fill data.
 * Enhanced: includes PnL and proper symbol names.
 */
export async function fetchDriftPositionHistory(
  authority: string,
  limit = 200
): Promise<PositionHistoryItem[]> {
  try {
    const url = `${DATA_API}/fills/${authority}?limit=${limit}`
    const fills = await fetchJson<DriftFill[]>(url, { timeoutMs: 15000 })

    if (!Array.isArray(fills) || fills.length === 0) return []

    return fills
      .filter((f) => f.baseAssetAmount && f.quoteAssetAmount)
      .slice(0, limit)
      .map((f) => {
        const isLong = (f.takerOrderDirection || '').toLowerCase() === 'long'
        const size = Math.abs(f.baseAssetAmount || f.baseAssetAmountFilled || 0) / 1e9
        const quote = Math.abs(f.quoteAssetAmount || f.quoteAssetAmountFilled || 0) / 1e6
        const price = size > 0 ? quote / size : null
        const symbol = DRIFT_MARKETS[f.marketIndex ?? -1] || `PERP-${f.marketIndex ?? '?'}`
        const pnl = f.pnl != null ? f.pnl / 1e6 : null

        return {
          symbol,
          direction: isLong ? 'long' as const : 'short' as const,
          positionType: 'perpetual',
          marginMode: 'cross',
          openTime: null,
          closeTime: f.ts ? new Date(f.ts * 1000).toISOString() : null,
          entryPrice: null,
          exitPrice: price,
          maxPositionSize: quote > 0 ? quote : null,
          closedSize: size > 0 ? size : null,
          pnlUsd: pnl,
          pnlPct: quote > 0 && pnl != null ? (pnl / quote) * 100 : null,
          status: 'closed',
        }
      })
  } catch (err) {
    logger.warn(`[drift] Position history failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

// ============================================
// S3 Historical Trade Data
// ============================================

interface S3TradeRecord {
  ts: string
  action: string
  taker: string
  maker: string
  takerOrderDirection: string
  marketIndex: string
  marketType: string
  baseAssetAmountFilled: string
  quoteAssetAmountFilled: string
  takerFee: string
  makerRebate: string
  oraclePrice: string
}

/**
 * Generate date strings (YYYYMMDD) for the last N days.
 */
function getDateRange(days: number): Array<{ year: string; yearMonthDay: string }> {
  const dates: Array<{ year: string; yearMonthDay: string }> = []
  const now = Date.now()
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000)
    const year = d.getUTCFullYear().toString()
    const month = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    dates.push({ year, yearMonthDay: `${year}${month}${day}` })
  }
  return dates
}

/**
 * Parse CSV text into objects using the header row.
 */
function parseCsv(text: string): S3TradeRecord[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map((h) => h.trim())
  const records: S3TradeRecord[] = []

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',')
    if (values.length < headers.length) continue
    const record: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = (values[j] || '').trim()
    }
    records.push(record as unknown as S3TradeRecord)
  }
  return records
}

/**
 * Fetch and decompress a single day's trade records from Drift S3.
 * Returns empty array on 404/missing (not all users have S3 data).
 */
async function fetchS3DayTrades(authority: string, year: string, yearMonthDay: string): Promise<S3TradeRecord[]> {
  const url = `${S3_BASE}/program/${DRIFT_PROGRAM}/user/${authority}/tradeRecords/${year}/${yearMonthDay}`
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'Accept-Encoding': 'gzip' },
    })

    if (res.status === 404 || res.status === 403) return []
    if (!res.ok) return []

    const buf = Buffer.from(await res.arrayBuffer())
    let text: string
    try {
      // S3 data is gzip-compressed CSV
      text = gunzipSync(buf).toString('utf-8')
    } catch {
      // Not gzipped — try as plain text
      text = buf.toString('utf-8')
    }

    return parseCsv(text)
  } catch (err) {
    // Network errors, timeouts — return empty gracefully
    logger.warn(`[drift-s3] Failed to fetch ${yearMonthDay} for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Group consecutive same-direction fills on the same market into positions.
 * A position closes when direction changes or market changes.
 */
function groupFillsIntoPositions(trades: S3TradeRecord[], authority: string): PositionHistoryItem[] {
  // Filter to fills where this authority is the taker
  const fills = trades
    .filter((t) => t.action === 'fill' && t.taker?.toLowerCase() === authority.toLowerCase())
    .sort((a, b) => Number(a.ts) - Number(b.ts))

  if (fills.length === 0) return []

  const positions: PositionHistoryItem[] = []

  let currentDirection: 'long' | 'short' | null = null
  let currentMarket: string | null = null
  let currentMarketType: string | null = null
  let openTs: number | null = null
  let totalBaseSize = 0
  let totalQuoteSize = 0
  let _totalFees = 0
  let entryPrice: number | null = null
  let fillCount = 0

  function flushPosition() {
    if (currentDirection == null || currentMarket == null || fillCount === 0) return

    const marketIdx = parseInt(currentMarket, 10)
    const symbol = DRIFT_MARKETS[marketIdx] || `PERP-${currentMarket}`
    const avgExitPrice = totalBaseSize > 0 ? totalQuoteSize / totalBaseSize : null

    positions.push({
      symbol,
      direction: currentDirection,
      positionType: currentMarketType === 'spot' ? 'spot' : 'perpetual',
      marginMode: 'cross',
      openTime: openTs ? new Date(openTs * 1000).toISOString() : null,
      closeTime: null, // Set by last fill below
      entryPrice: entryPrice,
      exitPrice: avgExitPrice,
      maxPositionSize: totalQuoteSize > 0 ? totalQuoteSize : null,
      closedSize: totalBaseSize > 0 ? totalBaseSize : null,
      pnlUsd: null, // S3 data doesn't include realized PnL per position
      pnlPct: null,
      status: 'closed',
    })
  }

  for (const fill of fills) {
    const dir = fill.takerOrderDirection?.toLowerCase() === 'long' ? 'long' as const : 'short' as const
    const market = fill.marketIndex
    const marketType = fill.marketType || 'perp'
    const baseSize = Math.abs(Number(fill.baseAssetAmountFilled) || 0) / 1e9
    const quoteSize = Math.abs(Number(fill.quoteAssetAmountFilled) || 0) / 1e6
    const fee = Math.abs(Number(fill.takerFee) || 0) / 1e6
    const oracle = Number(fill.oraclePrice) || 0
    const ts = Number(fill.ts) || 0

    // If direction or market changes, close the current position
    if (currentDirection !== dir || currentMarket !== market) {
      flushPosition()
      // Start new position
      currentDirection = dir
      currentMarket = market
      currentMarketType = marketType
      openTs = ts
      totalBaseSize = 0
      totalQuoteSize = 0
      _totalFees = 0
      entryPrice = oracle > 0 ? oracle / 1e6 : (quoteSize > 0 && baseSize > 0 ? quoteSize / baseSize : null)
      fillCount = 0
    }

    totalBaseSize += baseSize
    totalQuoteSize += quoteSize
    _totalFees += fee
    fillCount++
  }

  // Flush the last position
  flushPosition()

  // Set closeTime on all positions using the last fill timestamp
  // (Positions are approximate groups; use last fill as close)
  if (positions.length > 0 && fills.length > 0) {
    // Walk through fills again to assign close times
    let posIdx = 0
    let prevDir: string | null = null
    let prevMarket: string | null = null

    for (const fill of fills) {
      const dir = fill.takerOrderDirection?.toLowerCase() === 'long' ? 'long' : 'short'
      const market = fill.marketIndex

      if (prevDir !== null && (dir !== prevDir || market !== prevMarket)) {
        // Direction/market changed — the previous position closed at the previous fill
        posIdx++
      }
      prevDir = dir
      prevMarket = market

      if (posIdx < positions.length) {
        const ts = Number(fill.ts) || 0
        if (ts > 0) {
          positions[posIdx].closeTime = new Date(ts * 1000).toISOString()
        }
      }
    }
  }

  return positions
}

/**
 * Fetch position history from Drift S3 public bucket.
 *
 * Fetches gzip-compressed CSV trade records for the last 90 days,
 * parses them, and groups fills into PositionHistoryItem entries.
 *
 * Not all Drift users have S3 data (subaccounts, inactive traders).
 * Returns empty array on 404/missing data.
 */
export async function fetchDriftPositionHistoryFromS3(
  authority: string,
  days = 90
): Promise<PositionHistoryItem[]> {
  try {
    const dates = getDateRange(days)

    // Fetch in parallel batches of 10 to avoid overwhelming S3
    const allTrades: S3TradeRecord[] = []
    const batchSize = 10

    for (let i = 0; i < dates.length; i += batchSize) {
      const batch = dates.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map((d) => fetchS3DayTrades(authority, d.year, d.yearMonthDay))
      )

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allTrades.push(...result.value)
        }
      }

      // If first batch returns nothing, likely no S3 data exists — bail early
      if (i === 0 && allTrades.length === 0) {
        logger.info(`[drift-s3] No S3 trade data found for ${authority}, skipping remaining days`)
        return []
      }
    }

    if (allTrades.length === 0) return []

    logger.info(`[drift-s3] Fetched ${allTrades.length} trades over ${days} days for ${authority}`)

    return groupFillsIntoPositions(allTrades, authority)
  } catch (err) {
    logger.warn(`[drift-s3] Position history from S3 failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Drift snapshots API response item.
 * The snapshots/trading endpoint returns daily snapshots with cumulative PnL.
 */
interface DriftSnapshot {
  epochTs?: number
  ts?: number  // API actually returns 'ts', not 'epochTs'
  cumulativeRealizedPnl?: number | string
  cumulativePerpPnl?: number | string
  allTimeTotalPnl?: number | string
}

interface DriftSnapshotsResponse {
  success?: boolean
  accounts?: Array<{ accountId?: string; snapshots?: DriftSnapshot[]; metrics?: unknown }>
}

/**
 * Fetch Drift equity curve from snapshots API (preferred — gives daily PnL curve).
 * Fallback: build from fill history.
 */
export async function fetchDriftEquityCurve(
  authority: string,
  days: number
): Promise<EquityCurvePoint[]> {
  // Hard timeout protection: 2 minutes max per trader
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout: fetchDriftEquityCurve exceeded 2 minutes')), 120000)
  )

  const mainWork = async (): Promise<EquityCurvePoint[]> => {
    try {
      // Strategy 1: Use snapshots/trading API for accurate daily equity curve
      try {
        const snapUrl = `${DATA_API}/authority/${authority}/snapshots/trading?days=${days}`
        const resp = await fetchJson<DriftSnapshotsResponse>(snapUrl, { timeoutMs: 15000 })

        // Extract snapshots from nested accounts structure
        const allSnaps: DriftSnapshot[] = []
        if (resp?.accounts && Array.isArray(resp.accounts)) {
          for (const acct of resp.accounts) {
            if (Array.isArray(acct.snapshots)) allSnaps.push(...acct.snapshots)
          }
        } else if (Array.isArray(resp)) {
          allSnaps.push(...(resp as unknown as DriftSnapshot[]))
        }

        if (allSnaps.length >= 2) {
          const points: EquityCurvePoint[] = allSnaps
            .filter((s) => (s.ts ?? s.epochTs) != null)
            .map((s) => {
              const pnl = Number(s.cumulativeRealizedPnl ?? s.allTimeTotalPnl ?? s.cumulativePerpPnl ?? 0)
              // Drift values are in USDC base units (divide by 1e6)
              const pnlUsd = Math.abs(pnl) > 1e10 ? pnl / 1e6 : pnl
              return {
                date: new Date(((s.ts ?? s.epochTs) ?? 0) * 1000).toISOString().split('T')[0],
                roi: 0,
                pnl: pnlUsd,
              }
            })
            .sort((a, b) => a.date.localeCompare(b.date))

          // Deduplicate by date (keep last per day)
          const dateMap = new Map<string, EquityCurvePoint>()
          for (const p of points) dateMap.set(p.date, p)
          const deduped = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date))

          if (deduped.length >= 2) {
            // Compute ROI relative to first point
            const basePnl = deduped[0].pnl ?? 0
            const estimatedCapital = Math.abs(basePnl) > 0 ? Math.abs(basePnl) * 5 : 10000
            for (const p of deduped) {
              p.roi = (((p.pnl ?? 0) - basePnl) / estimatedCapital) * 100
            }
            return deduped
          }
        }
      } catch (err) {
        logger.warn(`[drift] Snapshots API failed for ${authority}, falling back to fills: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Strategy 2: Fallback to building from fill history
      const positions = await fetchDriftPositionHistory(authority, 500)
      if (positions.length === 0) return []
      return buildEquityCurveFromPositions(positions, days)
    } catch (err) {
      logger.warn(`[drift] Equity curve failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  try {
    return await Promise.race([mainWork(), timeoutPromise])
  } catch (err) {
    logger.warn(`[drift] Equity curve timeout for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch stats detail for a Drift trader.
 * Combines user stats API with computed metrics from fills.
 */
export async function fetchDriftStatsDetail(
  authority: string
): Promise<StatsDetail | null> {
  // Hard timeout protection: 2 minutes max per trader
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout: fetchDriftStatsDetail exceeded 2 minutes')), 120000)
  )

  const mainWork = async (): Promise<StatsDetail | null> => {
    try {
      // Strategy 1: Derive WR/MDD from snapshots API (daily cumulativeRealizedPnl)
      // This is far more reliable than fills which often return empty
      let winRate: number | null = null
      let maxDrawdown: number | null = null
      let sharpeRatio: number | null = null
      let totalDays = 0

      try {
        const snapUrl = `${DATA_API}/authority/${authority}/snapshots/trading?days=90`
        // API returns { success, accounts: [{ snapshots: [...] }] }
        const resp = await fetchJson<DriftSnapshotsResponse>(snapUrl, { timeoutMs: 15000 })

        // Extract snapshots from nested accounts structure
        const allSnapshots: DriftSnapshot[] = []
        if (resp?.accounts && Array.isArray(resp.accounts)) {
          for (const acct of resp.accounts) {
            if (Array.isArray(acct.snapshots)) {
              allSnapshots.push(...acct.snapshots)
            }
          }
        } else if (Array.isArray(resp)) {
          // Fallback: flat array format (legacy)
          allSnapshots.push(...(resp as unknown as DriftSnapshot[]))
        }

        const snaps = allSnapshots
          .filter((s) => (s.ts ?? s.epochTs) != null)
          .map((s) => {
            const rawPnl = Number(s.cumulativeRealizedPnl ?? s.allTimeTotalPnl ?? s.cumulativePerpPnl ?? 0)
            // Drift values may be in USDC base units (divide by 1e6 if very large)
            const pnl = Math.abs(rawPnl) > 1e10 ? rawPnl / 1e6 : rawPnl
            return { ts: (s.ts ?? s.epochTs)!, pnl }
          })
          .sort((a, b) => a.ts - b.ts)

        if (snaps.length >= 3) {
          let wins = 0, losses = 0, peak = 0, mdd = 0
          for (let i = 1; i < snaps.length; i++) {
            const delta = snaps[i].pnl - snaps[i - 1].pnl
            if (delta > 0.01) wins++
            else if (delta < -0.01) losses++
            // MDD from cumulative PnL
            if (snaps[i].pnl > peak) peak = snaps[i].pnl
            if (peak > 0) {
              const dd = ((peak - snaps[i].pnl) / Math.abs(peak)) * 100
              if (dd > mdd) mdd = dd
            }
          }
          totalDays = wins + losses
          if (totalDays >= 3) {
            winRate = Math.round((wins / totalDays) * 10000) / 100
          }
          if (mdd > 0.01 && mdd <= 100) {
            maxDrawdown = Math.round(mdd * 100) / 100
          }

          // Compute Sharpe from daily PnL deltas
          if (snaps.length >= 3) {
            const dailyReturns: number[] = []
            for (let i = 1; i < snaps.length; i++) {
              dailyReturns.push(snaps[i].pnl - snaps[i - 1].pnl)
            }
            if (dailyReturns.length >= 2) {
              const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
              const std = Math.sqrt(dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / dailyReturns.length)
              if (std > 0) sharpeRatio = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
            }
          }
        }
      } catch (snapErr) {
        logger.warn(`[drift] Snapshots failed for ${authority}: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`)
      }

      // Strategy 2: Fallback to fills if snapshots didn't provide data
      const positions = await fetchDriftPositionHistory(authority, 500)
      const derivedStats = computeStatsFromPositions(positions)

      // Prefer snapshot-derived WR/MDD over fills-derived
      return {
        totalTrades: derivedStats.totalTrades ?? totalDays ?? null,
        profitableTradesPct: winRate ?? derivedStats.profitableTradesPct ?? null,
        avgHoldingTimeHours: null,
        avgProfit: derivedStats.avgProfit ?? null,
        avgLoss: derivedStats.avgLoss ?? null,
        largestWin: derivedStats.largestWin ?? null,
        largestLoss: derivedStats.largestLoss ?? null,
        sharpeRatio: sharpeRatio ?? derivedStats.sharpeRatio ?? null,
        maxDrawdown: maxDrawdown ?? derivedStats.maxDrawdown ?? null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: null,
        copiersPnl: null,
        aum: null,
        winningPositions: derivedStats.winningPositions ?? null,
        totalPositions: derivedStats.totalPositions ?? null,
      }
    } catch (err) {
      logger.warn(`[drift] Stats detail failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  try {
    return await Promise.race([mainWork(), timeoutPromise])
  } catch (err) {
    logger.warn(`[drift] Stats detail timeout for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
