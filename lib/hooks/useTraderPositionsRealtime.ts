/**
 * Legacy live-position transport quarantine.
 *
 * Browser-side PostgREST reads and Realtime subscriptions used to expose raw
 * entry/mark prices, margin, liquidation levels, and PnL. Until a public
 * position publication contract exists, keep every hook on a stable empty
 * state instead of reconnecting to the raw relation.
 */

'use client'

import { useCallback } from 'react'
import type { TraderPositionLive } from '@/lib/types/unified-trader'
import {
  LEGACY_METRIC_PUBLICATION_UNAVAILABLE,
  type LegacyMetricPublication,
} from '@/lib/data/trader/history-quarantine'

interface PositionUpdate {
  type: 'open' | 'update' | 'close'
  position: TraderPositionLive
  previousPosition?: TraderPositionLive
}

interface UseTraderPositionsRealtimeOptions {
  platform?: string
  traderKey?: string
  enabled?: boolean
  onPositionOpen?: (position: TraderPositionLive) => void
  onPositionUpdate?: (position: TraderPositionLive, previous?: TraderPositionLive) => void
  onPositionClose?: (position: TraderPositionLive) => void
  onChange?: (update: PositionUpdate) => void
}

interface UseTraderPositionsRealtimeReturn {
  positions: TraderPositionLive[]
  isLoading: boolean
  status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error'
  error: string | null
  totalUnrealizedPnl: null
  positionCount: number
  longCount: number
  shortCount: number
  refresh: () => void
  recentUpdates: PositionUpdate[]
  publication: LegacyMetricPublication
}

/**
 * Retained for source compatibility. It intentionally performs no Supabase
 * SELECT, channel subscription, or client-side filtering of raw positions.
 */
export function useTraderPositionsRealtime(
  _options: UseTraderPositionsRealtimeOptions = {}
): UseTraderPositionsRealtimeReturn {
  const refresh = useCallback(() => undefined, [])

  return {
    positions: [],
    isLoading: false,
    status: 'disconnected',
    error: null,
    totalUnrealizedPnl: null,
    positionCount: 0,
    longCount: 0,
    shortCount: 0,
    refresh,
    recentUpdates: [],
    publication: LEGACY_METRIC_PUBLICATION_UNAVAILABLE,
  }
}

/** Retained source-compatible aliases; both inherit the same fail-closed state. */
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
    enabled: Boolean(platform && traderKey),
    ...callbacks,
  })
}

export function useSymbolPositions(_symbol: string) {
  return useTraderPositionsRealtime({ enabled: Boolean(_symbol) })
}

export function useTraderPositionSummary(platform: string, traderKey: string) {
  const state = useTraderPositionsRealtime({ platform, traderKey })

  return {
    ...state,
    summary: {
      totalPositions: null,
      longPositions: null,
      shortPositions: null,
      totalMargin: null,
      totalUnrealizedPnl: null,
      avgLeverage: null,
      largestPosition: null,
    },
  }
}

export default useTraderPositionsRealtime
