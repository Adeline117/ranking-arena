import {
  validateEmail,
  validatePassword,
  validateHandle,
  getPasswordStrength,
  emailRegex,
} from '../validation'

describe('validateEmail', () => {
  it('should return valid for correct email format', () => {
    const result = validateEmail('test@example.com')
    expect(result.isValid).toBe(true)
    expect(result.message).toBe('')
  })

  it('should return invalid for empty email when required', () => {
    const result = validateEmail('', true)
    expect(result.isValid).toBe(false)
    expect(result.message).toBe('邮箱不能为空')
  })

  it('should return valid for empty email when not required', () => {
    const result = validateEmail('', false)
    expect(result.isValid).toBe(true)
  })

  it('should return invalid for malformed email', () => {
    const result = validateEmail('invalid-email')
    expect(result.isValid).toBe(false)
    expect(result.message).toBe('请输入有效的邮箱地址')
  })

  it('should return invalid for email without domain', () => {
    const result = validateEmail('test@')
    expect(result.isValid).toBe(false)
  })

  it('should return invalid for email without @ symbol', () => {
    const result = validateEmail('testexample.com')
    expect(result.isValid).toBe(false)
  })
})

describe('validatePassword', () => {
  it('should return valid for password with 6+ characters', () => {
    const result = validatePassword('password123')
    expect(result.isValid).toBe(true)
    expect(result.message).toBe('')
  })

  it('should return invalid for empty password when required', () => {
    const result = validatePassword('', true)
    expect(result.isValid).toBe(false)
    expect(result.message).toBe('密码不能为空')
  })

  it('should return valid for empty password when not required', () => {
    const result = validatePassword('', false)
    expect(result.isValid).toBe(true)
  })

  it('should return invalid for password with less than 6 characters', () => {
    const result = validatePassword('12345')
    expect(result.isValid).toBe(false)
    expect(result.message).toBe('密码至少需要6位')
  })
})

describe('validateHandle', () => {
  it('should return valid for handle with 3+ characters', () => {
    const result = validateHandle('user123')
    expect(result.isValid).toBe(true)
    expect(result.message).toBe('')
  })

  it('should return invalid for empty handle when required', () => {
    const result = validateHandle('', true)
    expect(result.isValid).toBe(false)
    expect(result.message).toBe('用户名不能为空')
  })

  it('should return valid for empty handle when not required', () => {
    const result = validateHandle('', false)
    expect(result.isValid).toBe(true)
  })

  it('should return invalid for handle with less than 3 characters', () => {
    const result = validateHandle('ab')
    expect(result.isValid).toBe(false)
    expect(result.message).toBe('用户名至少需要3个字符')
  })

  it('should handle whitespace correctly', () => {
    const result = validateHandle('   ', true)
    expect(result.isValid).toBe(false)
  })
})

describe('getPasswordStrength', () => {
  it('should return level 0 for empty password', () => {
    const result = getPasswordStrength('')
    expect(result.level).toBe(0)
    expect(result.label).toBe('')
  })

  it('should return weak for short password', () => {
    const result = getPasswordStrength('123456')
    expect(result.level).toBe(1)
    expect(result.label).toBe('弱')
    expect(result.color).toBe('#ff4d4d')
  })

  it('should return medium for password with mixed case', () => {
    const result = getPasswordStrength('Password1')
    expect(result.level).toBeGreaterThanOrEqual(3)
  })

  it('should return strong for complex password', () => {
    const result = getPasswordStrength('Password123!')
    expect(result.level).toBe(4)
    expect(result.label).toBe('强')
    expect(result.color).toBe('#2fe57d')
  })
})

describe('emailRegex', () => {
  it('should match valid email addresses', () => {
    expect(emailRegex.test('test@example.com')).toBe(true)
    expect(emailRegex.test('user.name@domain.org')).toBe(true)
    expect(emailRegex.test('user+tag@example.co.uk')).toBe(true)
  })

  it('should not match invalid email addresses', () => {
    expect(emailRegex.test('invalid')).toBe(false)
    expect(emailRegex.test('@nodomain.com')).toBe(false)
    expect(emailRegex.test('noatsign.com')).toBe(false)
  })
})

