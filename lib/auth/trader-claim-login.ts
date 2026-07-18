export type TraderClaimIdentity = {
  traderId: string
  source: string
  handle?: string | null
}

function requiredIdentityPart(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`Trader claim login requires ${label}`)
  }
  return normalized
}

/**
 * Canonical claim destination for one exact exchange account.
 *
 * `source` and `trader` are both required: a display handle alone is not a
 * claim identity and can collide across exchanges.
 */
export function buildTraderClaimReturnPath(identity: TraderClaimIdentity): string {
  const traderId = requiredIdentityPart(identity.traderId, 'traderId')
  const source = requiredIdentityPart(identity.source, 'source')
  const handle = identity.handle?.trim() || traderId
  const params = new URLSearchParams({
    trader: traderId,
    source,
    handle,
    step: 'verify',
  })
  return `/claim?${params.toString()}`
}

export function buildTraderClaimLoginHref(identity: TraderClaimIdentity): string {
  return `/login?returnUrl=${encodeURIComponent(buildTraderClaimReturnPath(identity))}`
}
