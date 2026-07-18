#!/usr/bin/env node

/**
 * Attest that both inputs used by gen-types point at Ranking Arena production:
 *   - DATABASE_URL is structurally bound to the fixed Supabase project ref.
 *   - REST OpenAPI answers for that same project and reports a supported
 *     PostgREST version.
 *
 * Credentials are read only from the process environment. In particular, the
 * service-role key is never accepted as a command-line argument or included in
 * an error message.
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const PRODUCTION_PROJECT_REF = 'iknktzifjdyujdccyhsv'
export const SUPPORTED_POSTGREST_MAJORS = new Set(['13', '14'])

function sanitizedError(message) {
  return new Error(`production type source attestation failed: ${message}`)
}

function decodedUsername(url) {
  try {
    return decodeURIComponent(url.username)
  } catch {
    throw sanitizedError('DATABASE_URL has an invalid username encoding')
  }
}

export function validateDatabaseUrl(databaseUrl, expectedProjectRef = PRODUCTION_PROJECT_REF) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw sanitizedError('DATABASE_URL is required')
  }

  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw sanitizedError('DATABASE_URL is not a valid URL')
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw sanitizedError('DATABASE_URL must use postgres or postgresql')
  }

  const hostnameLabels = parsed.hostname.toLowerCase().split('.')
  const hostname = parsed.hostname.toLowerCase()
  const username = decodedUsername(parsed).toLowerCase()
  const projectRef = expectedProjectRef.toLowerCase()
  const hostIsBound =
    hostnameLabels.includes(projectRef) && hostname === `db.${projectRef}.supabase.co`
  const usernameIsBound =
    hostname.endsWith('.pooler.supabase.com') &&
    (username === projectRef || username.endsWith(`.${projectRef}`))

  if (!hostIsBound && !usernameIsBound) {
    throw sanitizedError('DATABASE_URL host or username is not bound to the production project')
  }

  return parsed
}

function validateSupabaseUrl(rawUrl, expectedProjectRef) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw sanitizedError('SUPABASE_URL is required')
  }

  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw sanitizedError('SUPABASE_URL is not a valid URL')
  }

  if (parsed.protocol !== 'https:') {
    throw sanitizedError('SUPABASE_URL must use https')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw sanitizedError('SUPABASE_URL must not contain credentials, query, or fragment')
  }
  if (parsed.hostname.toLowerCase() !== `${expectedProjectRef}.supabase.co`) {
    throw sanitizedError('SUPABASE_URL host does not match the production project')
  }

  return new URL('/rest/v1/', parsed)
}

export function validatePostgrestVersion(rawVersion) {
  if (
    typeof rawVersion !== 'string' ||
    !/^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?$/.test(rawVersion)
  ) {
    throw sanitizedError('REST OpenAPI info.version is missing or malformed')
  }

  const major = rawVersion.split('.', 1)[0]
  if (!SUPPORTED_POSTGREST_MAJORS.has(major)) {
    throw sanitizedError(`PostgREST major ${major} is not supported`)
  }

  return rawVersion
}

export async function attestProductionTypesSource({
  env = process.env,
  fetchImpl = globalThis.fetch,
  expectedProjectRef = PRODUCTION_PROJECT_REF,
} = {}) {
  validateDatabaseUrl(env.DATABASE_URL, expectedProjectRef)

  const apiKey =
    (typeof env.SUPABASE_SECRET_KEY === 'string' &&
      env.SUPABASE_SECRET_KEY.length > 0 &&
      env.SUPABASE_SECRET_KEY) ||
    (typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string' &&
      env.SUPABASE_SERVICE_ROLE_KEY.length > 0 &&
      env.SUPABASE_SERVICE_ROLE_KEY)
  if (!apiKey) {
    throw sanitizedError('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required')
  }
  if (typeof fetchImpl !== 'function') {
    throw sanitizedError('fetch is unavailable')
  }

  const restUrl = validateSupabaseUrl(env.SUPABASE_URL, expectedProjectRef)
  let response
  try {
    response = await fetchImpl(restUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/openapi+json',
        'Accept-Profile': 'public',
        apikey: apiKey,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw sanitizedError('REST OpenAPI request failed')
  }

  if (!response || typeof response.status !== 'number' || response.status !== 200 || !response.ok) {
    const status =
      response && Number.isInteger(response.status)
        ? `HTTP ${response.status}`
        : 'invalid HTTP response'
    throw sanitizedError(`REST OpenAPI returned ${status}`)
  }

  const actualProjectRef = response.headers?.get?.('sb-project-ref')
  if (actualProjectRef !== expectedProjectRef) {
    throw sanitizedError('REST OpenAPI project ref does not match production')
  }
  const contentType = response.headers?.get?.('content-type')
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/openapi+json') {
    throw sanitizedError('REST response content-type is not OpenAPI JSON')
  }
  if (response.headers?.get?.('content-profile') !== 'public') {
    throw sanitizedError('REST response content-profile is not public')
  }

  let document
  try {
    document = await response.json()
  } catch {
    throw sanitizedError('REST OpenAPI returned invalid JSON')
  }
  if (document?.swagger !== '2.0') {
    throw sanitizedError('REST document is not Swagger 2.0')
  }

  return {
    projectRef: actualProjectRef,
    postgrestVersion: validatePostgrestVersion(document?.info?.version),
  }
}

async function runCli() {
  const attestation = await attestProductionTypesSource()
  process.stdout.write(`${attestation.postgrestVersion}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runCli()
  } catch (error) {
    console.error(
      `[production-types-attestation] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
