'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import { getGlobalToast } from '@/lib/hooks/useApiMutation'
import { t } from '@/lib/i18n'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

type AdminVerification = 'checking' | 'authorized' | 'forbidden' | 'unavailable'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function readAdminSessionAcknowledgement(value: unknown, expectedUserId: string): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['success', 'data', 'meta'])) return false
  if (value.success !== true || !isRecord(value.data) || !isRecord(value.meta)) return false
  if (!hasExactKeys(value.data, ['admin']) || !hasExactKeys(value.meta, ['timestamp'])) return false
  if (
    typeof value.meta.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(value.meta.timestamp))
  ) {
    return false
  }

  const admin = value.data.admin
  return (
    isRecord(admin) &&
    hasExactKeys(admin, ['email', 'id']) &&
    admin.id === expectedUserId &&
    typeof admin.email === 'string'
  )
}

// Admin UI authority is intentionally verified by the same server boundary as
// every privileged API. Client-side user_profiles.role is not equivalent to
// the production ADMIN_EMAILS + active-profile contract in verifyAdmin().
export function useAdminAuth() {
  const router = useRouter()
  const pathname = usePathname()
  const auth = useAuthSession()
  const { getToken } = auth
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${auth.userId ?? ''}\u0000${auth.accessToken ?? ''}`
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const [verification, setVerification] = useViewerOwnedState<AdminVerification>(
    'checking',
    () => 'checking',
    scopeKey
  )

  useEffect(() => {
    if (!auth.authChecked || auth.loading) return

    const controller = new AbortController()
    const requestScopeKey = scopeKey
    const requestIsCurrent = () =>
      !controller.signal.aborted && scopeKeyRef.current === requestScopeKey

    if (!auth.userId || !auth.accessToken || auth.viewerKey !== `user:${auth.userId}`) {
      setVerification('forbidden')
      router.replace(`/login?returnUrl=${encodeURIComponent(pathname)}`)
      return () => controller.abort()
    }

    const expectedUserId = auth.userId
    const expectedGeneration = auth.sessionGeneration
    const accessToken = auth.accessToken
    setVerification('checking')

    void (async () => {
      try {
        const freshToken = await getToken()
        if (!requestIsCurrent()) return
        if (!freshToken) {
          setVerification('unavailable')
          logger.error('Admin authority token refresh failed')
          return
        }
        // getToken() may rotate the bearer and synchronously publish a new
        // canonical auth scope. The new render owns the corresponding probe;
        // never send or authorize the old scope with that replacement token.
        if (freshToken !== accessToken) return

        const result = await authedFetch<unknown>(
          '/api/admin/authority',
          'GET',
          accessToken,
          undefined,
          15_000,
          {
            expectedUserId,
            expectedSessionGeneration: expectedGeneration,
            signal: controller.signal,
          }
        )
        if (result.stale || !requestIsCurrent()) return

        if (result.ok && readAdminSessionAcknowledgement(result.data, expectedUserId)) {
          setVerification('authorized')
          return
        }

        setVerification('forbidden')
        if (result.status === 403) {
          getGlobalToast()?.(t('u13admin_accessRequired'), 'error')
          router.replace('/')
        } else {
          setVerification('unavailable')
          logger.error('Admin authority verification failed:', {
            status: result.status,
          })
        }
      } catch (error) {
        if (!requestIsCurrent()) return
        setVerification('unavailable')
        logger.error('Admin authority verification failed:', error)
      }
    })()

    return () => controller.abort()
  }, [
    auth.accessToken,
    auth.authChecked,
    auth.loading,
    auth.sessionGeneration,
    auth.userId,
    auth.viewerKey,
    getToken,
    pathname,
    router,
    scopeKey,
    setVerification,
  ])

  const isAdmin =
    auth.authChecked &&
    !auth.loading &&
    Boolean(auth.userId && auth.accessToken) &&
    verification === 'authorized'
  const signedInReady =
    auth.authChecked &&
    !auth.loading &&
    Boolean(auth.userId && auth.accessToken && auth.viewerKey === `user:${auth.userId}`)

  return {
    email: isAdmin ? auth.email : null,
    accessToken: isAdmin ? auth.accessToken : null,
    isAdmin,
    authChecking:
      !auth.authChecked || auth.loading || (signedInReady && verification === 'checking'),
    userId: isAdmin ? auth.userId : null,
  }
}
