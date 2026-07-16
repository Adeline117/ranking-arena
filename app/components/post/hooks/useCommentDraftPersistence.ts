'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const COMMENT_DRAFT_DEBOUNCE_MS = 500

type PendingDraft = {
  timer: ReturnType<typeof setTimeout>
  value: string
}

export type CommentDraftSnapshot = {
  viewerKey: string
  postId: string
  version: number
  value: string
}

function getDraftKey(viewerKey: string, postId: string): string {
  return `comment-draft-v2:${viewerKey}:${postId}`
}

function getLegacyDraftKey(postId: string): string {
  return `comment-draft-${postId}`
}

function readDraft(viewerKey: string, postId: string): string {
  try {
    const scopedKey = getDraftKey(viewerKey, postId)
    const scopedDraft = localStorage.getItem(scopedKey)
    if (scopedDraft !== null) {
      localStorage.removeItem(getLegacyDraftKey(postId))
      return scopedDraft
    }
    // The v1 key had no owner. Defer migration while auth is unresolved, then
    // atomically assign it to the first resolved viewer and remove the source
    // so it can never be copied into another account.
    if (viewerKey === 'pending') return ''
    const legacyKey = getLegacyDraftKey(postId)
    const legacyDraft = localStorage.getItem(legacyKey) || ''
    if (legacyDraft) localStorage.setItem(scopedKey, legacyDraft)
    localStorage.removeItem(legacyKey)
    return legacyDraft
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
  const renderedPostIdRef = useRef<string | null>(initialPostId || null)
  const renderedViewerKeyRef = useRef(viewerKey)
  renderedPostIdRef.current = initialPostId || currentPostIdRef.current
  renderedViewerKeyRef.current = viewerKey
  const draftVersionRef = useRef(0)
  const pendingDraftsRef = useRef(new Map<string, PendingDraft>())
  const [draft, setDraftRaw] = useState(() =>
    initialPostId ? readDraft(viewerKey, initialPostId) : ''
  )
  const draftRef = useRef(draft)

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
      const renderedViewerKey = renderedViewerKeyRef.current
      const renderedPostId = renderedPostIdRef.current
      // A newly committed render can receive input before passive effects hand
      // ownership over. Bind that input to the rendered viewer/resource now,
      // flushing the previous owner's pending value first.
      if (
        currentViewerKeyRef.current !== renderedViewerKey ||
        currentPostIdRef.current !== renderedPostId
      ) {
        const previousViewerKey = currentViewerKeyRef.current
        const previousPostId = currentPostIdRef.current
        if (previousPostId) flushDraft(previousPostId, previousViewerKey)
        currentViewerKeyRef.current = renderedViewerKey
        currentPostIdRef.current = renderedPostId
      }

      draftVersionRef.current += 1
      draftRef.current = value
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
    [flushDraft, pendingKey]
  )

  const restoreDraft = useCallback(
    (postId: string) => {
      const previousPostId = currentPostIdRef.current
      if (previousPostId && previousPostId !== postId) {
        flushDraft(previousPostId)
      }

      currentPostIdRef.current = postId
      const restored = readDraft(currentViewerKeyRef.current, postId)
      draftVersionRef.current += 1
      draftRef.current = restored
      setDraftRaw(restored)
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
      if (currentPostIdRef.current === postId) {
        draftVersionRef.current += 1
        draftRef.current = value
        setDraftRaw(value)
      }
    },
    [pendingKey]
  )

  const clearDraft = useCallback(
    (postId: string) => {
      saveDraft(postId, '')
    },
    [saveDraft]
  )

  const captureDraftSnapshot = useCallback(
    (postId: string): CommentDraftSnapshot => ({
      viewerKey: currentViewerKeyRef.current,
      postId,
      version: draftVersionRef.current,
      value: draftRef.current,
    }),
    []
  )

  const clearDraftIfUnchanged = useCallback(
    (snapshot: CommentDraftSnapshot): boolean => {
      if (
        currentViewerKeyRef.current !== snapshot.viewerKey ||
        (currentPostIdRef.current !== null && currentPostIdRef.current !== snapshot.postId) ||
        draftVersionRef.current !== snapshot.version ||
        draftRef.current !== snapshot.value
      ) {
        return false
      }
      saveDraft(snapshot.postId, '')
      if (currentPostIdRef.current === null) {
        draftVersionRef.current += 1
        draftRef.current = ''
        setDraftRaw('')
      }
      return true
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
    const restored = postId ? readDraft(viewerKey, postId) : ''
    draftVersionRef.current += 1
    draftRef.current = restored
    setDraftRaw(restored)
  }, [flushDraft, viewerKey])

  useEffect(() => flushAllDrafts, [flushAllDrafts])

  return {
    // Effects perform persistence/cleanup, but ownership is enforced during
    // render so a previous viewer/post draft is never committed for one frame.
    draft:
      currentViewerKeyRef.current === viewerKey &&
      (!initialPostId || currentPostIdRef.current === initialPostId)
        ? draft
        : '',
    setDraft,
    restoreDraft,
    saveDraft,
    clearDraft,
    captureDraftSnapshot,
    clearDraftIfUnchanged,
    flushDraft,
  }
}
