/**
 * 用户数据删除
 * GDPR 第 17 条被遗忘权
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'

/**
 * 数据删除结果
 */
export interface DataDeletionResult {
  success: boolean
  deletedAt: string
  deletedItems: {
    profile: boolean
    posts: number
    comments: number
    follows: number
    bookmarks: number
    notifications: number
    likes: number
    votes: number
  }
  errors: string[]
}

/**
 * 删除用户的所有数据
 * 
 * 注意：这是不可逆操作！
 * 在实际实现中，应该：
 * 1. 要求用户二次确认
 * 2. 发送确认邮件
 * 3. 设置冷却期（如 30 天）
 * 4. 保留法律要求的数据
 */
export async function deleteUserData(userId: string): Promise<DataDeletionResult> {
  const supabase = getSupabaseAdmin()
  const deletedAt = new Date().toISOString()
  const errors: string[] = []
  
  const deletedItems = {
    profile: false,
    posts: 0,
    comments: 0,
    follows: 0,
    bookmarks: 0,
    notifications: 0,
    likes: 0,
    votes: 0,
  }

  // 删除顺序很重要，需要先删除关联数据
  
  // 1. 删除点赞
  try {
    const { count } = await supabase
      .from('post_likes')
      .delete()
      .eq('user_id', userId)
    deletedItems.likes = count || 0
  } catch (error) {
    errors.push(`Failed to delete likes: ${error}`)
  }
  
  // 2. 删除投票
  try {
    const { count } = await supabase
      .from('post_votes')
      .delete()
      .eq('user_id', userId)
    deletedItems.votes = count || 0
  } catch (error) {
    errors.push(`Failed to delete votes: ${error}`)
  }
  
  // 3. 删除收藏
  try {
    const { count } = await supabase
      .from('bookmarks')
      .delete()
      .eq('user_id', userId)
    deletedItems.bookmarks = count || 0
  } catch (error) {
    errors.push(`Failed to delete bookmarks: ${error}`)
  }
  
  // 4. 删除关注
  try {
    const { count } = await supabase
      .from('trader_follows')
      .delete()
      .eq('user_id', userId)
    deletedItems.follows = count || 0
  } catch (error) {
    errors.push(`Failed to delete follows: ${error}`)
  }
  
  // 5. 删除通知
  try {
    const { count } = await supabase
      .from('notifications')
      .delete()
      .eq('user_id', userId)
    deletedItems.notifications = count || 0
  } catch (error) {
    errors.push(`Failed to delete notifications: ${error}`)
  }
  
  // 6. 匿名化评论（保留内容但移除作者关联）
  try {
    const { count } = await supabase
      .from('comments')
      .update({
        author_id: null,
        author_handle: '[已删除]',
      })
      .eq('author_id', userId)
    deletedItems.comments = count || 0
  } catch (error) {
    errors.push(`Failed to anonymize comments: ${error}`)
  }
  
  // 7. 匿名化帖子（可选：或者完全删除）
  try {
    const { count } = await supabase
      .from('posts')
      .update({
        author_id: null,
        author_handle: '[已删除]',
      })
      .eq('author_id', userId)
    deletedItems.posts = count || 0
  } catch (error) {
    errors.push(`Failed to anonymize posts: ${error}`)
  }
  
  // 8. 删除用户资料
  try {
    const { error } = await supabase
      .from('user_profiles')
      .delete()
      .eq('id', userId)
    
    if (!error) {
      deletedItems.profile = true
    } else {
      errors.push(`Failed to delete profile: ${error.message}`)
    }
  } catch (error) {
    errors.push(`Failed to delete profile: ${error}`)
  }
  
  // 9. 删除 Supabase Auth 用户（需要 admin 权限）
  try {
    const { error } = await supabase.auth.admin.deleteUser(userId)
    if (error) {
      errors.push(`Failed to delete auth user: ${error.message}`)
    }
  } catch (error) {
    errors.push(`Failed to delete auth user: ${error}`)
  }

  return {
    success: errors.length === 0,
    deletedAt,
    deletedItems,
    errors,
  }
}

/**
 * 数据删除请求
 */
export interface DataDeletionRequest {
  id: string
  userId: string
  requestedAt: string
  scheduledDeletionAt: string  // 冷却期后的删除时间
  status: 'pending' | 'scheduled' | 'processing' | 'completed' | 'cancelled'
  completedAt?: string
  cancellationReason?: string
}

/**
 * 创建数据删除请求
 * 
 * 在实际实现中：
 * 1. 设置 30 天冷却期
 * 2. 发送确认邮件
 * 3. 允许在冷却期内取消
 */
export async function createDataDeletionRequest(userId: string): Promise<DataDeletionRequest> {
  const requestId = `delete_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
  const requestedAt = new Date()
  const scheduledDeletionAt = new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1000) // 30 天后
  
  // 在实际实现中，这里应该：
  // 1. 在数据库中创建请求记录
  // 2. 发送确认邮件
  // 3. 设置定时任务
  
  return {
    id: requestId,
    userId,
    requestedAt: requestedAt.toISOString(),
    scheduledDeletionAt: scheduledDeletionAt.toISOString(),
    status: 'scheduled',
  }
}

/**
 * 取消数据删除请求
 */
export async function cancelDataDeletionRequest(
  requestId: string,
  reason?: string
): Promise<{ success: boolean; message: string }> {
  // 在实际实现中，这里应该：
  // 1. 检查请求是否存在且未执行
  // 2. 更新状态为 cancelled
  // 3. 取消定时任务
  
  return {
    success: true,
    message: '删除请求已取消',
  }
}
