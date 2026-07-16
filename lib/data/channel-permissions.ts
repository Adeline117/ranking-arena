/**
 * Channel membership privacy gate.
 *
 * Group channels must not become a way to bypass a recipient's block or DM
 * preference. This helper is deliberately fail-closed: callers may only add
 * IDs returned in `allowed`, and any incomplete/malformed database response
 * rejects the whole permission check before a membership write can begin.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const MAX_CHANNEL_ADD_CANDIDATES = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DM_PERMISSIONS = new Set(['all', 'mutual', 'none'])

export class ChannelPermissionReadError extends Error {
  constructor(readonly causeValue: unknown) {
    super('Failed to verify channel membership privacy')
    this.name = 'ChannelPermissionReadError'
  }
}

export interface ChannelAddFilterResult {
  /** Candidate IDs the actor is allowed to add. */
  allowed: string[]
  /** Candidate IDs removed by a block, privacy preference, or missing profile. */
  blocked: string[]
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ChannelPermissionReadError(new Error('Invalid channel membership UUID'))
  }
  return value.toLowerCase()
}

function requireRows(
  result: { data: unknown; error: unknown },
  operation: string
): Record<string, unknown>[] {
  if (result.error || !Array.isArray(result.data)) {
    throw new ChannelPermissionReadError(result.error ?? new Error(`Incomplete ${operation}`))
  }
  return result.data.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ChannelPermissionReadError(new Error(`Malformed ${operation}`))
    }
    return row as Record<string, unknown>
  })
}

function validateRelationshipRows(
  rows: readonly Record<string, unknown>[],
  actorId: string,
  candidates: ReadonlySet<string>,
  direction: 'outgoing-block' | 'incoming-block'
): Set<string> {
  const relatedIds = new Set<string>()
  for (const row of rows) {
    const blockerId = normalizeUuid(row.blocker_id)
    const blockedId = normalizeUuid(row.blocked_id)
    const candidateId = direction === 'outgoing-block' ? blockedId : blockerId
    const returnedActorId = direction === 'outgoing-block' ? blockerId : blockedId
    if (returnedActorId !== actorId || !candidates.has(candidateId)) {
      throw new ChannelPermissionReadError(new Error('Block query escaped its reviewed scope'))
    }
    relatedIds.add(candidateId)
  }
  return relatedIds
}

function validateFollowRows(
  rows: readonly Record<string, unknown>[],
  actorId: string,
  candidates: ReadonlySet<string>,
  direction: 'actor-follows' | 'follows-actor'
): Set<string> {
  const relatedIds = new Set<string>()
  for (const row of rows) {
    const followerId = normalizeUuid(row.follower_id)
    const followingId = normalizeUuid(row.following_id)
    const candidateId = direction === 'actor-follows' ? followingId : followerId
    const returnedActorId = direction === 'actor-follows' ? followerId : followingId
    if (returnedActorId !== actorId || !candidates.has(candidateId)) {
      throw new ChannelPermissionReadError(new Error('Follow query escaped its reviewed scope'))
    }
    relatedIds.add(candidateId)
  }
  return relatedIds
}

export async function filterChannelAddableUsers(
  supabase: SupabaseClient,
  actorIdValue: string,
  candidateIdValues: string[]
): Promise<ChannelAddFilterResult> {
  const actorId = normalizeUuid(actorIdValue)
  if (!Array.isArray(candidateIdValues)) {
    throw new ChannelPermissionReadError(new Error('Channel candidates must be an array'))
  }
  if (candidateIdValues.length > MAX_CHANNEL_ADD_CANDIDATES) {
    throw new ChannelPermissionReadError(new Error('Too many channel membership candidates'))
  }

  const unique: string[] = []
  const seen = new Set<string>()
  for (const candidateIdValue of candidateIdValues) {
    const candidateId = normalizeUuid(candidateIdValue)
    if (candidateId === actorId || seen.has(candidateId)) continue
    seen.add(candidateId)
    unique.push(candidateId)
  }
  if (unique.length === 0) return { allowed: [], blocked: [] }

  const candidateSet = new Set(unique)
  let outgoingBlockResult: { data: unknown; error: unknown }
  let incomingBlockResult: { data: unknown; error: unknown }
  try {
    const blockResults = await Promise.all([
      supabase
        .from('blocked_users')
        .select('blocker_id, blocked_id')
        .eq('blocker_id', actorId)
        .in('blocked_id', unique),
      supabase
        .from('blocked_users')
        .select('blocker_id, blocked_id')
        .eq('blocked_id', actorId)
        .in('blocker_id', unique),
    ])
    outgoingBlockResult = blockResults[0]
    incomingBlockResult = blockResults[1]
  } catch (error) {
    throw new ChannelPermissionReadError(error)
  }

  const removed = validateRelationshipRows(
    requireRows(outgoingBlockResult, 'outgoing block result'),
    actorId,
    candidateSet,
    'outgoing-block'
  )
  for (const candidateId of validateRelationshipRows(
    requireRows(incomingBlockResult, 'incoming block result'),
    actorId,
    candidateSet,
    'incoming-block'
  )) {
    removed.add(candidateId)
  }

  const unblocked = unique.filter((candidateId) => !removed.has(candidateId))
  if (unblocked.length === 0) return { allowed: [], blocked: [...unique] }

  let profileResult: { data: unknown; error: unknown }
  try {
    profileResult = await supabase
      .from('user_profiles')
      .select('id, dm_permission')
      .in('id', unblocked)
  } catch (error) {
    throw new ChannelPermissionReadError(error)
  }

  const unblockedSet = new Set(unblocked)
  const profileIds = new Set<string>()
  const mutualOnlyIds: string[] = []
  for (const row of requireRows(profileResult, 'channel candidate profile result')) {
    const profileId = normalizeUuid(row.id)
    if (profileIds.has(profileId) || !unblockedSet.has(profileId)) {
      throw new ChannelPermissionReadError(new Error('Profile query escaped its reviewed scope'))
    }
    profileIds.add(profileId)
    if (typeof row.dm_permission !== 'string' || !DM_PERMISSIONS.has(row.dm_permission)) {
      throw new ChannelPermissionReadError(new Error('Invalid channel candidate DM preference'))
    }
    if (row.dm_permission === 'none') removed.add(profileId)
    if (row.dm_permission === 'mutual') mutualOnlyIds.push(profileId)
  }

  // A deleted/nonexistent profile is never a valid channel member. Treat it as
  // unavailable without exposing whether the ID existed to the route caller.
  for (const candidateId of unblocked) {
    if (!profileIds.has(candidateId)) removed.add(candidateId)
  }

  if (mutualOnlyIds.length > 0) {
    const mutualSet = new Set(mutualOnlyIds)
    let actorFollowsResult: { data: unknown; error: unknown }
    let followsActorResult: { data: unknown; error: unknown }
    try {
      const followResults = await Promise.all([
        supabase
          .from('user_follows')
          .select('follower_id, following_id')
          .eq('follower_id', actorId)
          .in('following_id', mutualOnlyIds),
        supabase
          .from('user_follows')
          .select('follower_id, following_id')
          .eq('following_id', actorId)
          .in('follower_id', mutualOnlyIds),
      ])
      actorFollowsResult = followResults[0]
      followsActorResult = followResults[1]
    } catch (error) {
      throw new ChannelPermissionReadError(error)
    }

    const actorFollows = validateFollowRows(
      requireRows(actorFollowsResult, 'actor follow result'),
      actorId,
      mutualSet,
      'actor-follows'
    )
    const followsActor = validateFollowRows(
      requireRows(followsActorResult, 'reverse follow result'),
      actorId,
      mutualSet,
      'follows-actor'
    )
    for (const candidateId of mutualOnlyIds) {
      if (!actorFollows.has(candidateId) || !followsActor.has(candidateId)) {
        removed.add(candidateId)
      }
    }
  }

  return {
    allowed: unique.filter((candidateId) => !removed.has(candidateId)),
    blocked: unique.filter((candidateId) => removed.has(candidateId)),
  }
}
