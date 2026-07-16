import { jwtSubject } from '@/lib/auth/token-subject'
import { isViewerScopeCurrent, type ViewerKey, type ViewerScope } from '@/lib/auth/viewer-scope'

const UNSET_PARAMS_SOURCE = Symbol('unset-group-manage-params-source')

export type GroupManageParamsSourceScope = {
  source: unknown
  paramsRevision: number
}

/**
 * Treats the params Promise object as the route source identity. A replacement
 * source advances synchronously during render, before either Promise resolves.
 */
export class GroupManageParamsSourceLedger {
  private source: unknown = UNSET_PARAMS_SOURCE
  private paramsRevision = 0

  capture(source: unknown): GroupManageParamsSourceScope {
    if (this.source !== source) {
      this.source = source
      this.paramsRevision += 1
    }
    return { source: this.source, paramsRevision: this.paramsRevision }
  }

  isCurrent(expected: GroupManageParamsSourceScope): boolean {
    return this.source === expected.source && this.paramsRevision === expected.paramsRevision
  }
}

export type GroupManageResourceScope = {
  paramsRevision: number
  groupId: string | null
  resourceGeneration: number
}

export type GroupManageOwnerScope = ViewerScope & GroupManageResourceScope

export function canonicalGroupManageId(groupId: string | null): string | null {
  const canonical = groupId?.trim().toLowerCase() ?? ''
  return canonical && canonical !== 'loading' ? canonical : null
}

export function advanceGroupManageResourceScope(
  current: GroupManageResourceScope,
  paramsRevision: number,
  groupId: string | null
): GroupManageResourceScope {
  if (!Number.isSafeInteger(paramsRevision) || paramsRevision < 0) {
    throw new Error('paramsRevision must be a non-negative safe integer')
  }

  const nextGroupId = canonicalGroupManageId(groupId)
  if (current.paramsRevision === paramsRevision && current.groupId === nextGroupId) return current

  return {
    paramsRevision,
    groupId: nextGroupId,
    resourceGeneration: current.resourceGeneration + 1,
  }
}

function canonicalOwnerScope(scope: GroupManageOwnerScope): string {
  return JSON.stringify([
    scope.userId?.toLowerCase() ?? null,
    scope.viewerKey,
    scope.sessionGeneration,
    scope.paramsRevision,
    canonicalGroupManageId(scope.groupId),
    scope.resourceGeneration,
  ])
}

export function groupManageOwnerKey(scope: GroupManageOwnerScope): string {
  return `group-manage:${canonicalOwnerScope(scope)}`
}

export function isSameGroupManageOwnerScope(
  expected: GroupManageOwnerScope,
  rendered: GroupManageOwnerScope
): boolean {
  return canonicalOwnerScope(expected) === canonicalOwnerScope(rendered)
}

export function isGroupManageViewerCurrent(
  expected: GroupManageOwnerScope,
  rendered: GroupManageOwnerScope,
  accessToken: string | null
): boolean {
  const userId = expected.userId?.toLowerCase() ?? null
  const groupId = canonicalGroupManageId(expected.groupId)
  const expectedViewerKey: ViewerKey | null = userId ? `user:${userId}` : null

  return (
    userId !== null &&
    groupId !== null &&
    Number.isSafeInteger(expected.sessionGeneration) &&
    expected.sessionGeneration >= 0 &&
    Number.isSafeInteger(expected.paramsRevision) &&
    expected.paramsRevision >= 0 &&
    Number.isSafeInteger(expected.resourceGeneration) &&
    expected.resourceGeneration >= 0 &&
    expected.viewerKey === expectedViewerKey &&
    isSameGroupManageOwnerScope(expected, rendered) &&
    jwtSubject(accessToken) === userId &&
    isViewerScopeCurrent({
      userId,
      viewerKey: expected.viewerKey,
      sessionGeneration: expected.sessionGeneration,
    })
  )
}
