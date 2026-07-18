import { environmentManager, QueryClient } from '@tanstack/react-query'
import { logger } from '@/lib/logger'

/**
 * React Query client factory — mirrors SWRConfig defaults.
 *
 * Mapping from SWR → React Query:
 *   revalidateOnFocus: false       → refetchOnWindowFocus: false
 *   revalidateOnReconnect: true    → refetchOnReconnect: true
 *   dedupingInterval: 5000         → staleTime: 5_000
 *   errorRetryCount: 2             → retry: 2  (with smart filter)
 *   errorRetryInterval: 3000       → retryDelay: exponential backoff (base 1s)
 *   keepPreviousData: true         → placeholderData: keepPreviousData (per-query)
 *   loadingTimeout: 3000           → (no direct equivalent — handled at fetcher level)
 *   shouldRetryOnError: (fn)       → retry: (failureCount, error) => ...
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        staleTime: 5_000, // SWR dedupingInterval: 5000
        gcTime: 2 * 60 * 1000, // 2 min — prevents OOM on low-memory devices after visiting many traders
        retry: (failureCount, error) => {
          if (failureCount >= 2) return false // SWR errorRetryCount: 2
          const status = (error as { status?: number })?.status
          // 429 = rate limited — NEVER retry. Retrying amplifies the problem:
          // each retry also counts against the limit, creating a cascade where
          // N widgets × 3 retries = 3N extra 429s. The server's Retry-After
          // header tells the client when to try again, but React Query's retry
          // fires much sooner, guaranteeing another 429.
          if (status === 429) return false
          if (status && status >= 400 && status < 500) return false // 4xx — don't retry
          return true // network errors + 5xx
        },
        retryDelay: (attempt) => Math.min(1_000 * Math.pow(2, attempt), 30_000), // SWR errorRetryInterval: 3000 → exponential
      },
      mutations: {
        retry: false,
      },
    },
  })
}

let browserQueryClient: QueryClient | undefined

/**
 * Return an SSR-safe QueryClient.
 *
 * Client Components also execute during the server render. A module-level
 * QueryClient therefore shares cached query state across requests and can make
 * the server render data that a fresh browser cache does not have. TanStack's
 * App Router pattern is a new client per server render and a singleton only in
 * the browser (where it must survive Suspense retries).
 */
export function getQueryClient(): QueryClient {
  if (environmentManager.isServer()) {
    const client = createQueryClient()
    setupQueryErrorLogging(client)
    return client
  }

  if (!browserQueryClient) {
    browserQueryClient = createQueryClient()
    setupQueryErrorLogging(browserQueryClient)
  }
  return browserQueryClient
}

/**
 * Global error handler for React Query — mirrors SWRConfig.onError.
 * Call this once during app initialization to set up the global error handler.
 */
export function setupQueryErrorLogging(client: QueryClient) {
  const cache = client.getQueryCache()
  cache.config.onError = (error, query) => {
    const status =
      (error as { status?: number })?.status ??
      (error as { response?: { status?: number } })?.response?.status
    // Don't report 4xx client errors
    if (status && status >= 400 && status < 500) return

    if (process.env.NODE_ENV === 'production') {
      logger.error('React Query Error:', {
        key: query.queryKey,
        error,
      })

      import('@sentry/nextjs')
        .then((Sentry) => {
          Sentry.captureException(error, {
            tags: {
              source: 'react-query',
              query_key: JSON.stringify(query.queryKey),
            },
            level: 'warning',
          })
        })
        .catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget
    }
  }
}
