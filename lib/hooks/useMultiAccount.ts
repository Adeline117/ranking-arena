'use client'

import { useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useMultiAccountStore, StoredAccount } from '@/lib/stores/multiAccountStore'
import { usePremium } from '@/lib/premium/hooks'

const MAX_ACCOUNTS_FREE = 1
const MAX_ACCOUNTS_PRO = 5

export function useMultiAccount() {
  const { isPremium } = usePremium()
  const { accounts, addAccount, removeAccount, setActiveAccount, clear } = useMultiAccountStore()

  const activeAccount = useMemo(() => accounts.find((a) => a.isActive), [accounts])
  const inactiveAccounts = useMemo(() => accounts.filter((a) => !a.isActive), [accounts])

  const maxAccounts = isPremium ? MAX_ACCOUNTS_PRO : MAX_ACCOUNTS_FREE
  const canAddAccount = accounts.length < maxAccounts

  const addCurrentAccount = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return false

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return false

    // Fetch user profile for handle/avatar
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle, avatar_url')
      .eq('id', user.id)
      .maybeSingle()

    const newAccount: StoredAccount = {
      userId: user.id,
      email: user.email || '',
      handle: profile?.handle || null,
      avatarUrl: profile?.avatar_url || null,
      refreshToken: session.refresh_token,
      lastActiveAt: new Date().toISOString(),
      isActive: true,
    }

    // Deactivate all other accounts
    accounts.forEach((a) => {
      if (a.isActive && a.userId !== user.id) {
        addAccount({ ...a, isActive: false })
      }
    })

    addAccount(newAccount)
    return true
  }, [accounts, addAccount])

  const switchAccount = useCallback(async (userId: string) => {
    const target = accounts.find((a) => a.userId === userId)
    if (!target) return { success: false, error: 'Account not found' }

    // Save current session's refresh token first
    const { data: { session: currentSession } } = await supabase.auth.getSession()
    if (currentSession) {
      const currentActive = accounts.find((a) => a.isActive)
      if (currentActive) {
        addAccount({
          ...currentActive,
          refreshToken: currentSession.refresh_token,
          isActive: false,
        })
      }
    }

    // Restore target account session
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: target.refreshToken,
    })

    if (error || !data.session) {
      // Token expired — remove stale account from store so user isn't stuck
      removeAccount(userId)
      return { success: false, error: 'session_expired', userId }
    }

    // Update stored refresh token
    addAccount({
      ...target,
      refreshToken: data.session.refresh_token,
      isActive: true,
      lastActiveAt: new Date().toISOString(),
    })
    setActiveAccount(userId)

    return { success: true }
  }, [accounts, addAccount, setActiveAccount])

  const signOutAll = useCallback(async () => {
    await supabase.auth.signOut()
    clear()
  }, [clear])

  return {
    accounts,
    activeAccount,
    inactiveAccounts,
    canAddAccount,
    maxAccounts,
    isPro: isPremium,
    addCurrentAccount,
    switchAccount,
    removeAccount,
    signOutAll,
  }
}
