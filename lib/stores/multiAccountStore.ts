'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface StoredAccount {
  userId: string
  email: string
  handle: string | null
  avatarUrl: string | null
  refreshToken: string
  lastActiveAt: string
  isActive: boolean
}

interface MultiAccountState {
  accounts: StoredAccount[]
  addAccount: (account: StoredAccount) => void
  removeAccount: (userId: string) => void
  setActiveAccount: (userId: string) => void
  getInactiveAccounts: () => StoredAccount[]
  getActiveAccount: () => StoredAccount | undefined
  clear: () => void
}

export const useMultiAccountStore = create<MultiAccountState>()(
  persist(
    (set, get) => ({
      accounts: [],

      addAccount: (account) => {
        set((state) => {
          const existing = state.accounts.find((a) => a.userId === account.userId)
          if (existing) {
            return {
              accounts: state.accounts.map((a) =>
                a.userId === account.userId ? { ...account } : a
              ),
            }
          }
          return { accounts: [...state.accounts, account] }
        })
      },

      removeAccount: (userId) => {
        set((state) => ({
          accounts: state.accounts.filter((a) => a.userId !== userId),
        }))
      },

      setActiveAccount: (userId) => {
        set((state) => ({
          accounts: state.accounts.map((a) => ({
            ...a,
            isActive: a.userId === userId,
            lastActiveAt: a.userId === userId ? new Date().toISOString() : a.lastActiveAt,
          })),
        }))
      },

      getInactiveAccounts: () => {
        return get().accounts.filter((a) => !a.isActive)
      },

      getActiveAccount: () => {
        return get().accounts.find((a) => a.isActive)
      },

      clear: () => {
        set({ accounts: [] })
      },
    }),
    {
      name: 'arena-multi-accounts',
    }
  )
)
