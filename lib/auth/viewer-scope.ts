/**
 * Process-wide authentication identity scope.
 *
 * Access tokens rotate for the same principal, so they are deliberately not
 * part of the cache/request identity. `sessionGeneration` changes only when
 * the resolved principal changes (including entering/leaving the pending
 * state). Async work captures this small value object and must validate it
 * before committing user-specific state.
 */

export type ViewerKey = 'pending' | 'anon' | `user:${string}`

export type ViewerScope = {
  viewerKey: ViewerKey
  sessionGeneration: number
  userId: string | null
}

type IdentityTransition = {
  generation: number
  expectedUserId: string | null
}

let currentScope: ViewerScope = {
  viewerKey: 'pending',
  sessionGeneration: 0,
  userId: null,
}

let activeTransition: IdentityTransition | null = null

function viewerKeyFor(authChecked: boolean, userId: string | null): ViewerKey {
  if (!authChecked) return 'pending'
  return userId ? `user:${userId}` : 'anon'
}

export function getViewerScope(): ViewerScope {
  return currentScope
}

export function synchronizeViewerScope(authChecked: boolean, userId: string | null): ViewerScope {
  const viewerKey = viewerKeyFor(authChecked, userId)
  if (viewerKey !== currentScope.viewerKey) {
    currentScope = {
      viewerKey,
      sessionGeneration: currentScope.sessionGeneration + 1,
      userId: authChecked ? userId : null,
    }
  } else if (currentScope.userId !== userId) {
    currentScope = { ...currentScope, userId }
  }
  return currentScope
}

/**
 * Immediately invalidates all outstanding work before a logout/account swap.
 * The returned generation identifies this exact transition.
 */
export function beginViewerTransition(expectedUserId: string | null): number {
  currentScope = {
    viewerKey: 'pending',
    sessionGeneration: currentScope.sessionGeneration + 1,
    userId: null,
  }
  activeTransition = {
    generation: currentScope.sessionGeneration,
    expectedUserId,
  }
  return currentScope.sessionGeneration
}

export function isExpectedTransitionSession(userId: string | null): boolean {
  return !activeTransition || activeTransition.expectedUserId === userId
}

export function finishViewerTransition(generation: number): void {
  if (activeTransition?.generation === generation) activeTransition = null
}

export function isViewerScopeCurrent(scope: ViewerScope): boolean {
  return (
    currentScope.viewerKey === scope.viewerKey &&
    currentScope.sessionGeneration === scope.sessionGeneration &&
    currentScope.userId === scope.userId
  )
}

/** Test-only reset for modules that keep process-wide auth state. */
export function __resetViewerScopeForTests(): void {
  currentScope = { viewerKey: 'pending', sessionGeneration: 0, userId: null }
  activeTransition = null
}
