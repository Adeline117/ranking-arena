import { shouldSkip } from '@/proxy'

describe('cron proxy bypass paths', () => {
  it.each(['/api/cron/backfill-avatars', '/api/v1/cron/backfill-avatars'])(
    'bypasses proxy work for %s',
    (pathname) => {
      expect(shouldSkip(pathname)).toBe(true)
    }
  )

  it.each([
    '/api/cronical/backfill-avatars',
    '/api/v1/cronical/backfill-avatars',
    '/api/v1/cron-backfill-avatars',
  ])('does not bypass proxy work for adjacent non-cron path %s', (pathname) => {
    expect(shouldSkip(pathname)).toBe(false)
  })
})
