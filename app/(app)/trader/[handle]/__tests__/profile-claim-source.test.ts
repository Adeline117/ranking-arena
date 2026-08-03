import { resolveTraderProfileOwnership } from '../profile-ownership'
import {
  parseExactTraderClaimEnvelope,
  resolveTraderClaimSources,
  type ExactTraderClaimData,
} from '../profile-claim-source'

function verifiedClaim(
  traderId: string,
  source: string,
  ownerId: string,
  displayName: string
): ExactTraderClaimData {
  return {
    trader_id: traderId,
    source,
    is_verified: true,
    owner_id: ownerId,
    profile: { display_name: displayName, bio: `${displayName} bio`, profile_version: 4 },
  }
}

describe('exact trader claim source selection', () => {
  it('accepts only a successful, typed claim envelope at the authorization boundary', () => {
    const claim = verifiedClaim('account-99', 'bybit', 'owner-b', 'Fresh B')
    expect(parseExactTraderClaimEnvelope({ success: true, data: claim })).toEqual(claim)
    expect(parseExactTraderClaimEnvelope({ success: false, data: claim })).toBeNull()
    expect(
      parseExactTraderClaimEnvelope({
        success: true,
        data: { ...claim, is_verified: 'true' },
      })
    ).toBeNull()
    expect(
      parseExactTraderClaimEnvelope({
        success: true,
        data: { ...claim, owner_id: ' owner-b' },
      })
    ).toBeNull()
  })

  it('rejects the old A placeholder when visible identity has switched to B', () => {
    const sources = resolveTraderClaimSources({
      traderId: 'account-99',
      source: 'bybit',
      bundledClaim: verifiedClaim('account-42', 'binance_futures', 'owner-a', 'Account A'),
      bundledIsPlaceholder: true,
      exactClaim: null,
      requireExactAuthorization: true,
    })

    expect(sources.publicClaimSource).toBeNull()
    expect(sources.authorizationClaimSource).toBeNull()
  })

  it('keeps signed-in owner controls closed while the exact probe is pending', () => {
    const cachedBundle = verifiedClaim('account-99', 'bybit', 'owner-b', 'Cached B')
    const sources = resolveTraderClaimSources({
      traderId: 'account-99',
      source: 'bybit',
      bundledClaim: cachedBundle,
      bundledIsPlaceholder: false,
      exactClaim: null,
      requireExactAuthorization: true,
    })
    const ownership = resolveTraderProfileOwnership({
      currentUserId: 'owner-b',
      claimedUserId: null,
      isVerifiedClaim: !!sources.authorizationClaimSource?.is_verified,
      claimOwnerId: sources.authorizationClaimSource?.owner_id,
    })

    expect(sources.publicClaimSource).toBe(cachedBundle)
    expect(sources.authorizationClaimSource).toBeNull()
    expect(ownership.isVerifiedClaimOwner).toBe(false)
  })

  it('opens owner controls with only the fresh exact B profile after the probe resolves', () => {
    const freshClaim = verifiedClaim('account-99', 'bybit', 'owner-b', 'Fresh B')
    const sources = resolveTraderClaimSources({
      traderId: 'account-99',
      source: 'bybit',
      bundledClaim: verifiedClaim('account-99', 'bybit', 'owner-b', 'Cached B'),
      bundledIsPlaceholder: false,
      exactClaim: freshClaim,
      requireExactAuthorization: true,
    })
    const ownership = resolveTraderProfileOwnership({
      currentUserId: 'owner-b',
      claimedUserId: null,
      isVerifiedClaim: !!sources.authorizationClaimSource?.is_verified,
      claimOwnerId: sources.authorizationClaimSource?.owner_id,
    })

    expect(ownership.isVerifiedClaimOwner).toBe(true)
    expect(sources.authorizationClaimSource?.profile).toEqual(freshClaim.profile)
  })

  it('rejects a mismatched exact response for authorization', () => {
    const sources = resolveTraderClaimSources({
      traderId: 'account-99',
      source: 'bybit',
      bundledClaim: null,
      bundledIsPlaceholder: false,
      exactClaim: verifiedClaim('account-42', 'binance_futures', 'owner-a', 'Account A'),
      requireExactAuthorization: true,
    })

    expect(sources.publicClaimSource).toBeNull()
    expect(sources.authorizationClaimSource).toBeNull()
  })
})
