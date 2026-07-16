import { jwtSubject } from '@/lib/auth/token-subject'
import { isViewerScopeCurrent, type ViewerKey, type ViewerScope } from '@/lib/auth/viewer-scope'

const UNSET_PARAMS_SOURCE = Symbol('unset-group-detail-params-source')

export type GroupDetailParamsSourceScope = {
  source: unknown
  paramsRevision: number
}

/** Advances synchronously when the params Promise/object identity is replaced. */
export class GroupDetailParamsSourceLedger {
  private current: GroupDetailParamsSourceScope = {
    source: UNSET_PARAMS_SOURCE,
    paramsRevision: 0,
  }

  capture(source: unknown): GroupDetailParamsSourceScope {
    if (this.current.source !== source) {
      this.current = {
        source,
        paramsRevision: this.current.paramsRevision + 1,
      }
    }
    return this.current
  }

  isCurrent(expected: GroupDetailParamsSourceScope): boolean {
    return (
      this.current.source === expected.source &&
      this.current.paramsRevision === expected.paramsRevision
    )
  }
}

export type GroupDetailResourceScope = {
  paramsRevision: number
  groupId: string | null
  resourceGeneration: number
}

export type GroupDetailOwnerScope = ViewerScope & GroupDetailResourceScope

export function canonicalGroupDetailId(groupId: string | null | undefined): string | null {
  const canonical = groupId?.trim().toLowerCase() ?? ''
  return canonical && canonical !== 'loading' ? canonical : null
}

export function advanceGroupDetailResourceScope(
  current: GroupDetailResourceScope,
  paramsRevision: number,
  groupId: string | null | undefined
): GroupDetailResourceScope {
  if (!Number.isSafeInteger(paramsRevision) || paramsRevision < 0) {
    throw new Error('paramsRevision must be a non-negative safe integer')
  }

  const nextGroupId = canonicalGroupDetailId(groupId)
  if (current.paramsRevision === paramsRevision && current.groupId === nextGroupId) return current

  return {
    paramsRevision,
    groupId: nextGroupId,
    resourceGeneration: current.resourceGeneration + 1,
  }
}

function canonicalOwner(scope: GroupDetailOwnerScope): string {
  return JSON.stringify([
    scope.userId?.toLowerCase() ?? null,
    scope.viewerKey,
    scope.sessionGeneration,
    scope.paramsRevision,
    canonicalGroupDetailId(scope.groupId),
    scope.resourceGeneration,
  ])
}

export function groupDetailOwnerKey(scope: GroupDetailOwnerScope): string {
  return `group-detail:${canonicalOwner(scope)}`
}

export function isSameGroupDetailOwner(
  expected: GroupDetailOwnerScope,
  rendered: GroupDetailOwnerScope
): boolean {
  return canonicalOwner(expected) === canonicalOwner(rendered)
}

export function isGroupDetailOwnerCurrent(
  expected: GroupDetailOwnerScope,
  rendered: GroupDetailOwnerScope,
  accessToken: string | null
): boolean {
  const userId = expected.userId?.toLowerCase() ?? null
  const groupId = canonicalGroupDetailId(expected.groupId)
  const expectedViewerKey: ViewerKey = userId ? `user:${userId}` : 'anon'
  const tokenSubject = jwtSubject(accessToken)?.toLowerCase() ?? null

  return (
    groupId !== null &&
    Number.isSafeInteger(expected.sessionGeneration) &&
    expected.sessionGeneration >= 0 &&
    Number.isSafeInteger(expected.paramsRevision) &&
    expected.paramsRevision >= 0 &&
    Number.isSafeInteger(expected.resourceGeneration) &&
    expected.resourceGeneration >= 0 &&
    expected.viewerKey === expectedViewerKey &&
    (userId ? tokenSubject === userId : accessToken === null) &&
    isSameGroupDetailOwner(expected, rendered) &&
    isViewerScopeCurrent({
      userId,
      viewerKey: expected.viewerKey,
      sessionGeneration: expected.sessionGeneration,
    })
  )
}
