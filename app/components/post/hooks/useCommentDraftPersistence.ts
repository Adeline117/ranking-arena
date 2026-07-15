'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const COMMENT_DRAFT_DEBOUNCE_MS = 500

type PendingDraft = {
  timer: ReturnType<typeof setTimeout>
  value: string
}

function getDraftKey(viewerKey: string, postId: string): string {
  return `comment-draft-v2:${viewerKey}:${postId}`
}

function readDraft(viewerKey: string, postId: string): string {
  try {
    return localStorage.getItem(getDraftKey(viewerKey, postId)) || ''
  } catch {
    return ''
  }
}

function persistDraft(viewerKey: string, postId: string, value: string): void {
  try {
    if (value.trim()) {
      localStorage.setItem(getDraftKey(viewerKey, postId), value)
    } else {
      localStorage.removeItem(getDraftKey(viewerKey, postId))
    }
  } catch {
    // Storage can be unavailable or full. Draft persistence must never block input.
  }
}

/**
 * Keeps comment drafts isolated by post while retaining the 500ms write debounce.
 * Pending writes are flushed before a post switch and on unmount so another post's
 * keystroke can never cancel an unsaved draft.
 */
export function useCommentDraftPersistence(initialPostId?: string | null, viewerKey = 'anon') {
  const currentPostIdRef = useRef<string | null>(initialPostId || null)
  const currentViewerKeyRef = useRef(viewerKey)
  const pendingDraftsRef = useRef(new Map<string, PendingDraft>())
  const [draft, setDraftRaw] = useState(() =>
    initialPostId ? readDraft(viewerKey, initialPostId) : ''
  )

  const pendingKey = useCallback(
    (postId: string, scopeViewerKey = currentViewerKeyRef.current) =>
      `${scopeViewerKey}\u0000${postId}`,
    []
  )

  const flushDraft = useCallback(
    (postId: string, scopeViewerKey = currentViewerKeyRef.current) => {
      const key = pendingKey(postId, scopeViewerKey)
      const pending = pendingDraftsRef.current.get(key)
      if (!pending) return

      clearTimeout(pending.timer)
      pendingDraftsRef.current.delete(key)
      persistDraft(scopeViewerKey, postId, pending.value)
    },
    [pendingKey]
  )

  const flushAllDrafts = useCallback(() => {
    for (const [key, pending] of [...pendingDraftsRef.current.entries()]) {
      clearTimeout(pending.timer)
      pendingDraftsRef.current.delete(key)
      const separator = key.indexOf('\u0000')
      persistDraft(key.slice(0, separator), key.slice(separator + 1), pending.value)
    }
  }, [])

  const setDraft = useCallback(
    (value: string) => {
      setDraftRaw(value)

      const postId = currentPostIdRef.current
      if (!postId) return
      const scopeViewerKey = currentViewerKeyRef.current
      const key = pendingKey(postId, scopeViewerKey)

      const existing = pendingDraftsRef.current.get(key)
      if (existing) clearTimeout(existing.timer)

      const timer = setTimeout(() => {
        const pending = pendingDraftsRef.current.get(key)
        if (!pending || pending.timer !== timer) return

        pendingDraftsRef.current.delete(key)
        persistDraft(scopeViewerKey, postId, pending.value)
      }, COMMENT_DRAFT_DEBOUNCE_MS)

      pendingDraftsRef.current.set(key, { timer, value })
    },
    [pendingKey]
  )

  const restoreDraft = useCallback(
    (postId: string) => {
      const previousPostId = currentPostIdRef.current
      if (previousPostId && previousPostId !== postId) {
        flushDraft(previousPostId)
      }

      currentPostIdRef.current = postId
      setDraftRaw(readDraft(currentViewerKeyRef.current, postId))
    },
    [flushDraft]
  )

  const saveDraft = useCallback(
    (postId: string, value: string) => {
      const scopeViewerKey = currentViewerKeyRef.current
      const key = pendingKey(postId, scopeViewerKey)
      const pending = pendingDraftsRef.current.get(key)
      if (pending) {
        clearTimeout(pending.timer)
        pendingDraftsRef.current.delete(key)
      }

      persistDraft(scopeViewerKey, postId, value)
      if (currentPostIdRef.current === postId) setDraftRaw(value)
    },
    [pendingKey]
  )

  const clearDraft = useCallback(
    (postId: string) => {
      saveDraft(postId, '')
    },
    [saveDraft]
  )

  useEffect(() => {
    if (initialPostId && currentPostIdRef.current !== initialPostId) {
      restoreDraft(initialPostId)
    }
  }, [initialPostId, restoreDraft])

  useEffect(() => {
    if (currentViewerKeyRef.current === viewerKey) return
    const previousViewerKey = currentViewerKeyRef.current
    const postId = currentPostIdRef.current
    if (postId) flushDraft(postId, previousViewerKey)
    currentViewerKeyRef.current = viewerKey
    setDraftRaw(postId ? readDraft(viewerKey, postId) : '')
  }, [flushDraft, viewerKey])

  useEffect(() => flushAllDrafts, [flushAllDrafts])

  return {
    draft,
    setDraft,
    restoreDraft,
    saveDraft,
    clearDraft,
    flushDraft,
  }
}
