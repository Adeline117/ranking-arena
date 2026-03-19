/**
 * API 辅助函数统一导出
 */

export * from './response'
export * from './validation'
export * from './middleware'
export * from './errors'
export * from './pagination'
export * from './etag'
export * from './with-admin-auth'

// 重新导出 supabase server 函数
export {
  getSupabaseAdmin,
  getUserFromToken,
  getAuthUser,
  requireAuth,
  getUserHandle,
  getUserProfile,
} from '@/lib/supabase/server'

// 重新导出限流函数
export {
  checkRateLimit,
  checkRateLimitFull,
  getIdentifier,
  RateLimitPresets,
} from '@/lib/utils/rate-limit'
