'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef } from 'react'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import { useAchievements } from '@/lib/hooks/useAchievements'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import { authedFetch } from '@/lib/api/client'
import { isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'

interface WatchlistItem {
  source: string
  source_trader_id: string
  handle: string | null
  created_at: string
}

type WatchlistPayload = { watchlist?: unknown }

type WatchlistViewer = ViewerScope & {
  accessToken: string
  userId: string
  viewerKey: `user:${string}`
}

type WatchlistQueryKey = readonly ['watchlist', `user:${string}`, number]

const WATCHLIST_API = '/api/watchlist'
const watchlistWriteTails = new Map<string, Promise<void>>()

export class WatchlistViewerChangedError extends Error {
  constructor() {
    super('watchlist viewer changed')
    this.name = 'WatchlistViewerChangedError'
  }
}

export function isWatchlistViewerChangedError(error: unknown): boolean {
  return error instanceof WatchlistViewerChangedError
}

function captureWatchlistViewer(auth: AuthSessionReturn): WatchlistViewer | null {
  const expectedViewerKey = auth.userId ? (`user:${auth.userId}` as const) : null
  if (
    !auth.authChecked ||
    auth.loading ||
    !auth.isLoggedIn ||
    !auth.userId ||
    !auth.accessToken ||
    auth.viewerKey !== expectedViewerKey
  ) {
    return null
  }
  return {
    accessToken: auth.accessToken,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
    viewerKey: expectedViewerKey,
  }
}

function watchlistQueryKey(viewer: WatchlistViewer): WatchlistQueryKey {
  return ['watchlist', viewer.viewerKey, viewer.sessionGeneration]
}

function watchlistWriteKey(viewer: WatchlistViewer): string {
  return `${viewer.viewerKey}\u0000${viewer.sessionGeneration}`
}

async function serializeWatchlistWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = watchlistWriteTails.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  watchlistWriteTails.set(key, tail)
  try {
    return await result
  } finally {
    if (watchlistWriteTails.get(key) === tail) watchlistWriteTails.delete(key)
  }
}

function watchlistViewerIsCurrent(viewer: WatchlistViewer, auth: AuthSessionReturn): boolean {
  return (
    auth.authChecked &&
    !auth.loading &&
    auth.isLoggedIn &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration &&
    isViewerScopeCurrent(viewer)
  )
}

function isWatchlistItem(value: unknown): value is WatchlistItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.source === 'string' &&
    item.source.length > 0 &&
    typeof item.source_trader_id === 'string' &&
    item.source_trader_id.length > 0 &&
    (item.handle === null || typeof item.handle === 'string') &&
    typeof item.created_at === 'string'
  )
}

function readWatchlist(payload: WatchlistPayload | null): WatchlistItem[] | null {
  if (!Array.isArray(payload?.watchlist)) return null
  if (!payload.watchlist.every(isWatchlistItem)) return null
  return payload.watchlist
}

function watchlistRequestError(action: string, status: number): Error & { status: number } {
  return Object.assign(new Error(`watchlist ${action}: ${status}`), { status })
}

export function useWatchlist() {
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const { tryUnlock } = useAchievements()
  const queryClient = useQueryClient()
  const viewer = captureWatchlistViewer(auth)
  const hasViewer = Boolean(viewer)
  const queryKey = useMemo(
    () => (viewer ? watchlistQueryKey(viewer) : null),
    // Access-token rotation does not change ownership of this resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth.sessionGeneration, auth.userId, auth.viewerKey, hasViewer]
  )

  const query = useQuery<WatchlistItem[]>({
    queryKey: queryKey ?? ['watchlist', 'inactive', auth.viewerKey, auth.sessionGeneration],
    queryFn: async ({ signal }) => {
      const operationViewer = viewer
      if (!operationViewer) return []
      const result = await authedFetch<WatchlistPayload>(
        WATCHLIST_API,
        'GET',
        operationViewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: operationViewer.userId,
          expectedSessionGeneration: operationViewer.sessionGeneration,
          signal,
        }
      )
      if (result.stale || !watchlistViewerIsCurrent(operationViewer, authRef.current)) {
        throw new WatchlistViewerChangedError()
      }
      if (!result.ok) throw watchlistRequestError('list', result.status)
      const list = readWatchlist(result.data)
      if (!list) throw watchlistRequestError('list', 502)
      return list
    },
    enabled: Boolean(viewer && queryKey),
    refetchOnWindowFocus: false,
    staleTime: STALE_STANDARD,
  })

  // A new query key exposes no placeholder from the previous principal. This
  // is intentional: an empty star is safer than rendering A's private state to B.
  const watchlist = useMemo(() => (viewer ? query.data || [] : []), [query.data, viewer])
  const watchlistSet = useMemo(
    () => new Set(watchlist.map((item) => `${item.source}:${item.source_trader_id}`)),
    [watchlist]
  )

  const isWatched = useCallback(
    (source: string, sourceTraderID: string) => watchlistSet.has(`${source}:${sourceTraderID}`),
    [watchlistSet]
  )

  const persist = useCallback(
    async (method: 'POST' | 'DELETE', source: string, sourceTraderID: string, handle?: string) => {
      const operationViewer = captureWatchlistViewer(authRef.current)
      if (!operationViewer) throw watchlistRequestError(method === 'POST' ? 'add' : 'remove', 401)
      const operationKey = watchlistQueryKey(operationViewer)
      return serializeWatchlistWrite(watchlistWriteKey(operationViewer), async () => {
        try {
          if (!watchlistViewerIsCurrent(operationViewer, authRef.current)) {
            throw new WatchlistViewerChangedError()
          }
          // An older GET must not resolve after this mutation and overwrite the
          // server-authoritative response. The queryFn consumes its AbortSignal.
          await queryClient.cancelQueries({ queryKey: operationKey, exact: true })
          if (!watchlistViewerIsCurrent(operationViewer, authRef.current)) {
            throw new WatchlistViewerChangedError()
          }
          const result = await authedFetch<WatchlistPayload>(
            WATCHLIST_API,
            method,
            operationViewer.accessToken,
            {
              source,
              source_trader_id: sourceTraderID,
              ...(method === 'POST' && handle ? { handle } : {}),
            },
            15_000,
            {
              expectedUserId: operationViewer.userId,
              expectedSessionGeneration: operationViewer.sessionGeneration,
            }
          )
          if (result.stale || !watchlistViewerIsCurrent(operationViewer, authRef.current)) {
            throw new WatchlistViewerChangedError()
          }
          if (!result.ok) {
            throw watchlistRequestError(method === 'POST' ? 'add' : 'remove', result.status)
          }
          const updated = readWatchlist(result.data)
          if (!updated) {
            throw watchlistRequestError(method === 'POST' ? 'add' : 'remove', 502)
          }
          // A reconnect/refetch may have started while the write was in flight.
          // Cancel it before publishing. Writes for this viewer are serialized,
          // so sibling response snapshots cannot land out of order either.
          await queryClient.cancelQueries({ queryKey: operationKey, exact: true })
          if (!watchlistViewerIsCurrent(operationViewer, authRef.current)) {
            throw new WatchlistViewerChangedError()
          }
          queryClient.setQueryData<WatchlistItem[]>(operationKey, updated)
          if (method === 'POST') tryUnlock('first_watchlist')
        } catch (error) {
          if (
            !isWatchlistViewerChangedError(error) &&
            watchlistViewerIsCurrent(operationViewer, authRef.current)
          ) {
            // The write may have failed after the initial read was cancelled,
            // or a malformed 2xx may mean the DB changed without a usable
            // response. Reconcile before releasing the per-viewer write queue
            // so a recovery read cannot overwrite a later queued write.
            try {
              // With no cached data, TanStack may join an already-running
              // pre-write fetch instead of starting a post-write read. Cancel
              // that fetch explicitly before reconciliation.
              await queryClient.cancelQueries({ queryKey: operationKey, exact: true })
              if (watchlistViewerIsCurrent(operationViewer, authRef.current)) {
                await queryClient.refetchQueries({ queryKey: operationKey, exact: true })
              }
            } catch {
              // The query owns and exposes its recovery error. Preserve the
              // original mutation status so callers can still handle 401, etc.
            }
          }
          throw error
        }
      })
    },
    [queryClient, tryUnlock]
  )

  const addToWatchlist = useCallback(
    (source: string, sourceTraderID: string, handle?: string) =>
      persist('POST', source, sourceTraderID, handle),
    [persist]
  )

  const removeFromWatchlist = useCallback(
    (source: string, sourceTraderID: string) => persist('DELETE', source, sourceTraderID),
    [persist]
  )

  return {
    watchlist,
    isWatched,
    addToWatchlist,
    removeFromWatchlist,
    isLoading: Boolean(viewer) && (query.isLoading || query.isFetching),
    error: viewer ? query.error : null,
    refetch: query.refetch,
  }
}
