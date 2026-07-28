'use client'

import { useEffect, useMemo, useRef } from 'react'
import { getViewerScope, isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import { jwtSubject } from '@/lib/auth/token-subject'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/utils/logger'

type NavigationAuth = Pick<
  AuthSessionReturn,
  'accessToken' | 'authChecked' | 'email' | 'loading' | 'sessionGeneration' | 'userId' | 'viewerKey'
>

type NavigationViewer = ViewerScope & {
  viewerKey: `user:${string}`
  userId: string
  email: string | null
}

type SupabaseClient = Awaited<typeof import('@/lib/supabase/client')>['supabase']
let supabasePromise: Promise<SupabaseClient> | null = null

function getSupabase(): Promise<SupabaseClient> {
  if (!supabasePromise) {
    supabasePromise = import('@/lib/supabase/client')
      .then((module) => module.supabase)
      .catch((error) => {
        supabasePromise = null
        throw error
      })
  }
  return supabasePromise
}

function captureNavigationViewer(auth: NavigationAuth): NavigationViewer | null {
  if (
    auth.loading ||
    !auth.authChecked ||
    !auth.userId ||
    !auth.accessToken ||
    auth.viewerKey !== `user:${auth.userId}` ||
    jwtSubject(auth.accessToken) !== auth.userId
  ) {
    return null
  }

  const processScope = getViewerScope()
  if (
    processScope.viewerKey !== auth.viewerKey ||
    processScope.sessionGeneration !== auth.sessionGeneration ||
    processScope.userId !== auth.userId
  ) {
    return null
  }

  return {
    viewerKey: auth.viewerKey as `user:${string}`,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
    email: auth.email,
  }
}

function isNavigationViewerCurrent(viewer: NavigationViewer, auth: NavigationAuth): boolean {
  return (
    isViewerScopeCurrent(viewer) &&
    auth.authChecked &&
    !auth.loading &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration &&
    auth.userId === viewer.userId &&
    jwtSubject(auth.accessToken) === viewer.userId
  )
}

function fallbackHandle(email: string | null): string | null {
  const localPart = email?.split('@')[0]?.trim()
  return localPart || null
}

/**
 * Resolve the current viewer's profile route without ever carrying a previous
 * account's handle across an auth transition. Email fallback is derived only
 * from the exact canonical viewer; the profile lookup progressively enhances it.
 */
export function useViewerProfileHandle(): string | null {
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewer = useMemo(
    () =>
      captureNavigationViewer({
        accessToken: auth.accessToken,
        authChecked: auth.authChecked,
        email: auth.email,
        loading: auth.loading,
        sessionGeneration: auth.sessionGeneration,
        userId: auth.userId,
        viewerKey: auth.viewerKey,
      }),
    [
      auth.accessToken,
      auth.authChecked,
      auth.email,
      auth.loading,
      auth.sessionGeneration,
      auth.userId,
      auth.viewerKey,
    ]
  )
  const scopeKey = viewer
    ? `${viewer.viewerKey}\u0000${viewer.sessionGeneration}`
    : `invalid:${auth.viewerKey}\u0000${auth.sessionGeneration}`
  const [profileHandle, setProfileHandle] = useViewerOwnedState<string | null>(
    null,
    () => null,
    scopeKey
  )

  useEffect(() => {
    if (!viewer) return

    let alive = true
    const operationIsCurrent = () => alive && isNavigationViewerCurrent(viewer, authRef.current)

    void getSupabase()
      .then((supabase) => {
        if (!operationIsCurrent()) return null
        return supabase.from('user_profiles').select('handle').eq('id', viewer.userId).maybeSingle()
      })
      .then((result) => {
        if (!result || !operationIsCurrent() || result.error) return
        const handle = typeof result.data?.handle === 'string' ? result.data.handle.trim() : ''
        if (handle) setProfileHandle(handle)
      })
      .catch((error) => {
        logger.warn(
          '[navigation] Profile handle lookup failed',
          error instanceof Error ? error.message : String(error)
        )
      })

    return () => {
      alive = false
    }
  }, [scopeKey, setProfileHandle, viewer])

  return viewer ? profileHandle || fallbackHandle(viewer.email) : null
}
