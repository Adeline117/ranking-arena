/**
 * useMarketFeed - 实时市场数据 React Hook
 *
 * 通过 SSE 连接 /api/ws/market 端点, 提供:
 * - 实时交易流
 * - 行情数据
 * - 连接状态
 */

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { NormalizedTrade, NormalizedTicker, ExchangeId } from '@/lib/ws/exchange-feeds'

export interface MarketFeedState {
  trades: NormalizedTrade[]
  tickers: Map<string, NormalizedTicker>
  connectionStatus: Record<ExchangeId, boolean>
  connected: boolean
  error: string | null
}

export interface UseMarketFeedOptions {
  symbols?: string[]
  exchanges?: ExchangeId[]
  maxTrades?: number
  enabled?: boolean
  /**
   * Delay in ms before opening the SSE connection after mount.
   * Defaults to 2000ms so the page can reach networkidle before
   * a persistent SSE connection is established (fixes 30s timeout).
   */
  initialDelayMs?: number
}

const DEFAULT_SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT']
const DEFAULT_EXCHANGES: ExchangeId[] = ['binance', 'bybit', 'okx']

export function useMarketFeed(options: UseMarketFeedOptions = {}): MarketFeedState {
  const {
    symbols = DEFAULT_SYMBOLS,
    exchanges = DEFAULT_EXCHANGES,
    maxTrades = 100,
    enabled = true,
    initialDelayMs = 2000,
  } = options

  const [state, setState] = useState<MarketFeedState>({
    trades: [],
    tickers: new Map(),
    connectionStatus: { binance: false, bybit: false, okx: false },
    connected: false,
    error: null,
  })

  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttempts = useRef(0)

  const connect = useCallback(() => {
    if (!enabled) return

    const params = new URLSearchParams({
      symbols: symbols.join(','),
      exchanges: exchanges.join(','),
    })

    const es = new EventSource(`/api/ws/market?${params}`)
    eventSourceRef.current = es

    es.onopen = () => {
      reconnectAttempts.current = 0
      setState(prev => ({ ...prev, connected: true, error: null }))
    }

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)

        if (msg.type === 'snapshot') {
          setState(prev => ({
            ...prev,
            trades: msg.trades || [],
            connectionStatus: msg.connectionStatus || prev.connectionStatus,
          }))
          return
        }

        if (msg.type === 'trade') {
          setState(prev => {
            const newTrades = [msg.data, ...prev.trades]
            if (newTrades.length > maxTrades) newTrades.length = maxTrades
            return { ...prev, trades: newTrades }
          })
          return
        }

        if (msg.type === 'ticker') {
          setState(prev => {
            const newTickers = new Map(prev.tickers)
            newTickers.set(`${msg.data.pair}:${msg.data.exchange}`, msg.data)
            return { ...prev, tickers: newTickers }
          })
        }
      } catch {
        // Intentionally swallowed: malformed SSE JSON event, skip and wait for next tick
      }
    }

    es.onerror = () => {
      es.close()
      setState(prev => ({ ...prev, connected: false }))

      // 指数退避重连
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000)
      reconnectAttempts.current++
      reconnectTimerRef.current = setTimeout(connect, delay)
    }
  }, [enabled, symbols, exchanges, maxTrades])

  useEffect(() => {
    // Defer the SSE connection so the page can finish loading and reach
    // networkidle before a persistent connection is opened. This prevents
    // Playwright / browser timeouts caused by the SSE stream blocking idle.
    const startTimer = setTimeout(() => {
      connect()
    }, initialDelayMs)

    return () => {
      clearTimeout(startTimer)
      eventSourceRef.current?.close()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    }
  }, [connect, initialDelayMs])

  return state
}
