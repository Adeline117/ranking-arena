/**
 * On-chain enrichment via Etherscan V2 API
 *
 * Uses Etherscan V2 unified API to fetch trade events from DEX contracts.
 * Supports Ethereum (chainid=1) and Arbitrum (chainid=42161).
 *
 * Used for platforms where the native API doesn't expose trade history
 * but the on-chain data is available via event logs.
 *
 * Currently supports:
 * - Gains Network (Arbitrum) — MarketExecuted events with PnL
 */

import type { PositionHistoryItem, EquityCurvePoint, StatsDetail } from './enrichment-types'
import { buildEquityCurveFromPositions, computeStatsFromPositions } from './enrichment-dex'
import { logger } from '@/lib/logger'

// Etherscan V2 API key rotation (6 keys for rate limit distribution)
function getEtherscanKey(): string {
  const keys = (process.env.ETHERSCAN_API_KEYS || '').split(',').filter(Boolean)
  if (keys.length === 0) return ''
  return keys[Math.floor(Math.random() * keys.length)]
}

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api'

interface EtherscanLogEntry {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  timeStamp: string
  transactionHash: string
}

interface EtherscanResponse {
  status: string
  message: string
  result: EtherscanLogEntry[] | string
}

async function fetchEtherscanLogs(params: {
  chainId: number
  address: string
  topic0?: string
  topic1?: string
  fromBlock: number | string
  toBlock: string
  page?: number
  offset?: number
}): Promise<EtherscanLogEntry[]> {
  const apiKey = getEtherscanKey()
  if (!apiKey) return []

  const url = new URL(ETHERSCAN_V2)
  url.searchParams.set('chainid', String(params.chainId))
  url.searchParams.set('module', 'logs')
  url.searchParams.set('action', 'getLogs')
  url.searchParams.set('address', params.address)
  if (params.topic0) url.searchParams.set('topic0', params.topic0)
  if (params.topic1) url.searchParams.set('topic1', params.topic1)
  url.searchParams.set('fromBlock', String(params.fromBlock))
  url.searchParams.set('toBlock', params.toBlock)
  url.searchParams.set('page', String(params.page || 1))
  url.searchParams.set('offset', String(params.offset || 100))
  url.searchParams.set('apikey', apiKey)

  try {
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) })
    const data: EtherscanResponse = await resp.json()

    if (data.status !== '1' || !Array.isArray(data.result)) {
      return []
    }
    return data.result
  } catch (err) {
    logger.warn(`[etherscan] Log fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

// ============================================
// Gains Network (Arbitrum) — Trade Events
// ============================================

// Gains gTrade Diamond contract on Arbitrum
const GAINS_DIAMOND = '0xFF162c694EAA571f685030649814282eA457f169'
const ARBITRUM_CHAIN_ID = 42161

// MarketExecuted event signature (from gTrade v8)
// event MarketExecuted(address indexed trader, uint256 indexed orderId, ...)
// Topic0 for trade close events — we check multiple known signatures
const GAINS_TRADE_TOPICS = [
  '0xbb058b3eaaea5c2a669a057939f688156d50b5e092969eae671e583635192ead', // MarketExecuted
  '0xb4297e7afacc3feba178e4f28c397de07b41ed21fcf827dce89e87ebff30f456', // TradeClosed
]

/**
 * Fetch Gains Network position history for a trader via Etherscan V2.
 * Parses on-chain trade execution events.
 */
export async function fetchGainsOnchainPositionHistory(
  traderAddress: string,
  limit = 100
): Promise<PositionHistoryItem[]> {
  if (!getEtherscanKey()) return []

  try {
    // Pad trader address to 32 bytes for topic filter
    const paddedAddr = '0x' + traderAddress.toLowerCase().replace('0x', '').padStart(64, '0')

    // Fetch last 90 days of blocks (~7200 blocks/day on Arbitrum = ~648000 blocks)
    const fromBlock = 'earliest' // Let Etherscan handle block range

    const allEvents: EtherscanLogEntry[] = []

    for (const topic0 of GAINS_TRADE_TOPICS) {
      const events = await fetchEtherscanLogs({
        chainId: ARBITRUM_CHAIN_ID,
        address: GAINS_DIAMOND,
        topic0,
        topic1: paddedAddr,
        fromBlock: 270000000, // ~Nov 2024 onwards
        toBlock: 'latest',
        offset: limit,
      })
      allEvents.push(...events)
    }

    if (allEvents.length === 0) return []

    // Parse events into positions
    // The data field contains encoded trade details
    const positions: PositionHistoryItem[] = allEvents
      .filter((e) => e.data && e.data.length > 2)
      .map((e) => {
        const timestamp = parseInt(e.timeStamp, 16) * 1000
        // Extract PnL from event data (varies by event type)
        // For simplicity, we extract what we can — the key insight is having timestamps
        const dataHex = e.data.replace('0x', '')
        let pnlUsd: number | null = null

        // Try to parse PnL from data (if data is long enough)
        if (dataHex.length >= 128) {
          // In Gains v8 events, PnL is typically in the 3rd or 4th 32-byte word
          try {
            // Try 3rd word (offset 128-192)
            const pnlWord = dataHex.slice(128, 192)
            const pnlRaw = BigInt('0x' + pnlWord)
            // Check if negative (two's complement)
            const isSigned = pnlRaw > BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')
            const pnlValue = isSigned
              ? Number(pnlRaw - BigInt('0x10000000000000000000000000000000000000000000000000000000000000000')) / 1e18
              : Number(pnlRaw) / 1e18
            if (Math.abs(pnlValue) > 0.001 && Math.abs(pnlValue) < 1e9) {
              pnlUsd = pnlValue
            }
          } catch {
            // Can't parse PnL, leave null
          }
        }

        return {
          symbol: 'GAINS', // Can't easily determine pair from event data
          direction: 'long' as const, // Default — can't easily determine from event
          positionType: 'perpetual',
          marginMode: 'cross',
          openTime: null,
          closeTime: new Date(timestamp).toISOString(),
          entryPrice: null,
          exitPrice: null,
          maxPositionSize: null,
          closedSize: null,
          pnlUsd,
          pnlPct: null,
          status: 'closed',
        }
      })
      .filter((p) => p.closeTime != null)
      .slice(0, limit)

    return positions
  } catch (err) {
    logger.warn(`[gains-onchain] Position history failed for ${traderAddress}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch Gains equity curve from on-chain events.
 */
export async function fetchGainsOnchainEquityCurve(
  traderAddress: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const positions = await fetchGainsOnchainPositionHistory(traderAddress, 500)
    if (positions.length === 0) return []
    // Only use positions with PnL data
    const withPnl = positions.filter((p) => p.pnlUsd != null)
    if (withPnl.length < 2) return []
    return buildEquityCurveFromPositions(withPnl, days)
  } catch (err) {
    logger.warn(`[gains-onchain] Equity curve failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Compute Gains stats from on-chain trade events.
 */
export async function fetchGainsOnchainStatsDetail(
  traderAddress: string
): Promise<StatsDetail | null> {
  try {
    const positions = await fetchGainsOnchainPositionHistory(traderAddress, 500)
    const withPnl = positions.filter((p) => p.pnlUsd != null)
    if (withPnl.length === 0) return null

    const derivedStats = computeStatsFromPositions(withPnl)

    return {
      totalTrades: derivedStats.totalTrades ?? positions.length,
      profitableTradesPct: derivedStats.profitableTradesPct ?? null,
      avgHoldingTimeHours: null,
      avgProfit: derivedStats.avgProfit ?? null,
      avgLoss: derivedStats.avgLoss ?? null,
      largestWin: derivedStats.largestWin ?? null,
      largestLoss: derivedStats.largestLoss ?? null,
      sharpeRatio: null,
      maxDrawdown: derivedStats.maxDrawdown ?? null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: null,
      winningPositions: derivedStats.winningPositions ?? null,
      totalPositions: derivedStats.totalPositions ?? null,
    }
  } catch (err) {
    logger.warn(`[gains-onchain] Stats failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
