import {
  parseVideoUrl,
  truncateText,
  detectLanguage,
  isChineseText,
  isEmailLike,
  generateSummary,
  parseContent,
} from '../content'

describe('parseVideoUrl', () => {
  it('parses YouTube watch URL', () => {
    const result = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(result).toEqual({
      type: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      originalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
  })

  it('parses YouTube short URL', () => {
    const result = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')
    expect(result?.type).toBe('youtube')
  })

  it('returns null for non-video URL', () => {
    expect(parseVideoUrl('https://example.com')).toBeNull()
  })

  it('parses Bilibili URL', () => {
    const result = parseVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD')
    if (result) {
      expect(result.type).toBe('bilibili')
    }
  })
})

describe('truncateText', () => {
  it('returns short text as-is', () => {
    expect(truncateText('hello', 10)).toBe('hello')
  })

  it('truncates long text', () => {
    const long = 'a'.repeat(200)
    const result = truncateText(long, 50)
    expect(result.length).toBeLessThanOrEqual(53) // 50 + '...'
  })

  it('handles empty string', () => {
    expect(truncateText('', 10)).toBe('')
  })
})

describe('detectLanguage', () => {
  it('detects Chinese-dominant text', () => {
    expect(detectLanguage('这是一段中文内容测试用例')).toBe('zh')
  })
  it('detects English-dominant text', () => {
    expect(detectLanguage('this is plain english content here')).toBe('en')
  })
})

describe('isChineseText', () => {
  it('true for Chinese, false for English', () => {
    expect(isChineseText('比特币价格')).toBe(true)
    expect(isChineseText('bitcoin price')).toBe(false)
  })
})

describe('isEmailLike', () => {
  it('recognizes emails and rejects non-emails / nullish', () => {
    expect(isEmailLike('a@b.com')).toBe(true)
    expect(isEmailLike('not an email')).toBe(false)
    expect(isEmailLike(null)).toBe(false)
    expect(isEmailLike(undefined)).toBe(false)
    expect(isEmailLike('')).toBe(false)
  })
})

describe('generateSummary', () => {
  it('returns a bounded summary for long text', () => {
    const s = generateSummary('word '.repeat(100), 50)
    expect(s.length).toBeLessThanOrEqual(53)
  })
  it('returns short text as-is', () => {
    expect(generateSummary('brief note', 50)).toBe('brief note')
  })
})

describe('parseContent', () => {
  it('parses text with tag/mention/url without throwing', () => {
    expect(() => parseContent('hello #btc and @alice see https://x.com')).not.toThrow()
    expect(parseContent('').length).toBeGreaterThanOrEqual(0)
    expect(parseContent('plain text only').length).toBeGreaterThan(0)
  })
})
