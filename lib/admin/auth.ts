/**
 * 管理员认证工具
 * 统一前端和后端的管理员验证逻辑
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

// 管理员邮箱白名单（与前端 useAdminAuth 保持一致）
// 可以通过环境变量覆盖
const ADMIN_EMAILS: string[] = process.env.ADMIN_EMAILS
  ? process.env.ADMIN_EMAILS.split(',').map(e => e.trim())
  : ['test@example.com']

/**
 * 创建 Supabase Admin 客户端
 */
export function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Supabase 环境变量缺失: SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient(url, key, { auth: { persistSession: false } })
}

/**
 * 验证管理员身份
 * 支持两种方式：
 * 1. 邮箱在白名单中
 * 2. 数据库中 role === 'admin'
 */
export async function verifyAdmin(
  supabase: SupabaseClient,
  authHeader: string | null
): Promise<{ id: string; email: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return null
  }

  // 方法1: 邮箱白名单
  const isAdminByEmail = user.email && ADMIN_EMAILS.includes(user.email)

  // 方法2: 数据库角色
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const isAdminByRole = profile?.role === 'admin'

  if (!isAdminByEmail && !isAdminByRole) {
    return null
  }

  return { id: user.id, email: user.email || '' }
}

/**
 * 获取管理员邮箱列表（用于调试）
 */
export function getAdminEmails(): string[] {
  return ADMIN_EMAILS
}
