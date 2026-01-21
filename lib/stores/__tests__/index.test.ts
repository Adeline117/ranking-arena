/**
 * Zustand Store 单元测试
 */

import { act, renderHook } from '@testing-library/react'
import {
  useRankingStore,
  useUserStore,
  useUIStore,
  useCacheStore,
  selectFilteredTraders,
  selectIsFollowing,
} from '../index'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(window, 'localStorage', { value: localStorageMock })

describe('useRankingStore', () => {
  beforeEach(() => {
    // 重置 store
    act(() => {
      useRankingStore.setState({
        traders: [],
        loading: true,
        error: null,
        timeRange: '90D',
        exchange: 'all',
        sortBy: 'roi',
      })
    })
  })

  it('should have correct initial state', () => {
    const { result } = renderHook(() => useRankingStore())

    expect(result.current.traders).toEqual([])
    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.timeRange).toBe('90D')
    expect(result.current.exchange).toBe('all')
    expect(result.current.sortBy).toBe('roi')
  })

  it('should set traders and update loading state', () => {
    const { result } = renderHook(() => useRankingStore())

    const mockTraders = [
      { id: '1', handle: 'trader1', roi: 100, source: 'binance' },
      { id: '2', handle: 'trader2', roi: 50, source: 'bybit' },
    ]

    act(() => {
      result.current.setTraders(mockTraders as any)
    })

    expect(result.current.traders).toEqual(mockTraders)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('should set error and update loading state', () => {
    const { result } = renderHook(() => useRankingStore())

    act(() => {
      result.current.setError('Network error')
    })

    expect(result.current.error).toBe('Network error')
    expect(result.current.loading).toBe(false)
  })

  it('should update filter settings', () => {
    const { result } = renderHook(() => useRankingStore())

    act(() => {
      result.current.setTimeRange('30D')
      result.current.setExchange('binance')
      result.current.setSortBy('pnl')
    })

    expect(result.current.timeRange).toBe('30D')
    expect(result.current.exchange).toBe('binance')
    expect(result.current.sortBy).toBe('pnl')
  })

  it('should reset filters to default', () => {
    const { result } = renderHook(() => useRankingStore())

    act(() => {
      result.current.setTimeRange('7D')
      result.current.setExchange('bybit')
      result.current.resetFilters()
    })

    expect(result.current.timeRange).toBe('90D')
    expect(result.current.exchange).toBe('all')
    expect(result.current.sortBy).toBe('roi')
  })
})

describe('useUserStore', () => {
  beforeEach(() => {
    localStorageMock.clear()
    act(() => {
      useUserStore.setState({
        isLoggedIn: false,
        userId: null,
        handle: null,
        avatarUrl: null,
        subscriptionTier: 'free',
        followedTraders: [],
      })
    })
  })

  it('should have correct initial state', () => {
    const { result } = renderHook(() => useUserStore())

    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.userId).toBeNull()
    expect(result.current.handle).toBeNull()
    expect(result.current.subscriptionTier).toBe('free')
    expect(result.current.followedTraders).toEqual([])
  })

  it('should set user correctly', () => {
    const { result } = renderHook(() => useUserStore())

    act(() => {
      result.current.setUser({
        id: 'user123',
        handle: 'testuser',
        avatarUrl: 'https://example.com/avatar.jpg',
        tier: 'pro',
      })
    })

    expect(result.current.isLoggedIn).toBe(true)
    expect(result.current.userId).toBe('user123')
    expect(result.current.handle).toBe('testuser')
    expect(result.current.avatarUrl).toBe('https://example.com/avatar.jpg')
    expect(result.current.subscriptionTier).toBe('pro')
  })

  it('should clear user on logout', () => {
    const { result } = renderHook(() => useUserStore())

    act(() => {
      result.current.setUser({ id: 'user123', handle: 'testuser' })
      result.current.logout()
    })

    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.userId).toBeNull()
    expect(result.current.handle).toBeNull()
    expect(result.current.followedTraders).toEqual([])
  })

  it('should follow and unfollow traders', () => {
    const { result } = renderHook(() => useUserStore())

    act(() => {
      result.current.followTrader('trader1')
      result.current.followTrader('trader2')
    })

    expect(result.current.followedTraders).toContain('trader1')
    expect(result.current.followedTraders).toContain('trader2')

    act(() => {
      result.current.unfollowTrader('trader1')
    })

    expect(result.current.followedTraders).not.toContain('trader1')
    expect(result.current.followedTraders).toContain('trader2')
  })

  it('should not add duplicate followers', () => {
    const { result } = renderHook(() => useUserStore())

    act(() => {
      result.current.followTrader('trader1')
      result.current.followTrader('trader1')
    })

    expect(result.current.followedTraders.filter(id => id === 'trader1').length).toBe(1)
  })
})

describe('useUIStore', () => {
  beforeEach(() => {
    localStorageMock.clear()
    act(() => {
      useUIStore.setState({
        theme: 'dark',
        language: 'zh',
        sidebarOpen: false,
        searchQuery: '',
        searchOpen: false,
      })
    })
  })

  it('should have correct initial state', () => {
    const { result } = renderHook(() => useUIStore())

    expect(result.current.theme).toBe('dark')
    expect(result.current.language).toBe('zh')
    expect(result.current.sidebarOpen).toBe(false)
  })

  it('should toggle sidebar', () => {
    const { result } = renderHook(() => useUIStore())

    act(() => {
      result.current.toggleSidebar()
    })

    expect(result.current.sidebarOpen).toBe(true)

    act(() => {
      result.current.toggleSidebar()
    })

    expect(result.current.sidebarOpen).toBe(false)
  })

  it('should update search query', () => {
    const { result } = renderHook(() => useUIStore())

    act(() => {
      result.current.setSearchQuery('test query')
    })

    expect(result.current.searchQuery).toBe('test query')
  })

  it('should change language', () => {
    const { result } = renderHook(() => useUIStore())

    act(() => {
      result.current.setLanguage('en')
    })

    expect(result.current.language).toBe('en')
  })
})

describe('useCacheStore', () => {
  beforeEach(() => {
    localStorageMock.clear()
    act(() => {
      useCacheStore.setState({
        cache: {},
        defaultTTL: 5 * 60 * 1000,
        defaultStaleTime: 30 * 1000,
      })
    })
  })

  it('should set and get cache entries', () => {
    const { result } = renderHook(() => useCacheStore())

    act(() => {
      result.current.set('testKey', { foo: 'bar' })
    })

    const cached = result.current.get<{ foo: string }>('testKey')
    expect(cached).toEqual({ foo: 'bar' })
  })

  it('should return null for non-existent keys', () => {
    const { result } = renderHook(() => useCacheStore())

    const cached = result.current.get('nonExistent')
    expect(cached).toBeNull()
  })

  it('should invalidate cache entries', () => {
    const { result } = renderHook(() => useCacheStore())

    act(() => {
      result.current.set('testKey', { foo: 'bar' })
      result.current.invalidate('testKey')
    })

    const cached = result.current.get('testKey')
    expect(cached).toBeNull()
  })

  it('should invalidate by pattern', () => {
    const { result } = renderHook(() => useCacheStore())

    act(() => {
      result.current.set('traders:list', [])
      result.current.set('traders:detail:1', {})
      result.current.set('users:list', [])
      result.current.invalidatePattern('^traders:')
    })

    expect(result.current.get('traders:list')).toBeNull()
    expect(result.current.get('traders:detail:1')).toBeNull()
    expect(result.current.get('users:list')).not.toBeNull()
  })

  it('should clear all cache', () => {
    const { result } = renderHook(() => useCacheStore())

    act(() => {
      result.current.set('key1', 'value1')
      result.current.set('key2', 'value2')
      result.current.clear()
    })

    expect(result.current.get('key1')).toBeNull()
    expect(result.current.get('key2')).toBeNull()
  })

  it('should return cache stats', () => {
    const { result } = renderHook(() => useCacheStore())

    act(() => {
      result.current.set('key1', 'value1')
      result.current.set('key2', 'value2')
    })

    const stats = result.current.getStats()
    expect(stats.size).toBe(2)
    expect(stats.keys).toContain('key1')
    expect(stats.keys).toContain('key2')
  })

  it('should support stale-while-revalidate pattern', () => {
    const { result } = renderHook(() => useCacheStore())

    act(() => {
      result.current.set('testKey', 'fresh', { ttl: 60000, staleTime: 100 })
    })

    // 立即检查应该是新鲜的
    const meta = result.current.getWithMeta<string>('testKey')
    expect(meta.isFresh).toBe(true)
    expect(meta.isStale).toBe(false)
    expect(meta.data).toBe('fresh')
  })
})

describe('Selectors', () => {
  describe('selectFilteredTraders', () => {
    it('should filter traders by exchange', () => {
      const state = {
        traders: [
          { id: '1', source: 'binance', roi: 100 },
          { id: '2', source: 'bybit', roi: 80 },
          { id: '3', source: 'binance', roi: 60 },
        ] as any[],
        exchange: 'binance' as const,
        sortBy: 'roi' as const,
        timeRange: '90D' as const,
        loading: false,
        error: null,
        setTraders: () => {},
        setLoading: () => {},
        setError: () => {},
        setTimeRange: () => {},
        setExchange: () => {},
        setSortBy: () => {},
        resetFilters: () => {},
      }

      const filtered = selectFilteredTraders(state)
      expect(filtered.length).toBe(2)
      expect(filtered.every(t => t.source === 'binance')).toBe(true)
    })

    it('should sort traders by ROI descending', () => {
      const state = {
        traders: [
          { id: '1', roi: 50 },
          { id: '2', roi: 100 },
          { id: '3', roi: 75 },
        ] as any[],
        exchange: 'all' as const,
        sortBy: 'roi' as const,
        timeRange: '90D' as const,
        loading: false,
        error: null,
        setTraders: () => {},
        setLoading: () => {},
        setError: () => {},
        setTimeRange: () => {},
        setExchange: () => {},
        setSortBy: () => {},
        resetFilters: () => {},
      }

      const sorted = selectFilteredTraders(state)
      expect(sorted[0].roi).toBe(100)
      expect(sorted[1].roi).toBe(75)
      expect(sorted[2].roi).toBe(50)
    })
  })

  describe('selectIsFollowing', () => {
    it('should return true if trader is followed', () => {
      const state = {
        followedTraders: ['trader1', 'trader2'],
      } as any

      expect(selectIsFollowing('trader1')(state)).toBe(true)
      expect(selectIsFollowing('trader2')(state)).toBe(true)
    })

    it('should return false if trader is not followed', () => {
      const state = {
        followedTraders: ['trader1', 'trader2'],
      } as any

      expect(selectIsFollowing('trader3')(state)).toBe(false)
    })
  })
})
