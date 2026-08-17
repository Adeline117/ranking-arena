import { isAvatarProxyBypassPath, shouldSkip } from '@/proxy'

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

describe('avatar proxy compatibility bypass paths', () => {
  it.each(['/api/avatar', '/api/v1/avatar'])('hands %s directly to its route', (pathname) => {
    expect(isAvatarProxyBypassPath(pathname)).toBe(true)
    expect(shouldSkip(pathname)).toBe(true)
  })

  it.each(['/api/avatar-metadata', '/api/avatar/metadata', '/api/v1/avatar-metadata'])(
    'does not bypass proxy work for adjacent non-avatar route %s',
    (pathname) => {
      expect(isAvatarProxyBypassPath(pathname)).toBe(false)
      expect(shouldSkip(pathname)).toBe(false)
    }
  )
})
