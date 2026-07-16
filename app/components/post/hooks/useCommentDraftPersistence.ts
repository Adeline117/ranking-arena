'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const COMMENT_DRAFT_DEBOUNCE_MS = 500

type PendingDraft = {
  timer: ReturnType<typeof setTimeout>
  value: string
}

function getDraftKey(postId: string): string {
  return `comment-draft-${postId}`
}

function readDraft(postId: string): string {
  try {
    return localStorage.getItem(getDraftKey(postId)) || ''
  } catch {
    return ''
  }
}

function persistDraft(postId: string, value: string): void {
  try {
    if (value.trim()) {
      localStorage.setItem(getDraftKey(postId), value)
    } else {
      localStorage.removeItem(getDraftKey(postId))
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
export function useCommentDraftPersistence(initialPostId?: string | null) {
  const currentPostIdRef = useRef<string | null>(initialPostId || null)
  const pendingDraftsRef = useRef(new Map<string, PendingDraft>())
  const [draft, setDraftRaw] = useState(() => (initialPostId ? readDraft(initialPostId) : ''))

  const flushDraft = useCallback((postId: string) => {
    const pending = pendingDraftsRef.current.get(postId)
    if (!pending) return

    clearTimeout(pending.timer)
    pendingDraftsRef.current.delete(postId)
    persistDraft(postId, pending.value)
  }, [])

  const flushAllDrafts = useCallback(() => {
    for (const postId of [...pendingDraftsRef.current.keys()]) {
      flushDraft(postId)
    }
  }, [flushDraft])

  const setDraft = useCallback((value: string) => {
    setDraftRaw(value)

    const postId = currentPostIdRef.current
    if (!postId) return

    const existing = pendingDraftsRef.current.get(postId)
    if (existing) clearTimeout(existing.timer)

    const timer = setTimeout(() => {
      const pending = pendingDraftsRef.current.get(postId)
      if (!pending || pending.timer !== timer) return

      pendingDraftsRef.current.delete(postId)
      persistDraft(postId, pending.value)
    }, COMMENT_DRAFT_DEBOUNCE_MS)

    pendingDraftsRef.current.set(postId, { timer, value })
  }, [])

  const restoreDraft = useCallback(
    (postId: string) => {
      const previousPostId = currentPostIdRef.current
      if (previousPostId && previousPostId !== postId) {
        flushDraft(previousPostId)
      }

      currentPostIdRef.current = postId
      setDraftRaw(readDraft(postId))
    },
    [flushDraft]
  )

  const saveDraft = useCallback((postId: string, value: string) => {
    const pending = pendingDraftsRef.current.get(postId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingDraftsRef.current.delete(postId)
    }

    persistDraft(postId, value)
    if (currentPostIdRef.current === postId) setDraftRaw(value)
  }, [])

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
