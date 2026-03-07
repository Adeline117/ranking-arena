'use client'

/**
 * 实时排行榜更新 Hook
 * 订阅 leaderboard_ranks 表变化，自动更新排行榜数据
 */

import { useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'

interface RankingUpdate {
  source_trader_id: string
  source: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  rank: number
}

interface UseRealtimeRankingsOptions {
  /** Exchange/source to filter (e.g., 'binance_futures') */
  source?: string
  /** Whether to enable realtime (default: true) */
  enabled?: boolean
  /** Callback when ranking data changes */
  onUpdate?: (updates: RankingUpdate[]) => void
}

/**
 * Subscribe to ranking changes via Supabase Realtime.
 * Batches updates over a 2s window to avoid excessive re-renders.
 */
export function useRealtimeRankings({
  source,
  enabled = true,
  onUpdate,
}: UseRealtimeRankingsOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null)
  const bufferRef = useRef<Map<string, RankingUpdate>>(new Map())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  const flush = useCallback(() => {
    if (bufferRef.current.size === 0) return
    const updates = Array.from(bufferRef.current.values())
    bufferRef.current.clear()
    onUpdateRef.current?.(updates)
  }, [])

  useEffect(() => {
    if (!enabled) return

    const filter = source ? `source=eq.${source}` : undefined
    const channelName = `rankings-${source || 'all'}-${Date.now()}`

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'leaderboard_ranks',
          ...(filter ? { filter } : {}),
        },
        (payload) => {
          const row = payload.new as RankingUpdate
          if (row?.source_trader_id) {
            bufferRef.current.set(row.source_trader_id, row)
            // Batch: flush after 2s of quiet
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(flush, 2000)
          }
        }
      )
      .subscribe()

    channelRef.current = channel

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      flush() // flush remaining
      channel.unsubscribe()
      channelRef.current = null
    }
  }, [source, enabled, flush])
}
