import { authedFetch, type AuthedFetchScope, type ScopedFetchResult } from '@/lib/api/client'

type OAuthAuthorizeResponse = {
  success?: unknown
  error?: unknown
  data?: {
    viewerId?: unknown
    exchange?: unknown
    authUrl?: unknown
  }
}

export type OAuthViewerRequest = {
  accessToken: string
  sessionGeneration: number
  userId: string
}

type OAuthFetch = (
  input: string,
  method: 'GET',
  accessToken: string,
  body: undefined,
  timeoutMs: number,
  scope: AuthedFetchScope
) => Promise<ScopedFetchResult<OAuthAuthorizeResponse>>

function isSecureOAuthUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export async function requestExchangeOAuthUrl(
  exchange: string,
  viewer: OAuthViewerRequest,
  signal?: AbortSignal,
  fetcher: OAuthFetch = authedFetch
): Promise<string> {
  const result = await fetcher(
    `/api/exchange/oauth/authorize?${new URLSearchParams({ exchange }).toString()}`,
    'GET',
    viewer.accessToken,
    undefined,
    15_000,
    {
      expectedUserId: viewer.userId,
      expectedSessionGeneration: viewer.sessionGeneration,
      signal,
    }
  )

  if (result.stale) throw new Error('Authenticated viewer changed')
  const payload = result.data
  if (!result.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Failed to get OAuth URL')
  }

  const acknowledgement = payload?.data
  if (
    payload?.success !== true ||
    acknowledgement?.viewerId !== viewer.userId ||
    acknowledgement.exchange !== exchange ||
    typeof acknowledgement.authUrl !== 'string' ||
    !isSecureOAuthUrl(acknowledgement.authUrl)
  ) {
    throw new Error('OAuth authorize response identity mismatch')
  }

  return acknowledgement.authUrl
}

const OAUTH_CALLBACK_EXCHANGES = new Set(['binance', 'bybit'])

export function resolveOAuthCallbackExchange(
  exchangeParam: string | null,
  state: string
): string | null {
  const normalizedParam = exchangeParam?.trim().toLowerCase() || null
  const delimiter = state.indexOf('.')
  const stateExchange =
    delimiter > 0 && OAUTH_CALLBACK_EXCHANGES.has(state.slice(0, delimiter).toLowerCase())
      ? state.slice(0, delimiter).toLowerCase()
      : null

  if (normalizedParam) {
    if (!OAUTH_CALLBACK_EXCHANGES.has(normalizedParam)) return null
    if (stateExchange && stateExchange !== normalizedParam) return null
    return normalizedParam
  }

  return stateExchange
}
