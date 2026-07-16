const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
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

export function readOnlyViolation({ method, url, baseUrl, supabaseUrl }) {
  const normalizedMethod = String(method).toUpperCase()
  if (READ_ONLY_METHODS.has(normalizedMethod)) return null

  const target = parseUrl(url)
  const app = parseUrl(baseUrl)
  if (!target || !app) return null

  if (target.origin === app.origin) {
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
