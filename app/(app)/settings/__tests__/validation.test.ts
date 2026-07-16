/**
 * Settings Validation Functions Tests
 */

import {
  validateHandle,
  validateEmail,
  validatePassword,
  validatePasswordMatch,
  MAX_HANDLE_LENGTH,
  MAX_BIO_LENGTH,
} from '../validation'

describe('validateHandle', () => {
  describe('valid usernames', () => {
    it('should accept a single-character username', () => {
      expect(validateHandle('a')).toEqual({ valid: true, message: '' })
    })

    it('should accept 2-character username', () => {
      expect(validateHandle('ab')).toEqual({ valid: true, message: '' })
    })

    it('should accept alphabetic username', () => {
      expect(validateHandle('testuser')).toEqual({ valid: true, message: '' })
    })

    it('should accept username with numbers', () => {
      expect(validateHandle('user123')).toEqual({ valid: true, message: '' })
    })

    it('should accept username with underscores', () => {
      expect(validateHandle('test_user')).toEqual({ valid: true, message: '' })
    })

    it('should accept Chinese username', () => {
      expect(validateHandle('测试用户')).toEqual({ valid: true, message: '' })
    })

    it('should accept mixed Chinese and English username', () => {
      expect(validateHandle('test用户123')).toEqual({ valid: true, message: '' })
    })

    it('accepts the exact Japanese and Korean ranges allowed by the database', () => {
      expect(validateHandle('ひらがな')).toEqual({ valid: true, message: '' })
      expect(validateHandle('カタカナ')).toEqual({ valid: true, message: '' })
      expect(validateHandle('거래자')).toEqual({ valid: true, message: '' })
      expect(validateHandle('\u4E00\u9FAF\u3041\u309F\u30A0\u30FF\uAC00\uD7A3')).toEqual({
        valid: true,
        message: '',
      })
    })

    it('should accept max length username', () => {
      const maxLengthHandle = 'a'.repeat(MAX_HANDLE_LENGTH)
      expect(validateHandle(maxLengthHandle)).toEqual({ valid: true, message: '' })
    })

    it('keeps an exactly unchanged safe legacy dotted username valid', () => {
      expect(validateHandle('legacy.user', undefined, 'legacy.user')).toEqual({
        valid: true,
        message: '',
      })
    })

    it('keeps an exactly unchanged reserved legacy username valid', () => {
      expect(validateHandle('Admin', undefined, 'Admin')).toEqual({ valid: true, message: '' })
    })
  })

  describe('invalid usernames', () => {
    it('should reject an empty username', () => {
      const result = validateHandle('')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('1')
    })

    it('should reject username exceeding max length', () => {
      const tooLongHandle = 'a'.repeat(MAX_HANDLE_LENGTH + 1)
      const result = validateHandle(tooLongHandle)
      expect(result.valid).toBe(false)
      expect(result.message).toContain(String(MAX_HANDLE_LENGTH))
    })

    it.each([
      'test@user',
      'test user',
      'test-user',
      'test.user',
      'bad/name',
      'bad\\name',
      'bad?query',
      'bad#fragment',
      'bad%2Fescape',
      'safe\u202Eeman',
      'safe\u200Bname',
      'emoji😀',
      'é',
      '___',
    ])('should reject a new username outside the database alphabet: %s', (handle) => {
      const result = validateHandle(handle)
      expect(result.valid).toBe(false)
      expect(result.message).toContain('letters')
    })

    it('rejects non-NFC input instead of diverging from the database', () => {
      expect(validateHandle('\u306F\u3099').valid).toBe(false)
      expect(validateHandle('\u3070').valid).toBe(true)
    })

    it('does not extend legacy-dot compatibility to a renamed handle', () => {
      expect(validateHandle('new.name', undefined, 'old.name').valid).toBe(false)
      expect(validateHandle('legacy/name', undefined, 'legacy/name').valid).toBe(false)
    })

    it.each([
      'admin',
      'Administrator',
      'ARENA',
      'moderator',
      'official',
      'root',
      'support',
      'system',
    ])('should reject a new or changed reserved username: %s', (reserved) => {
      expect(validateHandle(reserved, undefined, 'ordinary_user').valid).toBe(false)
    })

    it('rejects changing only the case of a reserved legacy username', () => {
      expect(validateHandle('ADMIN', undefined, 'Admin').valid).toBe(false)
    })
  })
})

describe('validateEmail', () => {
  describe('valid emails', () => {
    it('should accept empty email (optional field)', () => {
      expect(validateEmail('')).toEqual({ valid: true, message: '' })
    })

    it('should accept standard email format', () => {
      expect(validateEmail('test@example.com')).toEqual({ valid: true, message: '' })
    })

    it('should accept email with subdomain', () => {
      expect(validateEmail('user@mail.example.com')).toEqual({ valid: true, message: '' })
    })

    it('should accept email with plus sign', () => {
      expect(validateEmail('user+tag@example.com')).toEqual({ valid: true, message: '' })
    })

    it('should accept email with dots in username', () => {
      expect(validateEmail('first.last@example.com')).toEqual({ valid: true, message: '' })
    })
  })

  describe('invalid emails', () => {
    it('should reject email without @ symbol', () => {
      const result = validateEmail('testexample.com')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('valid')
    })

    it('should reject email without domain', () => {
      const result = validateEmail('test@')
      expect(result.valid).toBe(false)
    })

    it('should reject email without username', () => {
      const result = validateEmail('@example.com')
      expect(result.valid).toBe(false)
    })

    it('should reject email with spaces', () => {
      const result = validateEmail('test @example.com')
      expect(result.valid).toBe(false)
    })

    it('should reject email without TLD', () => {
      const result = validateEmail('test@example')
      expect(result.valid).toBe(false)
    })
  })
})

describe('validatePassword', () => {
  describe('valid passwords', () => {
    it('should accept empty password (optional field)', () => {
      expect(validatePassword('')).toEqual({ valid: true, message: '' })
    })

    it('should accept 6-character password', () => {
      expect(validatePassword('123456')).toEqual({ valid: true, message: '' })
    })

    it('should accept long password', () => {
      expect(validatePassword('this_is_a_very_long_password_123!')).toEqual({
        valid: true,
        message: '',
      })
    })

    it('should accept password with special characters', () => {
      expect(validatePassword('Pass@123')).toEqual({ valid: true, message: '' })
    })
  })

  describe('invalid passwords', () => {
    it('should reject 5-character password', () => {
      const result = validatePassword('12345')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('6')
    })

    it('should reject single character password', () => {
      const result = validatePassword('a')
      expect(result.valid).toBe(false)
    })
  })
})

describe('validatePasswordMatch', () => {
  describe('matching passwords', () => {
    it('should accept empty confirm password (optional field)', () => {
      expect(validatePasswordMatch('password', '')).toEqual({
        valid: true,
        message: '',
      })
    })

    it('should accept matching passwords', () => {
      expect(validatePasswordMatch('password123', 'password123')).toEqual({
        valid: true,
        message: '',
      })
    })
  })

  describe('mismatched passwords', () => {
    it('should reject mismatched passwords', () => {
      const result = validatePasswordMatch('password123', 'password456')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('match')
    })

    it('should reject passwords with different cases', () => {
      const result = validatePasswordMatch('Password', 'password')
      expect(result.valid).toBe(false)
    })
  })
})

describe('exported constants', () => {
  it('should export correct MAX_HANDLE_LENGTH', () => {
    expect(MAX_HANDLE_LENGTH).toBe(30)
  })

  it('should export correct MAX_BIO_LENGTH', () => {
    expect(MAX_BIO_LENGTH).toBe(200)
  })
})
