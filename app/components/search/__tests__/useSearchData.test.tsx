import { renderHook, act } from '@testing-library/react'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (k: string) => k }),
}))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ userId: null, isLoggedIn: false, authChecked: true, accessToken: null }),
}))
jest.mock('@/lib/services/search-history', () => ({
  initializeHistory: jest.fn().mockResolvedValue([]),
  addToHistory: jest.fn().mockResolvedValue([]),
  removeFromHistory: jest.fn().mockResolvedValue([]),
  clearHistory: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/features', () => ({ features: { social: true } }))

import { useSearchData } from '../useSearchData'

function response(query: string, traderIds: string[]) {
  return {
    query,
    total: traderIds.length,
    results: {
      traders: traderIds.map((id) => ({ id, type: 'trader', title: id, href: `/trader/${id}` })),
      posts: [{ id: 'p1', type: 'post', title: 'post', href: '/post/p1' }],
      users: [],
      groups: [],
    },
  }
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

const fetchMock = jest.fn()
const searchCalls = () =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/search?q='))

describe('useSearchData unified search', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('type=trending') || url.startsWith('/api/posts')
        ? ok({ data: {} })
        : ok({ data: response('x', ['t1']) })
    )
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => jest.useRealTimers())

  async function settle(ms = 200) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms)
    })
  }

  it('does not search for queries shorter than 2 characters after trimming', async () => {
    renderHook(() => useSearchData(true, 'a '))
    await settle()
    expect(searchCalls()).toEqual([])
  })

  it('debounces and sends the trimmed query', async () => {
    const { rerender } = renderHook(({ q }) => useSearchData(true, q), {
      initialProps: { q: 'bt' },
    })
    rerender({ q: 'btc' })
    rerender({ q: '  btc_x  ' })
    await settle()
    expect(searchCalls()).toEqual(['/api/search?q=btc_x&limit=10'])
  })

  it('flattens traders and social results for keyboard navigation', async () => {
    const { result } = renderHook(() => useSearchData(true, 'btc'))
    await settle()
    expect(result.current.flatResults.map((r) => r.id)).toEqual(['t1', 'p1'])
    expect(result.current.searchFailed).toBe(false)
  })

  it('never lets a slow earlier response overwrite a newer query', async () => {
    let resolveSlow: (v: unknown) => void = () => {}
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('q=old')) return new Promise((r) => (resolveSlow = r))
      if (url.includes('q=new')) return Promise.resolve(ok({ data: response('new', ['n1']) }))
      return Promise.resolve(ok({ data: {} }))
    })
    const { result, rerender } = renderHook(({ q }) => useSearchData(true, q), {
      initialProps: { q: 'old' },
    })
    await settle()
    rerender({ q: 'new' })
    await settle()
    await act(async () => {
      resolveSlow(ok({ data: response('old', ['o1']) }))
    })
    expect(result.current.searchData?.query).toBe('new')
  })

  it('drops stale results and flags failure when a search errors', async () => {
    const { result, rerender } = renderHook(({ q }) => useSearchData(true, q), {
      initialProps: { q: 'btc' },
    })
    await settle()
    expect(result.current.searchData?.results.traders).toHaveLength(1)

    fetchMock.mockImplementation(async (url: string) =>
      url.includes('q=btcxyz') ? { ok: false, status: 500, json: async () => ({}) } : ok({})
    )
    rerender({ q: 'btcxyz' })
    await settle()

    expect(result.current.searchData).toBeNull()
    expect(result.current.searchFailed).toBe(true)
    expect(result.current.searching).toBe(false)
  })

  it('clears results when the dropdown closes', async () => {
    const { result, rerender } = renderHook(({ open }) => useSearchData(open, 'btc'), {
      initialProps: { open: true },
    })
    await settle()
    expect(result.current.searchData).not.toBeNull()
    rerender({ open: false })
    expect(result.current.searchData).toBeNull()
  })
})
