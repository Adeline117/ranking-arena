'use client'

/**
 * Unsaved-changes guard for composers (UIUX_PERPAGE_AUDIT_2026-06-30 实体/详情:
 * post/group composers lost drafts silently on tab close / refresh — "全缺").
 *
 * Registers a `beforeunload` prompt while `isDirty` is true. Covers tab close,
 * reload, and external navigation — the cases where a draft is unrecoverable.
 * (App-Router client-side navigations don't fire beforeunload; guarding those
 * requires intercepting every Link/router call — deliberately out of scope, as
 * in-app nav keeps React state recoverable via back/forward cache far more
 * often than a hard unload does.)
 *
 * Usage: useUnsavedChangesGuard(Boolean(title.trim() || content.trim()) && !submitted)
 */

import { useEffect } from 'react'

export function useUnsavedChangesGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Chrome requires returnValue to be set; the string itself is ignored
      // by modern browsers, which show a generic prompt.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])
}
