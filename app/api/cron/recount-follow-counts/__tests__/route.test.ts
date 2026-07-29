import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/recount-follow-counts/route.ts'),
  'utf8'
)

describe('follow-count recount cron contract', () => {
  it('bounds the mutation and rejects missing or malformed acknowledgements', () => {
    expect(route).toContain('const workSignal = AbortSignal.timeout(45_000)')
    expect(route).toContain('.abortSignal(workSignal)')
    expect(route).toContain('!Array.isArray(data)')
    expect(route).toContain('data.length !== 1')
    expect(route).toContain('!Number.isSafeInteger(updatedCount)')
    expect(route).toContain('{ safetyTimeoutMs: 55_000 }')
  })
})
