/**
 * 用户数据导出
 * GDPR 第 20 条数据可携权
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'

/**
 * 用户数据导出结果
 */
export interface UserDataExport {
  exportedAt: string
  userId: string
  profile: object | null
  posts: object[]
  comments: object[]
  follows: object[]
  bookmarks: object[]
  notifications: object[]
  settings: object | null
}

/**
 * 导出用户的所有数据
 */
export async function exportUserData(userId: string): Promise<UserDataExport> {
  const supabase = getSupabaseAdmin()
  const exportedAt = new Date().toISOString()

  // 并行获取所有用户数据
  const [
    profileResult,
    postsResult,
    commentsResult,
    followsResult,
    bookmarksResult,
    notificationsResult,
  ] = await Promise.all([
    // 用户资料
    supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle(),
    
    // 用户帖子
    supabase
      .from('posts')
      .select('id, title, content, created_at, updated_at, like_count, comment_count')
      .eq('author_id', userId)
      .order('created_at', { ascending: false }),
    
    // 用户评论
    supabase
      .from('comments')
      .select('id, content, created_at, post_id')
      .eq('author_id', userId)
      .order('created_at', { ascending: false }),
    
    // 关注列表
    supabase
      .from('trader_follows')
      .select('trader_id, created_at')
      .eq('user_id', userId),
    
    // 收藏列表
    supabase
      .from('bookmarks')
      .select('post_id, created_at')
      .eq('user_id', userId),
    
    // 通知
    supabase
      .from('notifications')
      .select('id, type, message, created_at, read_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  return {
    exportedAt,
    userId,
    profile: profileResult.data || null,
    posts: postsResult.data || [],
    comments: commentsResult.data || [],
    follows: followsResult.data || [],
    bookmarks: bookmarksResult.data || [],
    notifications: notificationsResult.data || [],
    settings: null, // 如果有用户设置表，在这里添加
  }
}

/**
 * 生成数据导出文件
 */
export function generateExportFile(data: UserDataExport): string {
  return JSON.stringify(data, null, 2)
}

/**
 * 数据导出请求记录
 */
export interface DataExportRequest {
  id: string
  userId: string
  requestedAt: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  completedAt?: string
  downloadUrl?: string
  expiresAt?: string
}

/**
 * 创建数据导出请求
 * 实际实现中，这应该创建一个异步任务
 */
export async function createDataExportRequest(userId: string): Promise<DataExportRequest> {
  const requestId = `export_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
  
  // 在实际实现中，这里应该：
  // 1. 在数据库中创建请求记录
  // 2. 触发异步任务处理导出
  // 3. 完成后通过邮件通知用户
  
  return {
    id: requestId,
    userId,
    requestedAt: new Date().toISOString(),
    status: 'pending',
  }
}
