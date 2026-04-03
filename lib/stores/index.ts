/**
 * Zustand 状态管理
 * 提供轻量级的全局状态管理
 *
 * 实际使用的 Stores:
 * - useComparisonStore: 交易员对比功能 (此文件)
 * - usePostStore: 帖子和评论管理 (lib/stores/postStore.ts)
 * - useInboxStore: 收件箱和通知 (lib/stores/inboxStore.ts)
 * - useMultiAccountStore: 多账户管理 (lib/stores/multiAccountStore.ts)
 *
 * 其他状态管理方式:
 * - 排行榜数据: useTraderData hook + SWR
 * - 用户认证: Supabase Auth + useAuth hook
 * - UI 状态: LanguageProvider + ThemeProvider + 各组件 useState
 */

import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'

// ============================================
// SSR-safe localStorage wrapper
// ============================================

const safeStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null
    try { return localStorage.getItem(name) } catch { /* Intentionally swallowed: localStorage unavailable (SSR/private mode) */ return null }
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') return
    try { localStorage.setItem(name, value) } catch { /* Intentionally swallowed: localStorage full or unavailable */ }
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') return
    try { localStorage.removeItem(name) } catch { /* Intentionally swallowed: localStorage unavailable */ }
  },
}

// ============================================
// 交易员对比状态
// ============================================

const MAX_COMPARE_TRADERS = 10

/** @deprecated UI-specific. Will be replaced by UnifiedTrader adapter. */
export interface CompareTrader {
  id: string
  handle: string
  source: string
  avatarUrl?: string
}

interface ComparisonState {
  // 选中的交易员列表 (最多5个)
  selectedTraders: CompareTrader[]

  // UI 状态
  isBarExpanded: boolean

  // 操作
  addTrader: (trader: CompareTrader) => boolean
  removeTrader: (traderId: string) => void
  clearAll: () => void
  toggleBar: () => void
  setBarExpanded: (expanded: boolean) => void

  // 查询
  isSelected: (traderId: string) => boolean
  canAddMore: () => boolean
  getCompareUrl: () => string
}

export const useComparisonStore = create<ComparisonState>()(
  persist(
    (set, get) => ({
      selectedTraders: [],
      isBarExpanded: true,

      addTrader: (trader) => {
        const state = get()
        if (state.selectedTraders.length >= MAX_COMPARE_TRADERS) {
          return false // 已达上限
        }
        if (state.selectedTraders.some(t => t.id === trader.id)) {
          return false // 已选中
        }
        set({ selectedTraders: [...state.selectedTraders, trader] })
        return true
      },

      removeTrader: (traderId) => {
        set((state) => ({
          selectedTraders: state.selectedTraders.filter(t => t.id !== traderId)
        }))
      },

      clearAll: () => {
        set({ selectedTraders: [] })
      },

      toggleBar: () => {
        set((state) => ({ isBarExpanded: !state.isBarExpanded }))
      },

      setBarExpanded: (expanded) => {
        set({ isBarExpanded: expanded })
      },

      isSelected: (traderId) => {
        return get().selectedTraders.some(t => t.id === traderId)
      },

      canAddMore: () => {
        return get().selectedTraders.length < MAX_COMPARE_TRADERS
      },

      getCompareUrl: () => {
        const ids = get().selectedTraders.map(t => t.id).join(',')
        return `/compare?ids=${encodeURIComponent(ids)}`
      },
    }),
    {
      name: 'ranking-arena-comparison',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        selectedTraders: state.selectedTraders,
        isBarExpanded: state.isBarExpanded,
      }),
    }
  )
)

// ============================================
// Re-export other stores
// ============================================

export { usePostStore, type PostData, type CommentData } from './postStore'
export { useInboxStore } from './inboxStore'
export { useMultiAccountStore, type StoredAccount } from './multiAccountStore'
