type OAuthAuthorizeResponse = {
  authUrl?: unknown
  error?: unknown
}

type OAuthFetch = (
  input: string,
  init: { headers: { Authorization: string } }
) => Promise<Pick<Response, 'json' | 'ok'>>

interface OAuthSession {
  access_token: string
  user: { id: string }
}

type OAuthSessionReader = () => Promise<{
  data: { session: OAuthSession | null }
  error: unknown
}>

export async function readCurrentOAuthAccessToken(
  getSession: OAuthSessionReader,
  expectedUserId: string
): Promise<string> {
  const { data, error } = await getSession()
  if (error) {
    throw error instanceof Error ? error : new Error('Failed to read the current session')
  }
  if (
    typeof data.session?.access_token !== 'string' ||
    data.session.access_token.length === 0 ||
    data.session.user.id !== expectedUserId
  ) {
    throw new Error('Authenticated viewer changed')
  }
  return data.session.access_token
}

export async function requestExchangeOAuthUrl(
  exchange: string,
  accessToken: string,
  fetcher: OAuthFetch = fetch
): Promise<string> {
  const response = await fetcher(
    `/api/exchange/oauth/authorize?${new URLSearchParams({ exchange }).toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  )
  const payload = (await response.json().catch(() => null)) as OAuthAuthorizeResponse | null
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Failed to get OAuth URL')
  }
  if (typeof payload?.authUrl !== 'string' || payload.authUrl.length === 0) {
    throw new Error('OAuth authorize response is missing authUrl')
  }
  return payload.authUrl
}
