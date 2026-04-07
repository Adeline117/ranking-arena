'use client'

/**
 * Reusable draft auto-save hook (extracted from usePostForm).
 * Saves draft to localStorage with debounce, restores on mount.
 * Pattern from Discourse: auto-save every N seconds, restore with prompt.
 */

import { useState, useEffect, useCallback, useRef } from 'react'

interface DraftData {
  [key: string]: unknown
  _savedAt?: number
}

interface UseDraftAutoSaveOptions<T extends DraftData> {
  /** Unique key for this draft (e.g., 'post_new_handle', 'post_edit_123') */
  key: string
  /** Current form data to save */
  data: T
  /** Whether the draft has meaningful content worth saving */
  hasContent: boolean
  /** Debounce interval in ms (default: 5000) */
  debounceMs?: number
  /** Whether auto-save is enabled (default: true) */
  enabled?: boolean
}

interface UseDraftAutoSaveReturn<T extends DraftData> {
  /** True briefly after each save (for UI indicator) */
  draftSaved: boolean
  /** Whether a draft exists in localStorage */
  hasDraft: boolean
  /** Load the saved draft */
  loadDraft: () => T | null
  /** Clear the saved draft */
  clearDraft: () => void
  /** The loaded draft data (set on mount if draft exists) */
  restoredDraft: T | null
}

export function useDraftAutoSave<T extends DraftData>({
  key,
  data,
  hasContent,
  debounceMs = 5000,
  enabled = true,
}: UseDraftAutoSaveOptions<T>): UseDraftAutoSaveReturn<T> {
  const [draftSaved, setDraftSaved] = useState(false)
  const [hasDraft, setHasDraft] = useState(false)
  const [restoredDraft, setRestoredDraft] = useState<T | null>(null)
  const mountedRef = useRef(false)

  // Check for existing draft on mount
  useEffect(() => {
    if (typeof window === 'undefined' || !enabled || mountedRef.current) return
    mountedRef.current = true
    try {
      const saved = localStorage.getItem(key)
      if (saved) {
        setHasDraft(true)
        setRestoredDraft(JSON.parse(saved) as T)
      }
    } catch { /* localStorage unavailable */ }
  }, [key, enabled])

  // Auto-save with debounce
  useEffect(() => {
    if (typeof window === 'undefined' || !enabled) return

    const timer = setTimeout(() => {
      if (hasContent) {
        try {
          localStorage.setItem(key, JSON.stringify({ ...data, _savedAt: Date.now() }))
          setHasDraft(true)
          setDraftSaved(true)
          setTimeout(() => setDraftSaved(false), 2000)
        } catch { /* quota exceeded or unavailable */ }
      }
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [key, data, hasContent, debounceMs, enabled])

  const loadDraft = useCallback((): T | null => {
    if (typeof window === 'undefined') return null
    try {
      const saved = localStorage.getItem(key)
      return saved ? JSON.parse(saved) as T : null
    } catch { return null }
  }, [key])

  const clearDraft = useCallback(() => {
    if (typeof window === 'undefined') return
    try {
      localStorage.removeItem(key)
      setHasDraft(false)
      setRestoredDraft(null)
    } catch { /* ignore */ }
  }, [key])

  return { draftSaved, hasDraft, loadDraft, clearDraft, restoredDraft }
}
