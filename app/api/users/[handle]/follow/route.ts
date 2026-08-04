/**
 * Paginated public follow-list API.
 *
 * GET /api/users/[handle]/follow?list=followers[&cursor=...]
 * GET /api/users/[handle]/follow?list=following[&cursor=...]
 *
 * The response binds every page to the authenticated viewer (or anonymous
 * viewer), immutable target id, canonical target handle, and requested list.
 */

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { badRequest, notFound, serverError, success, unauthorized } from '@/lib/api/response'
import type { Database } from '@/lib/supabase/database.types'
import { createLogger } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'
import {
  isPublicProfileActive,
  readPublicProfileAudienceByHandle,
} from '@/lib/profile/public-audience'
import { getHandleShapeError, normalizeHandle } from '@/lib/identity/handle-policy'
import {
  FOLLOW_LIST_PAGE_SIZE,
  type FollowListType,
} from '@/lib/follows/follow-list-client-contract'

const logger = createLogger('users-follow-list')

export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]?.length ?? 0) <= 6)
const CursorValueSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/)
const ListSchema = z.enum(['followers', 'following'])
const CursorSchema = z
  .object({
    version: z.literal(1),
    target_user_id: UuidSchema,
    list: ListSchema,
    created_at: TimestampSchema,
    edge_id: UuidSchema,
  })
  .strict()

const TargetProfileSchema = z
  .object({
    id: UuidSchema,
    handle: z.string(),
    show_followers: z.boolean().nullable(),
    show_following: z.boolean().nullable(),
    deleted_at: z.string().nullable(),
    banned_at: z.string().nullable(),
    is_banned: z.boolean().nullable(),
    ban_expires_at: z.string().nullable(),
  })
  .strict()
  .refine(
    (profile) => getHandleShapeError(profile.handle, { allowUnchangedLegacyDot: true }) === null,
    { path: ['handle'] }
  )

const ListProfileSchema = z
  .object({
    id: UuidSchema,
    handle: z.string().nullable(),
    bio: z.string().nullable(),
    avatar_url: z.string().nullable(),
    deleted_at: z.string().nullable(),
    banned_at: z.string().nullable(),
    is_banned: z.boolean().nullable(),
    ban_expires_at: z.string().nullable(),
  })
  .strict()

const RawFollowEdgeSchema = z
  .object({
    id: UuidSchema,
    created_at: TimestampSchema,
    follower_id: UuidSchema,
    following_id: UuidSchema,
  })
  .strict()

type TargetProfile = z.infer<typeof TargetProfileSchema>
type FollowCursor = z.infer<typeof CursorSchema>
type FollowEdge = {
  id: string
  created_at: string
  related_user_id: string
}

class FollowListReadError extends Error {}

function noStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

function sameHandle(left: string, right: string): boolean {
  return normalizeHandle(left).toLowerCase() === normalizeHandle(right).toLowerCase()
}

function decodeCursor(value: string): FollowCursor | null {
  const encoded = CursorValueSchema.safeParse(value)
  if (!encoded.success) return null

  try {
    const decoded = Buffer.from(encoded.data, 'base64url').toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded.data) return null
    const parsed = CursorSchema.safeParse(JSON.parse(decoded))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function encodeCursor(cursor: FollowCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function readInput(
  searchParams: URLSearchParams
): { list: FollowListType; cursor: FollowCursor | null } | null {
  const allowed = new Set(['list', 'cursor'])
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) return null
  }

  const parsedList = ListSchema.safeParse(searchParams.get('list'))
  if (!parsedList.success) return null

  const rawCursor = searchParams.get('cursor')
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor)
  if (rawCursor !== null && cursor === null) return null
  return { list: parsedList.data, cursor }
}

function timestampParts(value: string): readonly [milliseconds: number, submillisecond: number] {
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
  const microseconds = Number(`${fraction}000000`.slice(0, 6))
  return [Date.parse(value), microseconds % 1_000]
}

function comparePosition(
  left: { created_at: string; id: string },
  right: { created_at: string; id: string }
): number {
  const [leftMilliseconds, leftSubmillisecond] = timestampParts(left.created_at)
  const [rightMilliseconds, rightSubmillisecond] = timestampParts(right.created_at)
  if (leftMilliseconds !== rightMilliseconds) return leftMilliseconds - rightMilliseconds
  if (leftSubmillisecond !== rightSubmillisecond) return leftSubmillisecond - rightSubmillisecond
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1
}

function canViewList(
  target: TargetProfile,
  list: FollowListType,
  viewerId: string | null
): boolean {
  if (viewerId === target.id) return true
  return list === 'followers' ? target.show_followers === true : target.show_following === true
}

async function readTarget(
  supabase: SupabaseClient<Database>,
  targetId: string
): Promise<TargetProfile | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select(
      'id, handle, show_followers, show_following, deleted_at, banned_at, is_banned, ban_expires_at'
    )
    .eq('id', targetId)
    .maybeSingle()

  if (error) throw new FollowListReadError('Target profile read failed')
  if (data === null) return null
  const parsed = TargetProfileSchema.safeParse(data)
  if (!parsed.success) throw new FollowListReadError('Target profile acknowledgement was malformed')
  if (parsed.data.id !== targetId) {
    throw new FollowListReadError('Target profile acknowledgement was mismatched')
  }
  return parsed.data
}

async function fetchProfilesByIds(
  supabase: SupabaseClient<Database>,
  ids: string[]
): Promise<Map<string, z.infer<typeof ListProfileSchema>>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, handle, bio, avatar_url, deleted_at, banned_at, is_banned, ban_expires_at')
    .in('id', ids)
  if (error) throw new FollowListReadError('Follow-list profile read failed')

  const parsed = z.array(ListProfileSchema).safeParse(data)
  if (!parsed.success) throw new FollowListReadError('Follow-list profiles were malformed')
  const requested = new Set(ids)
  const result = new Map<string, z.infer<typeof ListProfileSchema>>()
  for (const profile of parsed.data) {
    if (!requested.has(profile.id) || result.has(profile.id)) {
      throw new FollowListReadError('Follow-list profiles were inconsistent')
    }
    if (
      isPublicProfileActive(profile) &&
      profile.handle !== null &&
      getHandleShapeError(profile.handle, { allowUnchangedLegacyDot: true }) === null
    ) {
      result.set(profile.id, profile)
    }
  }
  return result
}

async function fetchFollowStatus(
  supabase: SupabaseClient<Database>,
  viewerId: string,
  userIds: string[]
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const { data, error } = await supabase
    .from('user_follows')
    .select('follower_id, following_id')
    .eq('follower_id', viewerId)
    .in('following_id', userIds)
  if (error) throw new FollowListReadError('Viewer follow-status read failed')

  const parsed = z
    .array(z.object({ follower_id: UuidSchema, following_id: UuidSchema }).strict())
    .safeParse(data)
  if (!parsed.success) throw new FollowListReadError('Viewer follow statuses were malformed')
  const requested = new Set(userIds)
  const following = new Set<string>()
  for (const row of parsed.data) {
    if (
      row.follower_id !== viewerId ||
      !requested.has(row.following_id) ||
      following.has(row.following_id)
    ) {
      throw new FollowListReadError('Viewer follow statuses were inconsistent')
    }
    following.add(row.following_id)
  }
  return following
}

async function fetchEdges(
  supabase: SupabaseClient<Database>,
  targetId: string,
  list: FollowListType,
  cursor: FollowCursor | null
): Promise<{ edges: FollowEdge[]; hasMore: boolean; nextCursor: string | null }> {
  let query = supabase
    .from('user_follows')
    .select('id, created_at, follower_id, following_id')
    .eq(list === 'followers' ? 'following_id' : 'follower_id', targetId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })

  if (cursor) {
    query = query.or(
      `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.edge_id})`
    )
  }

  const { data, error } = await query.limit(FOLLOW_LIST_PAGE_SIZE + 1)
  if (error) throw new FollowListReadError('Follow edges read failed')

  const parsed = z
    .array(RawFollowEdgeSchema)
    .max(FOLLOW_LIST_PAGE_SIZE + 1)
    .safeParse(data)
  if (!parsed.success) throw new FollowListReadError('Follow edges were malformed')

  const normalizedEdges: FollowEdge[] = []
  const edgeIds = new Set<string>()
  const relatedIds = new Set<string>()
  for (let index = 0; index < parsed.data.length; index += 1) {
    const rawEdge = parsed.data[index]!
    const isBoundToTarget =
      list === 'followers' ? rawEdge.following_id === targetId : rawEdge.follower_id === targetId
    if (!isBoundToTarget) throw new FollowListReadError('Follow edge target was mismatched')
    const edge: FollowEdge = {
      id: rawEdge.id,
      created_at: rawEdge.created_at,
      related_user_id: list === 'followers' ? rawEdge.follower_id : rawEdge.following_id,
    }
    if (edgeIds.has(edge.id) || relatedIds.has(edge.related_user_id)) {
      throw new FollowListReadError('Follow edges contained duplicates')
    }
    edgeIds.add(edge.id)
    relatedIds.add(edge.related_user_id)

    const previous = normalizedEdges[index - 1]
    if (previous && comparePosition(previous, edge) <= 0) {
      throw new FollowListReadError('Follow edges were not totally ordered')
    }
    if (
      cursor &&
      comparePosition(edge, { created_at: cursor.created_at, id: cursor.edge_id }) >= 0
    ) {
      throw new FollowListReadError('Follow edges did not advance the cursor')
    }
    normalizedEdges.push(edge)
  }

  const hasMore = normalizedEdges.length > FOLLOW_LIST_PAGE_SIZE
  const edges = normalizedEdges.slice(0, FOLLOW_LIST_PAGE_SIZE)
  const last = edges.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          version: 1,
          target_user_id: targetId,
          list,
          created_at: last.created_at,
          edge_id: last.id,
        })
      : null
  return { edges, hasMore, nextCursor }
}

function pageResponse(input: {
  viewerId: string | null
  target: TargetProfile
  list: FollowListType
  hidden: boolean
  users: unknown[]
  hasMore: boolean
  nextCursor: string | null
}): NextResponse {
  return success(
    {
      viewer_id: input.viewerId,
      target_user_id: input.target.id,
      target_handle: input.target.handle,
      list: input.list,
      hidden: input.hidden,
      users: input.users,
      pagination: {
        limit: FOLLOW_LIST_PAGE_SIZE,
        has_more: input.hasMore,
        next_cursor: input.nextCursor,
      },
    },
    200,
    NO_STORE_HEADERS
  )
}

function hiddenPage(
  viewerId: string | null,
  target: TargetProfile,
  list: FollowListType
): NextResponse {
  return pageResponse({
    viewerId,
    target,
    list,
    hidden: true,
    users: [],
    hasMore: false,
    nextCursor: null,
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> | { handle: string } }
) {
  const guard = socialFeatureGuard()
  if (guard) return noStore(guard)

  const resolvedParams = params instanceof Promise ? await params : params
  let handle: string
  try {
    handle = decodeURIComponent(resolvedParams.handle)
  } catch {
    return noStore(badRequest('Invalid follow-list request'))
  }
  const input = readInput(request.nextUrl.searchParams)
  if (getHandleShapeError(handle, { allowUnchangedLegacyDot: true }) !== null || input === null) {
    return noStore(badRequest('Invalid follow-list request'))
  }

  const handler = withPublic(
    async ({ user, supabase: rawSupabase }) => {
      const supabase: SupabaseClient<Database> = rawSupabase
      const parsedViewerId = user ? UuidSchema.safeParse(user.id) : null
      if (parsedViewerId !== null && !parsedViewerId.success) {
        return noStore(unauthorized('Authentication failed'))
      }
      const viewerId = parsedViewerId?.data ?? null

      try {
        const audience = await readPublicProfileAudienceByHandle(supabase, handle)
        if (audience.status !== 'active') return noStore(notFound('User not found'))
        const targetId = UuidSchema.safeParse(audience.profile.id)
        if (!targetId.success) throw new FollowListReadError('Target identity was malformed')

        const target = await readTarget(supabase, targetId.data)
        if (
          target === null ||
          !isPublicProfileActive(target) ||
          !sameHandle(target.handle, handle)
        ) {
          return noStore(notFound('User not found'))
        }

        if (
          input.cursor &&
          (input.cursor.target_user_id !== target.id || input.cursor.list !== input.list)
        ) {
          return noStore(badRequest('Invalid follow-list request'))
        }

        if (!canViewList(target, input.list, viewerId)) {
          return hiddenPage(viewerId, target, input.list)
        }

        const page = await fetchEdges(supabase, target.id, input.list, input.cursor)
        const relatedIds = page.edges.map((edge) => edge.related_user_id)
        const [profiles, following] = await Promise.all([
          fetchProfilesByIds(supabase, relatedIds),
          viewerId
            ? fetchFollowStatus(supabase, viewerId, relatedIds)
            : Promise.resolve(new Set<string>()),
        ])

        // Re-read account state and privacy after materializing the page. This
        // narrows the service-role privacy race without introducing a risky
        // launch migration; the remaining non-atomic window is documented.
        const revalidatedTarget = await readTarget(supabase, target.id)
        if (
          revalidatedTarget === null ||
          !isPublicProfileActive(revalidatedTarget) ||
          !sameHandle(revalidatedTarget.handle, handle)
        ) {
          return noStore(notFound('User not found'))
        }
        if (!canViewList(revalidatedTarget, input.list, viewerId)) {
          return hiddenPage(viewerId, revalidatedTarget, input.list)
        }

        const users = page.edges.flatMap((edge) => {
          const profile = profiles.get(edge.related_user_id)
          if (!profile || profile.handle === null) return []
          return [
            {
              id: profile.id,
              handle: profile.handle,
              bio: profile.bio,
              avatar_url: profile.avatar_url,
              followed_at: edge.created_at,
              is_following: following.has(profile.id),
            },
          ]
        })

        return pageResponse({
          viewerId,
          target: revalidatedTarget,
          list: input.list,
          hidden: false,
          users,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        })
      } catch (error) {
        logger.error('Follow-list read failed', {
          error: error instanceof Error ? error.message : String(error),
          handle,
          list: input.list,
          viewerId,
        })
        return noStore(serverError('Failed to fetch follow list'))
      }
    },
    { name: 'users-follow-list', rateLimit: 'public', readsAuth: true }
  )

  return noStore(await handler(request))
}
