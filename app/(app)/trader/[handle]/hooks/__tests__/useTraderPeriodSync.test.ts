import { renderHook } from '@testing-library/react'
import { usePeriodStore } from '@/lib/stores/periodStore'

let mockPathname = '/trader/a'
let mockSearch = ''
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}))
const mockReplace = jest.fn()
jest.mock('../replaceUrlShallow', () => ({ replaceUrlShallow: (p: string) => mockReplace(p) }))

import { useTraderPeriodSync } from '../useTraderPeriodSync'

describe('useTraderPeriodSync', () => {
  beforeEach(() => {
    mockReplace.mockClear()
    usePeriodStore.setState({ period: '90D' })
  })

  it('opening a trader without ?period resets a period left over from another trader', () => {
    usePeriodStore.setState({ period: '7D' }) // chosen on trader A
    mockPathname = '/trader/b'
    mockSearch = ''
    const { result } = renderHook(() => useTraderPeriodSync())
    expect(result.current).toBe('90D')
    expect(usePeriodStore.getState().period).toBe('90D')
  })

  it('honours an explicit ?period= link', () => {
    mockPathname = '/trader/c'
    mockSearch = 'period=30D'
    const { result } = renderHook(() => useTraderPeriodSync())
    expect(result.current).toBe('30D')
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
