/**
 * Supabase 服务端客户端
 * 用于 API 路由中的数据库操作
 *
 * 性能优化（Vercel Pro + Edge Runtime）：
 * 1. 单例模式 - 复用客户端实例
 * 2. Edge 兼容 - 使用全局 fetch
 * 3. 超时配置 - 防止长时间挂起
 */

import { createClient, SupabaseClient, User } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { NextRequest } from 'next/server'
import { logger } from '@/lib/logger'

// Lazy-loaded correlation ID getter (avoids importing node:async_hooks in client bundles)
let _getCorrelationId: (() => string | undefined) | null = null
function correlationId(): string | undefined {
  if (typeof window !== 'undefined') return undefined
  if (!_getCorrelationId) {
    try {
      const mod = '@/lib/api/' + 'correlation'
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _getCorrelationId = require(mod).getCorrelationId
    } catch (_err) {
      /* correlation module unavailable */
      _getCorrelationId = () => undefined
    }
  }
  return _getCorrelationId!()
}

// 构建时使用占位符，运行时使用真实环境变量
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key'

// Admin client query timeout.
// Was 30s → bumped to 60s (2026-04-09) due to cron storm contention.
// 2026-04-13: Cron schedule rewritten to eliminate storms (compute-leaderboard
// shifted to :01/:21/:41, heavy batch jobs staggered ≥3min apart).
// Reduced to 45s: enough headroom for heavy queries, but fails faster
// than 60s when Supabase is degraded. Public anon client keeps 15s.
const ADMIN_QUERY_TIMEOUT_MS = 45_000

// 缓存 admin 客户端实例（单例模式，复用连接）
let adminClientInstance: SupabaseClient<Database> | null = null

/**
 * 获取 Supabase Admin 客户端（使用 Service Role Key）
 * 用于服务端 API 路由，绕过 RLS 策略
 *
 * 注意：Supabase JS 使用 REST API (PostgREST)，不是直接 PostgreSQL 连接
 * PostgREST 服务端已内置连接池，无需客户端配置 PgBouncer
 *
 * Correlation ID is automatically injected into headers from AsyncLocalStorage context
 * when available, enabling distributed tracing across Supabase queries.
 */
export function getSupabaseAdmin(): SupabaseClient<Database> {
  if (!adminClientInstance) {
    // Re-read env vars at runtime (build time uses placeholders, runtime has real values)
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || supabaseUrl
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseServiceKey

    adminClientInstance = createClient<Database>(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      // Edge Runtime 优化 + 60s query timeout to prevent hung Vercel functions
      // (admin context — see ADMIN_QUERY_TIMEOUT_MS above for rationale)
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          // Admin query timeout + correlation ID injection
          const signal = init?.signal ?? AbortSignal.timeout(ADMIN_QUERY_TIMEOUT_MS)
          const cid = correlationId()
          if (cid) {
            const headers = new Headers(init?.headers)
            headers.set('X-Correlation-ID', cid)
            return globalThis.fetch(input, { ...init, headers, signal })
          }
          return globalThis.fetch(input, { ...init, signal })
        },
        headers: {
          'x-client-info': 'ranking-arena-server',
        },
      },
      // 数据库查询配置
      db: {
        schema: 'public',
      },
    })
  }

  return adminClientInstance
}

/**
 * 从 JWT Token 获取用户信息
 * @param token Bearer Token（不含 "Bearer " 前缀）
 */
// In-memory ban status cache — used ONLY for the "not banned" fast path, with a
// short TTL so bans propagate promptly across already-warm serverless instances.
// SECURITY: banned users are NEVER cached (banned=true always re-queries). This
// caps the worst-case delay for a ban to take effect at CLEAN_TTL seconds on
// any single instance that had previously seen the user, while still avoiding
// a DB hit on every authed request for the common clean case.
const banStatusCache = new Map<string, { ts: number }>()
const CLEAN_STATUS_TTL_MS = 10_000 // 10 seconds — bans take effect within 10s

export async function getUserFromToken(token: string): Promise<User | null> {
  if (!token) return null

  try {
    const supabase = getSupabaseAdmin()
    const { data: { user }, error } = await supabase.auth.getUser(token)

    if (error || !user) {
      return null
    }

    // Fast path: we've recently confirmed this user is NOT banned. Only the
    // "clean" result is cached, so a newly-banned user is always re-queried
    // on next request (capped at CLEAN_STATUS_TTL_MS of stale caching).
    const cached = banStatusCache.get(user.id)
    const now = Date.now()
    if (cached && now - cached.ts < CLEAN_STATUS_TTL_MS) {
      return user
    }
    if (cached) {
      // Expired — drop the entry so the Map doesn't grow unboundedly.
      banStatusCache.delete(user.id)
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('banned_at, deleted_at')
      .eq('id', user.id)
      .maybeSingle()

    const isBanned = !!(profile?.banned_at || profile?.deleted_at)

    // Only cache the CLEAN result. Banned/deleted status must always hit the DB
    // so unbans (or re-bans of the same user) reflect within one request.
    if (!isBanned) {
      // Prevent unbounded growth: clear entire map when oversized.
      // Serverless instances are short-lived, so a full clear is cheap and avoids O(n) scans.
      if (banStatusCache.size > 5000) {
        banStatusCache.clear()
      }
      banStatusCache.set(user.id, { ts: now })
    }

    return isBanned ? null : user
  } catch (error) {
    logger.error('[supabase/server] getUserFromToken 错误:', error)
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

  // 使用正则匹配，支持大小写 Bearer，并严格验证格式
  // 格式必须是 "Bearer <token>"，不接受多余空格或其他变体
  const match = authHeader.match(/^Bearer\s+(\S+)$/i)
  if (!match) return null

  return getUserFromToken(match[1])
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
    const error = Object.assign(new Error('未授权'), { statusCode: 401 })
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
    logger.error('[supabase/server] getUserHandle 错误:', error)
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
      .select('id, handle, display_name, avatar_url, bio, is_pro, exp, level, badge, locale, banned_at, deleted_at, created_at, updated_at')
      .eq('id', userId)
      .maybeSingle()
    
    if (error) throw error
    return data
  } catch (error) {
    logger.error('[supabase/server] getUserProfile 错误:', error)
    return null
  }
}

// 导出类型
export type { SupabaseClient, User }


