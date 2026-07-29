import { isProfileBanned, isProfileSuspended } from './profile-suspension'

const NOW = Date.parse('2026-07-29T12:00:00.000Z')

describe('profile suspension state', () => {
  it.each([
    ['modern ban', { banned_at: '2026-07-01T00:00:00.000Z' }],
    ['legacy permanent ban', { is_banned: true, ban_expires_at: null }],
    ['legacy temporary ban', { is_banned: true, ban_expires_at: '2026-07-30T00:00:00.000Z' }],
    ['malformed legacy expiry', { is_banned: true, ban_expires_at: 'invalid' }],
  ])('recognizes %s', (_label, profile) => {
    expect(isProfileBanned(profile, NOW)).toBe(true)
  })

  it.each([
    ['clear profile', { banned_at: null, is_banned: false, ban_expires_at: null }],
    ['expired legacy ban', { is_banned: true, ban_expires_at: '2026-07-28T00:00:00.000Z' }],
  ])('keeps %s active', (_label, profile) => {
    expect(isProfileBanned(profile, NOW)).toBe(false)
  })

  it('keeps deletion separate from effective ban status', () => {
    const deleted = {
      deleted_at: '2026-07-29T00:00:00.000Z',
      banned_at: null,
      is_banned: false,
    }

    expect(isProfileBanned(deleted, NOW)).toBe(false)
    expect(isProfileSuspended(deleted, NOW)).toBe(true)
  })
})
