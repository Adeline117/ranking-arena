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

const mockQuery = jest.fn()

jest.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import {
  V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
  V1_CRON_EXECUTION_NO_STORE_HEADERS,
} from '@/lib/cron/v1-execution-publication'
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

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

function handlerSource(name: 'POST' | 'GET'): string {
  const start = routeSource.indexOf(
    name === 'GET' ? 'export async function GET' : `export function ${name}`
  )
  const next = name === 'POST' ? routeSource.indexOf('export async function GET', start) : -1
  return routeSource.slice(start, next === -1 ? undefined : next)
}

describe('health heartbeat V1 write containment', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'health-heartbeat-v1-test-secret'
    mockQuery.mockReset()
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
      expect(mockQuery).not.toHaveBeenCalled()
    }
  )

  it('returns no-store 410 for an authenticated heartbeat write without parsing or writing', async () => {
    const response = POST(requestWithSecret('POST', 'health-heartbeat-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('keeps the authenticated GET history reader outside the POST hold', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          platform: 'worker',
          source_host: 'historical-host',
          status: 'ok',
          trader_count: 4,
          error_message: null,
          created_at: '2026-08-17T00:00:00.000Z',
          hours_since: '1.5',
        },
      ],
    })

    const response = await GET(requestWithSecret('GET', 'health-heartbeat-v1-test-secret'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      platforms: [
        expect.objectContaining({
          platform: 'worker',
          is_stale: false,
          is_critical: false,
        }),
      ],
    })
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM platform_heartbeats'), [])
  })

  it('keeps GET authentication at the route even when its versioned alias bypasses proxy work', async () => {
    const response = await GET(requestWithSecret('GET'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('has no body parsing or database write path in POST while retaining GET history reads', () => {
    const post = handlerSource('POST')
    const get = handlerSource('GET')

    expect(post).toContain('v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()')
    expect(post).not.toMatch(/request\.(?:json|text|formData|arrayBuffer)\b/)
    expect(post).not.toMatch(/\bgetDb\b|\b(?:INSERT|UPDATE|UPSERT)\b/i)
    expect(get).toContain('verifyCronSecret(request)')
    expect(get).toContain('FROM platform_heartbeats')
    expect(get).not.toContain('v1CronExecutionGate')
  })
})
