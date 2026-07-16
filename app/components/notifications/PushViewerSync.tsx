'use client'

import { useEffect, useRef } from 'react'
import { jwtSubject } from '@/lib/auth/token-subject'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { fireAndForget } from '@/lib/utils/logger'

export const SET_ACTIVE_PUSH_VIEWER = 'SET_ACTIVE_PUSH_VIEWER'

/**
 * Keep the service worker's device-level push filter aligned with the
 * canonical app viewer. Pending, anonymous and token-mismatched sessions all
 * publish `null` immediately so an older account cannot remain active during
 * an identity transition.
 */
export function PushViewerSync() {
  const auth = useAuthSession()
  const nextSyncIdRef = useRef(0)
  const activeUserId =
    auth.authChecked &&
    !auth.loading &&
    auth.userId &&
    auth.viewerKey === `user:${auth.userId}` &&
    jwtSubject(auth.accessToken) === auth.userId
      ? auth.userId
      : null

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const syncId = ++nextSyncIdRef.current
    let cancelled = false

    fireAndForget(
      navigator.serviceWorker.ready.then((registration) => {
        if (cancelled || nextSyncIdRef.current !== syncId) return
        const worker = registration.active ?? navigator.serviceWorker.controller
        worker?.postMessage({ type: SET_ACTIVE_PUSH_VIEWER, userId: activeUserId })
      }),
      'push-viewer-service-worker-sync'
    )

    return () => {
      cancelled = true
    }
  }, [activeUserId, auth.sessionGeneration, auth.viewerKey])

  return null
}
