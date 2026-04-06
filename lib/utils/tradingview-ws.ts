/**
 * TradingView 实时数据 WebSocket 客户端
 *
 * 使用 @mathieuc/tradingview 库连接 TradingView WebSocket，
 * 获取实时价格、成交量和技术分析数据。
 *
 * 注意：此模块仅在 Node.js 运行时可用（非 Edge），
 * 因为 @mathieuc/tradingview 依赖 `ws` 包。
 */

import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('tradingview-ws')

// ============================================
// Types
// ============================================

export interface RealtimePrice {
  symbol: string
  price: number
  change24h: number
  changePct24h: number
  volume: number
  high24h: number
  low24h: number
  updatedAt: number
}

export interface TechnicalAnalysis {
  symbol: string
  timeframe: string
  /** -2 (strong sell) to +2 (strong buy) */
  recommendation: number
  recommendationLabel: string
  maRecommendation: number
  otherRecommendation: number
  updatedAt: number
}

export interface RealtimeSnapshot {
  prices: Record<string, RealtimePrice>
  technicalAnalysis: Record<string, TechnicalAnalysis>
  updatedAt: number
}

// ============================================
// TradingView symbols mapping
// ============================================

const SYMBOL_MAP: Record<string, { tv: string; display: string }> = {
  BTC: { tv: 'BINANCE:BTCUSDT', display: 'BTC' },
  ETH: { tv: 'BINANCE:ETHUSDT', display: 'ETH' },
  SOL: { tv: 'BINANCE:SOLUSDT', display: 'SOL' },
  BNB: { tv: 'BINANCE:BNBUSDT', display: 'BNB' },
  XRP: { tv: 'BINANCE:XRPUSDT', display: 'XRP' },
  ADA: { tv: 'BINANCE:ADAUSDT', display: 'ADA' },
  DOGE: { tv: 'BINANCE:DOGEUSDT', display: 'DOGE' },
  AVAX: { tv: 'BINANCE:AVAXUSDT', display: 'AVAX' },
  LINK: { tv: 'BINANCE:LINKUSDT', display: 'LINK' },
  DOT: { tv: 'BINANCE:DOTUSDT', display: 'DOT' },
  ARB: { tv: 'BINANCE:ARBUSDT', display: 'ARB' },
  MATIC: { tv: 'BINANCE:MATICUSDT', display: 'MATIC' },
}

// ============================================
// Minimal type stubs for @mathieuc/tradingview (no published types)
// ============================================

interface TVChartPeriod {
  close: number
  open: number
  volume?: number
  max?: number
  high?: number
  min?: number
  low?: number
}

interface TVChart {
  setMarket(symbol: string, opts: { timeframe: string; range: number }): void
  onError(cb: (...args: unknown[]) => void): void
  onUpdate(cb: () => void): void
  delete(): void
  periods?: TVChartPeriod[]
}

interface TVClient {
  onConnected(cb: () => void): void
  onDisconnected(cb: () => void): void
  onError(cb: (...args: unknown[]) => void): void
  end(): void
  Session: { Chart: new () => TVChart }
}

interface TVModule {
  Client: new () => TVClient
  getTA(symbol: string): Promise<Record<string, { All?: number; MA?: number; Other?: number }> | null>
}

// ============================================
// Singleton state
// ============================================

let tvClient: TradingViewClientWrapper | null = null
let isInitializing = false

interface TradingViewClientWrapper {
  prices: Map<string, RealtimePrice>
  ta: Map<string, TechnicalAnalysis>
  lastTaFetch: number

  client: TVClient | null

  charts: Map<string, TVChart>
  connected: boolean
  destroy: () => void
}

// ============================================
// Technical Analysis via Scanner API (HTTP)
// ============================================

async function fetchTechnicalAnalysis(
  symbols: string[]
): Promise<Map<string, TechnicalAnalysis>> {
  const result = new Map<string, TechnicalAnalysis>()

  try {
    // Use variable to prevent Turbopack static analysis
    const pkg = '@mathieuc/' + 'tradingview'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TradingView = require(pkg) as TVModule

    for (const sym of symbols) {
      const mapping = SYMBOL_MAP[sym]
      if (!mapping) continue

      try {
        const ta = await TradingView.getTA(mapping.tv)
        if (!ta) continue

        // 1D timeframe
        const daily = ta['1D']
        if (!daily) continue

        const rec = daily.All ?? 0
        let label = '中性'
        if (rec >= 1) label = '买入'
        if (rec >= 1.5) label = '强烈买入'
        if (rec <= -1) label = '卖出'
        if (rec <= -1.5) label = '强烈卖出'

        result.set(sym, {
          symbol: sym,
          timeframe: '1D',
          recommendation: rec,
          recommendationLabel: label,
          maRecommendation: daily.MA ?? 0,
          otherRecommendation: daily.Other ?? 0,
          updatedAt: Date.now(),
        })
      } catch (e) {
        logger.warn(`TA fetch failed for ${sym}`, {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  } catch (e) {
    logger.error('TradingView TA module load failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  return result
}

// ============================================
// Real-time Price via WebSocket
// ============================================

function createTVClient(): TradingViewClientWrapper {
  let TradingView: TVModule | undefined
  try {
    TradingView = globalThis.require?.('@mathieuc/' + 'tradingview') as TVModule | undefined
  } catch (_err) { /* optional dep */ }

  const wrapper: TradingViewClientWrapper = {
    prices: new Map(),
    ta: new Map(),
    lastTaFetch: 0,
    client: null,
    charts: new Map(),
    connected: false,
    destroy: () => {},
  }

  try {
    if (!TradingView) throw new Error('TradingView module not available')
    const client = new TradingView.Client()
    wrapper.client = client

    client.onConnected(() => {
      logger.info('TradingView WebSocket connected')
      wrapper.connected = true
    })

    client.onDisconnected(() => {
      logger.warn('TradingView WebSocket disconnected')
      wrapper.connected = false
      // Schedule reconnection
      scheduleReconnect()
    })

    client.onError((...args: unknown[]) => {
      logger.error('TradingView WebSocket error', {
        error: args.map(String).join(' '),
      })
    })

    // Create chart sessions for each symbol
    for (const [sym, mapping] of Object.entries(SYMBOL_MAP)) {
      try {
        const chart = new client.Session.Chart()
        chart.setMarket(mapping.tv, { timeframe: '1D', range: 2 })

        chart.onError((...err: unknown[]) => {
          logger.warn(`Chart error for ${sym}`, {
            error: err.map(String).join(' '),
          })
        })

        chart.onUpdate(() => {
          if (!chart.periods || !chart.periods[0]) return
          const p = chart.periods[0]
          const prev = chart.periods[1]

          const price = p.close
          const open24h = prev ? prev.close : p.open
          const change24h = price - open24h
          const changePct24h = open24h > 0 ? (change24h / open24h) * 100 : 0

          wrapper.prices.set(sym, {
            symbol: sym,
            price,
            change24h,
            changePct24h,
            volume: p.volume ?? 0,
            high24h: p.max ?? p.high ?? price,
            low24h: p.min ?? p.low ?? price,
            updatedAt: Date.now(),
          })
        })

        wrapper.charts.set(sym, chart)
      } catch (e) {
        logger.warn(`Failed to create chart for ${sym}`, {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    wrapper.destroy = () => {
      try {
        for (const chart of wrapper.charts.values()) {
          try {
            chart.delete()
          } catch (_err) {
            /* chart.delete() may fail if already disposed */
          }
        }
        wrapper.charts.clear()
        client.end()
      } catch (_err) {
        /* destroy cleanup errors are non-critical */
      }
      wrapper.connected = false
    }
  } catch (e) {
    logger.error('Failed to create TradingView client', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  return wrapper
}

// ============================================
// Reconnection logic
// ============================================

let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
const BASE_RECONNECT_DELAY_MS = 5000

function scheduleReconnect() {
  if (reconnectTimer) return
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error(
      `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`
    )
    return
  }

  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    60000
  )
  reconnectAttempts++

  logger.info(`Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts})`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (tvClient) {
      tvClient.destroy()
      tvClient = null
    }
    isInitializing = false
    // Will re-initialize on next getSnapshot call
  }, delay)
}

// ============================================
// Public API
// ============================================

/**
 * 获取当前实时数据快照
 */
export async function getRealtimeSnapshot(): Promise<RealtimeSnapshot> {
  // Initialize client if needed
  if (!tvClient && !isInitializing) {
    isInitializing = true
    try {
      tvClient = createTVClient()
      reconnectAttempts = 0
    } catch (e) {
      isInitializing = false
      logger.error('Failed to initialize TradingView client', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const prices: Record<string, RealtimePrice> = {}
  const ta: Record<string, TechnicalAnalysis> = {}

  if (tvClient) {
    // Collect prices
    for (const [sym, data] of tvClient.prices) {
      prices[sym] = data
    }

    // Fetch TA periodically (every 5 minutes)
    const now = Date.now()
    if (now - tvClient.lastTaFetch > 5 * 60 * 1000) {
      tvClient.lastTaFetch = now
      const symbols = Object.keys(SYMBOL_MAP)
      // Fire and forget - don't block the response
      fetchTechnicalAnalysis(symbols)
        .then((taMap) => {
          if (tvClient) {
            for (const [sym, data] of taMap) {
              tvClient.ta.set(sym, data)
            }
          }
        })
        .catch((e) => {
          logger.warn('Background TA fetch failed', {
            error: e instanceof Error ? e.message : String(e),
          })
        })
    }

    // Collect cached TA
    for (const [sym, data] of tvClient.ta) {
      ta[sym] = data
    }
  }

  return {
    prices,
    technicalAnalysis: ta,
    updatedAt: Date.now(),
  }
}

/**
 * 获取特定币种的技术分析（直接 HTTP 调用，不需要 WebSocket）
 */
export async function getTechnicalAnalysisForSymbol(
  symbol: string
): Promise<TechnicalAnalysis | null> {
  const result = await fetchTechnicalAnalysis([symbol])
  return result.get(symbol) ?? null
}

/**
 * 清理所有连接
 */
export function cleanup() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (tvClient) {
    tvClient.destroy()
    tvClient = null
  }
  isInitializing = false
  reconnectAttempts = 0
}

/**
 * 获取支持的币种列表
 */
export function getSupportedSymbols(): string[] {
  return Object.keys(SYMBOL_MAP)
}
