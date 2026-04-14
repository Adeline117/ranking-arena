/**
 * Real-time Trader Positions Hook
 *
 * Provides live position updates for traders using Supabase Realtime.
 * Subscribes to the trader_positions_live table for instant updates.
 */

'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRealtime } from './useRealtime'
import type { TraderPositionLive } from '@/lib/types/unified-trader'
import { logger } from '@/lib/logger'

// ============================================
// Types
// ============================================

interface PositionUpdate {
  type: 'open' | 'update' | 'close'
  position: TraderPositionLive
  previousPosition?: TraderPositionLive
}

interface UseTraderPositionsRealtimeOptions {
  /** Platform filter (e.g., 'binance', 'bybit') */
  platform?: string
  /** Trader key filter */
  traderKey?: string
  /** Whether to enable the subscription */
  enabled?: boolean
  /** Callback when a position is opened */
  onPositionOpen?: (position: TraderPositionLive) => void
  /** Callback when a position is updated */
  onPositionUpdate?: (position: TraderPositionLive, previous?: TraderPositionLive) => void
  /** Callback when a position is closed */
  onPositionClose?: (position: TraderPositionLive) => void
  /** Callback for any position change */
  onChange?: (update: PositionUpdate) => void
}

interface UseTraderPositionsRealtimeReturn {
  /** Current live positions */
  positions: TraderPositionLive[]
  /** Loading state */
  isLoading: boolean
  /** Connection status */
  status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error'
  /** Error message if any */
  error: string | null
  /** Total unrealized PnL */
  totalUnrealizedPnl: number
  /** Total position count */
  positionCount: number
  /** Long positions count */
  longCount: number
  /** Short positions count */
  shortCount: number
  /** Refresh positions manually */
  refresh: () => void
  /** Recent position updates (for notification display) */
  recentUpdates: PositionUpdate[]
}

// ============================================
// Helper Functions
// ============================================

function mapDbToPosition(row: Record<string, unknown>): TraderPositionLive {
  return {
    id: row.id as string,
    platform: row.platform as string,
    market_type: row.market_type as string || 'futures',
    trader_key: row.trader_key as string,
    symbol: row.symbol as string,
    side: row.side as 'long' | 'short',
    entry_price: Number(row.entry_price) || 0,
    current_price: row.current_price != null ? Number(row.current_price) : null,
    mark_price: row.mark_price != null ? Number(row.mark_price) : null,
    quantity: Number(row.quantity) || 0,
    leverage: Number(row.leverage) || 1,
    margin: row.margin != null ? Number(row.margin) : null,
    unrealized_pnl: row.unrealized_pnl != null ? Number(row.unrealized_pnl) : null,
    unrealized_pnl_pct: row.unrealized_pnl_pct != null ? Number(row.unrealized_pnl_pct) : null,
    liquidation_price: row.liquidation_price != null ? Number(row.liquidation_price) : null,
    opened_at: row.opened_at as string | null,
    updated_at: row.updated_at as string,
  }
}

// ============================================
// Main Hook
// ============================================

/**
 * Subscribe to real-time position updates for a trader
 *
 * @example
 * ```tsx
 * const {
 *   positions,
 *   totalUnrealizedPnl,
 *   status,
 *   recentUpdates
 * } = useTraderPositionsRealtime({
 *   platform: 'binance',
 *   traderKey: '123456',
 *   onPositionOpen: (pos) => toast.success(`New ${pos.side} position opened: ${pos.symbol}`),
 *   onPositionClose: (pos) => toast.info(`Position closed: ${pos.symbol}`),
 * })
 * ```
 */
export function useTraderPositionsRealtime(
  options: UseTraderPositionsRealtimeOptions = {}
): UseTraderPositionsRealtimeReturn {
  const {
    platform,
    traderKey,
    enabled = true,
    onPositionOpen,
    onPositionUpdate,
    onPositionClose,
    onChange,
  } = options

  // State
  const [positions, setPositions] = useState<TraderPositionLive[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [recentUpdates, setRecentUpdates] = useState<PositionUpdate[]>([])

  // Refs for callback stability
  const positionsRef = useRef<Map<string, TraderPositionLive>>(new Map())
  const onPositionOpenRef = useRef(onPositionOpen)
  const onPositionUpdateRef = useRef(onPositionUpdate)
  const onPositionCloseRef = useRef(onPositionClose)
  const onChangeRef = useRef(onChange)

  // Keep refs updated
  useEffect(() => {
    onPositionOpenRef.current = onPositionOpen
    onPositionUpdateRef.current = onPositionUpdate
    onPositionCloseRef.current = onPositionClose
    onChangeRef.current = onChange
  }, [onPositionOpen, onPositionUpdate, onPositionClose, onChange])

  // Build filter string
  const filter = (() => {
    const conditions: string[] = []
    if (platform) conditions.push(`platform=eq.${platform}`)
    if (traderKey) conditions.push(`trader_key=eq.${traderKey}`)
    return conditions.length > 0 ? conditions.join(',') : undefined
  })()

  // Add update to recent updates (keep last 10)
  const addRecentUpdate = useCallback((update: PositionUpdate) => {
    setRecentUpdates(prev => [update, ...prev].slice(0, 10))
  }, [])

  // Handle position insert (new position opened)
  const handleInsert = useCallback((payload: Record<string, unknown>) => {
    const position = mapDbToPosition(payload)
    const positionKey = `${position.platform}:${position.trader_key}:${position.symbol}:${position.side}`

    positionsRef.current.set(positionKey, position)
    setPositions(Array.from(positionsRef.current.values()))

    const update: PositionUpdate = { type: 'open', position }
    addRecentUpdate(update)
    onPositionOpenRef.current?.(position)
    onChangeRef.current?.(update)
  }, [addRecentUpdate])

  // Handle position update
  const handleUpdate = useCallback((payload: { old: Record<string, unknown>; new: Record<string, unknown> }) => {
    const newPosition = mapDbToPosition(payload.new)
    const oldPosition = mapDbToPosition(payload.old)
    const positionKey = `${newPosition.platform}:${newPosition.trader_key}:${newPosition.symbol}:${newPosition.side}`

    positionsRef.current.set(positionKey, newPosition)
    setPositions(Array.from(positionsRef.current.values()))

    const update: PositionUpdate = {
      type: 'update',
      position: newPosition,
      previousPosition: oldPosition,
    }
    addRecentUpdate(update)
    onPositionUpdateRef.current?.(newPosition, oldPosition)
    onChangeRef.current?.(update)
  }, [addRecentUpdate])

  // Handle position delete (position closed)
  const handleDelete = useCallback((payload: Record<string, unknown>) => {
    const position = mapDbToPosition(payload)
    const positionKey = `${position.platform}:${position.trader_key}:${position.symbol}:${position.side}`

    positionsRef.current.delete(positionKey)
    setPositions(Array.from(positionsRef.current.values()))

    const update: PositionUpdate = { type: 'close', position }
    addRecentUpdate(update)
    onPositionCloseRef.current?.(position)
    onChangeRef.current?.(update)
  }, [addRecentUpdate])

  // Set up realtime subscription
  const { status, error, reconnect } = useRealtime<Record<string, unknown>>({
    table: 'trader_positions_live',
    event: '*',
    filter,
    enabled: enabled && (!!platform || !!traderKey),
    onInsert: handleInsert,
    onUpdate: handleUpdate,
    onDelete: handleDelete,
    onConnect: () => setIsLoading(false),
  })

  // Initial data fetch
  useEffect(() => {
    if (!enabled || (!platform && !traderKey)) {
      setIsLoading(false)
      return
    }

    let aborted = false

    const fetchInitialPositions = async () => {
      setIsLoading(true)
      try {
        // Import supabase client dynamically to avoid SSR issues
        const { supabase } = await import('@/lib/supabase/client')
        if (aborted) return

        let query = supabase
          .from('trader_positions_live')
          .select('id, platform, market_type, trader_key, symbol, side, entry_price, current_price, mark_price, quantity, leverage, margin, unrealized_pnl, unrealized_pnl_pct, liquidation_price, opened_at, updated_at')
          .order('updated_at', { ascending: false })

        if (platform) {
          query = query.eq('platform', platform)
        }
        if (traderKey) {
          query = query.eq('trader_key', traderKey)
        }

        const { data, error: fetchError } = await query
        if (aborted) return

        if (fetchError) {
          logger.error('Error fetching initial positions:', fetchError)
        } else if (data) {
          positionsRef.current.clear()
          for (const row of data) {
            const position = mapDbToPosition(row as Record<string, unknown>)
            const key = `${position.platform}:${position.trader_key}:${position.symbol}:${position.side}`
            positionsRef.current.set(key, position)
          }
          setPositions(Array.from(positionsRef.current.values()))
        }
      } catch (err) {
        if (aborted) return
        logger.error('Error in fetchInitialPositions:', err)
      } finally {
        if (!aborted) setIsLoading(false)
      }
    }

    fetchInitialPositions()
    return () => { aborted = true }
  }, [enabled, platform, traderKey])

  // Calculate derived values
  const totalUnrealizedPnl = positions.reduce(
    (sum, p) => sum + (p.unrealized_pnl || 0),
    0
  )

  const longCount = positions.filter(p => p.side === 'long').length
  const shortCount = positions.filter(p => p.side === 'short').length

  // Refresh function
  const refresh = useCallback(() => {
    positionsRef.current.clear()
    setPositions([])
    reconnect()
  }, [reconnect])

  return {
    positions,
    isLoading,
    status,
    error,
    totalUnrealizedPnl,
    positionCount: positions.length,
    longCount,
    shortCount,
    refresh,
    recentUpdates,
  }
}

// ============================================
// Specialized Hooks
// ============================================

/**
 * Subscribe to all positions for a specific trader
 */
export function useTraderAllPositions(
  platform: string,
  traderKey: string,
  callbacks?: {
    onPositionOpen?: (position: TraderPositionLive) => void
    onPositionUpdate?: (position: TraderPositionLive) => void
    onPositionClose?: (position: TraderPositionLive) => void
  }
) {
  return useTraderPositionsRealtime({
    platform,
    traderKey,
    enabled: !!platform && !!traderKey,
    ...callbacks,
  })
}

/**
 * Subscribe to positions for a specific symbol across all traders
 */
export function useSymbolPositions(symbol: string) {
  const [positions, setPositions] = useState<TraderPositionLive[]>([])

  // Note: This would need a server-side filter or custom RPC
  // For now, filter client-side from all positions
  const { positions: allPositions, ...rest } = useTraderPositionsRealtime({
    enabled: !!symbol,
  })

  useEffect(() => {
    const filtered = allPositions.filter(
      p => p.symbol.toUpperCase().includes(symbol.toUpperCase())
    )
    setPositions(filtered)
  }, [allPositions, symbol])

  return {
    positions,
    ...rest,
  }
}

/**
 * Get aggregated position summary for a trader
 */
export function useTraderPositionSummary(platform: string, traderKey: string) {
  const {
    positions,
    isLoading,
    status,
    totalUnrealizedPnl,
    positionCount,
    longCount,
    shortCount,
  } = useTraderPositionsRealtime({ platform, traderKey })

  // Calculate additional metrics
  const totalMargin = positions.reduce((sum, p) => sum + (p.margin || 0), 0)
  const avgLeverage = positions.length > 0
    ? positions.reduce((sum, p) => sum + p.leverage, 0) / positions.length
    : 0
  const largestPosition = positions.reduce<TraderPositionLive | null>(
    (largest, p) => {
      const value = (p.margin || 0) * p.leverage
      const largestValue = largest ? (largest.margin || 0) * largest.leverage : 0
      return value > largestValue ? p : largest
    },
    null
  )

  return {
    positions,
    isLoading,
    status,
    summary: {
      totalPositions: positionCount,
      longPositions: longCount,
      shortPositions: shortCount,
      totalMargin,
      totalUnrealizedPnl,
      avgLeverage,
      largestPosition,
    },
  }
}

export default useTraderPositionsRealtime
