import type { Session, SupabaseClient, User } from '@supabase/supabase-js'
import {
  captureAuthOperation,
  isAuthOperationCurrent,
  type AuthOperationLease,
} from '@/lib/auth/session-operation'
import { getViewerScope, isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'

type SupabaseAuthClient = Pick<SupabaseClient, 'auth'>

export class StaleVerifiedSessionError extends Error {
  constructor() {
    super('Authentication operation was superseded')
    this.name = 'StaleVerifiedSessionError'
  }
}

export type VerifiedSessionSnapshot = {
  session: Session
  user: User
  authOperation: AuthOperationLease
  viewerScope: ViewerScope | null
}

export async function verifySessionUser(
  client: SupabaseAuthClient,
  session: Session
): Promise<User> {
  const {
    data: { user },
    error,
  } = await client.auth.getUser(session.access_token)

  if (error || !user || user.id !== session.user.id) {
    throw error || new Error('Authentication identity changed. Please sign in again.')
  }

  return user
}

function captureSessionOwnership(
  userId: string,
  allowPendingViewer: boolean
): Pick<VerifiedSessionSnapshot, 'authOperation' | 'viewerScope'> {
  const viewerScope = getViewerScope()
  const capturedViewer =
    viewerScope.userId === userId && isViewerScopeCurrent(viewerScope) ? viewerScope : null

  if (
    !capturedViewer &&
    !(
      allowPendingViewer &&
      (viewerScope.viewerKey === 'pending' || viewerScope.viewerKey === 'anon') &&
      viewerScope.userId === null
    )
  ) {
    throw new StaleVerifiedSessionError()
  }

  const authOperation = captureAuthOperation(userId)
  if (!authOperation || !isAuthOperationCurrent(authOperation)) {
    throw new StaleVerifiedSessionError()
  }

  return { authOperation, viewerScope: capturedViewer }
}

export async function verifySessionSnapshot(
  client: SupabaseAuthClient,
  session: Session,
  options: { allowPendingViewer?: boolean } = {}
): Promise<VerifiedSessionSnapshot> {
  const user = await verifySessionUser(client, session)
  const ownership = captureSessionOwnership(user.id, options.allowPendingViewer === true)
  const snapshot = { session, user, ...ownership }
  assertVerifiedSessionSnapshotCurrent(snapshot)
  return snapshot
}

export function isVerifiedSessionSnapshotCurrent(snapshot: VerifiedSessionSnapshot): boolean {
  if (!isAuthOperationCurrent(snapshot.authOperation)) return false
  if (snapshot.viewerScope) return isViewerScopeCurrent(snapshot.viewerScope)

  const currentViewer = getViewerScope()
  return (
    currentViewer.viewerKey === 'pending' ||
    currentViewer.viewerKey === 'anon' ||
    (currentViewer.userId === snapshot.user.id && isViewerScopeCurrent(currentViewer))
  )
}

export function assertVerifiedSessionSnapshotCurrent(
  snapshot: VerifiedSessionSnapshot
): asserts snapshot is VerifiedSessionSnapshot {
  if (!isVerifiedSessionSnapshotCurrent(snapshot)) throw new StaleVerifiedSessionError()
}

export async function getVerifiedSessionSnapshot(
  client: SupabaseAuthClient
): Promise<VerifiedSessionSnapshot> {
  const {
    data: { session },
    error,
  } = await client.auth.getSession()

  if (error || !session) {
    throw error || new Error('Session could not be verified. Please sign in again.')
  }

  return verifySessionSnapshot(client, session)
}
