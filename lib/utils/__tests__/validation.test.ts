import {
  validateEmail,
  validatePassword,
  validateHandle,
  getPasswordStrength,
  EMAIL_REGEX,
} from '../validation'

describe('validateEmail', () => {
  it('should return valid for correct email format', () => {
    const result = validateEmail('test@example.com')
    expect(result.valid).toBe(true)
    expect(result.message).toBe('')
  })

  it('should return valid for empty email (optional by default)', () => {
    const result = validateEmail('')
    expect(result.valid).toBe(true)
  })

  it('should return invalid for malformed email', () => {
    const result = validateEmail('invalid-email')
    expect(result.valid).toBe(false)
    expect(result.message).toBe('请输入有效的邮箱地址')
  })

  it('should return invalid for email without domain', () => {
    const result = validateEmail('test@')
    expect(result.valid).toBe(false)
  })

  it('should return invalid for email without @ symbol', () => {
    const result = validateEmail('testexample.com')
    expect(result.valid).toBe(false)
  })
})

describe('validatePassword', () => {
  it('should return valid for password with 6+ characters', () => {
    const result = validatePassword('password123')
    expect(result.valid).toBe(true)
    expect(result.message).toBe('')
  })

  it('should return valid for empty password (optional by default)', () => {
    const result = validatePassword('')
    expect(result.valid).toBe(true)
  })

  it('should return invalid for password with less than 6 characters', () => {
    const result = validatePassword('12345')
    expect(result.valid).toBe(false)
    expect(result.message).toBe('密码至少需要6个字符')
  })

  it('should support custom minimum length', () => {
    const result = validatePassword('12345678', 10)
    expect(result.valid).toBe(false)
    expect(result.message).toBe('密码至少需要10个字符')
  })
})

describe('validateHandle', () => {
  it('should return valid for handle with 1+ characters', () => {
    const result = validateHandle('user123')
    expect(result.valid).toBe(true)
    expect(result.message).toBe('')
  })

  it('should return valid for empty handle (optional by default)', () => {
    const result = validateHandle('')
    expect(result.valid).toBe(true)
  })

  it('should return valid for single character handle', () => {
    const result = validateHandle('a')
    expect(result.valid).toBe(true)
  })

  it('should support custom minimum length', () => {
    const result = validateHandle('ab', 3)
    expect(result.valid).toBe(false)
    expect(result.message).toBe('用户名至少需要3个字符')
  })
})

describe('getPasswordStrength', () => {
  it('should return level 0 for empty password', () => {
    const result = getPasswordStrength('')
    expect(result.level).toBe(0)
    expect(result.label).toBe('')
  })

  it('should return fair for numeric-only password', () => {
    // '123456' gets score 2: length >= 6 (+1), contains digits (+1)
    const result = getPasswordStrength('123456')
    expect(result.level).toBe(2)
    expect(result.label).toBe('一般')
    expect(result.color).toBe('var(--color-medal-gold-end)')
  })

  it('should return weak for very short password', () => {
    // '12345' gets score 1: length >= 6 (no), contains digits (+1)
    const result = getPasswordStrength('12345')
    expect(result.level).toBe(1)
    expect(result.label).toBe('弱')
    expect(result.color).toBe('var(--color-accent-error)')
  })

  it('should return medium for password with mixed case', () => {
    const result = getPasswordStrength('Password1')
    expect(result.level).toBeGreaterThanOrEqual(3)
  })

  it('should return strong for complex password', () => {
    const result = getPasswordStrength('Password123!')
    expect(result.level).toBe(4)
    expect(result.label).toBe('强')
    expect(result.color).toBe('var(--color-accent-success)')
  })
})

describe('EMAIL_REGEX', () => {
  it('should match valid email addresses', () => {
    expect(EMAIL_REGEX.test('test@example.com')).toBe(true)
    expect(EMAIL_REGEX.test('user.name@domain.org')).toBe(true)
    expect(EMAIL_REGEX.test('user+tag@example.co.uk')).toBe(true)
  })

  it('should not match invalid email addresses', () => {
    expect(EMAIL_REGEX.test('invalid')).toBe(false)
    expect(EMAIL_REGEX.test('@nodomain.com')).toBe(false)
    expect(EMAIL_REGEX.test('noatsign.com')).toBe(false)
  })
})
