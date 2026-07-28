import { resolveTraderProfileOwnership } from '../profile-ownership'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'

describe('trader profile ownership', () => {
  it('keeps a bound-but-unclaimed profile owner out of verified trader writes', () => {
    expect(
      resolveTraderProfileOwnership({
        currentUserId: USER_ID,
        claimedUserId: USER_ID,
        isVerifiedClaim: false,
        claimOwnerId: null,
      })
    ).toEqual({
      isProfileOwner: true,
      isVerifiedClaimOwner: false,
    })
  })

  it('preserves verified claim ownership for trader routes without a claimed profile overlay', () => {
    expect(
      resolveTraderProfileOwnership({
        currentUserId: USER_ID,
        claimedUserId: null,
        isVerifiedClaim: true,
        claimOwnerId: USER_ID,
      })
    ).toEqual({
      isProfileOwner: false,
      isVerifiedClaimOwner: true,
    })
  })

  it('does not trust an unverified claim owner id', () => {
    expect(
      resolveTraderProfileOwnership({
        currentUserId: USER_ID,
        claimedUserId: null,
        isVerifiedClaim: false,
        claimOwnerId: USER_ID,
      })
    ).toEqual({
      isProfileOwner: false,
      isVerifiedClaimOwner: false,
    })
  })

  it('does not grant ownership to another authenticated viewer', () => {
    expect(
      resolveTraderProfileOwnership({
        currentUserId: OTHER_USER_ID,
        claimedUserId: USER_ID,
        isVerifiedClaim: true,
        claimOwnerId: USER_ID,
      })
    ).toEqual({
      isProfileOwner: false,
      isVerifiedClaimOwner: false,
    })
  })
})
