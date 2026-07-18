#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000
export const DEFAULT_POLL_INTERVAL_MS = 15 * 1000
export const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000

const TRANSIENT_HTTP_STATUSES = new Set([404, 408, 409, 425, 429])
const TERMINAL_FAILURE_STATES = new Set(['ERROR', 'CANCELED'])

function boundedInteger(name, fallback, maximum) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`)
  }
  return value
}

function deploymentHost(deploymentUrl) {
  let parsed
  try {
    parsed = new URL(deploymentUrl)
  } catch {
    throw new Error('Vercel returned an invalid deployment URL')
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.vercel.app') ||
    parsed.hostname === 'vercel.app' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Vercel returned an invalid deployment URL')
  }
  return parsed.hostname
}

function deploymentId(payload) {
  const candidate = payload?.id ?? payload?.uid
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(candidate) ? candidate : ''
}

function deploymentState(payload) {
  const candidate = payload?.readyState
  return typeof candidate === 'string' && /^[A-Z_]{1,40}$/.test(candidate) ? candidate : 'UNKNOWN'
}

function apiUrl(apiBaseUrl, pathname, teamId) {
  const url = new URL(pathname, apiBaseUrl)
  url.searchParams.set('teamId', teamId)
  return url
}

function requestSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs)
}

async function getDeployment({ apiBaseUrl, host, teamId, token, requestTimeoutMs, fetchImpl }) {
  const url = apiUrl(apiBaseUrl, `/v13/deployments/${encodeURIComponent(host)}`, teamId)
  let response
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: requestSignal(requestTimeoutMs),
    })
  } catch (error) {
    return {
      kind: 'network',
      errorName: error instanceof Error ? error.name : 'Error',
    }
  }

  if (response.status !== 200) {
    return { kind: 'http', status: response.status }
  }

  try {
    const payload = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { kind: 'malformed' }
    }
    return {
      kind: 'deployment',
      id: deploymentId(payload),
      state: deploymentState(payload),
    }
  } catch {
    return { kind: 'malformed' }
  }
}

async function cancelDeployment({
  apiBaseUrl,
  id,
  teamId,
  token,
  requestTimeoutMs,
  fetchImpl,
  log,
  warn,
}) {
  if (!id) {
    warn('Vercel candidate timeout: deployment id unavailable; remote cancellation skipped')
    return
  }
  const url = apiUrl(apiBaseUrl, `/v12/deployments/${encodeURIComponent(id)}/cancel`, teamId)
  try {
    const response = await fetchImpl(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      signal: requestSignal(requestTimeoutMs),
    })
    if (response.ok) {
      log(`Vercel candidate timeout: cancellation accepted for ${id}`)
    } else {
      warn(`Vercel candidate timeout: cancellation returned HTTP ${response.status}`)
    }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Error'
    warn(`Vercel candidate timeout: cancellation request failed (${errorName})`)
  }
}

export async function waitForVercelDeployment({
  deploymentUrl,
  token,
  teamId,
  apiBaseUrl = 'https://api.vercel.com',
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  now = () => Date.now(),
  log = (message) => console.log(message),
  warn = (message) => console.warn(message),
}) {
  if (!token) throw new Error('VERCEL_TOKEN is required')
  if (!teamId) throw new Error('VERCEL_ORG_ID is required')
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive')
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('pollIntervalMs must be positive')
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('requestTimeoutMs must be positive')
  }

  const host = deploymentHost(deploymentUrl)
  const deadline = now() + timeoutMs
  let lastId = ''
  let lastState = 'UNKNOWN'

  while (true) {
    const result = await getDeployment({
      apiBaseUrl,
      host,
      teamId,
      token,
      requestTimeoutMs,
      fetchImpl,
    })

    if (result.kind === 'deployment') {
      lastId = result.id || lastId
      lastState = result.state
      log(`Vercel candidate state=${lastState} id=${lastId || 'unavailable'}`)
      if (lastState === 'READY') {
        return { id: lastId, state: lastState }
      }
      if (TERMINAL_FAILURE_STATES.has(lastState)) {
        throw new Error(`Vercel candidate reached terminal state ${lastState}`)
      }
    } else if (result.kind === 'malformed') {
      throw new Error('Vercel deployment status response was malformed')
    } else if (result.kind === 'http') {
      if (result.status === 401 || result.status === 403) {
        throw new Error(`Vercel deployment status authorization failed (HTTP ${result.status})`)
      }
      if (TRANSIENT_HTTP_STATUSES.has(result.status) || result.status >= 500) {
        warn(`Vercel deployment status is temporarily unavailable (HTTP ${result.status})`)
      } else {
        throw new Error(`Vercel deployment status failed (HTTP ${result.status})`)
      }
    } else {
      warn(`Vercel deployment status request failed (${result.errorName})`)
    }

    const remainingMs = deadline - now()
    if (remainingMs <= 0) break
    await sleep(Math.min(pollIntervalMs, remainingMs))
  }

  await cancelDeployment({
    apiBaseUrl,
    id: lastId,
    teamId,
    token,
    requestTimeoutMs,
    fetchImpl,
    log,
    warn,
  })
  throw new Error(
    `Vercel candidate did not reach READY within ${Math.ceil(timeoutMs / 60_000)} minutes (last state ${lastState})`
  )
}

async function main() {
  const deploymentUrl = process.argv[2]
  if (!deploymentUrl) throw new Error('Usage: wait-for-vercel-deployment.mjs <deployment-url>')
  const timeoutMs = boundedInteger(
    'VERCEL_DEPLOY_WAIT_TIMEOUT_MS',
    DEFAULT_WAIT_TIMEOUT_MS,
    DEFAULT_WAIT_TIMEOUT_MS
  )
  const pollIntervalMs = boundedInteger(
    'VERCEL_DEPLOY_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    60_000
  )
  const requestTimeoutMs = boundedInteger(
    'VERCEL_DEPLOY_REQUEST_TIMEOUT_MS',
    DEFAULT_REQUEST_TIMEOUT_MS,
    30_000
  )
  await waitForVercelDeployment({
    deploymentUrl,
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_ORG_ID,
    timeoutMs,
    pollIntervalMs,
    requestTimeoutMs,
  })
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown Vercel wait failure'
    console.error(message)
    process.exitCode = 1
  })
}
