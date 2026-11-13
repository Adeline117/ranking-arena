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
const source = readFileSync(join(process.cwd(), 'app/api/cron/retry-dead-letters/route.ts'), 'utf8')

describe('retired retry-dead-letters', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: 'test-secret' }
  })
  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('rejects unauthenticated requests', async () => {
    const res = await GET(new NextRequest('http://localhost/api/cron/retry-dead-letters'))
    expect(res.status).toBe(401)
  })

  it('answers 410 instead of discarding gaps and reporting success', async () => {
    for (const handler of [GET, POST]) {
      const res = await handler(
        new NextRequest('http://localhost/api/cron/retry-dead-letters', {
          headers: { authorization: 'Bearer test-secret' },
        })
      )
      expect(res.status).toBe(410)
    }
  })

  it('no longer reads or rewrites PipelineState keys', () => {
    expect(source).not.toContain('@/lib/services/pipeline-state')
    expect(source).not.toMatch(/withCron\(/)
  })
})
