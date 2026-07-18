#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const DEFAULT_API_BASE_URL = 'https://api.vercel.com'
const DEFAULT_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required to enforce the single production writer`)
  }
  return value.trim()
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function safeApiMessage(payload, status) {
  const candidate = payload?.error?.message ?? payload?.message
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return `Vercel API returned HTTP ${status}`
  }
  return candidate.replace(/[\r\n]+/g, ' ').slice(0, 300)
}

function assertProjectState(payload, projectId, phase) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${phase} returned a non-object project response`)
  }
  if (payload.id !== projectId) {
    throw new Error(`${phase} returned a different Vercel project`)
  }
  if (payload.autoAssignCustomDomains !== false) {
    throw new Error(`${phase} left Git auto-assignment enabled`)
  }
}

async function readJsonResponse(response) {
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`Vercel API returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(safeApiMessage(payload, response.status))
  return payload
}

async function requestProject({ url, token, method, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'PATCH' ? JSON.stringify({ autoAssignCustomDomains: false }) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  return readJsonResponse(response)
}

export async function enforceVercelReleaseControl({
  token,
  orgId,
  projectId,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const resolvedToken = required(token, 'VERCEL_TOKEN')
  const resolvedOrgId = required(orgId, 'VERCEL_ORG_ID')
  const resolvedProjectId = required(projectId, 'VERCEL_PROJECT_ID')
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')

  const resolvedAttempts = positiveInteger(attempts, DEFAULT_ATTEMPTS, 'attempts')
  const resolvedRequestTimeoutMs = positiveInteger(
    requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs'
  )
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a non-negative integer')
  }

  const url = new URL(
    `/v9/projects/${encodeURIComponent(resolvedProjectId)}`,
    required(apiBaseUrl, 'VERCEL_API_BASE_URL')
  )
  url.searchParams.set('teamId', resolvedOrgId)

  let lastError
  for (let attempt = 1; attempt <= resolvedAttempts; attempt += 1) {
    try {
      const patched = await requestProject({
        url,
        token: resolvedToken,
        method: 'PATCH',
        timeoutMs: resolvedRequestTimeoutMs,
        fetchImpl,
      })
      assertProjectState(patched, resolvedProjectId, 'Vercel release-control PATCH')

      const verified = await requestProject({
        url,
        token: resolvedToken,
        method: 'GET',
        timeoutMs: resolvedRequestTimeoutMs,
        fetchImpl,
      })
      assertProjectState(verified, resolvedProjectId, 'Vercel release-control GET')

      logger.log('Vercel autoAssignCustomDomains=false; Deploy Gate is the sole production writer.')
      return verified
    } catch (error) {
      lastError = error
      if (attempt === resolvedAttempts) break
      logger.warn(`Vercel release-control attempt ${attempt}/${resolvedAttempts} failed; retrying.`)
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  }

  throw new Error(
    `Unable to enforce Vercel release control after ${resolvedAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  )
}

async function main() {
  await enforceVercelReleaseControl({
    token: process.env.VERCEL_TOKEN,
    orgId: process.env.VERCEL_ORG_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
    apiBaseUrl: process.env.VERCEL_API_BASE_URL,
    attempts: positiveInteger(
      process.env.VERCEL_RELEASE_CONTROL_ATTEMPTS,
      DEFAULT_ATTEMPTS,
      'VERCEL_RELEASE_CONTROL_ATTEMPTS'
    ),
    retryDelayMs:
      process.env.VERCEL_RELEASE_CONTROL_RETRY_DELAY_MS === undefined
        ? DEFAULT_RETRY_DELAY_MS
        : Number(process.env.VERCEL_RELEASE_CONTROL_RETRY_DELAY_MS),
    requestTimeoutMs: positiveInteger(
      process.env.VERCEL_RELEASE_CONTROL_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'VERCEL_RELEASE_CONTROL_TIMEOUT_MS'
    ),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
