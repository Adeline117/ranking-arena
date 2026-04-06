/**
 * Exchange WebSocket Feeds - 交易所实时数据源
 *
 * 灵感来源: bmoscon/cryptofeed 架构
 * 统一 Binance / Bybit / OKX 三大交易所的 WebSocket 数据流
 * 标准化交易/行情数据格式, 自动重连, 消息去重
 */

import { EventEmitter } from 'events'

// ============================================
// 标准化数据类型
// ============================================

export interface NormalizedTrade {
  /** 唯一标识: exchange-tradeId */
  id: string
  exchange: ExchangeId
  symbol: string
  /** 统一交易对格式: BTC-USDT */
  pair: string
  side: 'buy' | 'sell'
  price: number
  amount: number
  /** 名义价值 USD */
  notional: number
  timestamp: number
  /** 原始交易所时间戳 */
  exchangeTimestamp: number
}

export interface NormalizedTicker {
  exchange: ExchangeId
  symbol: string
  pair: string
  bid: number
  ask: number
  last: number
  volume24h: number
  change24h: number
  timestamp: number
}

export type ExchangeId = 'binance' | 'bybit' | 'okx'

export type FeedEvent = 'trade' | 'ticker' | 'error' | 'connected' | 'disconnected' | 'reconnecting'

// ============================================
// 交易所 WebSocket 配置
// ============================================

interface ExchangeWsConfig {
  baseUrl: string
  buildSubscribeMessage: (symbols: string[]) => unknown
  parseTrade: (data: unknown) => NormalizedTrade | null
  parseTicker: (data: unknown) => NormalizedTicker | null
  /** 交易所原始符号格式转换: BTC-USDT -> btcusdt */
  toExchangeSymbol: (pair: string) => string
  pingInterval: number
  pingMessage?: () => unknown
}

const EXCHANGE_CONFIGS: Record<ExchangeId, ExchangeWsConfig> = {
  binance: {
    baseUrl: 'wss://stream.binance.com:9443/ws',
    buildSubscribeMessage: (symbols: string[]) => ({
      method: 'SUBSCRIBE',
      params: symbols.flatMap(s => {
        const sym = s.replace('-', '').toLowerCase()
        return [`${sym}@trade`, `${sym}@ticker`]
      }),
      id: Date.now(),
    }),
    parseTrade: (data: unknown): NormalizedTrade | null => {
      const d = data as Record<string, unknown>
      if (d.e !== 'trade') return null
      const price = parseFloat(d.p as string)
      const amount = parseFloat(d.q as string)
      return {
        id: `binance-${d.t}`,
        exchange: 'binance',
        symbol: (d.s as string).toUpperCase(),
        pair: normalizePair(d.s as string),
        side: (d.m as boolean) ? 'sell' : 'buy',
        price,
        amount,
        notional: price * amount,
        timestamp: Date.now(),
        exchangeTimestamp: d.T as number,
      }
    },
    parseTicker: (data: unknown): NormalizedTicker | null => {
      const d = data as Record<string, unknown>
      if (d.e !== '24hrTicker') return null
      return {
        exchange: 'binance',
        symbol: (d.s as string).toUpperCase(),
        pair: normalizePair(d.s as string),
        bid: parseFloat(d.b as string),
        ask: parseFloat(d.a as string),
        last: parseFloat(d.c as string),
        volume24h: parseFloat(d.q as string),
        change24h: parseFloat(d.P as string),
        timestamp: Date.now(),
      }
    },
    toExchangeSymbol: (pair: string) => pair.replace('-', '').toLowerCase(),
    pingInterval: 180000, // 3 min, Binance 自动 pong
  },

  bybit: {
    baseUrl: 'wss://stream.bybit.com/v5/public/spot',
    buildSubscribeMessage: (symbols: string[]) => ({
      op: 'subscribe',
      args: symbols.flatMap(s => {
        const sym = s.replace('-', '')
        return [`publicTrade.${sym}`, `tickers.${sym}`]
      }),
    }),
    parseTrade: (data: unknown): NormalizedTrade | null => {
      const d = data as Record<string, unknown>
      if (d.topic && typeof d.topic === 'string' && d.topic.startsWith('publicTrade.')) {
        const trades = (d.data as Array<Record<string, unknown>>)
        if (!trades?.length) return null
        const t = trades[0]
        const price = parseFloat(t.p as string)
        const amount = parseFloat(t.v as string)
        return {
          id: `bybit-${t.i}`,
          exchange: 'bybit',
          symbol: t.s as string,
          pair: normalizePair(t.s as string),
          side: (t.S as string) === 'Buy' ? 'buy' : 'sell',
          price,
          amount,
          notional: price * amount,
          timestamp: Date.now(),
          exchangeTimestamp: parseInt(t.T as string, 10),
        }
      }
      return null
    },
    parseTicker: (data: unknown): NormalizedTicker | null => {
      const d = data as Record<string, unknown>
      if (d.topic && typeof d.topic === 'string' && d.topic.startsWith('tickers.')) {
        const t = (d.data as Record<string, unknown>)
        if (!t) return null
        return {
          exchange: 'bybit',
          symbol: t.symbol as string,
          pair: normalizePair(t.symbol as string),
          bid: parseFloat(t.bid1Price as string || '0'),
          ask: parseFloat(t.ask1Price as string || '0'),
          last: parseFloat(t.lastPrice as string),
          volume24h: parseFloat(t.turnover24h as string || '0'),
          change24h: parseFloat(t.price24hPcnt as string || '0') * 100,
          timestamp: Date.now(),
        }
      }
      return null
    },
    toExchangeSymbol: (pair: string) => pair.replace('-', ''),
    pingInterval: 20000,
    pingMessage: () => ({ op: 'ping' }),
  },

  okx: {
    baseUrl: 'wss://ws.okx.com:8443/ws/v5/public',
    buildSubscribeMessage: (symbols: string[]) => ({
      op: 'subscribe',
      args: symbols.flatMap(s => [
        { channel: 'trades', instId: s },
        { channel: 'tickers', instId: s },
      ]),
    }),
    parseTrade: (data: unknown): NormalizedTrade | null => {
      const d = data as Record<string, unknown>
      if (d.arg && (d.arg as Record<string, unknown>).channel === 'trades') {
        const trades = d.data as Array<Record<string, unknown>>
        if (!trades?.length) return null
        const t = trades[0]
        const price = parseFloat(t.px as string)
        const amount = parseFloat(t.sz as string)
        return {
          id: `okx-${t.tradeId}`,
          exchange: 'okx',
          symbol: t.instId as string,
          pair: (t.instId as string), // OKX 已经是 BTC-USDT 格式
          side: (t.side as string) === 'buy' ? 'buy' : 'sell',
          price,
          amount,
          notional: price * amount,
          timestamp: Date.now(),
          exchangeTimestamp: parseInt(t.ts as string, 10),
        }
      }
      return null
    },
    parseTicker: (data: unknown): NormalizedTicker | null => {
      const d = data as Record<string, unknown>
      if (d.arg && (d.arg as Record<string, unknown>).channel === 'tickers') {
        const tickers = d.data as Array<Record<string, unknown>>
        if (!tickers?.length) return null
        const t = tickers[0]
        const last = parseFloat(t.last as string)
        const open24h = parseFloat(t.open24h as string)
        return {
          exchange: 'okx',
          symbol: t.instId as string,
          pair: t.instId as string,
          bid: parseFloat(t.bidPx as string),
          ask: parseFloat(t.askPx as string),
          last,
          volume24h: parseFloat(t.volCcy24h as string || '0'),
          change24h: open24h > 0 ? ((last - open24h) / open24h) * 100 : 0,
          timestamp: Date.now(),
        }
      }
      return null
    },
    toExchangeSymbol: (pair: string) => pair, // OKX 原生 BTC-USDT
    pingInterval: 25000,
    pingMessage: () => 'ping',
  },
}

// ============================================
// 工具函数
// ============================================

/** 将交易所原始符号转为统一格式 BTC-USDT */
function normalizePair(raw: string): string {
  const s = raw.toUpperCase()
  // 已经有分隔符
  if (s.includes('-')) return s
  if (s.includes('/')) return s.replace('/', '-')
  // 尝试匹配常见 quote: USDT, USDC, BUSD, BTC, ETH
  for (const quote of ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH']) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return `${s.slice(0, -quote.length)}-${quote}`
    }
  }
  return s
}

// ============================================
// ExchangeFeed - 单交易所 WebSocket 连接
// ============================================

export interface ExchangeFeedOptions {
  exchange: ExchangeId
  symbols: string[]  // 统一格式: ['BTC-USDT', 'ETH-USDT']
  maxReconnectAttempts?: number
}

export class ExchangeFeed extends EventEmitter {
  readonly exchange: ExchangeId
  private config: ExchangeWsConfig
  private symbols: string[]
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts: number
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private dedupeSet = new Set<string>()
  private dedupeCleanupTimer: ReturnType<typeof setInterval> | null = null
  private _connected = false
  private _destroyed = false

  constructor(opts: ExchangeFeedOptions) {
    super()
    this.exchange = opts.exchange
    this.config = EXCHANGE_CONFIGS[opts.exchange]
    this.symbols = opts.symbols
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 10
  }

  get connected(): boolean {
    return this._connected
  }

  /** 启动连接 */
  connect(): void {
    if (this._destroyed) return
    this.cleanup()

    try {
      this.ws = new WebSocket(this.config.baseUrl)
    } catch (err) {
      this.emit('error', { exchange: this.exchange, error: err })
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this._connected = true
      this.reconnectAttempts = 0
      this.emit('connected', { exchange: this.exchange })

      // 发送订阅消息
      const subMsg = this.config.buildSubscribeMessage(this.symbols)
      this.ws?.send(typeof subMsg === 'string' ? subMsg : JSON.stringify(subMsg))

      // 启动心跳
      this.startPing()

      // 启动去重集合清理 (每60秒清空, 避免内存泄漏)
      this.dedupeCleanupTimer = setInterval(() => {
        this.dedupeSet.clear()
      }, 60000)
    }

    this.ws.onmessage = (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : ''
        // OKX pong
        if (raw === 'pong') return

        const parsed = JSON.parse(raw)

        // 解析交易
        const trade = this.config.parseTrade(parsed)
        if (trade && !this.dedupeSet.has(trade.id)) {
          this.dedupeSet.add(trade.id)
          this.emit('trade', trade)
        }

        // 解析行情
        const ticker = this.config.parseTicker(parsed)
        if (ticker) {
          this.emit('ticker', ticker)
        }
      } catch (_err) {
        // Intentionally swallowed: malformed WS message (e.g., Bybit pong response), skip non-ticker data
      }
    }

    this.ws.onclose = () => {
      this._connected = false
      this.emit('disconnected', { exchange: this.exchange })
      if (!this._destroyed) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = (err) => {
      this.emit('error', { exchange: this.exchange, error: err })
    }
  }

  /** 断开并销毁 */
  destroy(): void {
    this._destroyed = true
    this.cleanup()
    this.removeAllListeners()
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.dedupeCleanupTimer) clearInterval(this.dedupeCleanupTimer)
    this.pingTimer = null
    this.reconnectTimer = null
    this.dedupeCleanupTimer = null

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      try { this.ws.close() } catch (_err) { /* ignore */ }
      this.ws = null
    }
    this._connected = false
  }

  private startPing(): void {
    if (!this.config.pingMessage) return
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const msg = this.config.pingMessage!()
        this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg))
      }
    }, this.config.pingInterval)
  }

  /** 指数退避重连 */
  private scheduleReconnect(): void {
    if (this._destroyed) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', {
        exchange: this.exchange,
        error: new Error(`达到最大重连次数 (${this.maxReconnectAttempts})`),
      })
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 60000)
    this.emit('reconnecting', {
      exchange: this.exchange,
      attempt: this.reconnectAttempts,
      delay,
    })

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }
}

export { normalizePair, EXCHANGE_CONFIGS }
