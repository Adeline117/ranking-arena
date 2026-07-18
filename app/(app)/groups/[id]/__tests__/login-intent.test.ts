import { buildGroupLoginHref, buildGroupReturnPath } from '../login-intent'

describe('group login intent', () => {
  it('returns users to the exact group after login', () => {
    expect(buildGroupReturnPath('group-1')).toBe('/groups/group-1')
    expect(buildGroupLoginHref('group-1')).toBe('/login?returnUrl=%2Fgroups%2Fgroup-1')
  })

  it('preserves invite redemption without allowing it to escape the query value', () => {
    const returnPath = buildGroupReturnPath('group/2', 'invite&next=https://evil.test')

    expect(returnPath).toBe('/groups/group%2F2?invite=invite%26next%3Dhttps%3A%2F%2Fevil.test')
    expect(
      new URL(
        buildGroupLoginHref('group/2', 'invite&next=https://evil.test'),
        'https://arena.test'
      ).searchParams.get('returnUrl')
    ).toBe(returnPath)
  })

  it('falls back to the groups index before the route param resolves', () => {
    expect(buildGroupReturnPath('')).toBe('/groups')
    expect(buildGroupLoginHref('')).toBe('/login?returnUrl=%2Fgroups')
  })
})
