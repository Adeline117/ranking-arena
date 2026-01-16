/**
 * Supabase 服务端客户端
 * 用于 API 路由中的数据库操作
 */

import { createClient, SupabaseClient, User } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 缓存 admin 客户端实例
let adminClientInstance: SupabaseClient | null = null

/**
 * 获取 Supabase Admin 客户端（使用 Service Role Key）
 * 用于服务端 API 路由，绕过 RLS 策略
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!adminClientInstance) {
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase 环境变量未配置: NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
    }
    
    adminClientInstance = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  }
  
  return adminClientInstance
}

/**
 * 从 JWT Token 获取用户信息
 * @param token Bearer Token（不含 "Bearer " 前缀）
 */
export async function getUserFromToken(token: string): Promise<User | null> {
  if (!token) return null
  
  try {
    const supabase = getSupabaseAdmin()
    const { data: { user }, error } = await supabase.auth.getUser(token)
    
    if (error || !user) {
      return null
    }
    
    return user
  } catch (error) {
    console.error('[supabase/server] getUserFromToken 错误:', error)
    return null
  }
}

/**
 * 从请求中获取认证用户
 * @param request NextRequest 对象
 * @returns 用户对象或 null
 */
export async function getAuthUser(request: NextRequest): Promise<User | null> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader) return null
  
  const token = authHeader.replace('Bearer ', '')
  return getUserFromToken(token)
}

/**
 * 需要认证的请求辅助函数
 * 如果未认证，抛出错误
 * @param request NextRequest 对象
 * @returns 认证的用户对象
 * @throws Error 如果未认证
 */
export async function requireAuth(request: NextRequest): Promise<User> {
  const user = await getAuthUser(request)
  
  if (!user) {
    const error = new Error('未授权')
    ;(error as any).statusCode = 401
    throw error
  }
  
  return user
}

/**
 * 获取用户的 handle（用户名）
 * @param userId 用户 ID
 * @param fallbackEmail 备用邮箱（用于生成默认 handle）
 */
export async function getUserHandle(userId: string, fallbackEmail?: string): Promise<string> {
  try {
    const supabase = getSupabaseAdmin()
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', userId)
      .maybeSingle()
    
    if (profile?.handle) {
      return profile.handle
    }
    
    // 使用邮箱前缀作为备用
    if (fallbackEmail) {
      return fallbackEmail.split('@')[0]
    }
    
    return userId.slice(0, 8)
  } catch (error) {
    console.error('[supabase/server] getUserHandle 错误:', error)
    return userId.slice(0, 8)
  }
}

/**
 * 获取用户 profile
 * @param userId 用户 ID
 */
export async function getUserProfile(userId: string) {
  try {
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
    
    if (error) throw error
    return data
  } catch (error) {
    console.error('[supabase/server] getUserProfile 错误:', error)
    return null
  }
}

// 导出类型
export type { SupabaseClient, User }


