/**
 * 自定义投票 API
 * POST /api/posts/[id]/poll-vote - 对帖子关联的投票进行投票
 * GET /api/posts/[id]/poll-vote - 获取投票详情
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getAuthUser, requireAuth, success, handleError } from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'

type RouteContext = { params: Promise<{ id: string }> }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type PollOption = { text: string; votes: number }

function parsePollOptions(value: unknown): PollOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const options: PollOption[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const row = candidate as Record<string, unknown>
    if (
      typeof row.text !== 'string' ||
      !Number.isSafeInteger(row.votes) ||
      (row.votes as number) < 0
    ) {
      return null
    }
    options.push({ text: row.text, votes: row.votes as number })
  }
  return options
}

// 获取投票详情
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
    if (rateLimitResponse) return rateLimitResponse

    const { id: postId } = await context.params
    if (!UUID_RE.test(postId)) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }
    const supabase = getSupabaseAdmin()

    // 尝试获取用户（可选，未登录也可以查看）
    let userId: string | null = null
    userId = (await getAuthUser(request))?.id ?? null
    if (request.headers.get('authorization') && !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!(await canServiceActorReadPost(supabase, postId, userId))) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    // 获取投票信息
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
      return success({ poll: null, userVotes: [] })
    }

    const options = parsePollOptions(poll.options)
    if (!options) throw new Error('Poll could not be loaded')

    // 检查是否已过期
    const isExpired = poll.end_at ? new Date(poll.end_at) <= new Date() : false

    // 获取用户投票（如果已登录）
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

      userVotes = votes?.map((v) => v.option_index) || []
    }

    // 如果未过期且用户未投票，隐藏投票结果
    const hasVoted = userVotes.length > 0
    const showResults = isExpired || hasVoted

    return success({
      poll: {
        id: poll.id,
        question: poll.question,
        options: showResults ? options : options.map((opt) => ({ text: opt.text, votes: null })),
        type: poll.type,
        endAt: poll.end_at,
        isExpired,
        showResults,
        totalVotes: showResults ? options.reduce((sum, opt) => sum + opt.votes, 0) : null,
      },
      userVotes,
      hasVoted,
    })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/poll-vote GET')
  }
}

// 投票
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const { id: postId } = await context.params
    if (!UUID_RE.test(postId)) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const optionIndexes =
      body && typeof body === 'object' && !Array.isArray(body) && 'optionIndexes' in body
        ? (body as { optionIndexes?: unknown }).optionIndexes
        : null

    if (
      !Array.isArray(optionIndexes) ||
      optionIndexes.length === 0 ||
      optionIndexes.length > 100 ||
      !optionIndexes.every((value): value is number => Number.isSafeInteger(value)) ||
      new Set(optionIndexes).size !== optionIndexes.length
    ) {
      return NextResponse.json({ error: 'Invalid poll options' }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('cast_post_poll_vote_atomic', {
      p_actor_id: user.id,
      p_post_id: postId,
      p_option_indexes: optionIndexes,
    })

    if (error) {
      logger.error('[poll-vote POST] atomic vote failed', { code: error.code })
      throw new Error('Vote could not be recorded')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Vote could not be recorded')
    }

    const result = data as Record<string, unknown>
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Poll not found' }, { status: 404 })
    }
    if (result.status === 'ended') {
      return NextResponse.json({ error: 'Poll has ended' }, { status: 409 })
    }
    if (result.status === 'invalid') {
      return NextResponse.json({ error: 'Invalid poll options' }, { status: 400 })
    }

    const updatedOptions = parsePollOptions(result.options)
    const userVotes = result.user_votes
    if (
      result.status !== 'voted' ||
      typeof result.poll_id !== 'string' ||
      !UUID_RE.test(result.poll_id) ||
      !updatedOptions ||
      !Number.isSafeInteger(result.total_votes) ||
      (result.total_votes as number) < 0 ||
      !Array.isArray(userVotes) ||
      userVotes.length !== optionIndexes.length ||
      !userVotes.every((value, index) => value === optionIndexes[index])
    ) {
      throw new Error('Vote could not be recorded')
    }

    return success({
      poll: {
        id: result.poll_id,
        options: updatedOptions,
        totalVotes: result.total_votes,
      },
      userVotes,
    })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/poll-vote POST')
  }
}
