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
  expectedUserId: string | null | undefined
}

type ViewerScopeListener = (scope: ViewerScope) => void

let currentScope: ViewerScope = {
  viewerKey: 'pending',
  sessionGeneration: 0,
  userId: null,
}

let activeTransition: IdentityTransition | null = null
const scopeListeners = new Set<ViewerScopeListener>()

function publishViewerScope(): void {
  for (const listener of scopeListeners) {
    try {
      listener(currentScope)
    } catch {
      // Identity transitions must not be blocked by a cache listener failure.
    }
  }
}

export function subscribeViewerScope(listener: ViewerScopeListener): () => void {
  scopeListeners.add(listener)
  return () => scopeListeners.delete(listener)
}

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
  } else {
    return currentScope
  }
  publishViewerScope()
  return currentScope
}

/**
 * Immediately invalidates all outstanding work before a logout/account swap.
 * The returned generation identifies this exact transition.
 */
export function beginViewerTransition(expectedUserId?: string | null): number {
  currentScope = {
    viewerKey: 'pending',
    sessionGeneration: currentScope.sessionGeneration + 1,
    userId: null,
  }
  activeTransition = {
    generation: currentScope.sessionGeneration,
    expectedUserId,
  }
  publishViewerScope()
  return currentScope.sessionGeneration
}

export function isExpectedTransitionSession(userId: string | null): boolean {
  return (
    !activeTransition ||
    (activeTransition.expectedUserId !== undefined && activeTransition.expectedUserId === userId)
  )
}

export function finishViewerTransition(generation: number): void {
  if (activeTransition?.generation === generation) activeTransition = null
}

/**
 * True only while `generation` still owns the process-wide identity transition.
 * A newer switch/logout always replaces the active transition, so older async
 * completions must treat `false` as a hard stale boundary.
 */
export function isViewerTransitionCurrent(generation: number): boolean {
  return activeTransition?.generation === generation
}

/**
 * Atomically resolve the transition that still owns `generation`.
 *
 * Supabase may publish the target session through `onAuthStateChange` before
 * the promise that initiated the switch settles. In that case the viewer is
 * already resolved and this function only performs the ownership CAS. If a
 * newer transition has started, it returns null without changing the viewer.
 */
export function commitViewerTransition(
  generation: number,
  userId: string | null
): ViewerScope | null {
  if (activeTransition?.generation !== generation) return null

  activeTransition = null
  const viewerKey = viewerKeyFor(true, userId)
  if (currentScope.viewerKey === viewerKey && currentScope.userId === userId) {
    return currentScope
  }

  currentScope = {
    viewerKey,
    sessionGeneration: currentScope.sessionGeneration + 1,
    userId,
  }
  publishViewerScope()
  return currentScope
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
  publishViewerScope()
}
