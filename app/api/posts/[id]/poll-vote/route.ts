/**
 * 自定义投票 API
 * POST /api/posts/[id]/poll-vote - 对帖子关联的投票进行投票
 * GET /api/posts/[id]/poll-vote - 获取投票详情
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
} from '@/lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

type RouteContext = { params: Promise<{ id: string }> }

// 获取投票详情
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id: postId } = await context.params
    const supabase = getSupabaseAdmin() as SupabaseClient
    
    // 尝试获取用户（可选，未登录也可以查看）
    let userId: string | null = null
    try {
      const authHeader = request.headers.get('authorization')
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7)
        const { data: { user } } = await supabase.auth.getUser(token)
        userId = user?.id || null
      }
    } catch {
      // Intentionally swallowed: auth token parse failed, continue as anonymous user (userId = null)
    }

    // 获取投票信息
    const { data: poll, error: pollError } = await supabase
      .from('polls')
      .select('id, question, options, type, end_at')
      .eq('post_id', postId)
      .single()

    if (pollError || !poll) {
      return success({ poll: null, userVotes: [] })
    }

    // 检查是否已过期
    const isExpired = poll.end_at ? new Date(poll.end_at) <= new Date() : false
    
    // 获取用户投票（如果已登录）
    let userVotes: number[] = []
    if (userId) {
      const { data: votes } = await supabase
        .from('poll_votes')
        .select('option_index')
        .eq('poll_id', poll.id)
        .eq('user_id', userId)
      
      userVotes = votes?.map(v => v.option_index) || []
    }

    // 如果未过期且用户未投票，隐藏投票结果
    const hasVoted = userVotes.length > 0
    const showResults = isExpired || hasVoted

    return success({
      poll: {
        id: poll.id,
        question: poll.question,
        options: showResults 
          ? poll.options 
          : poll.options.map((opt: { text: string }) => ({ text: opt.text, votes: null })),
        type: poll.type,
        endAt: poll.end_at,
        isExpired,
        showResults,
        totalVotes: showResults 
          ? poll.options.reduce((sum: number, opt: { votes: number }) => sum + opt.votes, 0)
          : null,
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
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient

    const body = await request.json()
    const optionIndexes: number[] = body.optionIndexes

    if (!Array.isArray(optionIndexes) || optionIndexes.length === 0) {
      throw new Error('Please select at least one option')
    }

    // 获取投票信息
    const { data: poll, error: pollError } = await supabase
      .from('polls')
      .select('id, options, type, end_at')
      .eq('post_id', postId)
      .single()

    if (pollError || !poll) {
      throw new Error('Poll not found')
    }

    // 检查是否已过期
    if (poll.end_at && new Date(poll.end_at) <= new Date()) {
      throw new Error('Poll has ended')
    }

    // 检查选项索引是否有效
    const optionsCount = poll.options.length
    for (const idx of optionIndexes) {
      if (idx < 0 || idx >= optionsCount) {
        throw new Error('Invalid option')
      }
    }

    // 单选投票只能选一个
    if (poll.type === 'single' && optionIndexes.length > 1) {
      throw new Error('Single-choice poll allows only one option')
    }

    // 删除现有投票
    await supabase
      .from('poll_votes')
      .delete()
      .eq('poll_id', poll.id)
      .eq('user_id', user.id)

    // 插入新投票
    const newVotes = optionIndexes.map(optionIndex => ({
      poll_id: poll.id,
      user_id: user.id,
      option_index: optionIndex,
    }))

    const { error: insertError } = await supabase
      .from('poll_votes')
      .insert(newVotes)

    if (insertError) {
      throw new Error('Vote failed: ' + insertError.message)
    }

    // Recount votes from poll_votes table (source of truth) to avoid race conditions.
    // The old approach of read-modify-write on the JSON options field was prone to lost updates.
    const { data: voteCounts } = await supabase
      .from('poll_votes')
      .select('option_index')
      .eq('poll_id', poll.id)

    // Build accurate counts from source of truth
    const countMap: Record<number, number> = {}
    for (const v of voteCounts || []) {
      countMap[v.option_index] = (countMap[v.option_index] || 0) + 1
    }

    const updatedOptions = poll.options.map((opt: { text: string; votes: number }, idx: number) => ({
      ...opt,
      votes: countMap[idx] || 0,
    }))

    // Update polls table with recounted values
    const { data: updatedPoll, error: updateError } = await supabase
      .from('polls')
      .update({ options: updatedOptions, updated_at: new Date().toISOString() })
      .eq('id', poll.id)
      .select('id, options')
      .single()

    if (updateError) {
      logger.error('更新投票计数Failed:', updateError)
      return success({
        poll: {
          id: poll.id,
          options: updatedOptions,
          totalVotes: updatedOptions.reduce((sum: number, opt: { votes: number }) => sum + (opt.votes || 0), 0),
        },
        userVotes: optionIndexes,
        warning: 'Vote recorded but count update failed'
      })
    }

    return success({
      poll: {
        id: updatedPoll.id,
        options: updatedPoll.options,
        totalVotes: updatedPoll.options.reduce((sum: number, opt: { votes: number }) => sum + opt.votes, 0),
      },
      userVotes: optionIndexes,
    })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/poll-vote POST')
  }
}


