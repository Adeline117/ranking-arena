/**
 * 输入消毒工具测试
 */

import {
  sanitizeHtml,
  sanitizeText,
  sanitizeInput,
  sanitizeUrl,
  sanitizeEmail,
  sanitizeFilename,
  sanitizeJson,
  sanitizeObject,
  containsDangerousContent,
} from '../sanitize'

describe('sanitize utilities', () => {
  describe('sanitizeHtml', () => {
    it('应该保留允许的标签', () => {
      const input = '<p>Hello <strong>World</strong></p>'
      const result = sanitizeHtml(input)
      expect(result).toContain('<p>')
      expect(result).toContain('<strong>')
    })

    it('应该移除 script 标签', () => {
      const input = '<p>Hello</p><script>alert("xss")</script>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('<script>')
      expect(result).not.toContain('alert')
    })

    it('应该移除 onclick 属性', () => {
      const input = '<a onclick="alert(1)" href="#">Click</a>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('onclick')
    })

    it('应该为链接添加 rel="noopener noreferrer"', () => {
      const input = '<a href="https://example.com">Link</a>'
      const result = sanitizeHtml(input)
      expect(result).toContain('rel="noopener noreferrer"')
    })

    it('应该限制最大长度', () => {
      const input = '<p>' + 'a'.repeat(1000) + '</p>'
      const result = sanitizeHtml(input, { maxLength: 100 })
      expect(result.length).toBeLessThanOrEqual(100)
    })

    it('应该返回空字符串当输入为空', () => {
      expect(sanitizeHtml('')).toBe('')
      expect(sanitizeHtml(null as any)).toBe('')
    })
  })

  describe('sanitizeText', () => {
    it('应该移除所有 HTML 标签', () => {
      const input = '<p>Hello <strong>World</strong></p>'
      const result = sanitizeText(input)
      expect(result).toBe('Hello World')
    })

    it('应该保留换行当 preserveNewlines 为 true', () => {
      const input = 'Line 1\n\nLine 2'
      const result = sanitizeText(input, { preserveNewlines: true })
      expect(result).toContain('\n')
    })

    it('应该合并多个换行', () => {
      const input = 'Line 1\n\n\n\n\nLine 2'
      const result = sanitizeText(input, { preserveNewlines: true })
      expect(result).toBe('Line 1\n\nLine 2')
    })

    it('应该解码 HTML 实体', () => {
      const input = '&lt;script&gt;'
      const result = sanitizeText(input)
      expect(result).toBe('<script>')
    })
  })

  describe('sanitizeInput', () => {
    it('应该移除 HTML 标签', () => {
      const input = 'Hello <script>alert(1)</script> World'
      const result = sanitizeInput(input)
      expect(result).toBe('Hello World')
    })

    it('应该移除控制字符', () => {
      const input = 'Hello\x00World\x1F'
      const result = sanitizeInput(input)
      expect(result).toBe('HelloWorld')
    })

    it('应该规范化空白字符', () => {
      const input = '  Hello   World  '
      const result = sanitizeInput(input)
      expect(result).toBe('Hello World')
    })

    it('应该限制最大长度', () => {
      const input = 'a'.repeat(100)
      const result = sanitizeInput(input, { maxLength: 50 })
      expect(result.length).toBe(50)
    })
  })

  describe('sanitizeUrl', () => {
    it('应该接受有效的 http URL', () => {
      const input = 'http://example.com/path?query=1'
      const result = sanitizeUrl(input)
      expect(result).toBe(input)
    })

    it('应该接受有效的 https URL', () => {
      const input = 'https://example.com'
      const result = sanitizeUrl(input)
      expect(result).toBe('https://example.com/')
    })

    it('应该拒绝 javascript: URL', () => {
      const input = 'javascript:alert(1)'
      const result = sanitizeUrl(input)
      expect(result).toBe('')
    })

    it('应该拒绝无效 URL', () => {
      const input = 'not a url'
      const result = sanitizeUrl(input)
      expect(result).toBe('')
    })

    it('应该返回空字符串当输入为空', () => {
      expect(sanitizeUrl('')).toBe('')
    })
  })

  describe('sanitizeEmail', () => {
    it('应该接受有效的邮箱', () => {
      const input = 'Test@Example.com'
      const result = sanitizeEmail(input)
      expect(result).toBe('test@example.com')
    })

    it('应该拒绝无效的邮箱', () => {
      expect(sanitizeEmail('not-an-email')).toBe('')
      expect(sanitizeEmail('missing@domain')).toBe('')
      expect(sanitizeEmail('@example.com')).toBe('')
    })

    it('应该去除空白字符', () => {
      const input = '  test@example.com  '
      const result = sanitizeEmail(input)
      expect(result).toBe('test@example.com')
    })
  })

  describe('sanitizeFilename', () => {
    it('应该移除危险字符', () => {
      const input = 'file<>:"/\\|?*.txt'
      const result = sanitizeFilename(input)
      expect(result).not.toContain('<')
      expect(result).not.toContain('>')
      expect(result).not.toContain(':')
    })

    it('应该移除路径遍历字符', () => {
      const input = '../../../etc/passwd'
      const result = sanitizeFilename(input)
      expect(result).not.toContain('..')
    })

    it('应该移除开头的点', () => {
      const input = '.hiddenfile'
      const result = sanitizeFilename(input)
      expect(result).not.toMatch(/^\./)
    })

    it('应该限制文件名长度', () => {
      const input = 'a'.repeat(300) + '.txt'
      const result = sanitizeFilename(input)
      expect(result.length).toBeLessThanOrEqual(255)
      expect(result).toContain('.txt')
    })
  })

  describe('sanitizeJson', () => {
    it('应该返回有效的 JSON', () => {
      const input = '{"key": "value"}'
      const result = sanitizeJson(input)
      expect(result).toBe('{"key":"value"}')
    })

    it('应该返回空对象当 JSON 无效', () => {
      const input = 'not valid json'
      const result = sanitizeJson(input)
      expect(result).toBe('{}')
    })

    it('应该返回空对象当输入为空', () => {
      expect(sanitizeJson('')).toBe('{}')
    })
  })

  describe('sanitizeObject', () => {
    it('应该消毒对象中的字符串字段', () => {
      const input = {
        name: '<script>alert(1)</script>',
        age: 25,
      }
      const result = sanitizeObject(input)
      expect(result.name).not.toContain('<script>')
      expect(result.age).toBe(25)
    })

    it('应该递归处理嵌套对象', () => {
      const input = {
        user: {
          name: '<script>alert(1)</script>',
        },
      }
      const result = sanitizeObject(input)
      expect((result.user as any).name).not.toContain('<script>')
    })

    it('应该根据字段选项使用不同的消毒方法', () => {
      const input = {
        email: 'TEST@EXAMPLE.COM',
        url: 'https://example.com',
      }
      const result = sanitizeObject(input, {
        email: { type: 'email' },
        url: { type: 'url' },
      })
      expect(result.email).toBe('test@example.com')
      expect(result.url).toContain('example.com')
    })
  })

  describe('containsDangerousContent', () => {
    it('应该检测 script 标签', () => {
      expect(containsDangerousContent('<script>alert(1)</script>')).toBe(true)
    })

    it('应该检测 javascript: URL', () => {
      expect(containsDangerousContent('javascript:alert(1)')).toBe(true)
    })

    it('应该检测事件处理器', () => {
      expect(containsDangerousContent('onclick=alert(1)')).toBe(true)
      expect(containsDangerousContent('onerror = "alert(1)"')).toBe(true)
    })

    it('应该返回 false 对于安全内容', () => {
      expect(containsDangerousContent('Hello World')).toBe(false)
      expect(containsDangerousContent('<p>Safe HTML</p>')).toBe(false)
    })

    it('应该返回 false 对于空输入', () => {
      expect(containsDangerousContent('')).toBe(false)
      expect(containsDangerousContent(null as any)).toBe(false)
    })
  })
})
