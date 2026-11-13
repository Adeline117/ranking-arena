import { act, renderHook } from '@testing-library/react'

let mockPathname = '/trader/alice'
let mockSearch = ''
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}))
const mockReplaceUrlShallow = jest.fn()
jest.mock('../replaceUrlShallow', () => ({
  replaceUrlShallow: (path: string) => mockReplaceUrlShallow(path),
}))

import { usePeriodStore } from '@/lib/stores/periodStore'
import { useTraderPeriodSync } from '../useTraderPeriodSync'

describe('useTraderPeriodSync', () => {
  beforeEach(() => {
    mockReplaceUrlShallow.mockClear()
    mockPathname = '/trader/alice'
    mockSearch = ''
    act(() => usePeriodStore.getState().setPeriod('90D'))
  })

  it('adopts a valid ?period= from the URL on mount', () => {
    mockSearch = 'period=30D'
    const { result } = renderHook(() => useTraderPeriodSync())
    expect(result.current).toBe('30D')
  })

  it('resets to 90D when the next trader URL has no ?period=', () => {
    // Previous trader page left the module-global store on 7D.
    act(() => usePeriodStore.getState().setPeriod('7D'))
    mockSearch = ''

    const { result } = renderHook(() => useTraderPeriodSync())

    expect(result.current).toBe('90D')
    // 90D is the default, so the URL stays without ?period=.
    expect(mockReplaceUrlShallow).not.toHaveBeenCalled()
  })

  it('ignores an invalid ?period= and uses 90D', () => {
    act(() => usePeriodStore.getState().setPeriod('7D'))
    mockSearch = 'period=1Y'
    const { result } = renderHook(() => useTraderPeriodSync())
    expect(result.current).toBe('90D')
  })

  it('writes a user-selected non-default period back to the URL', () => {
    mockSearch = ''
    renderHook(() => useTraderPeriodSync())

    act(() => usePeriodStore.getState().setPeriod('7D'))

    expect(mockReplaceUrlShallow).toHaveBeenLastCalledWith('/trader/alice?period=7D')
  })

  it('re-syncs from the URL when the trader (pathname) changes on a mounted page', () => {
    mockPathname = '/trader/d'
    mockSearch = 'period=7D'
    const { result, rerender } = renderHook(() => useTraderPeriodSync())
    expect(result.current).toBe('7D')

    mockPathname = '/trader/e'
    mockSearch = ''
    rerender()

    expect(result.current).toBe('90D')
  })
})
