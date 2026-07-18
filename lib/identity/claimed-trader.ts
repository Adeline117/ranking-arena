import type { SupabaseClient } from '@supabase/supabase-js'

export interface TraderAccountIdentity {
  source: string
  traderId: string
}

export interface ClaimedTraderIdentity extends TraderAccountIdentity {
  userHandle: string
}

/**
 * Resolve a claimed account by its full exchange identity.
 *
 * Raw trader IDs and display handles are not globally unique. The lookup must
 * therefore start from (source, traderId), and ambiguous ownership rows fail
 * closed instead of picking whichever row Postgres happens to return first.
 */
export async function findClaimedUserHandleByIdentity(
  supabase: SupabaseClient,
  identity: TraderAccountIdentity
): Promise<string | null> {
  const { data: verifiedTraders, error: verifiedTraderError } = await supabase
    .from('verified_traders')
    .select('user_id')
    .eq('source', identity.source)
    .eq('trader_id', identity.traderId)
    .limit(2)

  if (verifiedTraderError || verifiedTraders?.length !== 1) return null

  const userId = verifiedTraders[0]?.user_id
  if (typeof userId !== 'string' || !userId) return null

  const { data: profiles, error: profileError } = await supabase
    .from('user_profiles')
    .select('handle')
    .eq('id', userId)
    .limit(2)

  if (profileError || profiles?.length !== 1) return null

  const handle = profiles[0]?.handle
  return typeof handle === 'string' && handle ? handle : null
}

export interface ClaimedTraderRedirectInput {
  claimedIdentity: ClaimedTraderIdentity | null | undefined
  visibleIdentity: TraderAccountIdentity
  requestedPlatform: string | null
  /**
   * True only after an explicit platform variant has been resolved and the
   * visible identity came from that validated response.
   */
  requestedPlatformValidated: boolean
}

/**
 * Decide whether the browser can safely canonicalize /trader/... to /u/....
 *
 * The ISR server component cannot observe ?platform= because one cached HTML
 * document serves every query variant. The browser may redirect only when the
 * account on screen is the exact claimed account and any differing explicit
 * platform has already been validated client-side.
 */
export function claimedTraderCanonicalHref({
  claimedIdentity,
  visibleIdentity,
  requestedPlatform,
  requestedPlatformValidated,
}: ClaimedTraderRedirectInput): string | null {
  if (!claimedIdentity) return null
  if (
    claimedIdentity.source !== visibleIdentity.source ||
    claimedIdentity.traderId !== visibleIdentity.traderId
  ) {
    return null
  }

  if (
    requestedPlatform &&
    requestedPlatform !== claimedIdentity.source &&
    !requestedPlatformValidated
  ) {
    return null
  }

  return `/u/${encodeURIComponent(claimedIdentity.userHandle)}`
}
