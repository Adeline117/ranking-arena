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
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

type RouteContext = { params: Promise<{ id: string }> }

// 获取投票详情
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id: postId } = await context.params
    const supabase = getSupabaseAdmin()
    
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
      // 未登录，继续
    }

    // 获取投票信息
    const { data: poll, error: pollError } = await supabase
      .from('polls')
      .select('*')
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
  try {
    const { id: postId } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const optionIndexes: number[] = body.optionIndexes

    if (!Array.isArray(optionIndexes) || optionIndexes.length === 0) {
      throw new Error('请选择至少一个选项')
    }

    // 获取投票信息
    const { data: poll, error: pollError } = await supabase
      .from('polls')
      .select('*')
      .eq('post_id', postId)
      .single()

    if (pollError || !poll) {
      throw new Error('投票不存在')
    }

    // 检查是否已过期
    if (poll.end_at && new Date(poll.end_at) <= new Date()) {
      throw new Error('投票已结束')
    }

    // 检查选项索引是否有效
    const optionsCount = poll.options.length
    for (const idx of optionIndexes) {
      if (idx < 0 || idx >= optionsCount) {
        throw new Error('无效的选项')
      }
    }

    // 单选投票只能选一个
    if (poll.type === 'single' && optionIndexes.length > 1) {
      throw new Error('单选投票只能选择一个选项')
    }

    // 获取用户现有投票
    const { data: existingVotes } = await supabase
      .from('poll_votes')
      .select('id, option_index')
      .eq('poll_id', poll.id)
      .eq('user_id', user.id)

    // 删除现有投票并手动更新计数（不依赖触发器）
    const existingIndexes = existingVotes?.map(v => v.option_index) || []
    
    if (existingVotes && existingVotes.length > 0) {
      await supabase
        .from('poll_votes')
        .delete()
        .eq('poll_id', poll.id)
        .eq('user_id', user.id)
    }

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
      throw new Error('投票失败: ' + insertError.message)
    }

    // 手动更新投票计数（因为触发器可能不工作）
    // NOTE: This uses optimistic counting. For accurate counts under high concurrency,
    // consider using a database function or recounting from poll_votes table.

    // Re-fetch the poll to get the latest state (reduce race condition window)
    const { data: latestPoll, error: refetchError } = await supabase
      .from('polls')
      .select('*')
      .eq('id', poll.id)
      .single()

    if (refetchError || !latestPoll) {
      logger.error('Failed to refetch poll:', refetchError)
      // Return the user's vote anyway - the counts may be stale but vote is recorded
      return success({
        poll: {
          id: poll.id,
          options: poll.options,
          totalVotes: poll.options.reduce((sum: number, opt: { votes: number }) => sum + (opt.votes || 0), 0),
        },
        userVotes: optionIndexes,
        warning: 'Vote recorded but counts may be delayed'
      })
    }

    const updatedOptions = [...latestPoll.options]

    // 减少旧投票的计数
    for (const oldIdx of existingIndexes) {
      if (updatedOptions[oldIdx]) {
        updatedOptions[oldIdx] = {
          ...updatedOptions[oldIdx],
          votes: Math.max(0, (updatedOptions[oldIdx].votes || 0) - 1)
        }
      }
    }

    // 增加新投票的计数
    for (const newIdx of optionIndexes) {
      if (updatedOptions[newIdx]) {
        updatedOptions[newIdx] = {
          ...updatedOptions[newIdx],
          votes: (updatedOptions[newIdx].votes || 0) + 1
        }
      }
    }

    // 更新 polls 表
    const { data: updatedPoll, error: updateError } = await supabase
      .from('polls')
      .update({ options: updatedOptions, updated_at: new Date().toISOString() })
      .eq('id', poll.id)
      .select('*')
      .single()

    if (updateError) {
      logger.error('更新投票计数失败:', updateError)
      // CRITICAL FIX: Return success with vote recorded but indicate counts may be stale
      // This is better than failing completely since the vote was already inserted
      return success({
        poll: {
          id: poll.id,
          options: updatedOptions, // Use our calculated options
          totalVotes: updatedOptions.reduce((sum: number, opt: { votes: number }) => sum + (opt.votes || 0), 0),
        },
        userVotes: optionIndexes,
        warning: 'Vote recorded but count update failed - counts may be inaccurate'
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


