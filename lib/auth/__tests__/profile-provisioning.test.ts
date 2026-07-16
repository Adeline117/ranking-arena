import { requireProvisionedProfile } from '../profile-provisioning'

describe('provisioned profile guard', () => {
  it('returns an existing trigger-provisioned profile', () => {
    const profile = { handle: 'alice', avatar_url: null }
    expect(requireProvisionedProfile(profile, null)).toBe(profile)
  })

  it('fails closed on lookup errors or missing rows', () => {
    expect(() => requireProvisionedProfile(null, new Error('db unavailable'))).toThrow(
      'db unavailable'
    )
    expect(() => requireProvisionedProfile(null, null)).toThrow(
      'Profile provisioning is incomplete'
    )
  })
})
