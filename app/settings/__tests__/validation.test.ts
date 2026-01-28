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
  describe('有效用户名', () => {
    it('应接受空用户名（可选字段）', () => {
      expect(validateHandle('')).toEqual({ valid: true, message: '' })
    })

    it('应接受 2 个字符的用户名', () => {
      expect(validateHandle('ab')).toEqual({ valid: true, message: '' })
    })

    it('应接受纯字母用户名', () => {
      expect(validateHandle('testuser')).toEqual({ valid: true, message: '' })
    })

    it('应接受带数字的用户名', () => {
      expect(validateHandle('user123')).toEqual({ valid: true, message: '' })
    })

    it('应接受带下划线的用户名', () => {
      expect(validateHandle('test_user')).toEqual({ valid: true, message: '' })
    })

    it('应接受中文用户名', () => {
      expect(validateHandle('测试用户')).toEqual({ valid: true, message: '' })
    })

    it('应接受中英混合用户名', () => {
      expect(validateHandle('test用户123')).toEqual({ valid: true, message: '' })
    })

    it('应接受最大长度的用户名', () => {
      const maxLengthHandle = 'a'.repeat(MAX_HANDLE_LENGTH)
      expect(validateHandle(maxLengthHandle)).toEqual({ valid: true, message: '' })
    })
  })

  describe('无效用户名', () => {
    it('应拒绝单个字符的用户名', () => {
      const result = validateHandle('a')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('2')
    })

    it('应拒绝超过最大长度的用户名', () => {
      const tooLongHandle = 'a'.repeat(MAX_HANDLE_LENGTH + 1)
      const result = validateHandle(tooLongHandle)
      expect(result.valid).toBe(false)
      expect(result.message).toContain(String(MAX_HANDLE_LENGTH))
    })

    it('应拒绝包含特殊字符的用户名', () => {
      const result = validateHandle('test@user')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('字母')
    })

    it('应拒绝包含空格的用户名', () => {
      const result = validateHandle('test user')
      expect(result.valid).toBe(false)
    })

    it('应拒绝包含连字符的用户名', () => {
      const result = validateHandle('test-user')
      expect(result.valid).toBe(false)
    })

    it('应拒绝包含点号的用户名', () => {
      const result = validateHandle('test.user')
      expect(result.valid).toBe(false)
    })
  })
})

describe('validateEmail', () => {
  describe('有效邮箱', () => {
    it('应接受空邮箱（可选字段）', () => {
      expect(validateEmail('')).toEqual({ valid: true, message: '' })
    })

    it('应接受标准邮箱格式', () => {
      expect(validateEmail('test@example.com')).toEqual({ valid: true, message: '' })
    })

    it('应接受带子域名的邮箱', () => {
      expect(validateEmail('user@mail.example.com')).toEqual({ valid: true, message: '' })
    })

    it('应接受带加号的邮箱', () => {
      expect(validateEmail('user+tag@example.com')).toEqual({ valid: true, message: '' })
    })

    it('应接受带点号的用户名', () => {
      expect(validateEmail('first.last@example.com')).toEqual({ valid: true, message: '' })
    })
  })

  describe('无效邮箱', () => {
    it('应拒绝没有 @ 符号的邮箱', () => {
      const result = validateEmail('testexample.com')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('有效')
    })

    it('应拒绝没有域名的邮箱', () => {
      const result = validateEmail('test@')
      expect(result.valid).toBe(false)
    })

    it('应拒绝没有用户名的邮箱', () => {
      const result = validateEmail('@example.com')
      expect(result.valid).toBe(false)
    })

    it('应拒绝包含空格的邮箱', () => {
      const result = validateEmail('test @example.com')
      expect(result.valid).toBe(false)
    })

    it('应拒绝没有顶级域名的邮箱', () => {
      const result = validateEmail('test@example')
      expect(result.valid).toBe(false)
    })
  })
})

describe('validatePassword', () => {
  describe('有效密码', () => {
    it('应接受空密码（可选字段）', () => {
      expect(validatePassword('')).toEqual({ valid: true, message: '' })
    })

    it('应接受 6 个字符的密码', () => {
      expect(validatePassword('123456')).toEqual({ valid: true, message: '' })
    })

    it('应接受长密码', () => {
      expect(validatePassword('this_is_a_very_long_password_123!')).toEqual({
        valid: true,
        message: '',
      })
    })

    it('应接受包含特殊字符的密码', () => {
      expect(validatePassword('Pass@123')).toEqual({ valid: true, message: '' })
    })
  })

  describe('无效密码', () => {
    it('应拒绝 5 个字符的密码', () => {
      const result = validatePassword('12345')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('6')
    })

    it('应拒绝单个字符的密码', () => {
      const result = validatePassword('a')
      expect(result.valid).toBe(false)
    })
  })
})

describe('validatePasswordMatch', () => {
  describe('匹配密码', () => {
    it('应接受空确认密码（可选字段）', () => {
      expect(validatePasswordMatch('password', '')).toEqual({
        valid: true,
        message: '',
      })
    })

    it('应接受匹配的密码', () => {
      expect(validatePasswordMatch('password123', 'password123')).toEqual({
        valid: true,
        message: '',
      })
    })
  })

  describe('不匹配密码', () => {
    it('应拒绝不匹配的密码', () => {
      const result = validatePasswordMatch('password123', 'password456')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('不一致')
    })

    it('应拒绝大小写不同的密码', () => {
      const result = validatePasswordMatch('Password', 'password')
      expect(result.valid).toBe(false)
    })
  })
})

describe('常量导出', () => {
  it('应导出正确的 MAX_HANDLE_LENGTH', () => {
    expect(MAX_HANDLE_LENGTH).toBe(30)
  })

  it('应导出正确的 MAX_BIO_LENGTH', () => {
    expect(MAX_BIO_LENGTH).toBe(200)
  })
})
