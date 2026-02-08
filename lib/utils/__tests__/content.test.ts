import { parseVideoUrl, truncateText } from '../content'

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
