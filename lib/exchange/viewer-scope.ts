import { jwtSubject } from '@/lib/auth/token-subject'
import {
  getViewerScope,
  isViewerScopeCurrent,
  type ViewerKey,
  type ViewerScope,
} from '@/lib/auth/viewer-scope'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'

type CanonicalExchangeAuth = Pick<
  AuthSessionReturn,
  'accessToken' | 'authChecked' | 'loading' | 'sessionGeneration' | 'userId' | 'viewerKey'
>

export type ExchangeViewerSnapshot = ViewerScope & {
  viewerKey: `user:${string}`
  userId: string
  accessToken: string
}

export function captureExchangeViewer(
  auth: CanonicalExchangeAuth,
  expectedUserId: string | null
): ExchangeViewerSnapshot | null {
  if (
    auth.loading ||
    !auth.authChecked ||
    !auth.userId ||
    auth.userId !== expectedUserId ||
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
  }
}

export function isExchangeViewerCurrent(
  snapshot: ExchangeViewerSnapshot,
  auth: CanonicalExchangeAuth,
  expectedUserId: string | null
): boolean {
  return (
    isViewerScopeCurrent(snapshot) &&
    auth.authChecked &&
    !auth.loading &&
    auth.userId === expectedUserId &&
    auth.userId === snapshot.userId &&
    auth.viewerKey === snapshot.viewerKey &&
    auth.sessionGeneration === snapshot.sessionGeneration &&
    !!auth.accessToken &&
    jwtSubject(auth.accessToken) === snapshot.userId
  )
}
