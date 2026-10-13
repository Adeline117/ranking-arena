import { renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useTraderPositionsRealtime } from '../useTraderPositionsRealtime'

describe('useTraderPositionsRealtime history quarantine', () => {
  it('exposes a stable unavailable state instead of a raw browser subscription', () => {
    const { result } = renderHook(() =>
      useTraderPositionsRealtime({ platform: 'binance_futures', traderKey: 'alice' })
    )

    expect(result.current).toMatchObject({
      positions: [],
      isLoading: false,
      status: 'disconnected',
      totalUnrealizedPnl: null,
      positionCount: 0,
      recentUpdates: [],
      publication: {
        state: 'unknown',
        reason: 'historical_metric_publication_unavailable',
      },
    })
  })

  it('does not retain direct PostgREST querying or Realtime subscription code', () => {
    const hook = readFileSync(
      join(process.cwd(), 'lib/hooks/useTraderPositionsRealtime.ts'),
      'utf8'
    )

    expect(hook).not.toContain(".from('trader_positions_live')")
    expect(hook).not.toContain("table: 'trader_positions_live'")
    expect(hook).not.toContain("from './useRealtime'")
    expect(hook).not.toContain('@/lib/supabase/client')
  })
})
