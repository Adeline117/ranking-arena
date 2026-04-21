'use client'

import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'

// --- Token encoding (defense-in-depth) ---
// Refresh tokens are XOR-encoded with a random per-session key stored in
// sessionStorage. This prevents trivial extraction via DevTools or scraped
// localStorage dumps. The key is lost when the tab/window closes, so stale
// tokens in localStorage become unusable garbage after session end.
function getSessionKey(): string {
  if (typeof window === 'undefined') return ''
  try {
    let key = sessionStorage.getItem('_ak')
    if (!key) {
      const bytes = new Uint8Array(32)
      crypto.getRandomValues(bytes)
      key = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
      sessionStorage.setItem('_ak', key)
    }
    return key
  } catch { return '' }
}

function xorEncode(plain: string): string {
  const key = getSessionKey()
  if (!key || !plain) return plain
  const out: string[] = []
  for (let i = 0; i < plain.length; i++) {
    out.push(String.fromCharCode(plain.charCodeAt(i) ^ key.charCodeAt(i % key.length)))
  }
  return btoa(out.join(''))
}

function xorDecode(encoded: string): string {
  const key = getSessionKey()
  if (!key || !encoded) return encoded
  try {
    const decoded = atob(encoded)
    const out: string[] = []
    for (let i = 0; i < decoded.length; i++) {
      out.push(String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length)))
    }
    return out.join('')
  } catch { return '' }
}

// SSR-safe localStorage wrapper with token encoding
const safeStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(name)
      if (!raw) return null
      // Decode refresh tokens on read
      const parsed = JSON.parse(raw)
      if (parsed?.state?.accounts) {
        parsed.state.accounts = parsed.state.accounts.map((a: Record<string, string>) => ({
          ...a,
          refreshToken: a.refreshToken ? xorDecode(a.refreshToken) : '',
        }))
      }
      return JSON.stringify(parsed)
    } catch { /* Intentionally swallowed: localStorage unavailable (SSR/private mode) */ return null }
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') return
    try {
      // Encode refresh tokens before storing
      const parsed = JSON.parse(value)
      if (parsed?.state?.accounts) {
        parsed.state.accounts = parsed.state.accounts.map((a: Record<string, string>) => ({
          ...a,
          refreshToken: a.refreshToken ? xorEncode(a.refreshToken) : '',
        }))
      }
      localStorage.setItem(name, JSON.stringify(parsed))
    } catch { /* Intentionally swallowed: localStorage full or unavailable */ }
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') return
    try { localStorage.removeItem(name) } catch { /* Intentionally swallowed: localStorage unavailable */ }
  },
}

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
      storage: createJSONStorage(() => safeStorage),
    }
  )
)
