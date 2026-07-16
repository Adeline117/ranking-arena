import { jwtSubject } from '@/lib/auth/token-subject'
import {
  getViewerScope,
  isViewerScopeCurrent,
  type ViewerKey,
  type ViewerScope,
} from '@/lib/auth/viewer-scope'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'

type CanonicalProfileAuth = Pick<
  AuthSessionReturn,
  'accessToken' | 'authChecked' | 'email' | 'loading' | 'sessionGeneration' | 'userId' | 'viewerKey'
>

export type ProfileViewerSnapshot = ViewerScope & {
  viewerKey: `user:${string}`
  userId: string
  accessToken: string
  email: string | null
}

/** Captures one resolved viewer and the exact token that starts profile work. */
export function captureProfileViewer(auth: CanonicalProfileAuth): ProfileViewerSnapshot | null {
  if (
    auth.loading ||
    !auth.authChecked ||
    !auth.userId ||
    !auth.accessToken ||
    jwtSubject(auth.accessToken) !== auth.userId ||
    auth.viewerKey !== (`user:${auth.userId}` as ViewerKey)
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
    accessToken: auth.accessToken,
    email: auth.email,
  }
}

/**
 * Exact-token CAS is intentional here: Supabase's browser singleton chooses
 * its Authorization header at dispatch time. A token rotation starts fresh
 * work and invalidates any response whose dispatch token is no longer current.
 */
export function isProfileViewerCurrent(
  snapshot: ProfileViewerSnapshot,
  auth: CanonicalProfileAuth
): boolean {
  return (
    isViewerScopeCurrent(snapshot) &&
    auth.authChecked &&
    !auth.loading &&
    auth.userId === snapshot.userId &&
    auth.viewerKey === snapshot.viewerKey &&
    auth.sessionGeneration === snapshot.sessionGeneration &&
    auth.accessToken === snapshot.accessToken &&
    jwtSubject(auth.accessToken) === snapshot.userId
  )
}
