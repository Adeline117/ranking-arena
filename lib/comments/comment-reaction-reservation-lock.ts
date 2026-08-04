type CommentReactionReservationScope = {
  actorId: string
  postId: string
  commentId: string
}

function reservationLockName(scope: CommentReactionReservationScope): string {
  return [
    'ranking-arena-comment-reaction-reserve-v1',
    scope.actorId,
    scope.postId,
    scope.commentId,
  ].join(':')
}

/**
 * Serialize the reserve phase across same-origin browsing contexts.
 *
 * The database remains the authority. This browser lock only preserves the
 * order in which same-browser tabs asked to reserve when an older HTTP request
 * is slower than a newer one. Unsupported browsers safely retain the server's
 * reservation-order guarantee.
 */
export async function withCommentReactionReservationLock<T>(
  scope: CommentReactionReservationScope,
  signal: AbortSignal,
  reserve: () => Promise<T>
): Promise<T> {
  const lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!lockManager) return reserve()

  return lockManager.request(
    reservationLockName(scope),
    { mode: 'exclusive', signal },
    async () => {
      signal.throwIfAborted()
      return reserve()
    }
  )
}
