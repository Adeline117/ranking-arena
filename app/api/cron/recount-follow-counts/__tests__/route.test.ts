import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFollowRecountAcknowledgement } from '../acknowledgement'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/recount-follow-counts/route.ts'),
  'utf8'
)

describe('follow-count recount cron contract', () => {
  it('bounds the mutation and rejects missing or malformed acknowledgements', () => {
    expect(route).toContain('const workSignal = AbortSignal.timeout(45_000)')
    expect(route).toContain('.abortSignal(workSignal)')
    expect(route).toContain('parseFollowRecountAcknowledgement(data)')
    expect(route).toContain('{ safetyTimeoutMs: 55_000 }')
  })

  it.each([0, 12, Number.MAX_SAFE_INTEGER])('accepts exact numeric count %s', (updatedCount) => {
    expect(parseFollowRecountAcknowledgement([{ updated_count: updatedCount }])).toBe(updatedCount)
  })

  it.each([
    null,
    [],
    [{ updated_count: null }],
    [{ updated_count: '12' }],
    [{ updated_count: false }],
    [{ updated_count: '' }],
    [{ updated_count: -1 }],
    [{ updated_count: 1.5 }],
    [{ updated_count: 1, extra: true }],
  ])('rejects malformed acknowledgement %#', (value) => {
    expect(() => parseFollowRecountAcknowledgement(value)).toThrow(
      'Follow-count recount returned an invalid acknowledgement'
    )
  })
})
