'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

export interface PriceData {
  symbol: string
  price: number
  change24h: number
  change1h?: number
  volume?: number
  high24h?: number
  low24h?: number
  source?: string
  ts?: number
}

export interface PriceFlashInfo {
  direction: 'up' | 'down'
  timestamp: number
}

export type PriceMap = Record<string, PriceData>
export type FlashMap = Record<string, PriceFlashInfo>

interface UseRealtimePricesOptions {
  enabled?: boolean
  /** Fallback poll interval in ms (default 30000) */
  pollFallbackInterval?: number
}

export function useRealtimePrices(options: UseRealtimePricesOptions = {}) {
  const { enabled = true, pollFallbackInterval = 30000 } = options

  const [prices, setPrices] = useState<PriceMap>({})
  const [flashes, setFlashes] = useState<FlashMap>({})
  const [connected, setConnected] = useState(false)
  const [mode, setMode] = useState<'sse' | 'poll' | 'none'>('none')

  const prevPricesRef = useRef<Record<string, number>>({})
  const esRef = useRef<EventSource | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const visibleRef = useRef(true)
  const mountedRef = useRef(true)
  const flashTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const handleData = useCallback((data: Record<string, PriceData>) => {
    if (!mountedRef.current) return

    const newFlashes: FlashMap = {}
    const prev = prevPricesRef.current

    for (const [sym, pd] of Object.entries(data)) {
      if (prev[sym] !== undefined && prev[sym] !== pd.price) {
        newFlashes[sym] = {
          direction: pd.price > prev[sym] ? 'up' : 'down',
          timestamp: Date.now(),
        }
      }
      prev[sym] = pd.price
    }

    setPrices(data)
    setConnected(true)

    if (Object.keys(newFlashes).length > 0) {
      setFlashes(prev => ({ ...prev, ...newFlashes }))
      const timer = setTimeout(() => {
        flashTimersRef.current.delete(timer)
        if (!mountedRef.current) return
        setFlashes(prev => {
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
  }, [])

  const fetchPoll = useCallback(async () => {
    if (!mountedRef.current) return
    try {
      const r = await fetch('/api/market/realtime')
      if (!r.ok) return
      const data = await r.json()
      if (data.prices) {
        const mapped: PriceMap = {}
        for (const [sym, pd] of Object.entries(data.prices) as [string, { price: number; changePct24h?: number; change24h?: number; volume?: number; high24h?: number; low24h?: number }][]) {
          mapped[sym] = {
            symbol: sym,
            price: pd.price,
            change24h: pd.changePct24h ?? pd.change24h ?? 0,
            volume: pd.volume,
            high24h: pd.high24h,
            low24h: pd.low24h,
          }
        }
        handleData(mapped)
      }
      setMode('poll')
    } catch (_err) {
      if (mountedRef.current) setConnected(false)
    }
  }, [handleData])

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPoll = useCallback(() => {
    if (pollRef.current) return
    setMode('poll')
    fetchPoll()
    pollRef.current = setInterval(fetchPoll, pollFallbackInterval)
  }, [fetchPoll, pollFallbackInterval])

  // SSE connection
  const connectSSE = useCallback(() => {
    if (esRef.current) esRef.current.close()

    const es = new EventSource('/api/stream/prices')
    esRef.current = es

    es.onmessage = (event) => {
      try {
        handleData(JSON.parse(event.data))
        setMode('sse')
      } catch (_err) { /* ignore parse errors */ }
    }

    es.onerror = () => {
      setConnected(false)
      es.close()
      esRef.current = null
      // Fallback to polling
      startPoll()
    }

    es.onopen = () => {
      setConnected(true)
      setMode('sse')
      stopPoll()
    }
  }, [handleData, startPoll, stopPoll])

  // Visibility handling
  useEffect(() => {
    if (!enabled) return

    mountedRef.current = true

    const handleVisibility = () => {
      const visible = document.visibilityState === 'visible'
      visibleRef.current = visible

      if (visible) {
        connectSSE()
      } else {
        // Disconnect when hidden
        if (esRef.current) {
          esRef.current.close()
          esRef.current = null
        }
        stopPoll()
        setConnected(false)
        setMode('none')
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)

    // Initial connect
    connectSSE()

    const timers = flashTimersRef.current
    return () => {
      mountedRef.current = false
      document.removeEventListener('visibilitychange', handleVisibility)
      if (esRef.current) { esRef.current.close(); esRef.current = null }
      stopPoll()
      // Clear all pending flash timers
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.clear()
    }
  }, [enabled, connectSSE, stopPoll])

  return { prices, flashes, connected, mode }
}
