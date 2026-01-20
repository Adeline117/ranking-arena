/**
 * 加密模块单元测试
 */

import {
  encrypt,
  decrypt,
  isEncryptionConfigured,
  generateEncryptionKey,
  hash,
} from '../encryption'

// 测试用密钥
const TEST_KEY = 'test-encryption-key-32-chars-long'

// ============================================
// 加密解密测试
// ============================================

describe('encrypt', () => {
  test('空字符串返回空字符串', () => {
    expect(encrypt('', TEST_KEY)).toBe('')
  })

  test('加密后格式正确 (iv:tag:data)', () => {
    const encrypted = encrypt('hello world', TEST_KEY)
    const parts = encrypted.split(':')
    expect(parts.length).toBe(3)
    
    // IV 是 16 字节 = 32 个十六进制字符
    expect(parts[0].length).toBe(32)
    // Tag 是 16 字节 = 32 个十六进制字符
    expect(parts[1].length).toBe(32)
    // 数据部分存在
    expect(parts[2].length).toBeGreaterThan(0)
  })

  test('相同明文加密结果不同（随机 IV）', () => {
    const text = 'test message'
    const encrypted1 = encrypt(text, TEST_KEY)
    const encrypted2 = encrypt(text, TEST_KEY)
    expect(encrypted1).not.toBe(encrypted2)
  })

  test('不同明文加密结果不同', () => {
    const encrypted1 = encrypt('message1', TEST_KEY)
    const encrypted2 = encrypt('message2', TEST_KEY)
    expect(encrypted1).not.toBe(encrypted2)
  })
})

describe('decrypt', () => {
  test('空字符串返回空字符串', () => {
    expect(decrypt('', TEST_KEY)).toBe('')
  })

  test('正确解密加密的数据', () => {
    const original = 'hello world 你好世界'
    const encrypted = encrypt(original, TEST_KEY)
    const decrypted = decrypt(encrypted, TEST_KEY)
    expect(decrypted).toBe(original)
  })

  test('解密特殊字符', () => {
    const original = '!@#$%^&*()_+-={}[]|\\:";\'<>?,./~`'
    const encrypted = encrypt(original, TEST_KEY)
    const decrypted = decrypt(encrypted, TEST_KEY)
    expect(decrypted).toBe(original)
  })

  test('解密 JSON 数据', () => {
    const original = JSON.stringify({ key: 'value', nested: { a: 1 } })
    const encrypted = encrypt(original, TEST_KEY)
    const decrypted = decrypt(encrypted, TEST_KEY)
    expect(decrypted).toBe(original)
    expect(JSON.parse(decrypted)).toEqual({ key: 'value', nested: { a: 1 } })
  })

  test('解密长文本', () => {
    const original = 'a'.repeat(10000)
    const encrypted = encrypt(original, TEST_KEY)
    const decrypted = decrypt(encrypted, TEST_KEY)
    expect(decrypted).toBe(original)
  })

  test('错误的密钥无法解密', () => {
    const original = 'secret message'
    const encrypted = encrypt(original, TEST_KEY)
    expect(() => decrypt(encrypted, 'wrong-key-wrong-key-32-chars!!!')).toThrow()
  })

  test('篡改的数据无法解密', () => {
    const encrypted = encrypt('test', TEST_KEY)
    const [iv, tag, data] = encrypted.split(':')
    
    // 篡改数据
    const tamperedData = data.slice(0, -2) + '00'
    const tampered = `${iv}:${tag}:${tamperedData}`
    
    expect(() => decrypt(tampered, TEST_KEY)).toThrow()
  })

  test('无效格式处理', () => {
    // 只有两部分的格式会抛出错误
    expect(() => decrypt('only:two', TEST_KEY)).toThrow()
    // 四部分的格式会抛出错误
    expect(() => decrypt('four:parts:here:now', TEST_KEY)).toThrow()
    // 注意：单部分的字符串会尝试 Base64 解码作为旧格式兼容
  })
})

// ============================================
// 加密配置测试
// ============================================

describe('isEncryptionConfigured', () => {
  const originalEnv = process.env.ENCRYPTION_KEY

  afterEach(() => {
    // 恢复原始环境变量
    if (originalEnv !== undefined) {
      process.env.ENCRYPTION_KEY = originalEnv
    } else {
      delete process.env.ENCRYPTION_KEY
    }
  })

  test('未设置环境变量返回 false', () => {
    delete process.env.ENCRYPTION_KEY
    expect(isEncryptionConfigured()).toBe(false)
  })

  test('密钥太短返回 false', () => {
    process.env.ENCRYPTION_KEY = 'short'
    expect(isEncryptionConfigured()).toBe(false)
  })

  test('密钥足够长返回 true', () => {
    process.env.ENCRYPTION_KEY = 'this-is-a-long-enough-key-16ch'
    expect(isEncryptionConfigured()).toBe(true)
  })
})

// ============================================
// 密钥生成测试
// ============================================

describe('generateEncryptionKey', () => {
  test('生成 64 字符的十六进制密钥', () => {
    const key = generateEncryptionKey()
    expect(key.length).toBe(64) // 32 字节 = 64 个十六进制字符
  })

  test('只包含十六进制字符', () => {
    const key = generateEncryptionKey()
    expect(key).toMatch(/^[0-9a-f]+$/i)
  })

  test('每次生成不同的密钥', () => {
    const key1 = generateEncryptionKey()
    const key2 = generateEncryptionKey()
    expect(key1).not.toBe(key2)
  })

  test('生成的密钥可用于加密', () => {
    const key = generateEncryptionKey()
    const text = 'test message'
    const encrypted = encrypt(text, key)
    const decrypted = decrypt(encrypted, key)
    expect(decrypted).toBe(text)
  })
})

// ============================================
// 哈希函数测试
// ============================================

describe('hash', () => {
  test('生成 64 字符的十六进制哈希', () => {
    const result = hash('test')
    expect(result.length).toBe(64) // SHA-256 = 32 字节 = 64 个十六进制字符
  })

  test('只包含十六进制字符', () => {
    const result = hash('test')
    expect(result).toMatch(/^[0-9a-f]+$/i)
  })

  test('相同输入产生相同哈希', () => {
    const hash1 = hash('test')
    const hash2 = hash('test')
    expect(hash1).toBe(hash2)
  })

  test('不同输入产生不同哈希', () => {
    const hash1 = hash('test1')
    const hash2 = hash('test2')
    expect(hash1).not.toBe(hash2)
  })

  test('空字符串有有效哈希', () => {
    const result = hash('')
    expect(result.length).toBe(64)
  })

  test('哈希已知值验证', () => {
    // SHA-256 of "hello" is well-known
    const result = hash('hello')
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})

// ============================================
// 端到端测试
// ============================================

describe('加密解密端到端', () => {
  test('API 密钥场景', () => {
    const apiKey = 'sk-xxxx-yyyy-zzzz-1234567890abcdef'
    const apiSecret = 'very-secret-api-secret-key-12345'
    
    const encryptedKey = encrypt(apiKey, TEST_KEY)
    const encryptedSecret = encrypt(apiSecret, TEST_KEY)
    
    expect(decrypt(encryptedKey, TEST_KEY)).toBe(apiKey)
    expect(decrypt(encryptedSecret, TEST_KEY)).toBe(apiSecret)
  })

  test('用户敏感数据场景', () => {
    const userData = JSON.stringify({
      email: 'user@example.com',
      phone: '+1234567890',
      address: '123 Main St',
    })
    
    const encrypted = encrypt(userData, TEST_KEY)
    const decrypted = decrypt(encrypted, TEST_KEY)
    
    expect(JSON.parse(decrypted)).toEqual({
      email: 'user@example.com',
      phone: '+1234567890',
      address: '123 Main St',
    })
  })

  test('多语言内容', () => {
    const content = '你好 こんにちは 안녕하세요 Привет مرحبا'
    const encrypted = encrypt(content, TEST_KEY)
    expect(decrypt(encrypted, TEST_KEY)).toBe(content)
  })
})
