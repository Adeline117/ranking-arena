import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('claimed trader routing contract', () => {
  const page = source('app/(app)/trader/[handle]/page.tsx')
  const client = source('app/(app)/trader/[handle]/TraderProfileClient.tsx')
  const overview = source('app/components/trader/tabs/OverviewTab.tsx')
  const claimProfileRoute = source('app/api/traders/claim/profile/route.ts')
  const claimStatusRoute = source('app/api/traders/claim/status/route.ts')
  const traderDetailRoute = source('app/api/traders/[handle]/route.ts')
  const verifiedProfileRoute = source('app/api/traders/verified/route.ts')

  it('never resolves claim ownership from a source-blind URL handle', () => {
    expect(page).not.toContain('cachedFindUserHandleByTrader(decodedHandle)')
    expect(page).toContain(
      'cachedFindUserHandleByTrader(servingResolved.source, servingResolved.exchangeTraderId)'
    )
    expect(page).toContain('cachedFindUserHandleByTrader(resolved.platform, resolved.traderKey)')
  })

  it('injects the exact claimed trader profile into the partial editor', () => {
    expect(client).toContain('claim_status?: ExactTraderClaimData')
    expect(client).toContain('verifiedTraderProfile={authorizationClaimSource?.profile ?? null}')
    expect(client).toContain('isFetchedAfterMount: claimDataFetchedAfterMount')
    expect(client).toContain('claimDataFetchedAfterMount && !claimDataError')
    expect(client).toContain('staleTime: 0')
    expect(client).toContain('retry: false')
    expect(client).toContain('exactClaim: freshExactClaim')
    expect(overview).toContain('verifiedTraderProfile: VerifiedTraderProfileData | null')
    expect(overview).toContain('isVerifiedClaimOwner && verifiedTraderProfile')
    expect(overview).toContain('currentData={verifiedTraderProfile}')
    expect(overview).not.toContain('currentData={{}}')

    for (const exactProfileRead of [claimStatusRoute, traderDetailRoute]) {
      expect(exactProfileRead).toContain(".eq('trader_id', traderId)")
      expect(exactProfileRead).toContain(".eq('source', source)")
      expect(exactProfileRead).toContain('trader_id: traderId')
      expect(exactProfileRead).toContain('source,')
      expect(exactProfileRead).toContain('display_name: verified.display_name')
      expect(exactProfileRead).toContain('bio: verified.bio')
      expect(exactProfileRead).toContain('profile_version: verified.profile_version')
    }
    expect(claimStatusRoute).toContain("response.headers.set('Cache-Control', 'private, no-store")
  })

  it('does not issue an ISR server redirect that can discard an explicit platform variant', () => {
    expect(page).not.toMatch(/\bredirect\s*\(/)
    expect(client).toContain('claimedTraderCanonicalHref({')
    expect(client).toContain('requestedPlatformValidated: Boolean(override)')
  })

  it('wires the claimed user identity into serving profile social actions and ownership', () => {
    expect(client).toContain('const { userId: currentUserId } = useAuthSession()')
    expect(client).toContain('registeredUserId={claimedUser?.id}')
    expect(client).toContain('resolveTraderProfileOwnership({')
    expect(client).toContain('claimedUserId: claimedUser?.id')
    expect(client).toContain('isVerifiedClaim: !!authorizationClaimSource?.is_verified')
    expect(client).toContain('claimOwnerId: authorizationClaimSource?.owner_id')
    expect(client).toContain('isOwnProfile={isProfilePageOwner}')
    expect(client).toContain('isVerifiedClaimOwner={isVerifiedClaimOwner}')
    expect(overview).toContain('isVerifiedClaimOwner: boolean')
    expect(overview).toContain('{isVerifiedClaimOwner && verifiedTraderProfile ? (')
    expect(overview).not.toContain('{isOwner ? (')
    for (const profileWriteRoute of [claimProfileRoute, verifiedProfileRoute]) {
      expect(profileWriteRoute).not.toContain('getUserVerifiedTrader(supabase, user.id)')
      expect(profileWriteRoute).toContain('{ trader_id: traderId, source }')
      expect(profileWriteRoute).toContain('You do not own this verified trader profile')
    }
  })

  it('uses the trader detail platform parameter after a claim and from a bot owner link', () => {
    const claimPage = source('app/(app)/claim/page.tsx')
    const botHeader = source('app/components/trader/serving/BotHeaderCard.tsx')

    expect(claimPage).toMatch(
      /\/trader\/\$\{encodeURIComponent\(selectedTrader\.source_trader_id\)\}\?platform=\$\{encodeURIComponent\(selectedTrader\.source\)\}/
    )
    expect(claimPage).not.toMatch(
      /\/trader\/\$\{encodeURIComponent\(selectedTrader\.(?:handle|source_trader_id)\)\}\?source=/
    )

    expect(botHeader).toMatch(/\?platform=\$\{encodeURIComponent\(bot\.ownerPlatform\)\}/)
    expect(botHeader).not.toMatch(/\?source=\$\{encodeURIComponent\(bot\.ownerPlatform\)\}/)
  })
})
