'use client'

import { useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase/client'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { useMultiAccountStore, StoredAccount } from '@/lib/stores/multiAccountStore'
import { usePremium } from '@/lib/premium/hooks'
import { logger } from '@/lib/logger'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'

const MAX_ACCOUNTS_FREE = 1
const MAX_ACCOUNTS_PRO = 5

let accountOperationTail: Promise<void> = Promise.resolve()
let accountOperationSequence = 0
const accountOperationRevision = new Map<string, number>()

function runAccountOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = accountOperationTail.then(operation, operation)
  accountOperationTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function beginAccountOperation(userIds: string[]): { sequence: number; userIds: string[] } {
  const sequence = ++accountOperationSequence
  const uniqueUserIds = [...new Set(userIds)]
  for (const userId of uniqueUserIds) accountOperationRevision.set(userId, sequence)
  return { sequence, userIds: uniqueUserIds }
}

function ownsAccountOperation(ticket: { sequence: number; userIds: string[] }): boolean {
  return ticket.userIds.every((userId) => accountOperationRevision.get(userId) === ticket.sequence)
}

/**
 * Invalidate a stored refresh token server-side by exchanging it once.
 * Supabase rotates refresh tokens on every successful refresh, so the
 * original token becomes unusable after this call — which means if it
 * ever leaked (XSS, device compromise) it can no longer mint sessions.
 *
 * The exchange runs on a non-persistent isolated client. It must never touch
 * the singleton client's storage or auth event stream for the active viewer.
 *
 * Best-effort: failures are reported but swallowed so local-state cleanup can
 * still proceed. A transport failure does not prove that the token was revoked.
 */
function createRevocationClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key',
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  )
}

export async function invalidateStoredRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return
  const revocationClient = createRevocationClient()

  try {
    // Exchange the stored refresh token. Success rotates it and invalidates the
    // old token. A returned error is not treated as proof of revocation because
    // it may be a transient transport or service failure.
    const { data, error } = await revocationClient.auth.refreshSession({
      refresh_token: refreshToken,
    })
    if (error) {
      logger.warn('[multi-account] Stored refresh token revocation was not confirmed:', error)
      return
    }

    // If the exchange yielded a fresh session, sign it out to drop the
    // rotated refresh token on the server too. scope=local keeps any other
    // devices/accounts unaffected.
    if (data.session) {
      await revocationClient.auth.signOut({ scope: 'local' })
    }
  } catch (err) {
    logger.warn('[multi-account] Failed to revoke stored refresh token:', err)
  }
}

export function useMultiAccount() {
  const { isPremium } = usePremium()
  const { signOut } = useAuthSession()
  const { accounts, addAccount, setActiveAccount } = useMultiAccountStore()

  const activeAccount = useMemo(() => accounts.find((a) => a.isActive), [accounts])
  const inactiveAccounts = useMemo(() => accounts.filter((a) => !a.isActive), [accounts])

  const maxAccounts = isPremium ? MAX_ACCOUNTS_PRO : MAX_ACCOUNTS_FREE
  const canAddAccount = accounts.length < maxAccounts

  const addCurrentAccount = useCallback(
    () =>
      runAccountOperation(async () => {
        const capturedScope = getViewerScope()
        if (!capturedScope.userId || !isViewerScopeCurrent(capturedScope)) return false

        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (
          !session ||
          session.user.id !== capturedScope.userId ||
          !isViewerScopeCurrent(capturedScope)
        ) {
          return false
        }

        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (
          !user ||
          user.id !== capturedScope.userId ||
          user.id !== session.user.id ||
          !isViewerScopeCurrent(capturedScope)
        ) {
          return false
        }

        // Fetch user profile for handle/avatar
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('handle, avatar_url')
          .eq('id', user.id)
          .maybeSingle()

        // This is the commit CAS: no profile/session result captured for A may
        // mutate the account store after the process-wide viewer has become B.
        if (!isViewerScopeCurrent(capturedScope)) return false

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
        useMultiAccountStore.getState().accounts.forEach((a) => {
          if (a.isActive && a.userId !== user.id) {
            addAccount({ ...a, isActive: false })
          }
        })

        addAccount(newAccount)
        return true
      }),
    [addAccount]
  )

  const switchAccount = useCallback(
    (userId: string) =>
      runAccountOperation(async () => {
        const capturedScope = getViewerScope()
        if (!capturedScope.userId || !isViewerScopeCurrent(capturedScope)) {
          return { success: false, error: 'stale_session' }
        }

        const currentAccounts = useMultiAccountStore.getState().accounts
        const target = currentAccounts.find((a) => a.userId === userId)
        if (!target) return { success: false, error: 'Account not found' }

        const currentActive = currentAccounts.find((a) => a.isActive)
        if (!currentActive || currentActive.userId !== capturedScope.userId) {
          return { success: false, error: 'stale_session' }
        }
        if (target.userId === currentActive.userId) return { success: true }
        const operationTicket = beginAccountOperation([currentActive.userId, target.userId])

        // Save current session's refresh token first
        const {
          data: { session: currentSession },
        } = await supabase.auth.getSession()

        // A session read is only safe to persist when all three principals agree:
        // the captured viewer, the active store entry, and Supabase's session.
        if (
          !currentSession ||
          currentSession.user.id !== capturedScope.userId ||
          currentSession.user.id !== currentActive.userId ||
          !isViewerScopeCurrent(capturedScope) ||
          !ownsAccountOperation(operationTicket)
        ) {
          return { success: false, error: 'stale_session' }
        }

        addAccount({
          ...currentActive,
          refreshToken: currentSession.refresh_token,
        })

        // Restore target account session
        const session = await tokenRefreshCoordinator.switchSession(
          target.refreshToken,
          target.userId
        )

        if (!session) {
          const restoredScope = getViewerScope()
          if (
            restoredScope.userId !== currentActive.userId ||
            !isViewerScopeCurrent(restoredScope)
          ) {
            return { success: false, error: 'stale_session' }
          }
          // The coordinator cannot distinguish an expired credential from a
          // transport/service failure. Preserve both store entries and let the
          // user explicitly remove the target instead of deleting it on an
          // unconfirmed failure.
          return { success: false, error: 'switch_failed' }
        }

        const switchedScope = getViewerScope()
        const liveTarget = useMultiAccountStore
          .getState()
          .accounts.find((account) => account.userId === userId)
        if (
          session.user.id !== target.userId ||
          switchedScope.userId !== target.userId ||
          !isViewerScopeCurrent(switchedScope) ||
          !ownsAccountOperation(operationTicket)
        ) {
          return { success: false, error: 'stale_session' }
        }

        // The identity switch has already committed globally. The store commit is
        // therefore mandatory: preserve any concurrent metadata update when the
        // target still exists, or reconstruct the captured target when it was
        // removed while the switch was in flight. In both cases the returned
        // session's rotated token is authoritative.
        addAccount({
          ...(liveTarget ?? target),
          refreshToken: session.refresh_token,
          isActive: true,
          lastActiveAt: new Date().toISOString(),
        })
        setActiveAccount(userId)

        return { success: true }
      }),
    [addAccount, setActiveAccount]
  )

  // Wrap removeAccount to revoke the stored refresh token server-side before
  // dropping it from local state. This narrows the blast radius of an XSS or
  // stolen-localStorage scenario: a leaked refresh token is long-lived and can
  // mint access tokens indefinitely, so "remove" must actually revoke it.
  const removeAccountAndRevoke = useCallback(
    (userId: string) =>
      runAccountOperation(async () => {
        const target = useMultiAccountStore
          .getState()
          .accounts.find((account) => account.userId === userId)
        if (!target) return
        const operationTicket = beginAccountOperation([userId])

        if (getViewerScope().userId === userId) {
          // Removing the real active principal is a logout, not a local-store edit.
          await signOut()
        } else if (target.refreshToken) {
          await invalidateStoredRefreshToken(target.refreshToken)
        }
        if (ownsAccountOperation(operationTicket)) {
          useMultiAccountStore.getState().removeAccount(userId)
        }
      }),
    [signOut]
  )

  const signOutAll = useCallback(
    () =>
      runAccountOperation(async () => {
        const liveAccounts = useMultiAccountStore.getState().accounts
        const operationTicket = beginAccountOperation(liveAccounts.map((account) => account.userId))
        const activeUserId = getViewerScope().userId
        // Revoke every stored refresh token before clearing local state, so any
        // token that may have been exfiltrated via XSS / device compromise is
        // actually invalidated on the Supabase side.
        for (const account of liveAccounts) {
          if (account.refreshToken && account.userId !== activeUserId) {
            // Serial is fine here — this path is rarely hit and we want to avoid
            // racing session swaps inside invalidateStoredRefreshToken.
            await invalidateStoredRefreshToken(account.refreshToken)
          }
        }
        await signOut()
        if (ownsAccountOperation(operationTicket)) useMultiAccountStore.getState().clear()
      }),
    [signOut]
  )

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
