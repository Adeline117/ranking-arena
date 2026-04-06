/**
 * 加密工具函数
 * 用于加密存储用户的API Key和Secret
 * 使用 AES-256-GCM 加密算法
 */

import crypto from 'crypto'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('encryption')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const _TAG_LENGTH = 16
const KEY_LENGTH = 32

/**
 * 获取加密密钥
 */
function getEncryptionKey(providedKey?: string): Buffer {
  const key = providedKey || process.env.ENCRYPTION_KEY
  
  if (!key) {
    throw new Error('ENCRYPTION_KEY 环境变量未设置')
  }
  
  // 如果密钥长度不够，使用 SHA-256 哈希扩展
  if (key.length < KEY_LENGTH) {
    return crypto.createHash('sha256').update(key).digest()
  }
  
  return Buffer.from(key.slice(0, KEY_LENGTH))
}

/**
 * AES-256-GCM 加密
 * @param text 要加密的明文
 * @param key 可选的加密密钥（默认使用环境变量）
 * @returns 加密后的字符串，格式: iv:tag:encrypted
 */
export function encrypt(text: string, key?: string): string {
  if (!text) return ''
  
  try {
    const encryptionKey = getEncryptionKey(key)
    const iv = crypto.randomBytes(IV_LENGTH)
    
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv)
    
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    
    const tag = cipher.getAuthTag()
    
    // 返回格式: iv:tag:encrypted
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`
  } catch (error) {
    logger.error('加密失败', { error })
    throw new Error('加密失败')
  }
}

/**
 * AES-256-GCM 解密
 * @param encrypted 加密的字符串，格式: iv:tag:encrypted
 * @param key 可选的加密密钥（默认使用环境变量）
 * @returns 解密后的明文
 */
export function decrypt(encrypted: string, key?: string): string {
  if (!encrypted) return ''
  
  try {
    const encryptionKey = getEncryptionKey(key)
    
    // 解析加密数据
    const parts = encrypted.split(':')
    
    // 兼容旧的 Base64 格式（迁移期间）
    if (parts.length === 1) {
      // 尝试 Base64 解码（旧格式）
      try {
        return Buffer.from(encrypted, 'base64').toString('utf-8')
      } catch (_err) {
        throw new Error('无法解析加密数据')
      }
    }
    
    if (parts.length !== 3) {
      throw new Error('加密数据格式无效')
    }
    
    const [ivHex, tagHex, data] = parts
    const iv = Buffer.from(ivHex, 'hex')
    const tag = Buffer.from(tagHex, 'hex')
    
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv)
    decipher.setAuthTag(tag)
    
    let decrypted = decipher.update(data, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    
    return decrypted
  } catch (error) {
    logger.error('解密失败', { error })
    throw new Error('解密失败')
  }
}

/**
 * 验证加密密钥是否已正确配置
 */
export function isEncryptionConfigured(): boolean {
  const key = process.env.ENCRYPTION_KEY
  return Boolean(key && key.length >= 16)
}

/**
 * 生成安全的随机密钥（用于初始化）
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('hex')
}

/**
 * 哈希函数（用于非敏感数据的标识）
 */
export function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}