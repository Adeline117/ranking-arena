/**
 * 输入消毒工具测试
 *
 * 这些测试运行真实的 sanitize-html（htmlparser2 实现，无 jsdom），
 * 不再需要 mock — 测试的是生产环境实际执行的消毒逻辑。
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
      expect(result).toContain('Hello')
      expect(result).toContain('World')
    })

    it('应该移除 script 标签及其内容', () => {
      const input = '<p>Hello</p><script>alert("xss")</script>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('<script')
      expect(result).not.toContain('alert')
      expect(result).toContain('<p>Hello</p>')
    })

    it('应该移除 iframe/object/embed/form/input/style 标签', () => {
      const input =
        '<iframe src="https://evil.com"></iframe><object data="x"></object><embed src="x"><form action="/steal"><input name="pw"></form><style>body{display:none}</style><p>safe</p>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('<iframe')
      expect(result).not.toContain('<object')
      expect(result).not.toContain('<embed')
      expect(result).not.toContain('<form')
      expect(result).not.toContain('<input')
      expect(result).not.toContain('<style')
      expect(result).not.toContain('display:none')
      expect(result).toContain('<p>safe</p>')
    })

    it('禁止标签即使显式加入 allowedTags 也不能通过', () => {
      const input = '<script>alert(1)</script><iframe src="x"></iframe><p>ok</p>'
      const result = sanitizeHtml(input, {
        allowedTags: ['p', 'script', 'iframe', 'style', 'form', 'input', 'object', 'embed'],
      })
      expect(result).not.toContain('<script')
      expect(result).not.toContain('<iframe')
      expect(result).toContain('<p>ok</p>')
    })

    it('应该移除事件处理器属性 (onerror/onclick/onmouseover)', () => {
      const input =
        '<p onclick="alert(1)" onmouseover="steal()">hi</p><div onerror="alert(2)">x</div>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('onclick')
      expect(result).not.toContain('onmouseover')
      expect(result).not.toContain('onerror')
      expect(result).not.toContain('alert')
      expect(result).toContain('hi')
    })

    it('事件处理器属性即使加入 allowedAttr 也不能通过', () => {
      const input = '<p onclick="alert(1)" class="a">hi</p>'
      const result = sanitizeHtml(input, {
        allowedTags: ['p'],
        allowedAttr: ['class', 'onclick', 'onerror', 'style'],
      })
      expect(result).not.toContain('onclick')
      expect(result).not.toContain('style')
      expect(result).toContain('class="a"')
    })

    it('应该中和 javascript: href', () => {
      const input = '<a href="javascript:alert(1)">Click</a>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('javascript:')
      expect(result).toContain('Click')
    })

    it('应该中和 data: 和 vbscript: href', () => {
      expect(
        sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')
      ).not.toContain('data:')
      expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript:')
    })

    it('应该为每个链接添加 target="_blank" 和 rel="noopener noreferrer"', () => {
      const input = '<a href="https://example.com">Link</a>'
      const result = sanitizeHtml(input)
      expect(result).toContain('target="_blank"')
      expect(result).toContain('rel="noopener noreferrer"')
      expect(result).toContain('href="https://example.com"')
    })

    it('应该覆盖链接上已有的 target/rel', () => {
      const input = '<a href="https://example.com" target="_self" rel="opener">Link</a>'
      const result = sanitizeHtml(input)
      expect(result).toContain('target="_blank"')
      expect(result).toContain('rel="noopener noreferrer"')
      expect(result).not.toContain('_self')
    })

    it('allowLinks=false 时应该移除 a 标签但保留文本', () => {
      const input = '<a href="https://example.com">Link text</a> and <p>para</p>'
      const result = sanitizeHtml(input, { allowLinks: false })
      expect(result).not.toContain('<a')
      expect(result).not.toContain('href')
      expect(result).toContain('Link text')
      expect(result).toContain('<p>para</p>')
    })

    it('应该处理嵌套/畸形 HTML 而不抛异常', () => {
      const inputs = [
        '<p><strong>unclosed',
        '<p>a<p>b</strong></em>',
        '<<script>script>alert(1)<</script>/script>',
        '<div><ul><li><div>deep</div></li></ul>',
        '<a href="x"<b>broken</b>',
      ]
      for (const input of inputs) {
        expect(() => sanitizeHtml(input)).not.toThrow()
        const result = sanitizeHtml(input)
        expect(result).not.toContain('<script')
      }
    })

    it('应该保留 unicode 内容（中文/emoji）', () => {
      const input = '<p>中文内容测试 🚀🎉 emoji</p>'
      const result = sanitizeHtml(input)
      expect(result).toContain('中文内容测试')
      expect(result).toContain('🚀🎉')
    })

    it('应该限制最大长度', () => {
      const input = '<p>' + 'a'.repeat(1000) + '</p>'
      const result = sanitizeHtml(input, { maxLength: 100 })
      expect(result.length).toBeLessThanOrEqual(100)
    })

    it('应该返回空字符串当输入为空', () => {
      expect(sanitizeHtml('')).toBe('')
      expect(sanitizeHtml(null as unknown as string)).toBe('')
      expect(sanitizeHtml(undefined as unknown as string)).toBe('')
    })

    it('应该支持自定义 allowedTags', () => {
      const input = '<p>keep</p><div>drop tag keep text</div>'
      const result = sanitizeHtml(input, { allowedTags: ['p'] })
      expect(result).toContain('<p>keep</p>')
      expect(result).not.toContain('<div>')
      expect(result).toContain('drop tag keep text')
    })
  })

  describe('sanitizeText', () => {
    it('应该移除所有 HTML 标签', () => {
      const input = '<p>Hello <strong>World</strong></p>'
      const result = sanitizeText(input)
      expect(result).toBe('Hello World')
    })

    it('应该移除 script 标签连同内容', () => {
      const input = '<script>alert("xss")</script>hello'
      const result = sanitizeText(input)
      expect(result).toBe('hello')
    })

    it('应该解码 HTML 实体（&amp; → &，单次解码）', () => {
      expect(sanitizeText('hello &amp; world')).toBe('hello & world')
      expect(sanitizeText('a &quot;b&quot; &#39;c&#39;')).toBe('a "b" \'c\'')
    })

    it('不应该双重解码实体', () => {
      // &amp;amp; 应该解码为 &amp;（字面文本），而不是 &
      const result = sanitizeText('a &amp;amp; b')
      expect(result).toBe('a &amp; b')
    })

    it('应该解码 &lt;/&gt; 实体为字面尖括号', () => {
      const input = '&lt;script&gt;'
      const result = sanitizeText(input)
      expect(result).toBe('<script>')
    })

    it('默认应该折叠空白', () => {
      const input = '  Hello \n\n  World  '
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

    it('应该保留 unicode 内容（中文/emoji）', () => {
      expect(sanitizeText('中文 🚀 测试')).toBe('中文 🚀 测试')
    })

    it('应该限制最大长度', () => {
      const result = sanitizeText('a'.repeat(100), { maxLength: 50 })
      expect(result.length).toBe(50)
    })

    it('应该返回空字符串当输入为空', () => {
      expect(sanitizeText('')).toBe('')
      expect(sanitizeText(null as unknown as string)).toBe('')
    })
  })

  describe('sanitizeInput', () => {
    it('应该移除 HTML 标签', () => {
      const input = 'Hello <script>alert(1)</script> World'
      const result = sanitizeInput(input)
      expect(result).toBe('Hello World')
    })

    it('应该解码 HTML 实体', () => {
      expect(sanitizeInput('Tom &amp; Jerry')).toBe('Tom & Jerry')
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

    it('应该保留 unicode 用户名', () => {
      expect(sanitizeInput('用户名🎉')).toBe('用户名🎉')
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

    it('应该拒绝 data: URL', () => {
      expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('')
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
      expect(result.name).not.toContain('alert')
      expect(result.age).toBe(25)
    })

    it('应该递归处理嵌套对象', () => {
      const input = {
        user: {
          name: '<script>alert(1)</script>',
        },
      }
      const result = sanitizeObject(input)
      expect((result.user as Record<string, unknown>).name).not.toContain('<script>')
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
      expect(containsDangerousContent(null as unknown as string)).toBe(false)
    })
  })
})
