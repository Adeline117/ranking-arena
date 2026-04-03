'use client'

/**
 * OnChainBadge — placeholder for future on-chain attestation feature.
 *
 * Will show "On-chain Verified" badge when trader_attestations table
 * is created and EAS integration is live. Currently returns null.
 */

interface OnChainBadgeProps {
  traderHandle: string
  size?: 'sm' | 'md' | 'lg'
}

export function OnChainBadge(_props: OnChainBadgeProps) {
  // trader_attestations table not yet created — feature pending
  return null
}
