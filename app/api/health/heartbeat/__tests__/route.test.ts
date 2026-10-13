/**
 * @jest-environment node
 */

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get: (_target, key) => process.env[String(key)],
    }
  ),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import {
  V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
  V1_CRON_EXECUTION_NO_STORE_HEADERS,
} from '@/lib/cron/v1-execution-publication'
import {
  V1_HEARTBEAT_HISTORY_NOT_PUBLISHED_CODE,
  V1_HEARTBEAT_HISTORY_NO_STORE_HEADERS,
  V1_HEARTBEAT_HISTORY_PUBLISHED,
} from '@/lib/monitoring/v1-heartbeat-history-publication'
import { GET, POST } from '../route'

const originalCronSecret = process.env.CRON_SECRET
const routeSource = readFileSync(join(process.cwd(), 'app/api/health/heartbeat/route.ts'), 'utf8')

function requestWithSecret(method: 'GET' | 'POST', secret?: string): NextRequest {
  return new NextRequest('http://localhost/api/health/heartbeat?ignored=true', {
    method,
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
    body: method === 'POST' ? '{not-valid-json' : undefined,
  })
}

function expectNoStore(
  response: Response,
  headers: Record<string, string> = V1_CRON_EXECUTION_NO_STORE_HEADERS
): void {
  for (const [header, value] of Object.entries(headers)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

function handlerSource(name: 'POST' | 'GET'): string {
  const start = routeSource.indexOf(`export function ${name}`)
  const next = name === 'POST' ? routeSource.indexOf('export function GET', start) : -1
  return routeSource.slice(start, next === -1 ? undefined : next)
}

describe('health heartbeat V1 ingress containment', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'health-heartbeat-v1-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([undefined, 'wrong-health-heartbeat-secret'])(
    'returns no-store 401 before parsing a heartbeat body for secret %s',
    async (secret) => {
      const response = POST(requestWithSecret('POST', secret))

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expectNoStore(response)
    }
  )

  it('returns no-store 410 for an authenticated heartbeat write without parsing or writing', async () => {
    const response = POST(requestWithSecret('POST', 'health-heartbeat-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })

  it('keeps heartbeat history unavailable behind the fixed checked-in publication hold', async () => {
    expect(V1_HEARTBEAT_HISTORY_PUBLISHED).toBe(false)

    const response = GET(requestWithSecret('GET', 'health-heartbeat-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Heartbeat history is temporarily unavailable during V1 verification.',
      code: V1_HEARTBEAT_HISTORY_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response, V1_HEARTBEAT_HISTORY_NO_STORE_HEADERS)
  })

  it('authenticates GET before returning the heartbeat-history hold', async () => {
    const response = GET(requestWithSecret('GET'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expectNoStore(response, V1_HEARTBEAT_HISTORY_NO_STORE_HEADERS)
  })

  it('keeps both ingress surfaces free of request parsing and history dependencies', () => {
    const post = handlerSource('POST')
    const get = handlerSource('GET')

    expect(post).toContain('v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()')
    expect(post).not.toMatch(/request\.(?:json|text|formData|arrayBuffer)\b/)
    expect(post).not.toMatch(/\bgetDb\b|\b(?:INSERT|UPDATE|UPSERT)\b/i)
    expect(get).toContain(
      'v1HeartbeatHistoryGate(request) ?? v1HeartbeatHistoryUnavailableResponse()'
    )
    expect(get).not.toMatch(
      /request\.(?:nextUrl|url|json|text|formData|arrayBuffer)\b|\b(?:getDb|query)\b|platform_heartbeats|@\/lib\/db|\bError\b/
    )
    expect(get).not.toContain('v1CronExecutionGate')
  })
})
