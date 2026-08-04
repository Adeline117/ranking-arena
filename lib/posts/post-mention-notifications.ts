import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { deliverNotification } from '@/lib/data/notifications'
import { fireAndForget } from '@/lib/utils/logger'

const MENTION_DEDUP_WINDOW_SECONDS = 604_800

type PostMentionNotificationClient = SupabaseClient<Database>

export type PostMentionNotificationEvent = Readonly<{
  actorId: string
  actorHandle?: string | null
  postId: string
  title: string
  content: string
  mentionHandles: readonly string[]
}>

function canonicalMentionHandles(handles: readonly string[]): string[] {
  const canonical = new Map<string, string>()
  for (const rawHandle of handles) {
    const handle = rawHandle.normalize('NFC')
    const key = handle.toLocaleLowerCase('und')
    if (handle && !canonical.has(key)) canonical.set(key, handle)
  }
  return [...canonical.values()].slice(0, 50)
}

/**
 * Schedule one observable task that owns mention normalization, recipient and
 * actor resolution, and every durable delivery. Callers must pass only the
 * database-acknowledged mention set; this helper never trusts request tokens.
 */
export function schedulePostMentionNotifications(
  supabase: PostMentionNotificationClient,
  event: PostMentionNotificationEvent,
  context: string
): void {
  if (event.mentionHandles.length === 0) return

  const deliveryTask = (async () => {
    const mentionHandles = canonicalMentionHandles(event.mentionHandles)
    if (mentionHandles.length === 0) return

    const { data: recipientRows, error: recipientError } = await supabase
      .from('user_profiles')
      .select('id, handle')
      .in('handle', mentionHandles)
    if (recipientError) throw recipientError

    let actorHandle = event.actorHandle?.normalize('NFC').trim() || null
    if (!actorHandle) {
      const { data: actorProfile, error: actorError } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', event.actorId)
        .maybeSingle()
      if (actorError) throw actorError
      actorHandle = actorProfile?.handle?.normalize('NFC').trim() || null
    }

    const mentionKeys = new Set(mentionHandles.map((handle) => handle.toLocaleLowerCase('und')))
    const actorId = event.actorId.toLowerCase()
    const recipients = new Map<string, { id: string; handle: string }>()
    for (const profile of recipientRows ?? []) {
      const recipientId = profile.id.toLowerCase()
      const handleKey = profile.handle.toLocaleLowerCase('und')
      if (recipientId !== actorId && mentionKeys.has(handleKey) && !recipients.has(recipientId)) {
        recipients.set(recipientId, { ...profile, id: recipientId })
      }
    }

    const notificationTitle = `${actorHandle || 'A user'} mentioned you in a post`
    const notificationMessage = (event.title || event.content).slice(0, 100)
    await Promise.all(
      [...recipients.values()]
        .sort((left, right) => left.id.localeCompare(right.id, 'en'))
        .map((recipient) =>
          deliverNotification(
            supabase,
            {
              user_id: recipient.id,
              type: 'mention',
              title: notificationTitle,
              message: notificationMessage,
              actor_id: event.actorId,
              link: `/post/${event.postId}`,
              reference_id: event.postId,
              read: false,
            },
            {
              deduplicate: true,
              dedupWindowSeconds: MENTION_DEDUP_WINDOW_SECONDS,
            }
          )
        )
    )
  })()

  fireAndForget(deliveryTask, context)
}
