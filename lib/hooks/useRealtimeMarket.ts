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
  /** 使用 SSE 流还是轮询（默认 SSE） */
  mode?: 'sse' | 'poll'
  /** 轮询间隔（毫秒，仅 poll 模式） */
  pollInterval?: number
  /** 是否启用（默认 true） */
  enabled?: boolean
}

export function useRealtimeMarket(options: UseRealtimeMarketOptions = {}) {
  const { mode = 'poll', pollInterval = 10000, enabled = true } = options

  const [snapshot, setSnapshot] = useState<RealtimeSnapshot | null>(null)
  const [flashes, setFlashes] = useState<Record<string, PriceFlash>>({})
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const prevPricesRef = useRef<Record<string, number>>({})
  const eventSourceRef = useRef<EventSource | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const handleSnapshot = useCallback((data: RealtimeSnapshot) => {
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
      // Clear flashes after 600ms
      setTimeout(() => {
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
    }

    setSnapshot(data)
    setConnected(true)
    setError(null)
  }, [])

  // SSE mode
  useEffect(() => {
    if (!enabled || mode !== 'sse') return

    const es = new EventSource('/api/market/realtime?stream=1')
    eventSourceRef.current = es

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as RealtimeSnapshot
        handleSnapshot(data)
      } catch {
        // skip malformed data
      }
    }

    es.onerror = () => {
      setConnected(false)
      setError('SSE connection lost, reconnecting...')
    }

    es.onopen = () => {
      setConnected(true)
      setError(null)
    }

    return () => {
      es.close()
      eventSourceRef.current = null
    }
  }, [enabled, mode, handleSnapshot])

  // Poll mode
  useEffect(() => {
    if (!enabled || mode !== 'poll') return

    const fetchData = async () => {
      try {
        const res = await fetch('/api/market/realtime')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as RealtimeSnapshot
        handleSnapshot(data)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'fetch failed')
        setConnected(false)
      }
    }

    fetchData()
    pollTimerRef.current = setInterval(fetchData, pollInterval)

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
  }, [enabled, mode, pollInterval, handleSnapshot])

  return {
    snapshot,
    flashes,
    connected,
    error,
    prices: snapshot?.prices ?? {},
    technicalAnalysis: snapshot?.technicalAnalysis ?? {},
  }
}
