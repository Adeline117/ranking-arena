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
  const mountedRef = useRef(true)

  // Memoize join keys so the connect callback doesn't churn on every render
  // (without this, inline `symbols`/`exchanges` arrays would create a new
  // `connect` identity → main effect re-runs → old EventSource leaks while
  // a new one opens, compounding every render).
  const symbolsKey = symbols.join(',')
  const exchangesKey = exchanges.join(',')

  const connect = useCallback(() => {
    if (!enabled || !mountedRef.current) return

    // Close any previous connection before opening a new one — prevents
    // orphaned EventSource instances from accumulating across reconnects.
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    const params = new URLSearchParams({
      symbols: symbolsKey,
      exchanges: exchangesKey,
    })

    const es = new EventSource(`/api/ws/market?${params}`)
    eventSourceRef.current = es

    es.onopen = () => {
      if (!mountedRef.current) return
      reconnectAttempts.current = 0
      setState(prev => ({ ...prev, connected: true, error: null }))
    }

    es.onmessage = (event) => {
      if (!mountedRef.current) return
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
      } catch (_err) {
        // Intentionally swallowed: malformed SSE JSON event, skip and wait for next tick
      }
    }

    es.onerror = () => {
      es.close()
      if (eventSourceRef.current === es) eventSourceRef.current = null
      if (!mountedRef.current) return

      setState(prev => ({ ...prev, connected: false }))

      // Clear any outstanding reconnect timer before scheduling a new one —
      // es.onerror can fire multiple times per broken connection on some
      // browsers, which otherwise queues parallel reconnect timers.
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }

      // Cap reconnect attempts to prevent unbounded background reconnection
      // on permanently failed endpoints (e.g. server decommissioned).
      if (reconnectAttempts.current >= 10) return

      // 指数退避重连
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000)
      reconnectAttempts.current++
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        if (mountedRef.current) connect()
      }, delay)
    }
  }, [enabled, symbolsKey, exchangesKey, maxTrades])

  useEffect(() => {
    mountedRef.current = true

    // Defer the SSE connection so the page can finish loading and reach
    // networkidle before a persistent connection is opened. This prevents
    // Playwright / browser timeouts caused by the SSE stream blocking idle.
    const startTimer = setTimeout(() => {
      connect()
    }, initialDelayMs)

    return () => {
      mountedRef.current = false
      clearTimeout(startTimer)
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [connect, initialDelayMs])

  return state
}
