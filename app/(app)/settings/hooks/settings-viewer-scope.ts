import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  getViewerScope,
  isViewerScopeCurrent,
  type ViewerKey,
  type ViewerScope,
} from '@/lib/auth/viewer-scope'
import { jwtSubject } from '@/lib/auth/token-subject'

type CanonicalAuthViewer = Pick<
  AuthSessionReturn,
  'accessToken' | 'authChecked' | 'email' | 'loading' | 'sessionGeneration' | 'userId' | 'viewerKey'
>

export type SettingsViewerSnapshot = Omit<ViewerScope, 'userId' | 'viewerKey'> & {
  viewerKey: `user:${string}`
  userId: string
  accessToken: string
  email: string | null
}

/** Captures one resolved authenticated viewer and the exact token used by its work. */
export function captureSettingsViewer(auth: CanonicalAuthViewer): SettingsViewerSnapshot | null {
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

/** Checks both the process-wide CAS and the hook's latest canonical snapshot. */
export function isSettingsViewerCurrent(
  snapshot: SettingsViewerSnapshot,
  auth: CanonicalAuthViewer
): boolean {
  return (
    isViewerScopeCurrent(snapshot) &&
    auth.authChecked &&
    !auth.loading &&
    auth.viewerKey === snapshot.viewerKey &&
    auth.sessionGeneration === snapshot.sessionGeneration &&
    auth.userId === snapshot.userId
  )
}
