import { act, renderHook, waitFor } from '@testing-library/react'

const mockReplace = jest.fn()
const mockRouter = { replace: mockReplace }
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  usePathname: () => '/trader/alice',
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}))

import { useTraderTabs } from '../useTraderTabs'

describe('useTraderTabs URL authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
  })

  it('publishes a click immediately while its URL replacement is pending', () => {
    mockSearchParams = new URLSearchParams('account=okx%3Asecondary')
    const hook = renderHook(() => useTraderTabs(null))

    expect(hook.result.current.activeTab).toBe('overview')

    act(() => hook.result.current.handleTabChange('stats'))

    expect(hook.result.current.activeTab).toBe('stats')
    expect(hook.result.current.visitedTabs).toContain('stats')
    expect(mockReplace).toHaveBeenLastCalledWith(
      '/trader/alice?account=okx%3Asecondary&tab=stats',
      { scroll: false }
    )
    expect(
      hook.result.current.tabKeys.indexOf(hook.result.current.activeTab)
    ).toBeGreaterThanOrEqual(0)
  })

  it('lets browser history and unrelated query rerenders override a pending click', async () => {
    mockSearchParams = new URLSearchParams('tab=stats&account=okx%3Asecondary')
    const hook = renderHook(() => useTraderTabs(null))

    expect(hook.result.current.activeTab).toBe('stats')
    act(() => hook.result.current.handleTabChange('portfolio'))
    expect(hook.result.current.activeTab).toBe('portfolio')

    // Back: the URL snapshot changes before the pending replace is accepted.
    mockSearchParams = new URLSearchParams('account=okx%3Asecondary')
    hook.rerender()
    expect(hook.result.current.activeTab).toBe('overview')
    expect(hook.result.current.visitedTabs).toContain('overview')

    // Forward to the prior URL, then rerender with an unrelated query change.
    mockSearchParams = new URLSearchParams('tab=stats&account=okx%3Asecondary')
    hook.rerender()
    expect(hook.result.current.activeTab).toBe('stats')

    mockSearchParams = new URLSearchParams('tab=portfolio&account=okx%3Asecondary&period=30D')
    hook.rerender()
    expect(hook.result.current.activeTab).toBe('portfolio')
    await waitFor(() => expect(hook.result.current.visitedTabs).toContain('portfolio'))
  })

  it('withdraws Posts synchronously when the visible subject loses claimed identity', async () => {
    mockSearchParams = new URLSearchParams('tab=posts&account=okx%3Asecondary')
    const hook = renderHook(({ claimed }) => useTraderTabs(claimed), {
      initialProps: { claimed: { id: 'route-owner' } as unknown },
    })

    expect(hook.result.current.activeTab).toBe('posts')
    expect(hook.result.current.visitedTabs).toContain('posts')

    hook.rerender({ claimed: null })

    expect(hook.result.current.tabKeys).not.toContain('posts')
    expect(hook.result.current.visitedTabs).not.toContain('posts')
    expect(hook.result.current.activeTab).toBe('overview')
    expect(hook.result.current.tabKeys.indexOf(hook.result.current.activeTab)).toBe(0)
    await waitFor(() =>
      expect(mockReplace).toHaveBeenLastCalledWith('/trader/alice?account=okx%3Asecondary', {
        scroll: false,
      })
    )
  })

  it('fails closed when claimed identity is withdrawn during a pending Posts click', () => {
    const hook = renderHook(({ claimed }) => useTraderTabs(claimed), {
      initialProps: { claimed: { id: 'route-owner' } as unknown },
    })

    act(() => hook.result.current.handleTabChange('posts'))
    expect(hook.result.current.activeTab).toBe('posts')

    hook.rerender({ claimed: null })

    expect(hook.result.current.activeTab).toBe('overview')
    expect(hook.result.current.tabKeys.indexOf(hook.result.current.activeTab)).toBe(0)
  })

  it.each([
    [
      'duplicate values',
      'tab=stats&account=okx%3Asecondary&tab=portfolio',
      'account=okx%3Asecondary',
    ],
    ['duplicate equal values', 'tab=stats&tab=stats&period=30D', 'period=30D'],
    ['unknown value', 'period=30D&tab=activity', 'period=30D'],
    ['empty value', 'tab=&period=7D', 'period=7D'],
  ])('removes %s without exposing an invalid active index', async (_label, query, remaining) => {
    mockSearchParams = new URLSearchParams(query)
    const hook = renderHook(() => useTraderTabs(null))

    expect(hook.result.current.activeTab).toBe('overview')
    expect(hook.result.current.tabKeys.indexOf(hook.result.current.activeTab)).toBe(0)
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(`/trader/alice?${remaining}`, { scroll: false })
    )
  })
})
