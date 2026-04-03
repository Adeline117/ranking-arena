'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

// ============================================
// Types (mirror server types)
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

export interface PriceFlash {
  symbol: string
  direction: 'up' | 'down' | null
  timestamp: number
}

// ============================================
// Hook
// ============================================

interface UseRealtimeMarketOptions {
  /** 使用 SSE 流还是轮询（默认 poll） */
  mode?: 'sse' | 'poll'
  /** 轮询间隔（毫秒，仅 poll 模式） */
  pollInterval?: number
  /** 是否启用（默认 true） */
  enabled?: boolean
  /** SSE 失败后是否自动降级到 poll（默认 true） */
  fallbackToPoll?: boolean
}

export function useRealtimeMarket(options: UseRealtimeMarketOptions = {}) {
  const {
    mode: preferredMode = 'poll',
    pollInterval = 10000,
    enabled = true,
    fallbackToPoll = true,
  } = options

  const [snapshot, setSnapshot] = useState<RealtimeSnapshot | null>(null)
  const [flashes, setFlashes] = useState<Record<string, PriceFlash>>({})
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeMode, setActiveMode] = useState<'sse' | 'poll' | 'none'>('none')

  const prevPricesRef = useRef<Record<string, number>>({})
  const eventSourceRef = useRef<EventSource | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)
  const flashTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const sseFailCountRef = useRef(0)

  const handleSnapshot = useCallback((data: RealtimeSnapshot) => {
    if (!mountedRef.current) return

    const newFlashes: Record<string, PriceFlash> = {}
    const prevPrices = prevPricesRef.current

    for (const [sym, priceData] of Object.entries(data.prices)) {
      const prevPrice = prevPrices[sym]
      if (prevPrice !== undefined && prevPrice !== priceData.price) {
        newFlashes[sym] = {
          symbol: sym,
          direction: priceData.price > prevPrice ? 'up' : 'down',
          timestamp: Date.now(),
        }
      }
      prevPrices[sym] = priceData.price
    }

    if (Object.keys(newFlashes).length > 0) {
      setFlashes((prev) => ({ ...prev, ...newFlashes }))
      const timer = setTimeout(() => {
        flashTimersRef.current.delete(timer)
        if (!mountedRef.current) return
        setFlashes((prev) => {
          const updated = { ...prev }
          for (const sym of Object.keys(newFlashes)) {
            if (updated[sym]?.timestamp === newFlashes[sym].timestamp) {
              delete updated[sym]
            }
          }
          return updated
        })
      }, 600)
      flashTimersRef.current.add(timer)
    }

    setSnapshot(data)
    setConnected(true)
    setError(null)
  }, [])

  // Fetch for poll mode
  const fetchData = useCallback(async () => {
    if (!mountedRef.current) return
    try {
      const res = await fetch('/api/market/realtime', { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as RealtimeSnapshot
      handleSnapshot(data)
    } catch (e) {
      if (!mountedRef.current) return
      if (e instanceof Error && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'fetch failed')
      setConnected(false)
    }
  }, [handleSnapshot])

  const stopPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const startPoll = useCallback(() => {
    if (pollTimerRef.current) return
    setActiveMode('poll')
    fetchData()
    pollTimerRef.current = setInterval(fetchData, pollInterval)
  }, [fetchData, pollInterval])

  const stopSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  const startSSE = useCallback(() => {
    stopSSE()

    const es = new EventSource('/api/market/realtime?stream=1')
    eventSourceRef.current = es

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as RealtimeSnapshot
        handleSnapshot(data)
        setActiveMode('sse')
        sseFailCountRef.current = 0
      } catch {
        // Intentionally swallowed: malformed SSE JSON data, skip and wait for next event
      }
    }

    es.onerror = () => {
      setConnected(false)
      sseFailCountRef.current++

      // After 3 consecutive failures, fallback to poll
      if (fallbackToPoll && sseFailCountRef.current >= 3) {
        setError('SSE failed, falling back to polling')
        stopSSE()
        startPoll()
      } else {
        setError('SSE connection lost, reconnecting...')
      }
    }

    es.onopen = () => {
      setConnected(true)
      setError(null)
      setActiveMode('sse')
      sseFailCountRef.current = 0
      stopPoll()
    }
  }, [handleSnapshot, fallbackToPoll, stopSSE, startPoll, stopPoll])

  // Visibility handling — pause when page is hidden
  useEffect(() => {
    if (!enabled) return

    const handleVisibility = () => {
      if (!mountedRef.current) return
      const visible = document.visibilityState === 'visible'

      if (visible) {
        // Resume
        if (preferredMode === 'sse') {
          startSSE()
        } else {
          startPoll()
        }
      } else {
        // Pause all connections when page is hidden
        stopSSE()
        stopPoll()
        setConnected(false)
        setActiveMode('none')
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [enabled, preferredMode, startSSE, startPoll, stopSSE, stopPoll])

  // Main connection effect
  useEffect(() => {
    if (!enabled) return

    mountedRef.current = true

    if (preferredMode === 'sse') {
      startSSE()
    } else {
      startPoll()
    }

    const timers = flashTimersRef.current
    return () => {
      mountedRef.current = false
      stopSSE()
      stopPoll()
      // Clear all pending flash timers
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.clear()
    }
  }, [enabled, preferredMode, startSSE, startPoll, stopSSE, stopPoll])

  return {
    snapshot,
    flashes,
    connected,
    error,
    mode: activeMode,
    prices: snapshot?.prices ?? {},
    technicalAnalysis: snapshot?.technicalAnalysis ?? {},
  }
}
