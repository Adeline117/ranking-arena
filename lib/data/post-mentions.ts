import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendNotifications } from '@/lib/data/notifications'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'

/** Bound the per-post audience RPCs a single post can trigger. */
export const MAX_MENTIONS_PER_POST = 20

export function extractMentionHandles(content: string): string[] {
  return [...new Set([...content.matchAll(/@(\w+)/g)].map((m) => m[1]))].slice(
    0,
    MAX_MENTIONS_PER_POST
  )
}

/**
 * Resolve @handles in a new post, store them on the post, and notify only the
 * mentioned users who may actually read it.
 *
 * The notification carries a preview of the post. Before the audience check, a
 * private-group or followers-only post that @-mentioned an outsider leaked its
 * first 100 characters into that outsider's inbox (and the link 404'd).
 */
export async function notifyPostMentions(
  supabase: SupabaseClient,
  params: {
    postId: string
    authorId: string
    authorHandle: string
    title: string
    content: string
  }
): Promise<void> {
  const handles = extractMentionHandles(params.content)
  if (handles.length === 0) return

  const { data: mentionedUsers, error: lookupError } = await supabase
    .from('user_profiles')
    .select('id, handle')
    .in('handle', handles)
  if (lookupError) {
    logger.error('[post-mentions] handle lookup failed', {
      postId: params.postId,
      error: lookupError.message,
    })
    return
  }
  if (!mentionedUsers || mentionedUsers.length === 0) return

  const { error: storeError } = await supabase
    .from('posts')
    .update({ mentions: mentionedUsers.map((u: { handle: string }) => u.handle) })
    .eq('id', params.postId)
  if (storeError) {
    logger.error('[post-mentions] storing resolved mentions failed', {
      postId: params.postId,
      error: storeError.message,
    })
  }

  const candidates = mentionedUsers.filter((u: { id: string }) => u.id !== params.authorId)
  const readable = await Promise.all(
    candidates.map((u: { id: string }) => canServiceActorReadPost(supabase, params.postId, u.id))
  )
  const recipients = candidates.filter((_: unknown, i: number) => readable[i])
  if (recipients.length === 0) return

  sendNotifications(
    supabase,
    recipients.map((m: { id: string }) => ({
      user_id: m.id,
      type: 'mention' as const,
      title: `${params.authorHandle} mentioned you in a post`,
      message: (params.title || params.content).slice(0, 100),
      actor_id: params.authorId,
      link: `/post/${params.postId}`,
      reference_id: params.postId,
      read: false,
    })),
    'Mention notifications'
  )
}
