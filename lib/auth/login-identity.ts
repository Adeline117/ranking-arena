import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { getCsrfHeaders } from '@/lib/api/client'
import { getStoredAuthSession } from '@/lib/auth/session-operation'
import {
  assertVerifiedSessionSnapshotCurrent,
  isVerifiedSessionSnapshotCurrent,
  StaleVerifiedSessionError,
  verifySessionSnapshot,
  type VerifiedSessionSnapshot,
} from '@/lib/auth/verified-session'

type SupabaseAuthClient = Pick<SupabaseClient, 'auth'>

export type ExactLoginIdentity = VerifiedSessionSnapshot

export type ExactSessionJsonResult<T> = {
  ok: boolean
  status: number
  data: T | null
}

function storedSessionMatches(snapshot: ExactLoginIdentity): boolean {
  const storedSession = getStoredAuthSession()
  return (
    storedSession?.user?.id === snapshot.user.id &&
    storedSession.access_token === snapshot.session.access_token &&
    storedSession.refresh_token === snapshot.session.refresh_token
  )
}

/**
 * Login completion is stricter than steady-state viewer ownership: a refresh
 * for the same user also supersedes the old completion. This prevents a slow
 * response holding token A1 from committing after A2 became canonical.
 */
export function isExactLoginIdentityCurrent(snapshot: ExactLoginIdentity): boolean {
  return isVerifiedSessionSnapshotCurrent(snapshot) && storedSessionMatches(snapshot)
}

export function assertExactLoginIdentityCurrent(
  snapshot: ExactLoginIdentity
): asserts snapshot is ExactLoginIdentity {
  assertVerifiedSessionSnapshotCurrent(snapshot)
  if (!storedSessionMatches(snapshot)) throw new StaleVerifiedSessionError()
}

/** Verify the exact coordinator/event session; never reacquire a singleton session. */
export async function verifyExactLoginIdentity(
  client: SupabaseAuthClient,
  session: Session,
  options: { allowPendingViewer?: boolean } = {}
): Promise<ExactLoginIdentity> {
  const snapshot = await verifySessionSnapshot(client, session, options)
  assertExactLoginIdentityCurrent(snapshot)
  return snapshot
}

/**
 * Issue one authenticated JSON request with the snapshot's exact bearer.
 * There is deliberately no 401 refresh/retry: adopting a newer token would
 * detach the request from the login operation that supplied its body.
 */
export async function exactSessionJsonRequest<T>(
  snapshot: ExactLoginIdentity,
  url: string,
  body?: Record<string, unknown>,
  options: { signal?: AbortSignal; keepalive?: boolean } = {}
): Promise<ExactSessionJsonResult<T>> {
  assertExactLoginIdentityCurrent(snapshot)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${snapshot.session.access_token}`,
      ...getCsrfHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
    signal: options.signal,
    keepalive: options.keepalive,
  })
  assertExactLoginIdentityCurrent(snapshot)
  const data = (await response.json().catch(() => null)) as T | null
  assertExactLoginIdentityCurrent(snapshot)
  return { ok: response.ok, status: response.status, data }
}
