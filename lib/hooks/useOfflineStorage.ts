'use client'

import { useCallback, useEffect, useState } from 'react'
import { drafts, cache, pendingActions, recentlyViewed, initOfflineStorage } from '../storage/indexedDB'

/**
 * Hook for managing draft posts/comments
 */
export function useDrafts() {
  const [allDrafts, setAllDrafts] = useState<Awaited<ReturnType<typeof drafts.getAll>>>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const items = await drafts.getAll()
      setAllDrafts(items)
    } catch {
      // IndexedDB not available
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const saveDraft = useCallback(async (
    id: string,
    type: 'post' | 'comment' | 'message',
    content: string,
    parentId?: string
  ) => {
    await drafts.save({ id, type, content, parentId })
    await refresh()
  }, [refresh])

  const deleteDraft = useCallback(async (id: string) => {
    await drafts.delete(id)
    await refresh()
  }, [refresh])

  const getDraft = useCallback(async (id: string) => {
    return drafts.get(id)
  }, [])

  return {
    drafts: allDrafts,
    loading,
    saveDraft,
    deleteDraft,
    getDraft,
    refresh,
  }
}

/**
 * Hook for caching data with TTL
 */
export function useOfflineCache<T>(key: string, ttlMs: number = 5 * 60 * 1000) {
  const [cachedData, setCachedData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    cache.get<T>(key).then(data => {
      setCachedData(data)
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  }, [key])

  const setCache = useCallback(async (data: T) => {
    await cache.set(key, data, ttlMs)
    setCachedData(data)
  }, [key, ttlMs])

  const clearCache = useCallback(async () => {
    await cache.delete(key)
    setCachedData(null)
  }, [key])

  return {
    data: cachedData,
    loading,
    setCache,
    clearCache,
  }
}

/**
 * Hook for managing pending offline actions
 */
export function usePendingActions() {
  const [actions, setActions] = useState<Awaited<ReturnType<typeof pendingActions.getAll>>>([])
  const [syncing, setSyncing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const items = await pendingActions.getAll()
      setActions(items)
    } catch {
      // IndexedDB not available
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const addAction = useCallback(async (
    type: 'like' | 'follow' | 'bookmark' | 'post' | 'comment',
    payload: unknown
  ) => {
    const id = await pendingActions.add({ type, payload })
    await refresh()
    return id
  }, [refresh])

  const removeAction = useCallback(async (id: string) => {
    await pendingActions.delete(id)
    await refresh()
  }, [refresh])

  const syncActions = useCallback(async (
    syncFn: (action: { type: string; payload: unknown }) => Promise<boolean>
  ) => {
    if (syncing || actions.length === 0) return

    setSyncing(true)
    const toProcess = [...actions]

    for (const action of toProcess) {
      try {
        const success = await syncFn(action)
        if (success) {
          await pendingActions.delete(action.id)
        } else if (action.retries < 3) {
          await pendingActions.incrementRetries(action.id)
        } else {
          // Too many retries, remove
          await pendingActions.delete(action.id)
        }
      } catch {
        if (action.retries < 3) {
          await pendingActions.incrementRetries(action.id)
        }
      }
    }

    await refresh()
    setSyncing(false)
  }, [actions, syncing, refresh])

  return {
    actions,
    syncing,
    addAction,
    removeAction,
    syncActions,
    refresh,
  }
}

/**
 * Hook for tracking recently viewed items
 */
export function useRecentlyViewed(type?: 'trader' | 'post' | 'group' | 'user') {
  const [items, setItems] = useState<Awaited<ReturnType<typeof recentlyViewed.getAll>>>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const all = type
        ? await recentlyViewed.getByType(type)
        : await recentlyViewed.getAll()
      setItems(all)
    } catch {
      // IndexedDB not available
    } finally {
      setLoading(false)
    }
  }, [type])

  useEffect(() => {
    refresh()
  }, [refresh])

  const addItem = useCallback(async (
    id: string,
    itemType: 'trader' | 'post' | 'group' | 'user',
    data: unknown
  ) => {
    await recentlyViewed.add({ id, type: itemType, data })
    if (!type || type === itemType) {
      await refresh()
    }
  }, [type, refresh])

  const clearHistory = useCallback(async () => {
    await recentlyViewed.clear()
    setItems([])
  }, [])

  return {
    items,
    loading,
    addItem,
    clearHistory,
    refresh,
  }
}

/**
 * Initialize offline storage on app load
 */
export function useInitOfflineStorage() {
  useEffect(() => {
    initOfflineStorage()
  }, [])
}
