'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { Suspense } from 'react'
import { logger } from '@/lib/logger'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useMultiAccountStore } from '@/lib/stores/multiAccountStore'
import {
  assertVerifiedSessionSnapshotCurrent,
  StaleVerifiedSessionError,
  verifySessionSnapshot,
  type VerifiedSessionSnapshot,
} from '@/lib/auth/verified-session'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import {
  clearAuthRedirectAcquisitionReceipt,
  getAuthRedirectAcquisitionReceipt,
  getAuthRedirectNavigationKey,
  getCurrentAuthOperation,
  isAuthOperationCurrent,
  type AuthRedirectAcquisitionReceipt,
  type AuthOperationLease,
} from '@/lib/auth/session-operation'

function AuthCallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t, language: _language } = useLanguage()

  useEffect(() => {
    let cancelled = false
    let callbackReceipt: AuthRedirectAcquisitionReceipt | null = null
    const retryTimers = new Set<ReturnType<typeof setTimeout>>()

    const clearCallbackReceipt = () => {
      if (!callbackReceipt) return
      clearAuthRedirectAcquisitionReceipt(callbackReceipt)
      callbackReceipt = null
    }
    const replaceFromCallback = (destination: string) => {
      router.replace(destination)
      clearCallbackReceipt()
    }

    const assertCallbackCurrent = (snapshot?: VerifiedSessionSnapshot) => {
      if (cancelled) throw new StaleVerifiedSessionError()
      if (snapshot) assertVerifiedSessionSnapshotCurrent(snapshot)
    }

    type CallbackBoundary = {
      authOperation: AuthOperationLease | null
      viewerScope: ReturnType<typeof getViewerScope>
    }
    const captureCallbackBoundary = (): CallbackBoundary => ({
      authOperation: getCurrentAuthOperation(),
      viewerScope: getViewerScope(),
    })
    const isCallbackBoundaryCurrent = (boundary: CallbackBoundary) =>
      boundary.authOperation
        ? isAuthOperationCurrent(boundary.authOperation)
        : getCurrentAuthOperation() === null && isViewerScopeCurrent(boundary.viewerScope)
    const assertCallbackBoundaryCurrent = (boundary: CallbackBoundary) => {
      assertCallbackCurrent()
      if (!isCallbackBoundaryCurrent(boundary)) throw new StaleVerifiedSessionError()
    }
    const proveCallbackSessionOwnership = (
      candidateSession: { user: { id: string } },
      boundary: CallbackBoundary
    ): boolean => {
      assertCallbackCurrent()
      const receipt = getAuthRedirectAcquisitionReceipt()
      if (!receipt) return isCallbackBoundaryCurrent(boundary)

      const currentOperation = getCurrentAuthOperation()
      if (
        receipt.navigationKey !== getAuthRedirectNavigationKey() ||
        receipt.userId !== candidateSession.user.id ||
        !currentOperation ||
        currentOperation.id !== receipt.operationId ||
        !currentOperation.targetKnown ||
        currentOperation.expectedUserId !== receipt.userId
      ) {
        return false
      }

      callbackReceipt = receipt
      return true
    }

    const waitForRetry = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          retryTimers.delete(timer)
          resolve()
        }, 1000)
        retryTimers.add(timer)
      })

    const handleCallback = async () => {
      // Check for OAuth provider error params (e.g., user cancelled, access_denied)
      const providerError = searchParams.get('error')
      const errorDescription = searchParams.get('error_description')
      if (providerError) {
        const errorMsg = errorDescription || providerError
        logger.warn('OAuth provider error:', {
          error: providerError,
          description: errorDescription,
        })
        replaceFromCallback(`/login?error=${encodeURIComponent(errorMsg)}`)
        return
      }

      const initialBoundary = captureCallbackBoundary()
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession()
      assertCallbackCurrent()

      if (error) {
        if (session) {
          if (!proveCallbackSessionOwnership(session, initialBoundary)) return
          logger.error('Auth callback error:', error)
          const rolledBack = await tokenRefreshCoordinator.signOutIfCurrent(
            session.user.id,
            session.access_token
          )
          if (!cancelled && rolledBack) {
            const viewer = getViewerScope()
            if (
              viewer.viewerKey === 'anon' &&
              viewer.userId === null &&
              isViewerScopeCurrent(viewer)
            ) {
              replaceFromCallback('/login?error=auth_failed')
            }
          }
        } else {
          if (!isCallbackBoundaryCurrent(initialBoundary)) return
          logger.error('Auth callback error:', error)
          replaceFromCallback('/login?error=auth_failed')
        }
        return
      }

      const isAddAccount =
        searchParams.get('addAccount') === 'true' ||
        (typeof window !== 'undefined' &&
          (() => {
            try {
              return localStorage.getItem('arena_adding_account') === 'true'
            } catch {
              return false
            }
          })())
      // Don't clear flag yet — wait until saveToStore succeeds

      const returnUrl = searchParams.get('returnUrl')
      // Validate returnUrl: must start with / but NOT // (prevents protocol-relative open redirect)
      const isSafeReturn = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//')
      const defaultRedirect = isAddAccount ? '/' : isSafeReturn ? returnUrl : '/'

      const rollbackAttempt = async (
        snapshot: Pick<VerifiedSessionSnapshot, 'session' | 'user'>,
        errorCode: 'auth_failed' | 'profile_provisioning_failed'
      ) => {
        if (cancelled) return
        const rolledBack = await tokenRefreshCoordinator.signOutIfCurrent(
          snapshot.user.id,
          snapshot.session.access_token
        )
        if (cancelled || !rolledBack) return

        // signOutIfCurrent deliberately invalidates the failed snapshot. Check
        // the resulting anonymous epoch instead so a login for B that starts
        // while rollback settles cannot be overwritten by A's error redirect.
        const viewer = getViewerScope()
        if (
          viewer.viewerKey !== 'anon' ||
          viewer.userId !== null ||
          !isViewerScopeCurrent(viewer)
        ) {
          return
        }
        replaceFromCallback(`/login?error=${errorCode}`)
      }

      // Fire-and-forget welcome email for genuinely-new signups (created_at window).
      // (route auth reads only the Authorization Bearer header)
      const sendWelcomeEmailIfNew = (snapshot: VerifiedSessionSnapshot) => {
        assertCallbackCurrent(snapshot)
        const createdAt = new Date(snapshot.user.created_at).getTime()
        if (Date.now() - createdAt < 30_000) {
          fetch('/api/email/welcome', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${snapshot.session.access_token}`,
            },
          })
            // eslint-disable-next-line no-restricted-syntax
            .catch(() => {
              /* intentional: fire-and-forget */
            })
        }
      }

      const commitSuccessfulCallback = (identity: {
        snapshot: VerifiedSessionSnapshot
        profile: {
          id: string
          handle: string | null
          avatar_url: string | null
          onboarding_completed: boolean | null
        }
      }) => {
        assertCallbackCurrent(identity.snapshot)
        const { snapshot, profile } = identity
        const { session: verifiedSession, user } = snapshot

        // Store mutation, flag cleanup and navigation are intentionally one
        // synchronous commit after every awaited identity/profile operation.
        // No A-owned promise can interleave and partially commit after B wins.
        if (isAddAccount) {
          const store = useMultiAccountStore.getState()
          store.accounts.forEach((a) => {
            if (a.isActive) store.addAccount({ ...a, isActive: false })
          })
          store.addAccount({
            userId: user.id,
            email: user.email || '',
            handle: profile.handle || null,
            avatarUrl: profile.avatar_url || null,
            refreshToken: verifiedSession.refresh_token,
            lastActiveAt: new Date().toISOString(),
            isActive: true,
          })
          try {
            localStorage.removeItem('arena_adding_account')
          } catch {
            /* intentional */
          }
        }

        sendWelcomeEmailIfNew(snapshot)
        if (isAddAccount) {
          replaceFromCallback('/')
        } else if (profile.onboarding_completed !== true) {
          const ru = isSafeReturn ? returnUrl! : '/'
          replaceFromCallback(`/onboarding?returnUrl=${encodeURIComponent(ru)}`)
        } else {
          replaceFromCallback(defaultRedirect)
        }
      }

      const loadVerifiedIdentity = async (candidateSession: NonNullable<typeof session>) => {
        let snapshot: VerifiedSessionSnapshot
        try {
          snapshot = await verifySessionSnapshot(supabase, candidateSession, {
            allowPendingViewer: true,
          })
          assertCallbackCurrent(snapshot)
        } catch (verificationError) {
          if (verificationError instanceof StaleVerifiedSessionError) return null
          logger.error('OAuth session identity validation failed', {
            expectedUserId: candidateSession.user.id,
            error: verificationError,
          })
          await rollbackAttempt(
            { session: candidateSession, user: candidateSession.user },
            'auth_failed'
          )
          return null
        }

        let profile
        try {
          const result = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url, onboarding_completed')
            .eq('id', snapshot.user.id)
            .maybeSingle()
          assertCallbackCurrent(snapshot)
          profile = result.data

          if (result.error || !profile || profile.id !== snapshot.user.id) {
            logger.error('Profile provisioning incomplete after OAuth callback', {
              userId: snapshot.user.id,
              error: result.error,
            })
            await rollbackAttempt(snapshot, 'profile_provisioning_failed')
            return null
          }
        } catch (profileError) {
          if (profileError instanceof StaleVerifiedSessionError) return null
          assertCallbackCurrent(snapshot)
          logger.error('Provisioned profile read threw during OAuth callback', profileError)
          await rollbackAttempt(snapshot, 'profile_provisioning_failed')
          return null
        }

        const oauthAvatar =
          snapshot.user.user_metadata?.avatar_url || snapshot.user.user_metadata?.picture || null
        if (oauthAvatar && (!profile.avatar_url || profile.avatar_url.length < 5)) {
          try {
            const { data: updatedProfile, error: updateError } = await supabase
              .from('user_profiles')
              .update({ avatar_url: oauthAvatar })
              .eq('id', snapshot.user.id)
              .select('id')
              .maybeSingle()
            assertCallbackCurrent(snapshot)
            if (updateError || !updatedProfile || updatedProfile.id !== snapshot.user.id) {
              logger.warn('OAuth profile avatar update failed', {
                userId: snapshot.user.id,
                error: updateError,
              })
            } else {
              profile.avatar_url = oauthAvatar
            }
          } catch (avatarError) {
            if (avatarError instanceof StaleVerifiedSessionError) return null
            assertCallbackCurrent(snapshot)
            logger.warn('OAuth profile avatar update threw', avatarError)
          }
        }

        assertCallbackCurrent(snapshot)
        return { snapshot, profile }
      }

      const processSession = async (candidateSession: NonNullable<typeof session>) => {
        const identity = await loadVerifiedIdentity(candidateSession)
        if (!identity) return
        commitSuccessfulCallback(identity)
      }

      if (session) {
        if (!proveCallbackSessionOwnership(session, initialBoundary)) return
        await processSession(session)
      } else {
        if (!isCallbackBoundaryCurrent(initialBoundary)) return
        // With no principal yet, pin all retries to the exact auth operation
        // that owned the initial empty read. A new login/account switch must
        // not be adopted by this older callback just because it appears later.
        const retryBoundary = initialBoundary
        // Retry with backoff: supabase may need time to process the hash fragment
        const tryGetSession = async (
          retries = 0
        ): Promise<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']> => {
          await waitForRetry()
          assertCallbackBoundaryCurrent(retryBoundary)
          const { data, error: retryError } = await supabase.auth.getSession()
          assertCallbackBoundaryCurrent(retryBoundary)
          if (retryError) throw retryError
          if (data.session) return data.session
          if (retries < 2) return tryGetSession(retries + 1)
          return null
        }

        const retrySession = await tryGetSession()
        if (retrySession) {
          if (!proveCallbackSessionOwnership(retrySession, retryBoundary)) return
          await processSession(retrySession)
        } else {
          replaceFromCallback('/login?error=no_session')
        }
      }
    }

    void handleCallback().catch((callbackError) => {
      if (cancelled || callbackError instanceof StaleVerifiedSessionError) return
      logger.error('Unhandled auth callback failure', callbackError)
      replaceFromCallback('/login?error=auth_failed')
    })

    return () => {
      cancelled = true
      retryTimers.forEach((timer) => clearTimeout(timer))
      retryTimers.clear()
      clearCallbackReceipt()
    }
  }, [router, searchParams])

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            width: 32,
            height: 32,
            border: `3px solid ${tokens.colors.accent.primary}`,
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 16px',
          }}
        />
        <p style={{ color: tokens.colors.text.secondary, fontSize: 14 }}>{t('signingIn')}</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: tokens.colors.bg.primary,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              border: `3px solid ${tokens.colors.accent.primary}`,
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
        </div>
      }
    >
      <AuthCallbackContent />
    </Suspense>
  )
}
