/**
 * Trader detail page period store
 *
 * Lightweight Zustand store that tracks the currently-selected
 * time window on the trader detail page (7D / 30D / 90D).
 * Used by ShareOnXButton to share with the correct window.
 */

import { create } from 'zustand'

export type Period = '7D' | '30D' | '90D'

interface PeriodStore {
  period: Period
  setPeriod: (p: Period) => void
}

export const usePeriodStore = create<PeriodStore>((set) => ({
  period: '90D',
  setPeriod: (period) => set({ period }),
}))
