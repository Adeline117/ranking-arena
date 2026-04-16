'use client'

import { useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useMultiAccountStore, StoredAccount } from '@/lib/stores/multiAccountStore'
import { usePremium } from '@/lib/premium/hooks'
import { logger } from '@/lib/logger'

const MAX_ACCOUNTS_FREE = 1
const MAX_ACCOUNTS_PRO = 5

/**
 * Invalidate a stored refresh token server-side by exchanging it once.
 * Supabase rotates refresh tokens on every successful refresh, so the
 * original token becomes unusable after this call — which means if it
 * ever leaked (XSS, device compromise) it can no longer mint sessions.
 *
 * We then immediately sign out that new session so we don't leave dangling
 * access tokens on the server, and we restore the currently active session
 * so the user's tab stays logged in.
 *
 * Best-effort: network failures / already-expired tokens are swallowed —
 * the local-state cleanup still proceeds.
 */
async function invalidateStoredRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return

  // Capture the current session so we can restore it. If the account being
  // removed IS the active one, currentSession will be null after signOut
  // and the caller is expected to redirect to login.
  let currentSession: Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session'] = null
  try {
    const { data } = await supabase.auth.getSession()
    currentSession = data.session
  } catch {
    /* ignore — best-effort */
  }

  try {
    // Exchange the stored refresh token. Success rotates it (old token is
    // invalidated); failure means the token is already dead — either way
    // the stored value is no longer a valid credential.
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
    if (error) {
      logger.info('[multi-account] Stored refresh token already invalid, nothing to revoke')
      return
    }

    // If the exchange yielded a fresh session, sign it out to drop the
    // rotated refresh token on the server too. scope=local keeps any other
    // devices/accounts unaffected.
    if (data.session) {
      await supabase.auth.signOut({ scope: 'local' })
    }
  } catch (err) {
    logger.warn('[multi-account] Failed to revoke stored refresh token:', err)
  } finally {
    // Restore the original active session so this browser tab stays logged
    // in as the active user. If there was no active session, nothing to do.
    if (currentSession?.refresh_token) {
      try {
        await supabase.auth.setSession({
          access_token: currentSession.access_token,
          refresh_token: currentSession.refresh_token,
        })
      } catch (err) {
        logger.warn('[multi-account] Failed to restore active session after revoke:', err)
      }
    }
  }
}

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
  }, [accounts, addAccount, removeAccount, setActiveAccount])

  // Wrap removeAccount to revoke the stored refresh token server-side before
  // dropping it from local state. This narrows the blast radius of an XSS or
  // stolen-localStorage scenario: a leaked refresh token is long-lived and can
  // mint access tokens indefinitely, so "remove" must actually revoke it.
  const removeAccountAndRevoke = useCallback(async (userId: string) => {
    const target = accounts.find((a) => a.userId === userId)
    if (target?.refreshToken) {
      // Best-effort revocation — we still clear local state even if this fails.
      await invalidateStoredRefreshToken(target.refreshToken)
    }
    removeAccount(userId)
  }, [accounts, removeAccount])

  const signOutAll = useCallback(async () => {
    // Revoke every stored refresh token before clearing local state, so any
    // token that may have been exfiltrated via XSS / device compromise is
    // actually invalidated on the Supabase side.
    for (const account of accounts) {
      if (account.refreshToken) {
        // Serial is fine here — this path is rarely hit and we want to avoid
        // racing session swaps inside invalidateStoredRefreshToken.
        // eslint-disable-next-line no-await-in-loop
        await invalidateStoredRefreshToken(account.refreshToken)
      }
    }
    await supabase.auth.signOut()
    clear()
  }, [accounts, clear])

  return {
    accounts,
    activeAccount,
    inactiveAccounts,
    canAddAccount,
    maxAccounts,
    isPro: isPremium,
    addCurrentAccount,
    switchAccount,
    removeAccount: removeAccountAndRevoke,
    signOutAll,
  }
}
