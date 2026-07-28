import type { VerifiedTraderProfileData } from '@/app/components/trader/VerifiedTraderEditor'

export interface ExactTraderClaimData {
  trader_id: string
  source: string
  is_verified: boolean
  owner_id?: string | null
  profile?: VerifiedTraderProfileData
}

interface TraderClaimSourcesInput {
  traderId: string
  source: string
  bundledClaim?: ExactTraderClaimData | null
  bundledIsPlaceholder: boolean
  exactClaim?: ExactTraderClaimData | null
  requireExactAuthorization: boolean
}

export interface TraderClaimSources {
  /** Safe for public verified-badge rendering. */
  publicClaimSource: ExactTraderClaimData | null
  /** Safe for owner-only controls and editable profile data. */
  authorizationClaimSource: ExactTraderClaimData | null
}

function claimMatchesIdentity(
  claim: ExactTraderClaimData | null | undefined,
  traderId: string,
  source: string
): claim is ExactTraderClaimData {
  return claim?.trader_id === traderId && claim.source === source
}

export function resolveTraderClaimSources({
  traderId,
  source,
  bundledClaim,
  bundledIsPlaceholder,
  exactClaim,
  requireExactAuthorization,
}: TraderClaimSourcesInput): TraderClaimSources {
  const exactBundledClaim =
    !bundledIsPlaceholder && claimMatchesIdentity(bundledClaim, traderId, source)
      ? bundledClaim
      : null
  const exactProbeClaim = claimMatchesIdentity(exactClaim, traderId, source) ? exactClaim : null
  const publicClaimSource = exactProbeClaim ?? exactBundledClaim

  return {
    publicClaimSource,
    // Signed-in users may see a cached public badge, but owner authorization
    // and editor data must wait for the exact, no-store status probe.
    authorizationClaimSource: requireExactAuthorization ? exactProbeClaim : publicClaimSource,
  }
}
