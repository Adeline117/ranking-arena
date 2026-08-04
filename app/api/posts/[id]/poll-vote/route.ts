/**
 * Custom-poll API.
 *
 * GET returns an exact viewer-bound snapshot (including explicit absence).
 * POST replaces the viewer's selection through the canonical atomic RPC and
 * returns authoritative option counts in their persisted order.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin, getAuthUser, requireAuth, handleError } from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { canServiceActorReadPostStrict } from '@/lib/data/service-post-audience'
import {
  POST_CUSTOM_POLL_READ_OPERATION,
  POST_CUSTOM_POLL_VOTE_OPERATION,
  isCanonicalPostVoteRequestId,
} from '@/lib/polls/post-vote-client-contract'

type RouteContext = { params: Promise<{ id: string }> }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type PollOption = { text: string; votes: number }

const PostPollVoteSchema = z
  .object({
    operation: z.literal(POST_CUSTOM_POLL_VOTE_OPERATION),
    request_id: z.string().refine(isCanonicalPostVoteRequestId),
    poll_id: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    option_indexes: z
      .array(z.number().int().min(0).max(5))
      .min(1)
      .max(6)
      .refine(
        (indexes) => indexes.every((value, index) => index === 0 || value > indexes[index - 1]),
        { message: 'option_indexes must be unique and sorted' }
      ),
  })
  .strict()

function privateNoStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store')
  response.headers.set('CDN-Cache-Control', 'no-store')
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function parsePollOptions(value: unknown): PollOption[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) return null
  const options: PollOption[] = []
  let indexedShape: boolean | null = null
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index]
    const hasIndex = isRecord(candidate) && hasExactKeys(candidate, ['index', 'text', 'votes'])
    const hasLegacyShape = isRecord(candidate) && hasExactKeys(candidate, ['text', 'votes'])
    if (
      !isRecord(candidate) ||
      (!hasIndex && !hasLegacyShape) ||
      (indexedShape !== null && indexedShape !== hasIndex) ||
      (hasIndex && candidate.index !== index) ||
      typeof candidate.text !== 'string' ||
      candidate.text.length < 1 ||
      candidate.text.length > 100 ||
      candidate.text !== candidate.text.trim() ||
      candidate.text !== candidate.text.normalize('NFC') ||
      !Number.isSafeInteger(candidate.votes) ||
      (candidate.votes as number) < 0
    ) {
      return null
    }
    indexedShape = hasIndex
    options.push({ text: candidate.text, votes: candidate.votes as number })
  }

  const normalized = options.map((option) => option.text.normalize('NFKC').toLowerCase())
  return new Set(normalized).size === normalized.length ? options : null
}

function readGetQuery(request: NextRequest): { requestId: string } | null {
  const params = new URL(request.url).searchParams
  const keys = [...params.keys()]
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes('operation') ||
    !keys.includes('request_id') ||
    params.getAll('operation').length !== 1 ||
    params.getAll('request_id').length !== 1 ||
    params.get('operation') !== POST_CUSTOM_POLL_READ_OPERATION
  ) {
    return null
  }

  const requestId = params.get('request_id')
  return isCanonicalPostVoteRequestId(requestId) ? { requestId } : null
}

async function getCustomPoll(request: NextRequest, context: RouteContext): Promise<Response> {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
    if (rateLimitResponse) return rateLimitResponse

    const query = readGetQuery(request)
    if (!query) {
      return NextResponse.json({ error: 'Invalid poll snapshot request' }, { status: 400 })
    }

    const { id: rawPostId } = await context.params
    if (!UUID_RE.test(rawPostId)) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }
    const postId = rawPostId.toLowerCase()
    const supabase = getSupabaseAdmin()

    const authenticatedUserId = (await getAuthUser(request))?.id ?? null
    if (request.headers.get('authorization') && !authenticatedUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (authenticatedUserId !== null && !UUID_RE.test(authenticatedUserId)) {
      throw new Error('Poll viewer identity is malformed')
    }
    const userId = authenticatedUserId?.toLowerCase() ?? null
    if (!(await canServiceActorReadPostStrict(supabase, postId, userId))) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    const { data: poll, error: pollError } = await supabase
      .from('polls')
      .select('id, question, options, type, end_at')
      .eq('post_id', postId)
      .maybeSingle()

    if (pollError) {
      logger.error('[poll-vote GET] poll lookup failed', { code: pollError.code })
      throw new Error('Poll could not be loaded')
    }
    if (!poll) {
      return NextResponse.json({
        actor_id: userId,
        post_id: postId,
        request_id: query.requestId,
        operation: POST_CUSTOM_POLL_READ_OPERATION,
        action: 'absent',
        poll: null,
        user_votes: [],
      })
    }

    const options = parsePollOptions(poll.options)
    if (
      typeof poll.id !== 'string' ||
      !UUID_RE.test(poll.id) ||
      typeof poll.question !== 'string' ||
      poll.question.length > 200 ||
      (poll.type !== 'single' && poll.type !== 'multiple') ||
      (poll.end_at !== null &&
        (typeof poll.end_at !== 'string' || Number.isNaN(Date.parse(poll.end_at)))) ||
      !options
    ) {
      throw new Error('Poll could not be loaded')
    }

    let userVotes: number[] = []
    if (userId) {
      const { data: votes, error: votesError } = await supabase
        .from('poll_votes')
        .select('option_index')
        .eq('poll_id', poll.id)
        .eq('user_id', userId)

      if (votesError) {
        logger.error('[poll-vote GET] viewer vote lookup failed', { code: votesError.code })
        throw new Error('Poll could not be loaded')
      }
      if (!Array.isArray(votes)) throw new Error('Poll could not be loaded')

      for (const vote of votes) {
        if (
          !isRecord(vote) ||
          !hasExactKeys(vote, ['option_index']) ||
          !Number.isSafeInteger(vote.option_index) ||
          (vote.option_index as number) < 0 ||
          (vote.option_index as number) >= options.length
        ) {
          throw new Error('Poll could not be loaded')
        }
        userVotes.push(vote.option_index as number)
      }
      userVotes = [...new Set(userVotes)].sort((left, right) => left - right)
      if (userVotes.length !== votes.length || (poll.type === 'single' && userVotes.length > 1)) {
        throw new Error('Poll could not be loaded')
      }
    }

    const isExpired = poll.end_at ? new Date(poll.end_at) <= new Date() : false
    const showResults = isExpired || userVotes.length > 0

    return NextResponse.json({
      actor_id: userId,
      post_id: postId,
      request_id: query.requestId,
      operation: POST_CUSTOM_POLL_READ_OPERATION,
      action: 'found',
      poll: {
        id: poll.id.toLowerCase(),
        question: poll.question,
        options: showResults
          ? options
          : options.map((option) => ({ text: option.text, votes: null })),
        type: poll.type,
        end_at: poll.end_at,
        is_expired: isExpired,
        show_results: showResults,
        total_votes: showResults ? options.reduce((sum, option) => sum + option.votes, 0) : null,
      },
      user_votes: userVotes,
    })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/poll-vote GET')
  }
}

async function setCustomPollVote(request: NextRequest, context: RouteContext): Promise<Response> {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id: rawPostId } = await context.params
    if (!UUID_RE.test(rawPostId)) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }
    const postId = rawPostId.toLowerCase()
    const user = await requireAuth(request)
    if (!UUID_RE.test(user.id)) throw new Error('Poll viewer identity is malformed')
    const actorId = user.id.toLowerCase()
    const supabase = getSupabaseAdmin()

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = PostPollVoteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid poll options' }, { status: 400 })
    }
    const {
      poll_id: requestedPollId,
      option_indexes: optionIndexes,
      request_id: requestId,
    } = parsed.data

    const { data, error } = await supabase.rpc('cast_post_poll_vote_expected_atomic', {
      p_actor_id: actorId,
      p_post_id: postId,
      p_expected_poll_id: requestedPollId,
      p_option_indexes: optionIndexes,
    })

    if (error) {
      logger.error('[poll-vote POST] atomic vote failed', { code: error.code })
      throw new Error('Vote could not be recorded')
    }
    if (!isRecord(data)) throw new Error('Vote could not be recorded')

    if (data.status === 'not_found') {
      return NextResponse.json({ error: 'Poll not found' }, { status: 404 })
    }
    if (data.status === 'ended') {
      return NextResponse.json({ error: 'Poll has ended' }, { status: 409 })
    }
    if (data.status === 'poll_changed') {
      return NextResponse.json({ error: 'Poll changed; reload before voting' }, { status: 409 })
    }
    if (data.status === 'invalid') {
      return NextResponse.json({ error: 'Invalid poll options' }, { status: 400 })
    }

    const updatedOptions = parsePollOptions(data.options)
    const resultPollId = typeof data.poll_id === 'string' ? data.poll_id.toLowerCase() : null
    if (
      !hasExactKeys(data, ['options', 'poll_id', 'status', 'total_votes', 'user_votes']) ||
      data.status !== 'voted' ||
      !resultPollId ||
      !UUID_RE.test(resultPollId) ||
      !updatedOptions ||
      !Number.isSafeInteger(data.total_votes) ||
      (data.total_votes as number) < 0 ||
      updatedOptions.reduce((sum, option) => sum + option.votes, 0) !== data.total_votes ||
      !Array.isArray(data.user_votes) ||
      data.user_votes.length !== optionIndexes.length ||
      !data.user_votes.every((value, index) => value === optionIndexes[index]) ||
      optionIndexes.some((index) => !updatedOptions[index] || updatedOptions[index].votes < 1)
    ) {
      throw new Error('Vote could not be recorded')
    }
    if (resultPollId !== requestedPollId) {
      return NextResponse.json({ error: 'Poll changed; reload before voting' }, { status: 409 })
    }

    return NextResponse.json({
      actor_id: actorId,
      post_id: postId,
      poll_id: resultPollId,
      request_id: requestId,
      operation: POST_CUSTOM_POLL_VOTE_OPERATION,
      action: 'voted',
      poll: {
        options: updatedOptions,
        total_votes: data.total_votes,
      },
      option_indexes: optionIndexes,
    })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/poll-vote POST')
  }
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return privateNoStore(await getCustomPoll(request, context))
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return privateNoStore(await setCustomPollVote(request, context))
}
