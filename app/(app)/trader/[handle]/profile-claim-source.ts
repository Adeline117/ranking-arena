import type { VerifiedTraderProfileData } from '@/app/components/trader/VerifiedTraderEditor'

export interface ExactTraderClaimData {
  trader_id: string
  source: string
  is_verified: boolean
  owner_id?: string | null
  profile?: VerifiedTraderProfileData
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null
}

/** Runtime boundary for the no-store authorization probe. */
export function parseExactTraderClaimEnvelope(value: unknown): ExactTraderClaimData | null {
  const envelope = record(value)
  const data = record(envelope?.data)
  const traderId = exactString(data?.trader_id)
  const source = exactString(data?.source)
  if (envelope?.success !== true || !data || !traderId || !source) return null
  if (typeof data.is_verified !== 'boolean') return null
  if (data.owner_id !== undefined && data.owner_id !== null && !exactString(data.owner_id)) {
    return null
  }
  if (data.profile !== undefined && data.profile !== null && !record(data.profile)) return null

  return {
    trader_id: traderId,
    source,
    is_verified: data.is_verified,
    owner_id: data.owner_id as string | null | undefined,
    profile: (data.profile as VerifiedTraderProfileData | null | undefined) ?? undefined,
  }
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
