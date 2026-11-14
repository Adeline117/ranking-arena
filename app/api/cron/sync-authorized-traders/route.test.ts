import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('GET /api/cron/sync-authorized-traders V1 compatibility contract', () => {
  it('remains an authenticated no-op with no queue or authorization scan', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/cron/sync-authorized-traders/route.ts'),
      'utf8'
    )

    expect(source).toMatch(/withCron\(\s*'sync-authorized-traders'/)
    expect(source).toContain('disabled: true')
    expect(source).toContain('queued: 0')
    expect(source).not.toMatch(/enqueueFirstPartySync|trader_authorizations|\.from\(|\.rpc\(/)
  })
})
