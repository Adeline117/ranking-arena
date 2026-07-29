#!/usr/bin/env node

/**
 * Deployment-only environment gate for ranking reads that combine a Supabase
 * receipt proof with a direct PostgreSQL page read.
 *
 * This performs no network access. It fails closed unless every configured
 * database URL and the Supabase API URL are structurally bound to the one
 * Ranking Arena production project. Secrets and full URLs never enter output.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RANKING_PRIMARY_PROJECT_REF = 'iknktzifjdyujdccyhsv'
export const RANKING_PRIMARY_SUPABASE_ORIGIN = `https://${RANKING_PRIMARY_PROJECT_REF}.supabase.co`

const DATABASE_VARIABLES = ['DATABASE_POOLER_URL', 'DATABASE_URL']
const APPROVED_SSL_MODES = new Set(['require', 'verify-full'])

function gateError(message) {
  return new Error(`ranking primary authority environment gate failed: ${message}`)
}

function parseUrl(rawValue, variableName) {
  if (typeof rawValue !== 'string' || rawValue.length === 0 || rawValue !== rawValue.trim()) {
    throw gateError(`${variableName} is missing or malformed`)
  }

  try {
    return new URL(rawValue)
  } catch {
    throw gateError(`${variableName} is missing or malformed`)
  }
}

function decodeUrlPart(value, variableName) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw gateError(`${variableName} contains invalid URL encoding`)
  }
}

export function validateRankingSupabaseUrl(
  rawValue,
  variableName,
  expectedProjectRef = RANKING_PRIMARY_PROJECT_REF
) {
  const parsed = parseUrl(rawValue, variableName)
  const expectedOrigin = `https://${expectedProjectRef}.supabase.co`

  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== expectedOrigin ||
    parsed.pathname !== '/' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw gateError(`${variableName} is not bound to the production Supabase project`)
  }

  return expectedProjectRef
}

export function validateRankingDatabaseUrl(
  rawValue,
  variableName,
  expectedProjectRef = RANKING_PRIMARY_PROJECT_REF
) {
  const parsed = parseUrl(rawValue, variableName)
  const hostname = parsed.hostname.toLowerCase()
  const username = decodeUrlPart(parsed.username, variableName).toLowerCase()
  const database = decodeUrlPart(parsed.pathname, variableName)
  const projectRef = expectedProjectRef.toLowerCase()
  const isDirect = hostname === `db.${projectRef}.supabase.co` && username === 'postgres'
  const isPooler =
    /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname) && username === `postgres.${projectRef}`
  const sslModes = parsed.searchParams.getAll('sslmode')
  const hasOnlyApprovedParameters = [...parsed.searchParams.keys()].every(
    (parameter) => parameter === 'sslmode'
  )
  const hasApprovedTls =
    sslModes.length <= 1 && (sslModes.length === 0 || APPROVED_SSL_MODES.has(sslModes[0]))

  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !parsed.password ||
    database !== '/postgres' ||
    parsed.hash ||
    !hasOnlyApprovedParameters ||
    !hasApprovedTls ||
    (isDirect && parsed.port !== '5432') ||
    (isPooler && !['5432', '6543'].includes(parsed.port)) ||
    (!isDirect && !isPooler)
  ) {
    throw gateError(`${variableName} is not bound to the production Supabase project`)
  }

  return { endpoint: isDirect ? 'direct' : 'pooler', projectRef }
}

export function checkRankingPrimaryAuthorityEnvironment({
  env = process.env,
  expectedProjectRef = RANKING_PRIMARY_PROJECT_REF,
} = {}) {
  validateRankingSupabaseUrl(
    env.NEXT_PUBLIC_SUPABASE_URL,
    'NEXT_PUBLIC_SUPABASE_URL',
    expectedProjectRef
  )
  if (env.SUPABASE_URL) {
    validateRankingSupabaseUrl(env.SUPABASE_URL, 'SUPABASE_URL', expectedProjectRef)
  }

  const configuredDatabaseVariables = DATABASE_VARIABLES.filter((variableName) => env[variableName])
  if (configuredDatabaseVariables.length === 0) {
    throw gateError('DATABASE_POOLER_URL or DATABASE_URL is required')
  }

  const databaseEndpoints = Object.fromEntries(
    configuredDatabaseVariables.map((variableName) => [
      variableName,
      validateRankingDatabaseUrl(env[variableName], variableName, expectedProjectRef).endpoint,
    ])
  )
  const effectiveDatabaseVariable = env.DATABASE_POOLER_URL ? 'DATABASE_POOLER_URL' : 'DATABASE_URL'

  return {
    checkedDatabaseVariables: configuredDatabaseVariables,
    databaseEndpoints,
    effectiveDatabaseVariable,
    projectRef: expectedProjectRef,
  }
}

function runCli() {
  const result = checkRankingPrimaryAuthorityEnvironment()
  process.stdout.write(
    `ranking primary authority environment gate passed ` +
      `(project ${result.projectRef}; runtime ${result.effectiveDatabaseVariable}; ` +
      `checked ${result.checkedDatabaseVariables.join(', ')})\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli()
  } catch (error) {
    console.error(
      `[ranking-primary-authority] ${error instanceof Error ? error.message : 'unknown failure'}`
    )
    process.exitCode = 1
  }
}
