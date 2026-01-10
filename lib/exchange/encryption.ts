/**
 * 加密工具函数
 * 用于加密存储用户的API Key和Secret
 * 
 * 注意：在生产环境中，应该使用更安全的加密方式（如Supabase Vault）
 * 这里使用简单的Base64编码作为示例，实际应该使用AES-256加密
 */

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-change-in-production'

/**
 * 简单的加密函数（Base64编码）
 * 生产环境应该使用AES-256加密
 */
export function encrypt(text: string): string {
  if (!text) return ''
  
  // 简单的Base64编码（仅用于演示）
  // 生产环境应该使用 crypto.createCipheriv 和 AES-256
  try {
    const encoded = Buffer.from(text).toString('base64')
    return encoded
  } catch (error) {
    console.error('[encryption] 加密失败:', error)
    throw new Error('加密失败')
  }
}

/**
 * 简单的解密函数（Base64解码）
 * 生产环境应该使用AES-256解密
 */
export function decrypt(encrypted: string): string {
  if (!encrypted) return ''
  
  try {
    const decoded = Buffer.from(encrypted, 'base64').toString('utf-8')
    return decoded
  } catch (error) {
    console.error('[encryption] 解密失败:', error)
    throw new Error('解密失败')
  }
}

/**
 * 验证加密密钥是否已配置
 */
export function isEncryptionConfigured(): boolean {
  return ENCRYPTION_KEY !== 'default-key-change-in-production'
}


