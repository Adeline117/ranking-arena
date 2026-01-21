/**
 * Input Validation Tests
 * 测试安全输入验证模块
 */

import {
  sanitizeHtml,
  stripHtml,
  escapeHtml,
  detectSqlInjection,
  sanitizeSqlInput,
  sanitizeUserInput,
  isValidEmail,
  isValidUrl,
  isValidUsername,
  validatePasswordStrength,
  SafeStringSchema,
  SafeHtmlSchema,
  PlainTextSchema,
  SafeEmailSchema,
  SafeUrlSchema,
  SafeUsernameSchema,
  SafePasswordSchema,
  SqlSafeStringSchema,
  withSanitization,
  validateAndSanitize,
} from './input-validation'
import { z } from 'zod'

describe('sanitizeHtml', () => {
  test('should allow safe HTML tags', () => {
    const input = '<p>Hello <b>World</b></p>'
    const result = sanitizeHtml(input)
    expect(result).toContain('<p>')
    expect(result).toContain('<b>')
  })

  test('should remove script tags', () => {
    const input = '<script>alert("xss")</script><p>Safe</p>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('<script>')
    expect(result).toContain('<p>Safe</p>')
  })

  test('should remove dangerous attributes', () => {
    const input = '<p onclick="alert(1)">Click me</p>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('onclick')
  })

  test('should allow links when allowLinks is true', () => {
    const input = '<a href="https://example.com">Link</a>'
    const result = sanitizeHtml(input, { allowLinks: true })
    expect(result).toContain('<a')
    expect(result).toContain('href')
  })

  test('should remove links when allowLinks is false', () => {
    const input = '<a href="https://example.com">Link</a>'
    const result = sanitizeHtml(input, { allowLinks: false })
    expect(result).not.toContain('<a')
  })

  test('should allow images when allowImages is true', () => {
    const input = '<img src="https://example.com/image.png" alt="Image">'
    const result = sanitizeHtml(input, { allowImages: true })
    expect(result).toContain('<img')
  })

  test('should remove images when allowImages is false', () => {
    const input = '<img src="https://example.com/image.png" alt="Image">'
    const result = sanitizeHtml(input, { allowImages: false })
    expect(result).not.toContain('<img')
  })
})

describe('stripHtml', () => {
  test('should remove all HTML tags', () => {
    const input = '<p>Hello <b>World</b></p>'
    const result = stripHtml(input)
    expect(result).toBe('Hello World')
  })

  test('should handle empty input', () => {
    const result = stripHtml('')
    expect(result).toBe('')
  })

  test('should handle plain text', () => {
    const input = 'Just plain text'
    const result = stripHtml(input)
    expect(result).toBe('Just plain text')
  })
})

describe('escapeHtml', () => {
  test('should escape HTML special characters', () => {
    const input = '<script>alert("test")</script>'
    const result = escapeHtml(input)
    expect(result).toBe('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;')
  })

  test('should escape ampersand', () => {
    const input = 'A & B'
    const result = escapeHtml(input)
    expect(result).toBe('A &amp; B')
  })

  test('should escape single quotes', () => {
    const input = "It's a test"
    const result = escapeHtml(input)
    expect(result).toBe('It&#39;s a test')
  })
})

describe('detectSqlInjection', () => {
  test('should detect SELECT statement', () => {
    expect(detectSqlInjection('SELECT * FROM users')).toBe(true)
  })

  test('should detect DROP statement', () => {
    expect(detectSqlInjection('DROP TABLE users')).toBe(true)
  })

  test('should detect SQL comments', () => {
    expect(detectSqlInjection("admin'--")).toBe(true)
    expect(detectSqlInjection('admin/*comment*/')).toBe(true)
  })

  test('should detect OR 1=1 injection', () => {
    expect(detectSqlInjection("' OR 1=1")).toBe(true)
  })

  test('should detect UNION injection', () => {
    expect(detectSqlInjection('UNION SELECT password FROM users')).toBe(true)
  })

  test('should not flag normal input', () => {
    expect(detectSqlInjection('Hello World')).toBe(false)
    expect(detectSqlInjection('My email is test@example.com')).toBe(false)
  })
})

describe('sanitizeSqlInput', () => {
  test('should escape single quotes', () => {
    const input = "O'Reilly"
    const result = sanitizeSqlInput(input)
    expect(result).toBe("O''Reilly")
  })

  test('should escape backslashes', () => {
    const input = 'C:\\path\\file'
    const result = sanitizeSqlInput(input)
    expect(result).toBe('C:\\\\path\\\\file')
  })

  test('should remove NULL bytes', () => {
    const input = 'test\x00value'
    const result = sanitizeSqlInput(input)
    expect(result).toBe('testvalue')
  })
})

describe('sanitizeUserInput', () => {
  test('should trim whitespace by default', () => {
    const input = '  Hello World  '
    const result = sanitizeUserInput(input)
    expect(result).toBe('Hello World')
  })

  test('should not trim when trim is false', () => {
    const input = '  Hello World  '
    const result = sanitizeUserInput(input, { trim: false })
    expect(result).toBe('  Hello World  ')
  })

  test('should remove control characters', () => {
    const input = 'Hello\x00\x1FWorld'
    const result = sanitizeUserInput(input)
    expect(result).toBe('HelloWorld')
  })

  test('should remove newlines when allowNewlines is false', () => {
    const input = 'Hello\nWorld'
    const result = sanitizeUserInput(input, { allowNewlines: false })
    expect(result).toBe('Hello World')
  })

  test('should keep newlines when allowNewlines is true', () => {
    const input = 'Hello\nWorld'
    const result = sanitizeUserInput(input, { allowNewlines: true })
    expect(result).toBe('Hello\nWorld')
  })

  test('should truncate to maxLength', () => {
    const input = 'Hello World'
    const result = sanitizeUserInput(input, { maxLength: 5 })
    expect(result).toBe('Hello')
  })
})

describe('isValidEmail', () => {
  test('should validate correct email', () => {
    expect(isValidEmail('test@example.com')).toBe(true)
    expect(isValidEmail('user.name@domain.org')).toBe(true)
  })

  test('should reject invalid email', () => {
    expect(isValidEmail('invalid')).toBe(false)
    expect(isValidEmail('invalid@')).toBe(false)
    expect(isValidEmail('@domain.com')).toBe(false)
  })

  test('should reject email exceeding max length', () => {
    const longEmail = 'a'.repeat(250) + '@example.com'
    expect(isValidEmail(longEmail)).toBe(false)
  })
})

describe('isValidUrl', () => {
  test('should validate HTTPS URLs by default', () => {
    expect(isValidUrl('https://example.com')).toBe(true)
    expect(isValidUrl('https://example.com/path?query=1')).toBe(true)
  })

  test('should reject HTTP URLs by default', () => {
    expect(isValidUrl('http://example.com')).toBe(false)
  })

  test('should allow HTTP when specified', () => {
    expect(isValidUrl('http://example.com', { allowedProtocols: ['http', 'https'] })).toBe(true)
  })

  test('should reject localhost by default', () => {
    expect(isValidUrl('https://localhost')).toBe(false)
    expect(isValidUrl('https://127.0.0.1')).toBe(false)
  })

  test('should allow localhost when specified', () => {
    expect(isValidUrl('https://localhost', { allowLocalhost: true })).toBe(true)
  })

  test('should reject private IP addresses', () => {
    expect(isValidUrl('https://192.168.1.1')).toBe(false)
    expect(isValidUrl('https://10.0.0.1')).toBe(false)
  })

  test('should reject invalid URLs', () => {
    expect(isValidUrl('not a url')).toBe(false)
    expect(isValidUrl('')).toBe(false)
  })
})

describe('isValidUsername', () => {
  test('should validate correct username', () => {
    expect(isValidUsername('validuser').valid).toBe(true)
    expect(isValidUsername('User123').valid).toBe(true)
    expect(isValidUsername('测试用户').valid).toBe(true)
  })

  test('should reject short username', () => {
    const result = isValidUsername('ab')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('至少需要3个字符')
  })

  test('should reject long username', () => {
    const result = isValidUsername('a'.repeat(31))
    expect(result.valid).toBe(false)
    expect(result.error).toContain('不能超过30个字符')
  })

  test('should reject username starting with number', () => {
    const result = isValidUsername('123user')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('不能以数字或下划线开头')
  })

  test('should reject username starting with underscore', () => {
    const result = isValidUsername('_user')
    expect(result.valid).toBe(false)
  })

  test('should reject reserved usernames', () => {
    expect(isValidUsername('admin').valid).toBe(false)
    expect(isValidUsername('root').valid).toBe(false)
    expect(isValidUsername('system').valid).toBe(false)
  })

  test('should reject special characters', () => {
    expect(isValidUsername('user@name').valid).toBe(false)
    expect(isValidUsername('user name').valid).toBe(false)
  })
})

describe('validatePasswordStrength', () => {
  test('should validate strong password', () => {
    const result = validatePasswordStrength('MyP@ssw0rd123')
    expect(result.valid).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(4)
  })

  test('should reject short password', () => {
    const result = validatePasswordStrength('Short1')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('密码至少需要8个字符')
  })

  test('should require lowercase', () => {
    const result = validatePasswordStrength('PASSWORD123')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('密码需要包含小写字母')
  })

  test('should require uppercase', () => {
    const result = validatePasswordStrength('password123')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('密码需要包含大写字母')
  })

  test('should require number', () => {
    const result = validatePasswordStrength('PasswordOnly')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('密码需要包含数字')
  })

  test('should reject common passwords', () => {
    const result = validatePasswordStrength('password')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('密码太常见，请使用更复杂的密码')
    expect(result.score).toBe(0)
  })

  test('should give higher score for longer passwords', () => {
    const short = validatePasswordStrength('Passw0rd')
    const long = validatePasswordStrength('MyLongPassw0rd!')
    expect(long.score).toBeGreaterThan(short.score)
  })
})

describe('Zod Schemas', () => {
  test('SafeStringSchema should sanitize input', () => {
    const result = SafeStringSchema.parse('  Hello\x00World  ')
    expect(result).toBe('HelloWorld')
  })

  test('SafeHtmlSchema should sanitize HTML', () => {
    const result = SafeHtmlSchema.parse('<script>alert(1)</script><p>Safe</p>')
    expect(result).not.toContain('<script>')
    expect(result).toContain('<p>')
  })

  test('PlainTextSchema should strip all HTML', () => {
    const result = PlainTextSchema.parse('<p>Hello <b>World</b></p>')
    expect(result).toBe('Hello World')
  })

  test('SafeEmailSchema should validate and normalize email', () => {
    // Note: email() validation happens before transform, so input must be valid email first
    const result = SafeEmailSchema.parse('TEST@Example.Com')
    expect(result).toBe('test@example.com')
  })

  test('SafeEmailSchema should reject invalid email', () => {
    expect(() => SafeEmailSchema.parse('invalid')).toThrow()
  })

  test('SafeUrlSchema should validate URL', () => {
    const result = SafeUrlSchema.parse('https://example.com')
    expect(result).toBe('https://example.com')
  })

  test('SafeUrlSchema should reject unsafe URL', () => {
    expect(() => SafeUrlSchema.parse('javascript:alert(1)')).toThrow()
  })

  test('SafeUsernameSchema should validate username', () => {
    const result = SafeUsernameSchema.parse('validuser')
    expect(result).toBe('validuser')
  })

  test('SafeUsernameSchema should reject invalid username', () => {
    expect(() => SafeUsernameSchema.parse('ab')).toThrow()
  })

  test('SafePasswordSchema should validate password', () => {
    const result = SafePasswordSchema.parse('MyP@ssw0rd')
    expect(result).toBe('MyP@ssw0rd')
  })

  test('SafePasswordSchema should reject weak password', () => {
    expect(() => SafePasswordSchema.parse('weak')).toThrow()
  })

  test('SqlSafeStringSchema should reject SQL injection', () => {
    expect(() => SqlSafeStringSchema.parse('SELECT * FROM users')).toThrow()
  })

  test('SqlSafeStringSchema should allow safe input', () => {
    const result = SqlSafeStringSchema.parse('Hello World')
    expect(result).toBe('Hello World')
  })
})

describe('withSanitization', () => {
  test('should sanitize string values in schema', () => {
    const schema = withSanitization(z.object({
      name: z.string(),
    }))

    const result = schema.parse({ name: '  Hello  ' })
    expect(result.name).toBe('Hello')
  })

  test('should sanitize top-level string values only', () => {
    // Note: withSanitization only sanitizes top-level strings, not nested objects
    const schema = withSanitization(z.object({
      name: z.string(),
    }))

    const result = schema.parse({ name: '  Test\x00User  ' })
    expect(result.name).toBe('TestUser')
  })
})

describe('validateAndSanitize', () => {
  test('should validate and sanitize data', async () => {
    const schema = z.object({
      name: z.string(),
      email: z.string().email(),
    })

    const result = await validateAndSanitize(schema, {
      name: '  Test User  ',
      email: 'test@example.com',
    })

    expect(result.name).toBe('Test User')
    expect(result.email).toBe('test@example.com')
  })

  test('should throw on invalid data', async () => {
    const schema = z.object({
      email: z.string().email(),
    })

    await expect(validateAndSanitize(schema, { email: 'invalid' })).rejects.toThrow()
  })
})
