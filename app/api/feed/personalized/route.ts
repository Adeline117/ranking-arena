/**
 * GET /api/feed/personalized
 *
 * Personalized feed using get_personalized_feed RPC.
 * Falls back to hot_score for unauthenticated users.
 */

export const runtime = 'nodejs'

import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  getSupabaseAdmin,
  getAuthUser,
  successWithPagination,
  handleError,
  validateNumber,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { getUserPostReactions, getUserPostVotes } from '@/lib/data/posts'
import { getOrSet } from '@/lib/cache'
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'
import { logRpcError } from '@/lib/data/serving/log-rpc-error'

const CANDIDATE_BATCH_SIZE = 100
const MAX_PAGE_OFFSET = 10_000
// Include the largest page plus its look-ahead batch. Access filtering may
// consume the remainder; the bound still prevents an unbounded service scan.
const MAX_RAW_CANDIDATES = MAX_PAGE_OFFSET + CANDIDATE_BATCH_SIZE * 2
const CANDIDATE_CACHE_TTL_SECONDS = 60

// Redis is allowed to remember ranking only. Runtime validation prevents an
// older full-payload entry (or any other schema drift) from reaching hydration.
const CandidateIdsSchema = z
  .array(z.string().uuid())
  .max(CANDIDATE_BATCH_SIZE)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate candidate IDs' })
    }
  })

const PersonalizedRowsSchema = z
  .array(z.object({ post_id: z.string().uuid() }).passthrough())
  .max(CANDIDATE_BATCH_SIZE)

const HotCandidateRowsSchema = z
  .array(z.object({ id: z.string().uuid() }).passthrough())
  .max(CANDIDATE_BATCH_SIZE)

type CurrentGroupRow = {
  id: string
  name: string | null
  name_en: string | null
  avatar_url: string | null
}

type CurrentPostRow = Record<string, unknown> & {
  id: string
  author_id: string
  group_id?: string | null
  group?: CurrentGroupRow | CurrentGroupRow[] | null
  visibility?: string | null
  status?: string | null
  deleted_at?: string | null
}

type CurrentAuthorRow = {
  id: string
  handle: string | null
  avatar_url: string | null
}

const CURRENT_POST_SELECT =
  'id, title, created_at, updated_at, author_id, author_handle, group_id, images, like_count, comment_count, repost_count, view_count, bookmark_count, is_pinned, hot_score, poll_enabled, poll_bull, poll_bear, poll_wait, visibility, language, mentions, hashtags, group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)'

class PersonalizedCandidateSourceUnavailableError extends Error {
  constructor() {
    super('Personalized candidate source unavailable')
    this.name = 'PersonalizedCandidateSourceUnavailableError'
  }
}

function normalizeCurrentGroup(group: CurrentPostRow['group']): CurrentGroupRow | null {
  if (Array.isArray(group)) return group[0] ?? null
  return group ?? null
}

async function loadPersonalizedCandidateIds(
  supabase: SupabaseClient,
  userId: string,
  rawOffset: number
): Promise<string[]> {
  const cacheKey = `feed:personalized:v3:ids:${userId}:${rawOffset}`
  const cached = await getOrSet<string[]>(
    cacheKey,
    async () => {
      const { data, error } = await supabase.rpc('get_personalized_feed', {
        p_user_id: userId,
        p_limit: CANDIDATE_BATCH_SIZE,
        p_offset: rawOffset,
      })
      if (error) {
        logRpcError('get_personalized_feed', error)
        throw new PersonalizedCandidateSourceUnavailableError()
      }

      const parsed = PersonalizedRowsSchema.safeParse(data)
      if (!parsed.success) {
        throw new Error('Personalized candidate source returned invalid data')
      }

      const ids = parsed.data.map((row) => row.post_id)
      if (new Set(ids).size !== ids.length) {
        throw new Error('Personalized candidate source returned duplicate IDs')
      }
      return ids
    },
    { ttl: CANDIDATE_CACHE_TTL_SECONDS, schema: CandidateIdsSchema }
  )

  // Keep the trust boundary local even if a cache adapter or test double does
  // not honor getOrSet's schema option.
  return CandidateIdsSchema.parse(cached)
}

async function loadHotCandidateIds(supabase: SupabaseClient, rawOffset: number): Promise<string[]> {
  const cacheKey = `feed:personalized:v3:ids:hot:${rawOffset}`
  const cached = await getOrSet<string[]>(
    cacheKey,
    async () => {
      const { data, error } = await supabase
        .from('posts')
        .select('id')
        .neq('status', 'deleted')
        .is('deleted_at', null)
        .order('hot_score', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(rawOffset, rawOffset + CANDIDATE_BATCH_SIZE - 1)

      if (error) throw error
      const parsed = HotCandidateRowsSchema.safeParse(data)
      if (!parsed.success) throw new Error('Hot candidate source returned invalid data')

      const ids = parsed.data.map((row) => row.id)
      if (new Set(ids).size !== ids.length) {
        throw new Error('Hot candidate source returned duplicate IDs')
      }
      return ids
    },
    { ttl: CANDIDATE_CACHE_TTL_SECONDS, schema: CandidateIdsSchema }
  )

  return CandidateIdsSchema.parse(cached)
}

async function hydrateCurrentCandidatePosts(
  supabase: SupabaseClient,
  postIds: readonly string[],
  actorId: string | null
): Promise<CurrentPostRow[]> {
  if (postIds.length === 0) return []

  const { data, error } = await supabase
    .from('posts')
    .select(CURRENT_POST_SELECT)
    .in('id', [...postIds])
    .neq('status', 'deleted')
    .is('deleted_at', null)

  if (error) throw error
  if (!Array.isArray(data) || data.length === 0) return []

  const readableRows = await filterServiceReadablePostRows(
    supabase,
    data as CurrentPostRow[],
    actorId
  )
  if (readableRows.length === 0) return []

  const authorIds = [
    ...new Set(
      readableRows
        .map((post) => post.author_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ]
  const profilesResult = authorIds.length
    ? await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', authorIds)
    : { data: [], error: null }

  if (profilesResult.error) throw profilesResult.error
  const profileById = new Map<string, CurrentAuthorRow>()
  for (const profile of profilesResult.data || []) {
    if (typeof profile?.id !== 'string') continue
    profileById.set(profile.id, {
      id: profile.id,
      handle: typeof profile.handle === 'string' ? profile.handle : null,
      avatar_url: typeof profile.avatar_url === 'string' ? profile.avatar_url : null,
    })
  }

  const rowById = new Map(readableRows.map((post) => [post.id, post]))
  const hydrated: CurrentPostRow[] = []
  for (const postId of postIds) {
    const post = rowById.get(postId)
    if (!post) continue

    const author = profileById.get(post.author_id) ?? null
    hydrated.push({
      ...post,
      // Both the flat compatibility field and nested object come from the
      // current profile row. Never fall back to posts.author_handle here.
      author_handle: author?.handle ?? null,
      author,
      group: normalizeCurrentGroup(post.group),
    })
  }

  return hydrated
}

async function collectCurrentPage(
  supabase: SupabaseClient,
  actorId: string | null,
  offset: number,
  limit: number,
  loadCandidateIds: (rawOffset: number) => Promise<string[]>
): Promise<{ posts: CurrentPostRow[]; hasMore: boolean }> {
  const wanted = limit + 1
  const posts: CurrentPostRow[] = []
  const seenCandidateIds = new Set<string>()
  let readableOffset = 0
  let rawOffset = 0
  let reachedSourceEnd = false

  while (posts.length < wanted && rawOffset < MAX_RAW_CANDIDATES) {
    const candidateIds = await loadCandidateIds(rawOffset)
    if (candidateIds.length < CANDIDATE_BATCH_SIZE) reachedSourceEnd = true

    const unseenIds = candidateIds.filter((id) => {
      if (seenCandidateIds.has(id)) return false
      seenCandidateIds.add(id)
      return true
    })
    const currentBatch = await hydrateCurrentCandidatePosts(supabase, unseenIds, actorId)
    for (const post of currentBatch) {
      if (readableOffset < offset) {
        readableOffset += 1
        continue
      }
      posts.push(post)
      if (posts.length === wanted) break
    }

    if (reachedSourceEnd) break
    rawOffset += CANDIDATE_BATCH_SIZE
  }

  if (!reachedSourceEnd && posts.length < wanted && rawOffset >= MAX_RAW_CANDIDATES) {
    throw new Error('Personalized audience scan exceeded the bounded read window')
  }

  return { posts: posts.slice(0, limit), hasMore: posts.length > limit }
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { searchParams } = new URL(request.url)
    const limit =
      validateNumber(searchParams.get('limit'), { min: 1, max: 100, integer: true }) ?? 20
    const offset =
      validateNumber(searchParams.get('offset'), { min: 0, max: MAX_PAGE_OFFSET, integer: true }) ??
      0

    const user = await getAuthUser(request)
    const supabase = getSupabaseAdmin()
    let page: { posts: CurrentPostRow[]; hasMore: boolean }

    if (user) {
      try {
        page = await collectCurrentPage(supabase, user.id, offset, limit, (rawOffset) =>
          loadPersonalizedCandidateIds(supabase, user.id, rawOffset)
        )
      } catch (error) {
        if (!(error instanceof PersonalizedCandidateSourceUnavailableError)) throw error
        page = await collectCurrentPage(supabase, user.id, offset, limit, (rawOffset) =>
          loadHotCandidateIds(supabase, rawOffset)
        )
      }
    } else {
      page = await collectCurrentPage(supabase, null, offset, limit, (rawOffset) =>
        loadHotCandidateIds(supabase, rawOffset)
      )
    }

    let userReactions: Map<string, 'up' | 'down'> = new Map()
    let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()
    if (user && page.posts.length > 0) {
      const postIds = page.posts.map((post) => post.id)
      const [reactions, votes] = await Promise.all([
        getUserPostReactions(supabase, postIds, user.id),
        getUserPostVotes(supabase, postIds, user.id),
      ])
      userReactions = reactions
      userVotes = votes
    }

    const postsWithState = page.posts.map((post) => ({
      ...post,
      user_reaction: userReactions.get(post.id) || null,
      user_vote: userVotes.get(post.id) || null,
    }))

    const response = successWithPagination(
      { posts: postsWithState },
      { limit, offset, has_more: page.hasMore }
    )
    response.headers.set('Cache-Control', 'private, no-store, max-age=0')
    response.headers.set('CDN-Cache-Control', 'no-store')
    response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
    return response
  } catch (error: unknown) {
    return handleError(error, 'personalized feed GET')
  }
}
