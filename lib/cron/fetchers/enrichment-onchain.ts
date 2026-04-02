/**
 * On-chain enrichment via Etherscan V2 API + Blockscout API
 *
 * Etherscan V2: Ethereum (1) and Arbitrum (42161) — free tier
 * Blockscout: Base (8453), Optimism (10), Arbitrum (42161) — completely free, no API key
 *
 * Currently supports:
 * - Gains Network (Arbitrum) — MarketExecuted events via Etherscan V2
 * - Kwenta / Synthetix V3 (Base) — OrderSettled events via Blockscout
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
    const _fromBlock = 'earliest' // Let Etherscan handle block range

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
            // Intentionally swallowed: PnL value unparseable (invalid format or overflow), leave as null
          }
        }

        const closeTimeISO = new Date(timestamp).toISOString()
        return {
          symbol: 'GAINS', // Can't easily determine pair from event data
          direction: 'long' as const, // Default — can't easily determine from event
          positionType: 'perpetual',
          marginMode: 'cross',
          openTime: closeTimeISO, // Use close time as open time — actual open unknown from event data, needed for unique constraint
          closeTime: closeTimeISO,
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
  // Hard timeout protection: 2 minutes max per trader
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout: fetchGainsOnchainEquityCurve exceeded 2 minutes')), 120000)
  )

  const mainWork = async (): Promise<EquityCurvePoint[]> => {
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

  try {
    return await Promise.race([mainWork(), timeoutPromise])
  } catch (err) {
    logger.warn(`[gains-onchain] Equity curve timeout for ${traderAddress}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

// ============================================
// Blockscout API client (free, no key needed)
// Supports: Base, Optimism, Arbitrum, Ethereum
// ============================================

const BLOCKSCOUT_URLS: Record<number, string> = {
  8453: 'https://base.blockscout.com',
  10: 'https://optimism.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  1: 'https://eth.blockscout.com',
}

interface BlockscoutLogEntry {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  timeStamp: string
  transactionHash: string
}

async function fetchBlockscoutLogs(params: {
  chainId: number
  address: string
  topic0: string
  topic1?: string
  topic2?: string
  fromBlock: number
  toBlock: string | number
  page?: number
  offset?: number
}): Promise<BlockscoutLogEntry[]> {
  const baseUrl = BLOCKSCOUT_URLS[params.chainId]
  if (!baseUrl) return []

  const url = new URL(`${baseUrl}/api`)
  url.searchParams.set('module', 'logs')
  url.searchParams.set('action', 'getLogs')
  url.searchParams.set('address', params.address)
  url.searchParams.set('topic0', params.topic0)
  if (params.topic1) {
    url.searchParams.set('topic1', params.topic1)
    url.searchParams.set('topic0_1_opr', 'and')
  }
  if (params.topic2) {
    url.searchParams.set('topic2', params.topic2)
    url.searchParams.set('topic0_2_opr', 'and')
  }
  url.searchParams.set('fromBlock', String(params.fromBlock))
  url.searchParams.set('toBlock', String(params.toBlock))
  url.searchParams.set('page', String(params.page || 1))
  url.searchParams.set('offset', String(params.offset || 200))

  try {
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(20000) })
    const data = await resp.json() as EtherscanResponse // Same format as Etherscan
    if (data.status !== '1' || !Array.isArray(data.result)) return []
    return data.result as BlockscoutLogEntry[]
  } catch (err) {
    logger.warn(`[blockscout] Log fetch failed (chain ${params.chainId}): ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

// ============================================
// Kwenta / Synthetix V3 (Base) — OrderSettled
// ============================================

const SYNTHETIX_PERPS_PROXY_BASE = '0x0a2af931effd34b81ebcc57e3d3c9b1e1de1c9ce'
const BASE_CHAIN_ID = 8453

// OrderSettled(uint128 indexed marketId, uint128 indexed accountId, ...)
// topic0 = keccak256 of full event signature
const ORDER_SETTLED_TOPIC = '0x460080a757ec90719fe90ab2384c0196cdeed071a9fd7ce1ada43481d96b7db5'

// Synthetix V3 market IDs → symbols (Base deployment)
const SYNTHETIX_MARKETS: Record<number, string> = {
  100: 'ETH', 200: 'BTC', 300: 'SNX', 400: 'SOL', 500: 'WIF',
  600: 'W', 700: 'DOGE', 800: 'AVAX', 900: 'OP', 1000: 'PEPE',
  1100: 'ARB', 1200: 'BNB', 1300: 'NEAR', 1400: 'LTC', 1500: 'AAVE',
  1600: 'LINK', 1700: 'ADA', 1800: 'XRP', 1900: 'MATIC', 2000: 'SUI',
}

function parseint256(hexWord: string): number {
  const val = BigInt('0x' + hexWord)
  const signed = val >= BigInt('0x8000000000000000000000000000000000000000000000000000000000000000')
    ? Number(val - BigInt('0x10000000000000000000000000000000000000000000000000000000000000000'))
    : Number(val)
  return signed / 1e18
}

/**
 * Fetch Kwenta/Synthetix V3 position history via Blockscout Base (free).
 * Parses OrderSettled events from PerpsMarketProxy contract.
 */
export async function fetchKwentaOnchainPositionHistory(
  traderAccountId: string,
  limit = 200
): Promise<PositionHistoryItem[]> {
  try {
    // Kwenta accountIds are uint128 — pad to 32 bytes for topic2
    const paddedId = '0x' + BigInt(traderAccountId).toString(16).padStart(64, '0')

    // OrderSettled(uint128 indexed marketId, uint128 indexed accountId, ...)
    // topic0 = event hash, topic1 = marketId, topic2 = accountId
    const events = await fetchBlockscoutLogs({
      chainId: BASE_CHAIN_ID,
      address: SYNTHETIX_PERPS_PROXY_BASE,
      topic0: ORDER_SETTLED_TOPIC,
      topic2: paddedId, // accountId is the 2nd indexed param (topic2)
      fromBlock: 10000000, // ~Jan 2024 when Synthetix V3 launched on Base
      toBlock: 'latest',
      offset: limit,
    })

    if (events.length === 0) {
      // If topic1 filter didn't work (Blockscout may not support topic2 directly),
      // try without topic filter and post-filter
      const allEvents = await fetchBlockscoutLogs({
        chainId: BASE_CHAIN_ID,
        address: SYNTHETIX_PERPS_PROXY_BASE,
        topic0: ORDER_SETTLED_TOPIC,
        fromBlock: 40000000, // Recent blocks only for unfiltered query
        toBlock: 'latest',
        offset: 1000,
      })

      // Filter by accountId in topic2
      const filtered = allEvents.filter((e) => e.topics[2]?.toLowerCase() === paddedId.toLowerCase())
      return parseKwentaEvents(filtered, limit)
    }

    return parseKwentaEvents(events, limit)
  } catch (err) {
    logger.warn(`[kwenta-onchain] Position history failed for ${traderAccountId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

function parseKwentaEvents(events: BlockscoutLogEntry[], limit: number): PositionHistoryItem[] {
  return events
    .filter((e) => e.data && e.data.length > 2 && e.topics.length >= 3)
    .map((e) => {
      const timestamp = parseInt(e.timeStamp, 16) * 1000
      let marketId = 0; try { marketId = Number(BigInt(e.topics[1])) } catch { /* invalid topic */ }
      const symbol = SYNTHETIX_MARKETS[marketId] || `MKT-${marketId}`

      // Parse data words (10 words: fillPrice, pnl, accruedFunding, sizeDelta, newSize, totalFees, ...)
      const dataHex = e.data.replace('0x', '')
      const words = Array.from({ length: Math.floor(dataHex.length / 64) }, (_, i) =>
        dataHex.slice(i * 64, (i + 1) * 64)
      )

      const fillPrice = words[0] ? parseint256(words[0]) : null
      const pnl = words[1] ? parseint256(words[1]) : null
      const accruedFunding = words[2] ? parseint256(words[2]) : null
      const sizeDelta = words[3] ? parseint256(words[3]) : 0
      const totalFees = words[5] ? parseint256(words[5]) : 0

      // Net PnL = pnl + accruedFunding - totalFees
      const netPnl = pnl != null
        ? pnl + (accruedFunding ?? 0) - totalFees
        : null

      const closeTimeISO = new Date(timestamp).toISOString()
      return {
        symbol: `${symbol}USDC`,
        direction: (sizeDelta > 0 ? 'long' : 'short') as 'long' | 'short',
        positionType: 'perpetual',
        marginMode: 'cross',
        openTime: closeTimeISO, // Use close time — actual open unknown from event data, needed for unique constraint
        closeTime: closeTimeISO,
        entryPrice: null,
        exitPrice: fillPrice,
        maxPositionSize: null,
        closedSize: Math.abs(sizeDelta) || null,
        pnlUsd: netPnl,
        pnlPct: null,
        status: 'closed',
      }
    })
    .filter((p) => p.closeTime != null)
    .slice(0, limit)
}

/**
 * Fetch Kwenta equity curve from on-chain OrderSettled events.
 */
export async function fetchKwentaOnchainEquityCurve(
  traderAccountId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const positions = await fetchKwentaOnchainPositionHistory(traderAccountId, 500)
    if (positions.length === 0) return []
    const withPnl = positions.filter((p) => p.pnlUsd != null)
    if (withPnl.length < 2) return []
    return buildEquityCurveFromPositions(withPnl, days)
  } catch (err) {
    logger.warn(`[kwenta-onchain] Equity curve failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Compute Kwenta stats from on-chain events.
 */
export async function fetchKwentaOnchainStatsDetail(
  traderAccountId: string
): Promise<StatsDetail | null> {
  try {
    const positions = await fetchKwentaOnchainPositionHistory(traderAccountId, 500)
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
      sharpeRatio: derivedStats.sharpeRatio ?? null,
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
    logger.warn(`[kwenta-onchain] Stats failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Compute Gains stats from on-chain trade events.
 */
export async function fetchGainsOnchainStatsDetail(
  traderAddress: string
): Promise<StatsDetail | null> {
  // Hard timeout protection: 2 minutes max per trader
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout: fetchGainsOnchainStatsDetail exceeded 2 minutes')), 120000)
  )

  const mainWork = async (): Promise<StatsDetail | null> => {
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
        sharpeRatio: derivedStats.sharpeRatio ?? null,
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

  try {
    return await Promise.race([mainWork(), timeoutPromise])
  } catch (err) {
    logger.warn(`[gains-onchain] Stats detail timeout for ${traderAddress}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
