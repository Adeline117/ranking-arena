/**
 * Trader Comparison Store
 * Manages the trader comparison selection state (up to 10 traders).
 *
 * Import directly from this file to avoid pulling in postStore, inboxStore, etc.
 * via the barrel re-export in index.ts.
 */

import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import {
  buildCompareUrl,
  compareAccountKey,
  isSameCompareAccount,
  type CompareAccountRef,
} from '@/lib/compare/identity'

// ============================================
// SSR-safe localStorage wrapper
// ============================================

const safeStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null
    try {
      return localStorage.getItem(name)
    } catch {
      /* Intentionally swallowed: localStorage unavailable (SSR/private mode) */ return null
    }
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(name, value)
    } catch {
      /* Intentionally swallowed: localStorage full or unavailable */
    }
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') return
    try {
      localStorage.removeItem(name)
    } catch {
      /* Intentionally swallowed: localStorage unavailable */
    }
  },
}

// ============================================
// 交易员对比状态
// ============================================

const MAX_COMPARE_TRADERS = 10

/** @deprecated UI-specific. Will be replaced by UnifiedTrader adapter. */
export interface CompareTrader extends CompareAccountRef {
  handle: string
  avatarUrl?: string
}

interface ComparisonState {
  // 选中的交易员列表 (最多10个)
  selectedTraders: CompareTrader[]

  // UI 状态
  isBarExpanded: boolean

  // 操作
  addTrader: (trader: CompareTrader) => boolean
  removeTrader: (account: CompareAccountRef) => void
  clearAll: () => void
  toggleBar: () => void
  setBarExpanded: (expanded: boolean) => void

  // 查询
  isSelected: (account: CompareAccountRef) => boolean
  canAddMore: () => boolean
  getCompareUrl: () => string
}

interface PersistedComparisonState {
  selectedTraders: CompareTrader[]
  isBarExpanded: boolean
}

function isPersistableTrader(value: unknown): value is CompareTrader {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CompareTrader>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim() !== '' &&
    typeof candidate.source === 'string' &&
    candidate.source.trim() !== '' &&
    typeof candidate.handle === 'string'
  )
}

/**
 * Version-1 entries already carried source, but the old store deduplicated and
 * removed by raw ID. Rehydrate only complete composite identities and dedupe
 * by (source, id), preserving same-ID accounts from different platforms.
 */
export function migrateComparisonPersistedState(persistedState: unknown): PersistedComparisonState {
  const candidate =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Partial<PersistedComparisonState>)
      : {}
  const selectedTraders: CompareTrader[] = []
  const seen = new Set<string>()

  for (const trader of Array.isArray(candidate.selectedTraders) ? candidate.selectedTraders : []) {
    if (!isPersistableTrader(trader)) continue
    const normalized = {
      ...trader,
      id: trader.id.trim(),
      source: trader.source.trim(),
    }
    const identity = compareAccountKey(normalized)
    if (seen.has(identity)) continue
    seen.add(identity)
    selectedTraders.push(normalized)
    if (selectedTraders.length === MAX_COMPARE_TRADERS) break
  }

  return {
    selectedTraders,
    isBarExpanded: typeof candidate.isBarExpanded === 'boolean' ? candidate.isBarExpanded : true,
  }
}

export const useComparisonStore = create<ComparisonState>()(
  persist(
    (set, get) => ({
      selectedTraders: [],
      isBarExpanded: true,

      addTrader: (trader) => {
        const state = get()
        if (!isPersistableTrader(trader)) {
          return false
        }
        const normalized = {
          ...trader,
          id: trader.id.trim(),
          source: trader.source.trim(),
        }
        if (state.selectedTraders.length >= MAX_COMPARE_TRADERS) {
          return false // 已达上限
        }
        if (state.selectedTraders.some((selected) => isSameCompareAccount(selected, normalized))) {
          return false // 已选中
        }
        set({ selectedTraders: [...state.selectedTraders, normalized] })
        return true
      },

      removeTrader: (account) => {
        set((state) => ({
          selectedTraders: state.selectedTraders.filter(
            (selected) => !isSameCompareAccount(selected, account)
          ),
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

      isSelected: (account) => {
        return get().selectedTraders.some((selected) => isSameCompareAccount(selected, account))
      },

      canAddMore: () => {
        return get().selectedTraders.length < MAX_COMPARE_TRADERS
      },

      getCompareUrl: () => {
        return buildCompareUrl(get().selectedTraders)
      },
    }),
    {
      name: 'ranking-arena-comparison',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        selectedTraders: state.selectedTraders,
        isBarExpanded: state.isBarExpanded,
      }),
      version: 2,
      migrate: (persistedState) =>
        migrateComparisonPersistedState(persistedState) as ComparisonState,
    }
  )
)
