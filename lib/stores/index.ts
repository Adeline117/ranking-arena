/**
 * Zustand 状态管理
 * 提供轻量级的全局状态管理
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
  subscriptionTier: 'free' | 'pro' | 'elite' | 'enterprise'
  
  // 关注列表（本地缓存）
  followedTraders: string[]
  
  // 操作
  setUser: (user: { id: string; handle: string; avatarUrl?: string; tier?: 'free' | 'pro' | 'elite' | 'enterprise' } | null) => void
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
      
      followTrader: (traderId) => {
        const current = get().followedTraders
        if (!current.includes(traderId)) {
          set({ followedTraders: [...current, traderId] })
        }
      },
      
      unfollowTrader: (traderId) => {
        const current = get().followedTraders
        set({ followedTraders: current.filter(id => id !== traderId) })
      },
      
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
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
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
// 缓存状态
// ============================================

interface CacheEntry<T> {
  data: T
  timestamp: number
  key: string
}

interface CacheState {
  // 缓存数据
  cache: Map<string, CacheEntry<unknown>>
  
  // 配置
  defaultTTL: number // 默认 TTL（毫秒）
  
  // 操作
  get: <T>(key: string) => T | null
  set: <T>(key: string, data: T, ttl?: number) => void
  invalidate: (key: string) => void
  invalidatePattern: (pattern: string) => void
  clear: () => void
}

export const useCacheStore = create<CacheState>()((set, get) => ({
  cache: new Map(),
  defaultTTL: 5 * 60 * 1000, // 5 分钟
  
  get: <T>(key: string): T | null => {
    const entry = get().cache.get(key)
    if (!entry) return null
    
    // 检查是否过期
    if (Date.now() - entry.timestamp > get().defaultTTL) {
      get().invalidate(key)
      return null
    }
    
    return entry.data as T
  },
  
  set: <T>(key: string, data: T, ttl?: number) => {
    const cache = new Map(get().cache)
    cache.set(key, {
      data,
      timestamp: Date.now(),
      key,
    })
    set({ cache })
  },
  
  invalidate: (key: string) => {
    const cache = new Map(get().cache)
    cache.delete(key)
    set({ cache })
  },
  
  invalidatePattern: (pattern: string) => {
    const cache = new Map(get().cache)
    const regex = new RegExp(pattern)
    
    for (const key of cache.keys()) {
      if (regex.test(key)) {
        cache.delete(key)
      }
    }
    
    set({ cache })
  },
  
  clear: () => set({ cache: new Map() }),
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
