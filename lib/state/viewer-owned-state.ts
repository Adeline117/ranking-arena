'use client'

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

export type ViewerOwnedStateResult<T> = { accepted: false; value: T } | { accepted: true; value: T }

/**
 * Resolve a React state action without allowing a delayed updater to adopt a
 * different viewer. The caller captures `invocationScopeKey` before scheduling
 * the updater and reads `currentScopeKey` only when React executes it.
 */
export function applyViewerOwnedStateAction<T>(options: {
  action: SetStateAction<T>
  previous: T
  empty: T
  ownerScopeKey: string
  invocationScopeKey: string
  currentScopeKey: string
}): ViewerOwnedStateResult<T> {
  const { action, previous, empty, ownerScopeKey, invocationScopeKey, currentScopeKey } = options
  if (currentScopeKey !== invocationScopeKey) return { accepted: false, value: previous }

  const ownedPrevious = ownerScopeKey === invocationScopeKey ? previous : empty
  return {
    accepted: true,
    value: typeof action === 'function' ? (action as (value: T) => T)(ownedPrevious) : action,
  }
}

/** Viewer-owned useState with render-time fail-empty and invocation-time CAS. */
export function useViewerOwnedState<T>(
  initialState: T | (() => T),
  emptyState: () => T,
  scopeKey: string
): [T, Dispatch<SetStateAction<T>>] {
  const currentScopeKeyRef = useRef(scopeKey)
  currentScopeKeyRef.current = scopeKey
  const emptyStateRef = useRef(emptyState)
  emptyStateRef.current = emptyState
  const [ownedState, setOwnedState] = useState<{
    ownerScopeKey: string
    value: T
  }>(() => ({
    ownerScopeKey: scopeKey,
    value: typeof initialState === 'function' ? (initialState as () => T)() : initialState,
  }))

  const setState = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const invocationScopeKey = currentScopeKeyRef.current
    setOwnedState((previous) => {
      const result = applyViewerOwnedStateAction({
        action,
        previous: previous.value,
        empty: emptyStateRef.current(),
        ownerScopeKey: previous.ownerScopeKey,
        invocationScopeKey,
        currentScopeKey: currentScopeKeyRef.current,
      })
      if (!result.accepted) return previous
      if (
        previous.ownerScopeKey === invocationScopeKey &&
        Object.is(previous.value, result.value)
      ) {
        return previous
      }
      return { ownerScopeKey: invocationScopeKey, value: result.value }
    })
  }, [])

  return [ownedState.ownerScopeKey === scopeKey ? ownedState.value : emptyState(), setState]
}
