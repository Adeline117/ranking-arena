/**
 * 跟单日记数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'

// ============================================
// 类型定义
// ============================================

export type JournalVisibility = 'public' | 'followers' | 'private'

export interface FollowJournal {
  id: string
  user_id: string
  trader_id: string
  source: string
  title: string | null
  content: string
  profit_loss_percent: number | null
  profit_loss_amount: number | null
  start_date: string | null
  end_date: string | null
  initial_capital: number | null
  screenshots: string[]
  tags: string[]
  visibility: JournalVisibility
  like_count: number
  comment_count: number
  view_count: number
  status: 'active' | 'archived' | 'deleted'
  is_pinned: boolean
  created_at: string
  updated_at: string
  // 关联数据
  author_handle?: string
  author_avatar_url?: string
  trader_handle?: string
  user_liked?: boolean
}

export interface JournalComment {
  id: string
  journal_id: string
  user_id: string
  parent_id: string | null
  content: string
  like_count: number
  created_at: string
  updated_at: string
  // 关联数据
  author_handle?: string
  author_avatar_url?: string
  replies?: JournalComment[]
}

export interface CreateJournalInput {
  trader_id: string
  source: string
  title?: string
  content: string
  profit_loss_percent?: number
  profit_loss_amount?: number
  start_date?: string
  end_date?: string
  initial_capital?: number
  screenshots?: string[]
  tags?: string[]
  visibility?: JournalVisibility
}

export interface UpdateJournalInput {
  title?: string
  content?: string
  profit_loss_percent?: number | null
  profit_loss_amount?: number | null
  start_date?: string | null
  end_date?: string | null
  initial_capital?: number | null
  screenshots?: string[]
  tags?: string[]
  visibility?: JournalVisibility
  is_pinned?: boolean
}

export interface JournalListOptions {
  limit?: number
  offset?: number
  trader_id?: string
  source?: string
  user_id?: string
  sort_by?: 'created_at' | 'like_count' | 'view_count'
  sort_order?: 'asc' | 'desc'
}

// ============================================
// 查询函数
// ============================================

/**
 * 获取日记列表
 */
export async function getJournals(
  supabase: SupabaseClient,
  options: JournalListOptions = {},
  currentUserId?: string
): Promise<FollowJournal[]> {
  const {
    limit = 20,
    offset = 0,
    trader_id,
    source,
    user_id,
    sort_by = 'created_at',
    sort_order = 'desc',
  } = options

  let query = supabase
    .from('follow_journals')
    .select('*')
    .eq('status', 'active')
    .order(sort_by, { ascending: sort_order === 'asc' })
    .range(offset, offset + limit - 1)

  // 可见性过滤
  if (currentUserId) {
    // 登录用户可以看到公开的和自己的
    query = query.or(`visibility.eq.public,user_id.eq.${currentUserId}`)
  } else {
    query = query.eq('visibility', 'public')
  }

  if (trader_id) {
    query = query.eq('trader_id', trader_id)
  }

  if (source) {
    query = query.eq('source', source)
  }

  if (user_id) {
    query = query.eq('user_id', user_id)
  }

  const { data: journals, error } = await query

  if (error) {
    console.error('[follow-journals] 获取日记列表失败:', error)
    throw error
  }

  if (!journals || journals.length === 0) return []

  // 获取作者信息
  const userIds = [...new Set(journals.map(j => j.user_id))]
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url')
    .in('id', userIds)

  const profileMap = new Map<string, { handle: string; avatar_url: string | null }>()
  profiles?.forEach(p => {
    profileMap.set(p.id, { handle: p.handle || '匿名用户', avatar_url: p.avatar_url })
  })

  // 获取用户点赞状态
  let likedJournalIds = new Set<string>()
  if (currentUserId) {
    const journalIds = journals.map(j => j.id)
    const { data: likes } = await supabase
      .from('journal_likes')
      .select('journal_id')
      .eq('user_id', currentUserId)
      .in('journal_id', journalIds)

    likes?.forEach(l => likedJournalIds.add(l.journal_id))
  }

  return journals.map(journal => {
    const profile = profileMap.get(journal.user_id)
    return {
      ...journal,
      author_handle: profile?.handle || '匿名用户',
      author_avatar_url: profile?.avatar_url || null,
      user_liked: likedJournalIds.has(journal.id),
    }
  })
}

/**
 * 获取单个日记
 */
export async function getJournal(
  supabase: SupabaseClient,
  journalId: string,
  currentUserId?: string
): Promise<FollowJournal | null> {
  const { data: journal, error } = await supabase
    .from('follow_journals')
    .select('*')
    .eq('id', journalId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) {
    console.error('[follow-journals] 获取日记失败:', error)
    throw error
  }

  if (!journal) return null

  // 检查可见性
  if (journal.visibility !== 'public' && journal.user_id !== currentUserId) {
    return null
  }

  // 获取作者信息
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('handle, avatar_url')
    .eq('id', journal.user_id)
    .maybeSingle()

  // 获取点赞状态
  let userLiked = false
  if (currentUserId) {
    const { data: like } = await supabase
      .from('journal_likes')
      .select('id')
      .eq('journal_id', journalId)
      .eq('user_id', currentUserId)
      .maybeSingle()
    userLiked = !!like
  }

  // 增加浏览量
  await supabase
    .from('follow_journals')
    .update({ view_count: journal.view_count + 1 })
    .eq('id', journalId)

  return {
    ...journal,
    author_handle: profile?.handle || '匿名用户',
    author_avatar_url: profile?.avatar_url || null,
    user_liked: userLiked,
  }
}

/**
 * 获取日记评论
 */
export async function getJournalComments(
  supabase: SupabaseClient,
  journalId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<JournalComment[]> {
  const { limit = 50, offset = 0 } = options

  const { data: comments, error } = await supabase
    .from('journal_comments')
    .select('*')
    .eq('journal_id', journalId)
    .is('parent_id', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) {
    console.error('[follow-journals] 获取评论失败:', error)
    throw error
  }

  if (!comments || comments.length === 0) return []

  // 获取回复
  const commentIds = comments.map(c => c.id)
  const { data: replies } = await supabase
    .from('journal_comments')
    .select('*')
    .in('parent_id', commentIds)
    .order('created_at', { ascending: true })

  // 获取用户信息
  const allComments = [...comments, ...(replies || [])]
  const userIds = [...new Set(allComments.map(c => c.user_id))]
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url')
    .in('id', userIds)

  const profileMap = new Map<string, { handle: string; avatar_url: string | null }>()
  profiles?.forEach(p => {
    profileMap.set(p.id, { handle: p.handle || '匿名用户', avatar_url: p.avatar_url })
  })

  // 构建回复映射
  const repliesMap = new Map<string, JournalComment[]>()
  replies?.forEach(reply => {
    const profile = profileMap.get(reply.user_id)
    const enrichedReply: JournalComment = {
      ...reply,
      author_handle: profile?.handle || '匿名用户',
      author_avatar_url: profile?.avatar_url || null,
    }
    const existing = repliesMap.get(reply.parent_id) || []
    existing.push(enrichedReply)
    repliesMap.set(reply.parent_id, existing)
  })

  return comments.map(comment => {
    const profile = profileMap.get(comment.user_id)
    return {
      ...comment,
      author_handle: profile?.handle || '匿名用户',
      author_avatar_url: profile?.avatar_url || null,
      replies: repliesMap.get(comment.id) || [],
    }
  })
}

// ============================================
// 写入函数
// ============================================

/**
 * 创建日记
 */
export async function createJournal(
  supabase: SupabaseClient,
  userId: string,
  input: CreateJournalInput
): Promise<FollowJournal> {
  const { data, error } = await supabase
    .from('follow_journals')
    .insert({
      user_id: userId,
      trader_id: input.trader_id,
      source: input.source,
      title: input.title,
      content: input.content,
      profit_loss_percent: input.profit_loss_percent,
      profit_loss_amount: input.profit_loss_amount,
      start_date: input.start_date,
      end_date: input.end_date,
      initial_capital: input.initial_capital,
      screenshots: input.screenshots || [],
      tags: input.tags || [],
      visibility: input.visibility || 'public',
    })
    .select()
    .single()

  if (error) {
    console.error('[follow-journals] 创建日记失败:', error)
    throw error
  }

  return data
}

/**
 * 更新日记
 */
export async function updateJournal(
  supabase: SupabaseClient,
  journalId: string,
  userId: string,
  input: UpdateJournalInput
): Promise<FollowJournal> {
  const updateData: Record<string, unknown> = {}

  if (input.title !== undefined) updateData.title = input.title
  if (input.content !== undefined) updateData.content = input.content
  if (input.profit_loss_percent !== undefined) updateData.profit_loss_percent = input.profit_loss_percent
  if (input.profit_loss_amount !== undefined) updateData.profit_loss_amount = input.profit_loss_amount
  if (input.start_date !== undefined) updateData.start_date = input.start_date
  if (input.end_date !== undefined) updateData.end_date = input.end_date
  if (input.initial_capital !== undefined) updateData.initial_capital = input.initial_capital
  if (input.screenshots !== undefined) updateData.screenshots = input.screenshots
  if (input.tags !== undefined) updateData.tags = input.tags
  if (input.visibility !== undefined) updateData.visibility = input.visibility
  if (input.is_pinned !== undefined) updateData.is_pinned = input.is_pinned

  const { data, error } = await supabase
    .from('follow_journals')
    .update(updateData)
    .eq('id', journalId)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
    console.error('[follow-journals] 更新日记失败:', error)
    throw error
  }

  return data
}

/**
 * 删除日记（软删除）
 */
export async function deleteJournal(
  supabase: SupabaseClient,
  journalId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('follow_journals')
    .update({ status: 'deleted' })
    .eq('id', journalId)
    .eq('user_id', userId)

  if (error) {
    console.error('[follow-journals] 删除日记失败:', error)
    throw error
  }
}

/**
 * 点赞日记
 */
export async function likeJournal(
  supabase: SupabaseClient,
  journalId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('journal_likes')
    .insert({
      journal_id: journalId,
      user_id: userId,
    })

  if (error && error.code !== '23505') {  // 忽略重复键错误
    console.error('[follow-journals] 点赞失败:', error)
    throw error
  }
}

/**
 * 取消点赞
 */
export async function unlikeJournal(
  supabase: SupabaseClient,
  journalId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('journal_likes')
    .delete()
    .eq('journal_id', journalId)
    .eq('user_id', userId)

  if (error) {
    console.error('[follow-journals] 取消点赞失败:', error)
    throw error
  }
}

/**
 * 添加评论
 */
export async function addComment(
  supabase: SupabaseClient,
  journalId: string,
  userId: string,
  content: string,
  parentId?: string
): Promise<JournalComment> {
  const { data, error } = await supabase
    .from('journal_comments')
    .insert({
      journal_id: journalId,
      user_id: userId,
      content,
      parent_id: parentId || null,
    })
    .select()
    .single()

  if (error) {
    console.error('[follow-journals] 添加评论失败:', error)
    throw error
  }

  return data
}

/**
 * 删除评论
 */
export async function deleteComment(
  supabase: SupabaseClient,
  commentId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('journal_comments')
    .delete()
    .eq('id', commentId)
    .eq('user_id', userId)

  if (error) {
    console.error('[follow-journals] 删除评论失败:', error)
    throw error
  }
}
