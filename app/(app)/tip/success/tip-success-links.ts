/**
 * A tip stores the canonical posts.id in tips.post_id. Group pages use a
 * different groups.id namespace, so a successful tip must always return to the
 * post route instead of guessing a group route from the post id.
 */
export function tipPostHref(postId: string | null | undefined): string | null {
  const normalized = postId?.trim()
  return normalized ? `/post/${encodeURIComponent(normalized)}` : null
}
