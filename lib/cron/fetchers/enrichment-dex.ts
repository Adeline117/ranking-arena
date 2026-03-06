/**
 * DEX enrichment: Hyperliquid + GMX position history
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { PositionHistoryItem } from './enrichment-types'

// ============================================
// Hyperliquid Position History (from userFills)
// ============================================

interface HyperliquidFill {
  coin?: string
  px?: string
  sz?: string
  side?: string
  time?: number
  dir?: string
  closedPnl?: string
  crossed?: boolean
  startPosition?: string
}

export async function fetchHyperliquidPositionHistory(
  address: string,
  limit = 200
): Promise<PositionHistoryItem[]> {
  try {
    const fills = await fetchJson<HyperliquidFill[]>(
      'https://api.hyperliquid.xyz/info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { type: 'userFills', user: address },
        timeoutMs: 15000,
      }
    )

    if (!Array.isArray(fills) || fills.length === 0) return []

    const closingFills = fills
      .filter((f) => {
        const pnl = parseFloat(f.closedPnl || '0')
        return pnl !== 0
      })
      .slice(0, limit)

    return closingFills.map((f) => {
      const dir = (f.dir || '').toLowerCase()
      const isShort = dir.includes('short') || (dir === 'buy' && parseFloat(f.startPosition || '0') < 0)

      return {
        symbol: (f.coin || '').replace('@', 'HL-'),
        direction: isShort ? 'short' as const : 'long' as const,
        positionType: 'perpetual',
        marginMode: f.crossed ? 'cross' : 'isolated',
        openTime: null,
        closeTime: f.time ? new Date(f.time).toISOString() : null,
        entryPrice: null,
        exitPrice: f.px != null ? Number(f.px) : null,
        maxPositionSize: null,
        closedSize: f.sz != null ? Number(f.sz) : null,
        pnlUsd: f.closedPnl != null ? Number(f.closedPnl) : null,
        pnlPct: null,
        status: 'closed',
      }
    })
  } catch (err) {
    logger.warn(`[enrichment] Hyperliquid position history failed: ${err}`)
    return []
  }
}

// ============================================
// GMX Position History (from GraphQL)
// ============================================

const GMX_SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const GMX_VALUE_SCALE = 1e30

export async function fetchGmxPositionHistory(
  address: string,
  limit = 50
): Promise<PositionHistoryItem[]> {
  try {
    const query = `{
      tradeActions(
        limit: ${limit},
        where: {
          account_eq: "${address}"
          orderType_in: [2, 4, 7]
        },
        orderBy: timestamp_DESC
      ) {
        timestamp
        orderType
        sizeDeltaUsd
        executionPrice
        isLong
        marketAddress
        basePnlUsd
      }
    }`

    const result = await fetchJson<{
      data?: {
        tradeActions?: Array<{
          timestamp: number
          orderType: number
          sizeDeltaUsd?: string
          executionPrice?: string
          isLong: boolean
          marketAddress?: string
          basePnlUsd?: string
        }>
      }
    }>(GMX_SUBSQUID_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { query },
      timeoutMs: 20000,
    })

    const actions = result?.data?.tradeActions
    if (!actions || actions.length === 0) return []

    const closingActions = actions.filter((a) => {
      if (!a.basePnlUsd) return false
      try {
        return Number(BigInt(a.basePnlUsd)) / GMX_VALUE_SCALE !== 0
      } catch (err) {
        logger.warn(`[enrichment] Error: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    })

    return closingActions.map((a) => {
      const pnlUsd = a.basePnlUsd ? Number(BigInt(a.basePnlUsd)) / GMX_VALUE_SCALE : null
      const sizeUsd = a.sizeDeltaUsd ? Number(BigInt(a.sizeDeltaUsd)) / GMX_VALUE_SCALE : null
      const price = a.executionPrice ? Number(BigInt(a.executionPrice)) / 1e24 : null

      return {
        symbol: a.marketAddress?.slice(0, 10) || 'GMX',
        direction: a.isLong ? 'long' as const : 'short' as const,
        positionType: 'perpetual',
        marginMode: 'cross',
        openTime: null,
        closeTime: new Date(a.timestamp * 1000).toISOString(),
        entryPrice: null,
        exitPrice: price,
        maxPositionSize: sizeUsd,
        closedSize: sizeUsd,
        pnlUsd,
        pnlPct: sizeUsd && pnlUsd ? (pnlUsd / sizeUsd) * 100 : null,
        status: 'closed',
      }
    })
  } catch (err) {
    logger.warn(`[enrichment] GMX position history failed: ${err}`)
    return []
  }
}
