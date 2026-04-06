/**
 * 安全加密模块 - CEX API Key 保护
 *
 * 安全特性:
 * 1. PBKDF2 密钥派生（100,000 次迭代）
 * 2. 密钥分拆存储（XOR 分片 + 环境变量 + 数据库）
 * 3. 密钥版本管理（支持轮换）
 * 4. AES-256-GCM 认证加密
 * 5. 安全审计日志
 *
 * 存储方案:
 * - 分片 1: 存储在环境变量 (ENCRYPTION_KEY_PART1)
 * - 分片 2: 存储在数据库 (user_encryption_keys 表)
 * - 实际密钥 = 分片1 XOR 分片2
 *
 * 即使数据库被拖库，没有环境变量分片也无法解密
 */

import crypto from 'crypto'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('secure-encryption')

// ============================================
// 常量配置
// ============================================

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32 // AES-256 需要 32 字节密钥
const IV_LENGTH = 16
const SALT_LENGTH = 32
const _AUTH_TAG_LENGTH = 16

// PBKDF2 配置
const PBKDF2_ITERATIONS = 100000
const PBKDF2_DIGEST = 'sha512'

// 当前密钥版本
const CURRENT_KEY_VERSION = 1

// ============================================
// 类型定义
// ============================================

interface EncryptedData {
  version: number
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

interface KeyParts {
  part1: Buffer // 环境变量存储
  part2: Buffer // 数据库存储
}

// ============================================
// 密钥派生（PBKDF2）
// ============================================

/**
 * 使用 PBKDF2 从密码派生加密密钥
 * 比简单的 SHA-256 更安全，抵抗暴力破解
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
  )
}

// ============================================
// 密钥分拆（XOR 方案）
// ============================================

/**
 * 将密钥分拆为两部分
 * key = part1 XOR part2
 */
export function splitKey(key: Buffer): KeyParts {
  // 生成随机分片1
  const part1 = crypto.randomBytes(KEY_LENGTH)

  // 计算分片2 = key XOR part1
  const part2 = Buffer.alloc(KEY_LENGTH)
  for (let i = 0; i < KEY_LENGTH; i++) {
    part2[i] = key[i] ^ part1[i]
  }

  return { part1, part2 }
}

/**
 * 从两个分片恢复密钥
 */
export function combineKeyParts(part1: Buffer, part2: Buffer): Buffer {
  if (part1.length !== KEY_LENGTH || part2.length !== KEY_LENGTH) {
    throw new Error('Invalid key part length')
  }

  const key = Buffer.alloc(KEY_LENGTH)
  for (let i = 0; i < KEY_LENGTH; i++) {
    key[i] = part1[i] ^ part2[i]
  }

  return key
}

// ============================================
// 安全的密钥获取
// ============================================

/**
 * 获取加密密钥
 * 支持两种模式:
 * 1. 简单模式: 仅使用环境变量
 * 2. 分拆模式: 环境变量 + 数据库分片
 */
export function getEncryptionKey(dbKeyPart?: string): Buffer {
  const envKeyPart1 = process.env.ENCRYPTION_KEY_PART1 || process.env.ENCRYPTION_KEY

  if (!envKeyPart1) {
    throw new Error('ENCRYPTION_KEY_PART1 或 ENCRYPTION_KEY 环境变量未设置')
  }

  // 简单模式：只使用环境变量
  if (!dbKeyPart) {
    const salt = Buffer.from(process.env.ENCRYPTION_SALT || 'arena-default-salt')
    return deriveKey(envKeyPart1, salt)
  }

  // 分拆模式：组合两个分片
  const part1 = Buffer.from(envKeyPart1, 'hex')
  const part2 = Buffer.from(dbKeyPart, 'hex')

  return combineKeyParts(part1, part2)
}

// ============================================
// 加密函数
// ============================================

/**
 * AES-256-GCM 加密
 *
 * 输出格式: JSON { version, salt, iv, tag, ciphertext }
 * - version: 密钥版本（支持轮换）
 * - salt: PBKDF2 盐值
 * - iv: 初始化向量
 * - tag: GCM 认证标签
 * - ciphertext: 密文
 */
export function encryptSecure(
  plaintext: string,
  dbKeyPart?: string
): string {
  if (!plaintext) return ''

  try {
    // 生成随机盐和 IV
    const salt = crypto.randomBytes(SALT_LENGTH)
    const iv = crypto.randomBytes(IV_LENGTH)

    // 获取加密密钥
    const baseKey = getEncryptionKey(dbKeyPart)

    // 使用 PBKDF2 派生实际加密密钥
    const encryptionKey = deriveKey(baseKey.toString('hex'), salt)

    // AES-256-GCM 加密
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv)

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex')
    ciphertext += cipher.final('hex')

    const tag = cipher.getAuthTag()

    // 构建加密数据结构
    const encryptedData: EncryptedData = {
      version: CURRENT_KEY_VERSION,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext,
    }

    return JSON.stringify(encryptedData)
  } catch (error) {
    logger.error('安全加密失败', { error })
    throw new Error('加密失败')
  }
}

/**
 * AES-256-GCM 解密
 */
export function decryptSecure(
  encrypted: string,
  dbKeyPart?: string
): string {
  if (!encrypted) return ''

  try {
    // 解析加密数据
    let encryptedData: EncryptedData

    try {
      encryptedData = JSON.parse(encrypted)
    } catch (_err) {
      // 不是 JSON 格式，可能是旧格式
      // 安全起见，拒绝解密旧格式数据
      throw new Error('不支持的加密格式，请重新加密数据')
    }

    // 检查版本
    if (encryptedData.version > CURRENT_KEY_VERSION) {
      throw new Error(`不支持的密钥版本: ${encryptedData.version}`)
    }

    // 解析各组件
    const salt = Buffer.from(encryptedData.salt, 'hex')
    const iv = Buffer.from(encryptedData.iv, 'hex')
    const tag = Buffer.from(encryptedData.tag, 'hex')

    // 获取加密密钥
    const baseKey = getEncryptionKey(dbKeyPart)

    // 使用 PBKDF2 派生解密密钥
    const decryptionKey = deriveKey(baseKey.toString('hex'), salt)

    // AES-256-GCM 解密
    const decipher = crypto.createDecipheriv(ALGORITHM, decryptionKey, iv)
    decipher.setAuthTag(tag)

    let plaintext = decipher.update(encryptedData.ciphertext, 'hex', 'utf8')
    plaintext += decipher.final('utf8')

    return plaintext
  } catch (error) {
    logger.error('安全解密失败', { error })
    throw new Error('解密失败')
  }
}

// ============================================
// 密钥轮换支持
// ============================================

/**
 * 生成新的密钥分片对
 * 用于密钥轮换
 */
export function generateNewKeyParts(): {
  envPart: string
  dbPart: string
} {
  const masterKey = crypto.randomBytes(KEY_LENGTH)
  const { part1, part2 } = splitKey(masterKey)

  return {
    envPart: part1.toString('hex'),
    dbPart: part2.toString('hex'),
  }
}

/**
 * 重新加密数据（用于密钥轮换）
 */
export function reencrypt(
  encrypted: string,
  oldDbKeyPart: string | undefined,
  newDbKeyPart: string | undefined
): string {
  // 使用旧密钥解密
  const plaintext = decryptSecure(encrypted, oldDbKeyPart)

  // 使用新密钥加密
  return encryptSecure(plaintext, newDbKeyPart)
}

// ============================================
// 审计日志
// ============================================

/**
 * 记录敏感操作（用于安全审计）
 */
export function auditLog(
  operation: 'encrypt' | 'decrypt' | 'key_rotation',
  userId: string,
  exchangeId?: string,
  success: boolean = true
): void {
  const logData = {
    operation,
    userId,
    exchangeId,
    success,
    timestamp: new Date().toISOString(),
    // 不记录实际密钥或明文数据
  }

  if (success) {
    logger.info('敏感操作审计', logData)
  } else {
    logger.warn('敏感操作失败', logData)
  }
}

// ============================================
// 迁移工具
// ============================================

/**
 * 检查是否为旧格式加密数据
 */
export function isLegacyFormat(encrypted: string): boolean {
  try {
    JSON.parse(encrypted)
    return false // 新 JSON 格式
  } catch (_err) {
    // 检查是否为旧的 iv:tag:ciphertext 格式
    const parts = encrypted.split(':')
    if (parts.length === 3) {
      return true // 旧格式
    }
    // 可能是 Base64 明文（极不安全）
    return true
  }
}

/**
 * 从旧格式迁移到新格式
 * 注意：这需要旧的加密密钥
 */
export async function migrateFromLegacy(
  legacyEncrypted: string,
  legacyDecryptFn: (data: string) => string,
  newDbKeyPart?: string
): Promise<string> {
  // 使用旧方法解密
  const plaintext = legacyDecryptFn(legacyEncrypted)

  // 使用新方法加密
  return encryptSecure(plaintext, newDbKeyPart)
}

// ============================================
// HSM 集成接口（预留）
// ============================================

/**
 * HSM 加密接口
 * 当部署 HSM 时，可以实现此接口
 */
export interface HSMProvider {
  encrypt(plaintext: Buffer): Promise<Buffer>
  decrypt(ciphertext: Buffer): Promise<Buffer>
  sign(data: Buffer): Promise<Buffer>
  verify(data: Buffer, signature: Buffer): Promise<boolean>
}

/**
 * 获取 HSM Provider
 * 默认返回 null，使用软件加密
 * 部署 HSM 后可配置
 */
export function getHSMProvider(): HSMProvider | null {
  const hsmEndpoint = process.env.HSM_ENDPOINT
  const hsmKeyId = process.env.HSM_KEY_ID

  if (!hsmEndpoint || !hsmKeyId) {
    return null
  }

  // HSM integration not yet implemented
  logger.info('HSM config detected but not yet integrated')
  return null
}

// ============================================
// 便捷函数
// ============================================

/**
 * 加密 API Key（便捷函数）
 */
export function encryptApiKey(apiKey: string, userId?: string): string {
  if (userId) {
    auditLog('encrypt', userId, undefined, true)
  }
  return encryptSecure(apiKey)
}

/**
 * 解密 API Key（便捷函数）
 */
export function decryptApiKey(encrypted: string, userId?: string): string {
  if (userId) {
    auditLog('decrypt', userId, undefined, true)
  }
  return decryptSecure(encrypted)
}

// ============================================
// 导出
// ============================================

export {
  CURRENT_KEY_VERSION,
  KEY_LENGTH,
  PBKDF2_ITERATIONS,
}
