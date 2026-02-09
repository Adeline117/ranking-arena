/**
 * 统一环境配置模块
 * 使用 Zod 验证环境变量，提供类型安全的配置访问
 */

import { z } from 'zod'
import { logger } from '@/lib/logger'

// ============================================
// 环境变量 Schema 定义
// ============================================

const envSchema = z.object({
  // Node 环境
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Supabase 配置
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('Supabase URL 格式无效'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, '缺少 Supabase Anon Key'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, '缺少 Supabase Service Role Key').optional(),

  // Redis Cloud 配置
  REDIS_HOST: z.string().min(1, '缺少 Redis Host').optional(),
  REDIS_PORT: z.string().optional(),
  REDIS_PASSWORD: z.string().min(1, '缺少 Redis Password').optional(),
  REDIS_USERNAME: z.string().optional(),

  // 应用配置
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

  // 加密密钥
  ENCRYPTION_KEY: z.string().min(32, '加密密钥至少 32 字符').optional(),

  // Sentry 配置（可选）
  SENTRY_DSN: z.string().url().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),

  // Vercel 配置（自动注入）
  VERCEL_ENV: z.enum(['development', 'preview', 'production']).optional(),
  VERCEL_URL: z.string().optional(),
})

// ============================================
// 环境变量解析
// ============================================

function parseEnv() {
  // 在服务端解析所有环境变量
  if (typeof window === 'undefined') {
    const result = envSchema.safeParse(process.env)
    
    if (!result.success) {
      logger.error('[ERROR] Environment variable configuration error:')
      result.error.issues.forEach(issue => {
        logger.error(`  - ${issue.path.join('.')}: ${issue.message}`)
      })
      
      // 开发环境提供详细错误，生产环境抛出通用错误
      if (process.env.NODE_ENV === 'development') {
        throw new Error(`环境变量配置错误: ${result.error.message}`)
      }
      throw new Error('服务器配置错误')
    }
    
    return result.data
  }
  
  // 客户端只能访问 NEXT_PUBLIC_ 开头的变量
  return {
    NODE_ENV: process.env.NODE_ENV as 'development' | 'production' | 'test' || 'development',
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  } as z.infer<typeof envSchema>
}

// ============================================
// 导出配置
// ============================================

export const env = parseEnv()

// 类型导出
export type Env = z.infer<typeof envSchema>

// ============================================
// 辅助函数
// ============================================

/**
 * 检查是否为生产环境
 */
export function isProduction(): boolean {
  return env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production'
}

/**
 * 检查是否为开发环境
 */
export function isDevelopment(): boolean {
  return env.NODE_ENV === 'development'
}

/**
 * 检查是否为测试环境
 */
export function isTest(): boolean {
  return env.NODE_ENV === 'test'
}

/**
 * 获取应用 URL（自动处理 Vercel 部署）
 */
export function getAppUrl(): string {
  if (env.VERCEL_URL) {
    return `https://${env.VERCEL_URL}`
  }
  return env.NEXT_PUBLIC_APP_URL
}

/**
 * 检查 Redis 是否可用
 */
export function isRedisAvailable(): boolean {
  return !!(env.REDIS_HOST && env.REDIS_PASSWORD)
}

/**
 * 检查 Sentry 是否配置
 */
export function isSentryConfigured(): boolean {
  return !!(env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN)
}
