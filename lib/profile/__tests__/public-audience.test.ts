import {
  isPublicProfileActive,
  PublicProfileAudienceReadError,
  readPublicProfileAudienceByHandle,
  type PublicProfileAudienceRow,
} from '../public-audience'

const NOW = Date.parse('2026-07-16T00:00:00.000Z')

function profile(overrides: Partial<PublicProfileAudienceRow> = {}): PublicProfileAudienceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    handle: 'alice',
    deleted_at: null,
    banned_at: null,
    is_banned: false,
    ban_expires_at: null,
    ...overrides,
  }
}

function clientResult(data: unknown, error: unknown = null) {
  const limit = jest.fn().mockResolvedValue({ data, error })
  const ilike = jest.fn().mockReturnValue({ limit })
  const select = jest.fn().mockReturnValue({ ilike })
  const from = jest.fn().mockReturnValue({ select })
  return { client: { from }, from, select, ilike, limit }
}

describe('public profile audience', () => {
  it('allows a current active profile', () => {
    expect(isPublicProfileActive(profile(), NOW)).toBe(true)
  })

  it.each([
    ['deleted account', { deleted_at: '2026-07-15T00:00:00.000Z' }],
    ['administratively banned account', { banned_at: '2026-07-15T00:00:00.000Z' }],
    ['permanent flag ban', { is_banned: true }],
    ['unexpired flag ban', { is_banned: true, ban_expires_at: '2026-07-17T00:00:00.000Z' }],
  ])('denies a %s', (_label, overrides) => {
    expect(isPublicProfileActive(profile(overrides), NOW)).toBe(false)
  })

  it('allows an expired flag ban only when no persistent ban marker exists', () => {
    expect(
      isPublicProfileActive(
        profile({ is_banned: true, ban_expires_at: '2026-07-15T00:00:00.000Z' }),
        NOW
      )
    ).toBe(true)
    expect(
      isPublicProfileActive(
        profile({
          banned_at: '2026-07-01T00:00:00.000Z',
          is_banned: true,
          ban_expires_at: '2026-07-15T00:00:00.000Z',
        }),
        NOW
      )
    ).toBe(false)
  })

  it('returns active, inactive, and missing outcomes without collapsing them', async () => {
    const active = clientResult([profile()])
    await expect(
      readPublicProfileAudienceByHandle(active.client as never, 'alice', NOW)
    ).resolves.toEqual({ status: 'active', profile: profile() })
    expect(active.ilike).toHaveBeenCalledWith('handle', 'alice')
    expect(active.limit).toHaveBeenCalledWith(2)

    const inactiveProfile = profile({ deleted_at: '2026-07-15T00:00:00.000Z' })
    const inactive = clientResult([inactiveProfile])
    await expect(
      readPublicProfileAudienceByHandle(inactive.client as never, 'alice', NOW)
    ).resolves.toEqual({ status: 'inactive', profile: inactiveProfile })

    const missing = clientResult([])
    await expect(
      readPublicProfileAudienceByHandle(missing.client as never, 'alice', NOW)
    ).resolves.toEqual({ status: 'missing', profile: null })
  })

  it('escapes an underscore as a literal in the exact case-insensitive lookup', async () => {
    const result = clientResult([profile({ handle: 'alice_dev' })])

    await expect(
      readPublicProfileAudienceByHandle(result.client as never, 'alice_dev', NOW)
    ).resolves.toMatchObject({ status: 'active' })
    expect(result.ilike).toHaveBeenCalledWith('handle', 'alice\\_dev')
  })

  it('does not normalize an invalid URL handle into a different account', async () => {
    const result = clientResult([profile({ handle: 'alice' })])

    await expect(
      readPublicProfileAudienceByHandle(result.client as never, 'ali,ce', NOW)
    ).resolves.toEqual({ status: 'missing', profile: null })
    expect(result.from).not.toHaveBeenCalled()
  })

  it.each([
    ['query error', clientResult(null, new Error('db unavailable')).client],
    ['invalid result', clientResult(null).client],
    ['duplicate handles', clientResult([profile(), profile({ id: 'two' })]).client],
    ['malformed state', clientResult([profile({ is_banned: 'yes' as never })]).client],
  ])('fails closed for %s', async (_label, client) => {
    await expect(
      readPublicProfileAudienceByHandle(client as never, 'alice', NOW)
    ).rejects.toBeInstanceOf(PublicProfileAudienceReadError)
  })

  it('fails closed when the client throws', async () => {
    const client = {
      from: jest.fn(() => {
        throw new Error('offline')
      }),
    }
    await expect(
      readPublicProfileAudienceByHandle(client as never, 'alice', NOW)
    ).rejects.toBeInstanceOf(PublicProfileAudienceReadError)
  })
})
