import { act, renderHook, waitFor } from '@testing-library/react'

const mockReplace = jest.fn()
const mockRouter = { replace: mockReplace }
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  usePathname: () => '/trader/alice',
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}))

import { parseTraderActiveAccountParam, useTraderActiveAccount } from '../useTraderActiveAccount'

describe('parseTraderActiveAccountParam', () => {
  it('keeps colons after the first separator inside the trader key', () => {
    expect(parseTraderActiveAccountParam('okx:wallet:subaccount')).toEqual({
      kind: 'account',
      activeAccount: 'okx:wallet:subaccount',
      activeAccountRaw: {
        platform: 'okx',
        traderKey: 'wallet:subaccount',
      },
    })
  })

  it('accepts the exact field-length boundaries', () => {
    const platform = 'p'.repeat(64)
    const traderKey = 'k'.repeat(512)

    expect(parseTraderActiveAccountParam(`${platform}:${traderKey}`)).toMatchObject({
      kind: 'account',
      activeAccountRaw: { platform, traderKey },
    })
  })

  it.each([
    '',
    'okx',
    ':wallet',
    'okx:',
    ' okx:wallet',
    'okx:wallet ',
    `${'p'.repeat(65)}:wallet`,
    `okx:${'k'.repeat(513)}`,
  ])('rejects malformed account value %j', (value) => {
    expect(parseTraderActiveAccountParam(value)).toEqual({
      kind: 'invalid',
      activeAccount: 'all',
      activeAccountRaw: null,
    })
  })
})

describe('useTraderActiveAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
  })

  it('removes a malformed parameter without exposing it or dropping other parameters', async () => {
    mockSearchParams = new URLSearchParams('period=90D&account=%20okx%3Awallet&tab=overview')

    const { result } = renderHook(() => useTraderActiveAccount())

    expect(result.current.activeAccount).toBe('all')
    expect(result.current.activeAccountRaw).toBeNull()
    expect(result.current.isAccountParamInvalid).toBe(true)
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/trader/alice?period=90D&tab=overview', {
        scroll: false,
      })
    )
  })

  it('rejects duplicate account parameters and removes every copy', async () => {
    mockSearchParams = new URLSearchParams(
      'account=okx%3Afirst&view=stats&account=binance%3Asecond'
    )

    const { result } = renderHook(() => useTraderActiveAccount())

    expect(result.current.activeAccountRaw).toBeNull()
    expect(result.current.isAccountParamInvalid).toBe(true)
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/trader/alice?view=stats', { scroll: false })
    )
  })

  it('tracks search-parameter changes from browser navigation', async () => {
    mockSearchParams = new URLSearchParams('account=binance%3Afirst')
    const hook = renderHook(() => useTraderActiveAccount())

    expect(hook.result.current.activeAccountRaw).toEqual({
      platform: 'binance',
      traderKey: 'first',
    })

    mockSearchParams = new URLSearchParams('account=okx%3Awallet%3Asub&period=30D')
    hook.rerender()

    await waitFor(() =>
      expect(hook.result.current.activeAccountRaw).toEqual({
        platform: 'okx',
        traderKey: 'wallet:sub',
      })
    )

    mockSearchParams = new URLSearchParams('period=30D')
    hook.rerender()

    await waitFor(() => expect(hook.result.current.activeAccount).toBe('all'))
    expect(hook.result.current.activeAccountRaw).toBeNull()
  })

  it('only publishes validated selections and writes their canonical URL', () => {
    mockSearchParams = new URLSearchParams('period=90D')
    const { result } = renderHook(() => useTraderActiveAccount())

    act(() => {
      result.current.handleAccountChange('okx:wallet:sub')
    })

    expect(result.current.activeAccountRaw).toEqual({
      platform: 'okx',
      traderKey: 'wallet:sub',
    })
    expect(mockReplace).toHaveBeenLastCalledWith(
      '/trader/alice?period=90D&account=okx%3Awallet%3Asub',
      { scroll: false }
    )

    act(() => {
      result.current.handleAccountChange(' okx:wallet')
    })

    expect(result.current.activeAccount).toBe('all')
    expect(result.current.activeAccountRaw).toBeNull()
    expect(mockReplace).toHaveBeenLastCalledWith('/trader/alice?period=90D', { scroll: false })
  })
})
