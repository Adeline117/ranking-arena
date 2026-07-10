/**
 * Channel membership privacy gate.
 *
 * Group channels (chat_channels type='group') let an owner/admin add arbitrary
 * users. Without a gate this bypasses the DM privacy rules that 1:1 DMs enforce
 * via check_dm_permission — a harasser (or airdrop bot) could force-add someone
 * who blocked them (or who disabled DMs) into a group and message them there.
 *
 * This helper filters a candidate list down to users who may be added by the
 * actor:
 *   - Excludes anyone who blocked the actor, and anyone the actor blocked
 *     (a block is mutual isolation — they should not share a group).
 *   - Excludes anyone with dm_permission='none' unless they mutually follow the
 *     actor (mirrors check_dm_permission's DM_DISABLED / mutual-follow rule).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ChannelAddFilterResult {
  /** Candidate ids the actor is allowed to add. */
  allowed: string[]
  /** Candidate ids removed because of a block or DM-disabled privacy setting. */
  blocked: string[]
}

export async function filterChannelAddableUsers(
  supabase: SupabaseClient,
  actorId: string,
  candidateIds: string[]
): Promise<ChannelAddFilterResult> {
  const unique = [...new Set(candidateIds)].filter((id) => id && id !== actorId)
  if (unique.length === 0) return { allowed: [], blocked: [] }

  const removed = new Set<string>()

  // 1. Blocks in EITHER direction between actor and each candidate.
  const { data: blocks } = await supabase
    .from('blocked_users')
    .select('blocker_id, blocked_id')
    .or(
      `and(blocker_id.eq.${actorId},blocked_id.in.(${unique.join(',')})),` +
        `and(blocked_id.eq.${actorId},blocker_id.in.(${unique.join(',')}))`
    )
  for (const b of blocks || []) {
    removed.add(b.blocker_id === actorId ? b.blocked_id : b.blocker_id)
  }

  // 2. DM-disabled (dm_permission='none') candidates are only addable if they
  //    mutually follow the actor.
  const remaining = unique.filter((id) => !removed.has(id))
  if (remaining.length > 0) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, dm_permission')
      .in('id', remaining)

    const dmDisabled = (profiles || []).filter((p) => p.dm_permission === 'none').map((p) => p.id)

    if (dmDisabled.length > 0) {
      // Determine which of the DM-disabled candidates mutually follow the actor.
      const [{ data: actorFollows }, { data: followsActor }] = await Promise.all([
        supabase
          .from('user_follows')
          .select('following_id')
          .eq('follower_id', actorId)
          .in('following_id', dmDisabled),
        supabase
          .from('user_follows')
          .select('follower_id')
          .eq('following_id', actorId)
          .in('follower_id', dmDisabled),
      ])
      const actorFollowsSet = new Set((actorFollows || []).map((r) => r.following_id))
      const followsActorSet = new Set((followsActor || []).map((r) => r.follower_id))
      for (const id of dmDisabled) {
        const mutual = actorFollowsSet.has(id) && followsActorSet.has(id)
        if (!mutual) removed.add(id)
      }
    }
  }

  return {
    allowed: unique.filter((id) => !removed.has(id)),
    blocked: [...removed],
  }
}
