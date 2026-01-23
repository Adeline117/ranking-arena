/**
 * Zustand 状态管理
 * 提供轻量级的全局状态管理
 *
 * ⚠️ 重要说明 (2026-01-21 审计):
 * 这些 stores 目前已定义但未在生产中使用。
 * 实际状态管理通过以下方式实现:
 * - 排行榜数据: useTraderData hook (app/components/Home/hooks/useTraderData.ts)
 * - 用户认证: Supabase Auth + useAuth hook
 * - UI 状态: LanguageProvider + 各组件 useState
 * - 数据缓存: SWR
 *
 * 如需迁移到 Zustand，请参考 docs/AUDIT_REPORT_2026-01-21.md
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { TimeRange, Exchange, RankedTrader } from '../types/trader'

// ============================================
// 排行榜状态
// ============================================

interface RankingState {
  // 数据
  traders: RankedTrader[]
  loading: boolean
  error: string | null
  
  // 筛选条件
  timeRange: TimeRange
  exchange: Exchange | 'all'
  sortBy: 'roi' | 'pnl' | 'win_rate' | 'risk_adjusted'
  
  // 操作
  setTraders: (traders: RankedTrader[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setTimeRange: (timeRange: TimeRange) => void
  setExchange: (exchange: Exchange | 'all') => void
  setSortBy: (sortBy: 'roi' | 'pnl' | 'win_rate' | 'risk_adjusted') => void
  resetFilters: () => void
}

export const useRankingStore = create<RankingState>()((set) => ({
  // 初始状态
  traders: [],
  loading: true,
  error: null,
  timeRange: '90D',
  exchange: 'all',
  sortBy: 'roi',
  
  // 操作
  setTraders: (traders) => set({ traders, loading: false, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  setTimeRange: (timeRange) => set({ timeRange }),
  setExchange: (exchange) => set({ exchange }),
  setSortBy: (sortBy) => set({ sortBy }),
  resetFilters: () => set({ timeRange: '90D', exchange: 'all', sortBy: 'roi' }),
}))

// ============================================
// 用户状态
// ============================================

interface UserState {
  // 用户信息
  isLoggedIn: boolean
  userId: string | null
  handle: string | null
  avatarUrl: string | null
  subscriptionTier: 'free' | 'pro'
  
  // 关注列表（本地缓存）
  followedTraders: string[]
  
  // 操作
  setUser: (user: { id: string; handle: string; avatarUrl?: string; tier?: 'free' | 'pro' } | null) => void
  setFollowedTraders: (traders: string[]) => void
  followTrader: (traderId: string) => void
  unfollowTrader: (traderId: string) => void
  logout: () => void
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      // 初始状态
      isLoggedIn: false,
      userId: null,
      handle: null,
      avatarUrl: null,
      subscriptionTier: 'free',
      followedTraders: [],
      
      // 操作
      setUser: (user) => set(user ? {
        isLoggedIn: true,
        userId: user.id,
        handle: user.handle,
        avatarUrl: user.avatarUrl || null,
        subscriptionTier: user.tier || 'free',
      } : {
        isLoggedIn: false,
        userId: null,
        handle: null,
        avatarUrl: null,
        subscriptionTier: 'free',
      }),
      
      setFollowedTraders: (traders) => set({ followedTraders: traders }),

      // 使用 set 回调函数避免竞态条件
      followTrader: (traderId) => set((state) => {
        if (state.followedTraders.includes(traderId)) {
          return state // 已关注，不做改变
        }
        return { followedTraders: [...state.followedTraders, traderId] }
      }),

      // 使用 set 回调函数避免竞态条件
      unfollowTrader: (traderId) => set((state) => ({
        followedTraders: state.followedTraders.filter(id => id !== traderId)
      })),
      
      logout: () => set({
        isLoggedIn: false,
        userId: null,
        handle: null,
        avatarUrl: null,
        subscriptionTier: 'free',
        followedTraders: [],
      }),
    }),
    {
      name: 'ranking-arena-user',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        followedTraders: state.followedTraders,
      }),
    }
  )
)

// ============================================
// UI 状态
// ============================================

interface UIState {
  // 主题
  theme: 'light' | 'dark' | 'system'
  
  // 语言
  language: 'zh' | 'en'
  
  // 侧边栏
  sidebarOpen: boolean
  
  // 搜索
  searchQuery: string
  searchOpen: boolean
  
  // 操作
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setLanguage: (language: 'zh' | 'en') => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSearchQuery: (query: string) => void
  setSearchOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // 初始状态
      theme: 'dark',
      language: 'zh',
      sidebarOpen: false,
      searchQuery: '',
      searchOpen: false,
      
      // 操作
      setTheme: (theme) => {
        set({ theme })
        // 应用主题
        if (typeof document !== 'undefined') {
          const effectiveTheme = theme === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : theme
          document.documentElement.setAttribute('data-theme', effectiveTheme)
        }
      },
      
      setLanguage: (language) => set({ language }),
      // 使用 set 回调函数避免竞态条件
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSearchOpen: (open) => set({ searchOpen: open }),
    }),
    {
      name: 'ranking-arena-ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        language: state.language,
      }),
    }
  )
)

// ============================================
// 缓存状态（增强版 - 支持持久化和 stale-while-revalidate）
// ============================================

interface CacheEntry<T = unknown> {
  data: T
  timestamp: number
  key: string
  ttl: number // 每个条目可以有自己的 TTL
  staleTime?: number // stale-while-revalidate 的过期时间
}

interface CacheState {
  // 缓存数据（使用对象而非 Map 以支持持久化）
  cache: Record<string, CacheEntry>

  // 配置
  defaultTTL: number // 默认 TTL（毫秒）
  defaultStaleTime: number // 默认 stale 时间（毫秒）

  // 操作
  get: <T>(key: string) => T | null
  getWithMeta: <T>(key: string) => { data: T | null; isStale: boolean; isFresh: boolean }
  set: <T>(key: string, data: T, options?: { ttl?: number; staleTime?: number }) => void
  invalidate: (key: string) => void
  invalidatePattern: (pattern: string) => void
  invalidateAll: (keys: string[]) => void
  clear: () => void

  // 新增：预取和后台刷新
  prefetch: <T>(key: string, fetcher: () => Promise<T>, options?: { ttl?: number }) => Promise<T>
  getOrFetch: <T>(key: string, fetcher: () => Promise<T>, options?: { ttl?: number; staleTime?: number }) => Promise<T>

  // 统计
  getStats: () => { size: number; keys: string[] }
}

// 缓存持久化存储
const cacheStorage = {
  getItem: (name: string): string | null => {
    if (typeof window === 'undefined') return null
    try {
      return localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem: (name: string, value: string): void => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(name, value)
    } catch {
      // localStorage 可能已满或不可用
      console.warn('Failed to persist cache to localStorage')
    }
  },
  removeItem: (name: string): void => {
    if (typeof window === 'undefined') return
    try {
      localStorage.removeItem(name)
    } catch {
      // ignore
    }
  },
}

// 从 localStorage 恢复缓存
function loadPersistedCache(): Record<string, CacheEntry> {
  const stored = cacheStorage.getItem('ranking-arena-cache')
  if (!stored) return {}

  try {
    const parsed = JSON.parse(stored)
    const now = Date.now()
    const validEntries: Record<string, CacheEntry> = {}

    // 只恢复未过期的条目
    for (const [key, entry] of Object.entries(parsed)) {
      const e = entry as CacheEntry
      if (now - e.timestamp < e.ttl) {
        validEntries[key] = e
      }
    }

    return validEntries
  } catch {
    return {}
  }
}

// 持久化缓存到 localStorage
function persistCache(cache: Record<string, CacheEntry>): void {
  // 只持久化重要的缓存数据，限制大小
  const persistableKeys = Object.keys(cache).filter(key =>
    key.startsWith('traders:') ||
    key.startsWith('user:') ||
    key.startsWith('settings:')
  )

  const persistableCache: Record<string, CacheEntry> = {}
  for (const key of persistableKeys.slice(0, 50)) { // 最多持久化 50 条
    persistableCache[key] = cache[key]
  }

  cacheStorage.setItem('ranking-arena-cache', JSON.stringify(persistableCache))
}

export const useCacheStore = create<CacheState>()((set, get) => ({
  cache: typeof window !== 'undefined' ? loadPersistedCache() : {},
  defaultTTL: 5 * 60 * 1000, // 5 分钟
  defaultStaleTime: 30 * 1000, // 30 秒后标记为 stale

  get: <T>(key: string): T | null => {
    const entry = get().cache[key]
    if (!entry) return null

    const now = Date.now()
    const age = now - entry.timestamp

    // 检查是否完全过期
    if (age > entry.ttl) {
      get().invalidate(key)
      return null
    }

    return entry.data as T
  },

  getWithMeta: <T>(key: string) => {
    const entry = get().cache[key]
    if (!entry) {
      return { data: null, isStale: false, isFresh: false }
    }

    const now = Date.now()
    const age = now - entry.timestamp
    const staleTime = entry.staleTime ?? get().defaultStaleTime

    // 完全过期
    if (age > entry.ttl) {
      get().invalidate(key)
      return { data: null, isStale: false, isFresh: false }
    }

    return {
      data: entry.data as T,
      isStale: age > staleTime,
      isFresh: age <= staleTime,
    }
  },

  // 使用 set 回调函数避免竞态条件
  set: <T>(key: string, data: T, options?: { ttl?: number; staleTime?: number }) => {
    const { defaultTTL, defaultStaleTime } = get()
    set((state) => {
      const newCache = { ...state.cache }
      newCache[key] = {
        data,
        timestamp: Date.now(),
        key,
        ttl: options?.ttl ?? defaultTTL,
        staleTime: options?.staleTime ?? defaultStaleTime,
      }
      // 异步持久化使用更新后的缓存
      setTimeout(() => persistCache(newCache), 0)
      return { cache: newCache }
    })
  },

  // 使用 set 回调函数避免竞态条件
  invalidate: (key: string) => {
    set((state) => {
      const newCache = { ...state.cache }
      delete newCache[key]
      setTimeout(() => persistCache(newCache), 0)
      return { cache: newCache }
    })
  },

  // 使用 set 回调函数避免竞态条件
  invalidatePattern: (pattern: string) => {
    const regex = new RegExp(pattern)
    set((state) => {
      const newCache = { ...state.cache }
      for (const key of Object.keys(newCache)) {
        if (regex.test(key)) {
          delete newCache[key]
        }
      }
      setTimeout(() => persistCache(newCache), 0)
      return { cache: newCache }
    })
  },

  // 使用 set 回调函数避免竞态条件
  invalidateAll: (keys: string[]) => {
    set((state) => {
      const newCache = { ...state.cache }
      for (const key of keys) {
        delete newCache[key]
      }
      setTimeout(() => persistCache(newCache), 0)
      return { cache: newCache }
    })
  },

  clear: () => {
    set({ cache: {} })
    cacheStorage.removeItem('ranking-arena-cache')
  },

  // 预取数据（后台获取，不阻塞）
  prefetch: async <T>(key: string, fetcher: () => Promise<T>, options?: { ttl?: number }): Promise<T> => {
    const data = await fetcher()
    get().set(key, data, options)
    return data
  },

  // 获取或获取数据（支持 stale-while-revalidate）
  getOrFetch: async <T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: { ttl?: number; staleTime?: number }
  ): Promise<T> => {
    const { data, isStale, isFresh } = get().getWithMeta<T>(key)

    // 新鲜数据，直接返回
    if (isFresh && data !== null) {
      return data
    }

    // stale 数据，后台刷新并返回旧数据
    if (isStale && data !== null) {
      // 后台刷新
      fetcher().then(newData => {
        get().set(key, newData, options)
      }).catch(console.error)

      return data
    }

    // 没有数据，同步获取
    const newData = await fetcher()
    get().set(key, newData, options)
    return newData
  },

  getStats: () => {
    const cache = get().cache
    return {
      size: Object.keys(cache).length,
      keys: Object.keys(cache),
    }
  },
}))

// ============================================
// 选择器（用于性能优化）
// ============================================

// 获取筛选后的交易员列表
export const selectFilteredTraders = (state: RankingState) => {
  let filtered = state.traders

  // 按交易所筛选
  if (state.exchange !== 'all') {
    filtered = filtered.filter(t => t.source === state.exchange)
  }

  // 排序
  return [...filtered].sort((a, b) => {
    switch (state.sortBy) {
      case 'roi':
        return b.roi - a.roi
      case 'pnl':
        return (b.pnl || 0) - (a.pnl || 0)
      case 'win_rate':
        return (b.win_rate || 0) - (a.win_rate || 0)
      case 'risk_adjusted':
        return (b.risk_adjusted_score || 0) - (a.risk_adjusted_score || 0)
      default:
        return b.roi - a.roi
    }
  })
}

// 检查是否关注了某个交易员
export const selectIsFollowing = (traderId: string) => (state: UserState) => 
  state.followedTraders.includes(traderId)
