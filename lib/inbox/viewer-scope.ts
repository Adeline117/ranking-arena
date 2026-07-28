import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  getViewerScope,
  isViewerScopeCurrent,
  type ViewerKey,
  type ViewerScope,
} from '@/lib/auth/viewer-scope'
import { jwtSubject } from '@/lib/auth/token-subject'

type InboxAuth = Pick<
  AuthSessionReturn,
  | 'accessToken'
  | 'authChecked'
  | 'email'
  | 'isLoggedIn'
  | 'loading'
  | 'sessionGeneration'
  | 'user'
  | 'userId'
  | 'viewerKey'
>

export type InboxViewerSnapshot = Omit<ViewerScope, 'userId' | 'viewerKey'> & {
  accessToken: string
  email: string | null
  userId: string
  viewerKey: `user:${string}`
  userMetadata: Record<string, unknown>
}

export function inboxViewerScopeKey(scope: ViewerScope): string {
  return `${scope.viewerKey}\u0000${scope.sessionGeneration}\u0000${scope.userId ?? ''}`
}

/** Capture only a fully resolved principal whose JWT and process CAS agree. */
export function captureInboxViewer(auth: InboxAuth): InboxViewerSnapshot | null {
  const expectedViewerKey = auth.userId ? (`user:${auth.userId}` as const) : null
  if (
    auth.loading ||
    !auth.authChecked ||
    !auth.isLoggedIn ||
    !auth.userId ||
    !auth.accessToken ||
    auth.viewerKey !== expectedViewerKey ||
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
    accessToken: auth.accessToken,
    email: auth.email,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
    userMetadata:
      auth.user?.user_metadata && typeof auth.user.user_metadata === 'object'
        ? { ...(auth.user.user_metadata as Record<string, unknown>) }
        : {},
    viewerKey: auth.viewerKey as `user:${string}`,
  }
}

/** Check the process CAS and the hook's latest canonical/JWT identity. */
export function isInboxViewerCurrent(viewer: InboxViewerSnapshot, auth: InboxAuth): boolean {
  return (
    isViewerScopeCurrent(viewer) &&
    !auth.loading &&
    auth.authChecked &&
    auth.isLoggedIn &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration &&
    jwtSubject(auth.accessToken) === viewer.userId
  )
}

export function authInboxScope(
  auth: Pick<InboxAuth, 'sessionGeneration' | 'userId' | 'viewerKey'>
) {
  return {
    viewerKey: auth.viewerKey as ViewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  } satisfies ViewerScope
}
