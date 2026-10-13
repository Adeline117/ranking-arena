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

import { NextRequest } from 'next/server'
import {
  V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
  V1_CRON_EXECUTION_NO_STORE_HEADERS,
  V1_CRON_EXECUTION_PUBLISHED,
  v1CronExecutionGate,
} from './v1-execution-publication'

describe('V1 cron execution publication gate', () => {
  const originalSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'v1-cron-test-secret'
  })

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalSecret
  })

  it('is an immutable checked-in hold rather than an environment toggle', () => {
    expect(V1_CRON_EXECUTION_PUBLISHED).toBe(false)
  })

  it('returns no-store 401 before any execution for an unauthenticated request', async () => {
    const response = v1CronExecutionGate(
      new NextRequest('http://localhost/api/cron/compute-leaderboard')
    )

    expect(response).not.toBeNull()
    if (!response) throw new Error('expected V1 cron gate response')
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
      expect(response.headers.get(header)).toBe(value)
    }
  })

  it('returns no-store 410 after valid cron authentication without running work', async () => {
    const response = v1CronExecutionGate(
      new NextRequest('http://localhost/api/cron/compute-leaderboard', {
        headers: { authorization: 'Bearer v1-cron-test-secret' },
      })
    )

    expect(response).not.toBeNull()
    if (!response) throw new Error('expected V1 cron gate response')
    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
      expect(response.headers.get(header)).toBe(value)
    }
  })
})
