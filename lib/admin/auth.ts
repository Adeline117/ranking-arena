/**
 * 管理员认证工具
 * 统一前端和后端的管理员验证逻辑
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'

// 管理员邮箱白名单（与前端 useAdminAuth 保持一致）
// 必须通过环境变量 ADMIN_EMAILS 配置，生产环境不能为空
const ADMIN_EMAILS: string[] = process.env.ADMIN_EMAILS
  ? process.env.ADMIN_EMAILS.split(',').map(e => e.trim()).filter(e => e.length > 0)
  : [] // 安全默认值：空数组，不允许任何未配置的管理员

// SECURITY: Warn if no admin emails configured in production
if (ADMIN_EMAILS.length === 0 && process.env.NODE_ENV === 'production') {
  console.warn('[SECURITY] ADMIN_EMAILS not configured — no admin access available')
}

export { getSupabaseAdmin }

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
 * 验证管理员或版主身份
 * 允许 role='moderator' 或 role='admin' 的用户
 */
export async function verifyModeratorOrAdmin(
  supabase: SupabaseClient,
  authHeader: string | null
): Promise<{ id: string; email: string; role: 'admin' | 'moderator' } | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return null
  }

  // 方法1: 邮箱白名单 (admin only)
  const isAdminByEmail = user.email && ADMIN_EMAILS.includes(user.email)

  // 方法2: 数据库角色
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const isAdminByRole = profile?.role === 'admin'
  const isModeratorByRole = profile?.role === 'moderator'

  if (isAdminByEmail || isAdminByRole) {
    return { id: user.id, email: user.email || '', role: 'admin' }
  }

  if (isModeratorByRole) {
    return { id: user.id, email: user.email || '', role: 'moderator' }
  }

  return null
}

/**
 * 检查用户是否是管理员或版主
 */
export function isModeratorOrAdmin(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'moderator'
}

/**
 * 获取管理员邮箱列表（用于调试）
 */
export function getAdminEmails(): string[] {
  return ADMIN_EMAILS
}
