/** @jest-environment node */
jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get: (_target, key) => (key === 'CRON_SECRET' ? process.env.CRON_SECRET : undefined),
    }
  ),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

const ORIGINAL_ENV = process.env
const source = readFileSync(join(process.cwd(), 'app/api/cron/ensure-partitions/route.ts'), 'utf8')

describe('retired /api/cron/ensure-partitions', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: 'test-secret' }
  })
  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('rejects unauthenticated requests', async () => {
    expect((await GET(new NextRequest('http://localhost/api/cron/ensure-partitions'))).status).toBe(
      401
    )
  })

  it('answers 410 and points at the worker housekeeping implementation', async () => {
    for (const handler of [GET, POST]) {
      const res = await handler(
        new NextRequest('http://localhost/api/cron/ensure-partitions', {
          headers: { authorization: 'Bearer test-secret' },
        })
      )
      expect(res.status).toBe(410)
      expect((await res.json()).replacement).toContain('ensurePartitions()')
    }
  })

  it('no longer calls the trader_snapshots_v2 partition function', () => {
    expect(source).not.toMatch(/rpc\(\s*'ensure_future_partitions'/)
    expect(source).not.toMatch(/withCron\(/)
  })
})
