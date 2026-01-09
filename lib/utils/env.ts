/**
 * 环境变量验证工具
 */

/**
 * 获取必需的环境变量，如果不存在则抛出错误
 */
export function getRequiredEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

/**
 * 获取可选的环境变量，如果不存在则返回默认值
 */
export function getOptionalEnv(key: string, defaultValue: string = ''): string {
  return process.env[key] || defaultValue
}

/**
 * 验证 Supabase 环境变量
 */
export function validateSupabaseEnv(): {
  url: string
  anonKey: string
} {
  return {
    url: getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: getRequiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  }
}

/**
 * 获取应用 URL
 */
export function getAppUrl(): string {
  return getOptionalEnv('NEXT_PUBLIC_APP_URL', 'https://www.arenafi.org')
}

