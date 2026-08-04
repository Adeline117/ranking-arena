const PRODUCTION_ORIGIN = /^https:\/\/(?:www\.)?arenafi\.org(?::\d+)?$/i

export function resolveLoadTestBaseUrl(environment = __ENV) {
  const rawBaseUrl = String(environment.BASE_URL || '').trim()
  if (!/^https?:\/\/[^/]+/i.test(rawBaseUrl)) {
    throw new Error('BASE_URL is required and must be an absolute HTTP(S) origin')
  }

  const baseUrl = rawBaseUrl.replace(/\/+$/, '')
  if (
    PRODUCTION_ORIGIN.test(baseUrl) &&
    environment.ALLOW_PRODUCTION_LOAD !== '1' &&
    environment.ALLOW_PRODUCTION_LOAD !== 'true'
  ) {
    throw new Error('Production load requires explicit ALLOW_PRODUCTION_LOAD=1 authorization')
  }

  return baseUrl
}
