/**
 * Feed Manager - 多交易所实时数据聚合管理
 *
 * 管理多个交易所 WebSocket 连接, 聚合数据流,
 * 提供订阅 API 供组件使用
 */

import { EventEmitter } from 'events'
import {
  ExchangeFeed,
  type ExchangeId,
  type NormalizedTrade,
  type NormalizedTicker,
} from './exchange-feeds'
import { logger } from '@/lib/logger'

// ============================================
// 类型
// ============================================

export interface FeedManagerConfig {
  /** 订阅的交易对 */
  symbols: string[]
  /** 启用的交易所 */
  exchanges: ExchangeId[]
  /** 最大交易历史条数 */
  maxTradeHistory: number
}

export interface MarketSnapshot {
  tickers: Map<string, Map<ExchangeId, NormalizedTicker>>
  recentTrades: NormalizedTrade[]
  connectionStatus: Record<ExchangeId, boolean>
}

export type Subscriber = (event: string, data: NormalizedTrade | NormalizedTicker | MarketSnapshot) => void

const DEFAULT_CONFIG: FeedManagerConfig = {
  symbols: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
  exchanges: ['binance', 'bybit', 'okx'],
  maxTradeHistory: 200,
}

// ============================================
// FeedManager 单例
// ============================================

export class FeedManager extends EventEmitter {
  private static instance: FeedManager | null = null

  private config: FeedManagerConfig
  private feeds: Map<ExchangeId, ExchangeFeed> = new Map()
  private tickers: Map<string, Map<ExchangeId, NormalizedTicker>> = new Map()
  private tradeHistory: NormalizedTrade[] = []
  private subscribers: Set<Subscriber> = new Set()
  private started = false

  private constructor(config: Partial<FeedManagerConfig> = {}) {
    super()
    this.setMaxListeners(100) // Prevent EventEmitter memory leak warnings with many SSE clients
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  static getInstance(config?: Partial<FeedManagerConfig>): FeedManager {
    if (!FeedManager.instance) {
      FeedManager.instance = new FeedManager(config)
    }
    return FeedManager.instance
  }

  static resetInstance(): void {
    if (FeedManager.instance) {
      FeedManager.instance.stop()
      FeedManager.instance = null
    }
  }

  /** 启动所有交易所连接 */
  start(): void {
    if (this.started) return
    this.started = true

    for (const exchangeId of this.config.exchanges) {
      const feed = new ExchangeFeed({
        exchange: exchangeId,
        symbols: this.config.symbols,
      })

      feed.on('trade', (trade: NormalizedTrade) => {
        this.tradeHistory.unshift(trade)
        if (this.tradeHistory.length > this.config.maxTradeHistory) {
          this.tradeHistory.length = this.config.maxTradeHistory
        }
        this.emit('trade', trade)
        this.notifySubscribers('trade', trade)
      })

      feed.on('ticker', (ticker: NormalizedTicker) => {
        if (!this.tickers.has(ticker.pair)) {
          this.tickers.set(ticker.pair, new Map())
        }
        this.tickers.get(ticker.pair)!.set(ticker.exchange, ticker)
        this.emit('ticker', ticker)
        this.notifySubscribers('ticker', ticker)
      })

      feed.on('connected', (info) => this.emit('connected', info))
      feed.on('disconnected', (info) => this.emit('disconnected', info))
      feed.on('reconnecting', (info) => this.emit('reconnecting', info))
      feed.on('error', (info) => {
        logger.warn(`[ws] Feed error for ${exchangeId}: ${JSON.stringify(info)}`)
        // Only emit if there are listeners — unhandled 'error' events crash Node.js
        if (this.listenerCount('error') > 0) {
          this.emit('error', info)
        }
      })

      this.feeds.set(exchangeId, feed)
      feed.connect()
    }
  }

  /** 停止所有连接 */
  stop(): void {
    this.started = false
    for (const feed of this.feeds.values()) {
      feed.destroy()
    }
    this.feeds.clear()
    this.subscribers.clear()
  }

  /** 订阅数据更新 */
  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
      // Auto-stop when no subscribers remain to prevent resource leaks in serverless
      if (this.subscribers.size === 0 && this.started) {
        this.stop()
        FeedManager.instance = null
      }
    }
  }

  /** 获取当前市场快照 */
  getSnapshot(): MarketSnapshot {
    const connectionStatus: Record<string, boolean> = {} as Record<ExchangeId, boolean>
    for (const [id, feed] of this.feeds) {
      connectionStatus[id] = feed.connected
    }
    return {
      tickers: this.tickers,
      recentTrades: [...this.tradeHistory],
      connectionStatus: connectionStatus as Record<ExchangeId, boolean>,
    }
  }

  /** 获取最近 N 条交易 */
  getRecentTrades(limit = 50): NormalizedTrade[] {
    return this.tradeHistory.slice(0, limit)
  }

  /** 获取指定交易对的最新行情 */
  getTicker(pair: string): Map<ExchangeId, NormalizedTicker> | undefined {
    return this.tickers.get(pair)
  }

  private notifySubscribers(event: string, data: NormalizedTrade | NormalizedTicker): void {
    for (const sub of this.subscribers) {
      try {
        sub(event, data)
      } catch (_err) {
        // Intentionally swallowed: subscriber callback error must not break iteration over other subscribers
      }
    }
  }
}
