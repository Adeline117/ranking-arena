const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// These endpoints use POST only because their bounded lookup keys live in the
// request body. They do not mutate product data and are required to render the
// leaderboard's rank/equity series during a read-only sweep.
const APP_READ_ONLY_POST_PATHS = new Set([
  '/api/posts/bookmarks/status',
  '/api/profile/handle-availability',
  '/api/rankings/rank-history',
  '/api/traders/sparklines',
])

// QA interactions must not contaminate production analytics, but aborting
// these requests emits ERR_BLOCKED_BY_CLIENT and creates a fake UI failure.
// Fulfil them locally with the same success class instead.
const APP_TELEMETRY_STUBS = new Map([
  [
    '/api/analytics/events',
    {
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { accepted: true } }),
    },
  ],
  ['/cdn-cgi/rum', { status: 204, body: '' }],
])
const SUPABASE_MUTATION_PATHS = [
  '/auth/v1/',
  '/functions/v1/',
  '/graphql/v1',
  '/realtime/v1/',
  '/rest/v1/',
  '/storage/v1/',
]

function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isSupabaseApi(target, configuredSupabaseUrl) {
  const configured = configuredSupabaseUrl ? parseUrl(configuredSupabaseUrl) : null
  return (
    target.hostname.endsWith('.supabase.co') ||
    (configured !== null && target.origin === configured.origin)
  )
}

function isRefreshTokenRequest(target) {
  return (
    target.pathname === '/auth/v1/token' &&
    target.searchParams.get('grant_type') === 'refresh_token'
  )
}

export function telemetryStubFor({ method, url, baseUrl }) {
  if (String(method).toUpperCase() !== 'POST') return null
  const target = parseUrl(url)
  const app = parseUrl(baseUrl)
  if (!target || !app || target.origin !== app.origin) return null
  return APP_TELEMETRY_STUBS.get(target.pathname) ?? null
}

export function readOnlyViolation({ method, url, baseUrl, supabaseUrl }) {
  const normalizedMethod = String(method).toUpperCase()
  if (READ_ONLY_METHODS.has(normalizedMethod)) return null

  const target = parseUrl(url)
  const app = parseUrl(baseUrl)
  if (!target || !app) return null

  if (target.origin === app.origin) {
    if (normalizedMethod === 'POST' && APP_READ_ONLY_POST_PATHS.has(target.pathname)) return null
    if (telemetryStubFor({ method: normalizedMethod, url, baseUrl })) return null
    return {
      method: normalizedMethod,
      scope: 'app',
      target: `${target.origin}${target.pathname}`,
    }
  }

  if (
    isSupabaseApi(target, supabaseUrl) &&
    SUPABASE_MUTATION_PATHS.some((prefix) => target.pathname.startsWith(prefix))
  ) {
    // A live QA session may refresh while a long sweep runs. This rotates only
    // the session token and is required to keep read-only auth coverage valid.
    if (isRefreshTokenRequest(target)) return null

    return {
      method: normalizedMethod,
      scope: 'supabase',
      target: `${target.origin}${target.pathname}`,
    }
  }

  return null
}

export async function installReadOnlyNetworkGuard(context, { baseUrl, supabaseUrl, onBlocked }) {
  await context.route('**/*', async (route) => {
    const request = route.request()
    const telemetryStub = telemetryStubFor({
      method: request.method(),
      url: request.url(),
      baseUrl,
    })
    if (telemetryStub) return route.fulfill(telemetryStub)

    const violation = readOnlyViolation({
      method: request.method(),
      url: request.url(),
      baseUrl,
      supabaseUrl,
    })

    if (!violation) return route.continue()
    onBlocked(violation)
    return route.abort('blockedbyclient')
  })
}
