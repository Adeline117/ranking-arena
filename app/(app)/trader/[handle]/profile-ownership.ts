export function resolveTraderProfileOwnership({
  currentUserId,
  claimedUserId,
  isVerifiedClaim,
  claimOwnerId,
}: {
  currentUserId: string | null
  claimedUserId?: string | null
  isVerifiedClaim: boolean
  claimOwnerId?: string | null
}): {
  isProfileOwner: boolean
  isVerifiedClaimOwner: boolean
} {
  const isProfileOwner = !!currentUserId && currentUserId === claimedUserId
  const isVerifiedClaimOwner = !!currentUserId && isVerifiedClaim && currentUserId === claimOwnerId

  return { isProfileOwner, isVerifiedClaimOwner }
}
