import {
  parseVideoUrl,
  truncateText,
  detectLanguage,
  isChineseText,
  isEmailLike,
  generateSummary,
  isAllowedContentImageUrl,
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

  it('creates image parts only for absolute http and https URLs', () => {
    const parts = parseContent(
      '![http](http://example.com/a.png) ![https](https://example.com/b.png)'
    )

    expect(parts.filter((part) => part.type === 'image')).toEqual([
      { type: 'image', content: 'http', url: 'http://example.com/a.png' },
      { type: 'image', content: 'https', url: 'https://example.com/b.png' },
    ])
  })

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'blob:https://example.com/1234',
    'file:///etc/passwd',
    '//example.com/protocol-relative.png',
    'not-a-url',
  ])('preserves a rejected markdown image as ordinary text: %s', (url) => {
    const markdown = `before ![unsafe](${url}) after`
    const parts = parseContent(markdown)

    expect(parts).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]))
    expect(parts.map((part) => part.content).join('')).toBe(markdown)
  })

  it.each(['\n', '\r'])('does not parse an image destination spanning %p', (lineBreak) => {
    const markdown = `![image](https://evil.example${lineBreak}@project.supabase.co/image.png)`
    const parts = parseContent(markdown)

    expect(parts).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]))
    expect(parts.map((part) => part.content).join('')).toBe(markdown)
  })

  it.each(["'", '(', ')'])(
    'keeps %p inside a renderer-reachable direct-video URL token',
    (delimiter) => {
      const url = `https://evil.example${delimiter}@project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`

      expect(new URL(url).origin).toBe('https://project.supabase.co')
      expect(parseContent(url)).toEqual([
        {
          type: 'video',
          content: url,
          url,
          video: { type: 'direct', embedUrl: url, originalUrl: url },
        },
      ])
    }
  )

  it.each(['{', '}', '|', '^', '\\'])(
    'parses a direct video separately after the raw URL delimiter %p',
    (delimiter) => {
      const externalUrl = 'https://evil.example/x'
      const videoUrl =
        'https://project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4'
      const content = `${externalUrl}${delimiter}${videoUrl}`
      const parts = parseContent(content)

      expect(parts.map((part) => part.content).join('')).toBe(content)
      expect(parts).toEqual(
        expect.arrayContaining([
          { type: 'link', content: externalUrl, url: externalUrl },
          {
            type: 'video',
            content: videoUrl,
            url: videoUrl,
            video: { type: 'direct', embedUrl: videoUrl, originalUrl: videoUrl },
          },
        ])
      )
    }
  )

  it.each([
    ['video', 'https://cdn.example/video.mp4', 'direct', 'https://cdn.example/video.mp4'],
    [
      'VIDEO',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'youtube',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ],
    [
      '视频',
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'bilibili',
      '//player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0',
    ],
  ])(
    'renders the persisted [%s] marker through the existing video capability',
    (label, url, type, embedUrl) => {
      expect(parseContent(`[${label}](${url})`)).toEqual([
        {
          type: 'video',
          content: url,
          url,
          video: { type, embedUrl, originalUrl: url },
        },
      ])
    }
  )

  it.each([
    '[video](javascript:evil.mp4)',
    '[video](/relative/video.mp4)',
    '[video](https://cdn.example/video.txt)',
  ])('preserves an invalid or unsupported video marker verbatim: %s', (marker) => {
    expect(parseContent(marker)).toEqual([{ type: 'text', content: marker }])
  })

  it.each(['\n', '\r'])(
    'does not consume a video marker whose destination spans %p',
    (lineBreak) => {
      const marker = `[video](https://evil.example${lineBreak}/video.mp4)`
      const parts = parseContent(marker)

      expect(parts).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'video' })])
      )
      expect(parts.map((part) => part.content).join('')).toBe(marker)
    }
  )

  it.each([
    '[video](![image](https://cdn.example/image.png))',
    '![image]([video](https://cdn.example/video.mp4))',
  ])('consumes an outer overlapping media range exactly once: %s', (content) => {
    const parts = parseContent(content)

    expect(parts.some((part) => part.type === 'image' || part.type === 'video')).toBe(false)
    expect(parts.map((part) => part.content).join('')).toBe(content)
  })

  it('keeps marker/image order and consumes two adjacent markers independently', () => {
    const directUrl = 'https://cdn.example/first.mp4'
    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    const imageUrl = 'https://cdn.example/image.webp'

    expect(parseContent(`[video](${directUrl})[视频](${youtubeUrl})![image](${imageUrl})`)).toEqual(
      [
        {
          type: 'video',
          content: directUrl,
          url: directUrl,
          video: { type: 'direct', embedUrl: directUrl, originalUrl: directUrl },
        },
        {
          type: 'video',
          content: youtubeUrl,
          url: youtubeUrl,
          video: {
            type: 'youtube',
            embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
            originalUrl: youtubeUrl,
          },
        },
        { type: 'image', content: 'image', url: imageUrl },
      ]
    )
  })

  it('continues rendering a raw direct URL after an unsupported marker', () => {
    const marker = '[video](https://cdn.example/no-extension)'
    const directUrl = 'https://cdn.example/video.mp4'

    expect(parseContent(`${marker}${directUrl}`)).toEqual([
      { type: 'text', content: marker },
      {
        type: 'video',
        content: directUrl,
        url: directUrl,
        video: { type: 'direct', embedUrl: directUrl, originalUrl: directUrl },
      },
    ])
  })

  it('keeps same-host HTTP managed image and video URLs renderer-reachable', () => {
    const imageUrl =
      'http://project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'
    const videoUrl =
      'http://project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4'

    expect(
      parseContent(`![image](${imageUrl})\n${videoUrl}`).filter((part) => part.type !== 'text')
    ).toEqual([
      { type: 'image', content: 'image', url: imageUrl },
      {
        type: 'video',
        content: videoUrl,
        url: videoUrl,
        video: { type: 'direct', embedUrl: videoUrl, originalUrl: videoUrl },
      },
    ])
  })

  it('keeps alternate Storage image and signed-video routes renderer-reachable', () => {
    const imageUrl =
      'https://project.supabase.co/storage/v1/render/image/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp?width=100'
    const videoUrl =
      'https://project.supabase.co/storage/v1/object/sign/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4?token=one'

    expect(
      parseContent(`![image](${imageUrl})\n${videoUrl}`).filter((part) => part.type !== 'text')
    ).toEqual([
      { type: 'image', content: 'image', url: imageUrl },
      {
        type: 'video',
        content: videoUrl,
        url: videoUrl,
        video: { type: 'direct', embedUrl: videoUrl, originalUrl: videoUrl },
      },
    ])
  })

  it('keeps DNS root-dot managed image and video URLs renderer-reachable', () => {
    const imageUrl =
      'https://project.supabase.co./storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'
    const videoUrl =
      'https://project.supabase.co./storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4'

    expect(
      parseContent(`![image](${imageUrl})\n${videoUrl}`).filter((part) => part.type !== 'text')
    ).toEqual([
      { type: 'image', content: 'image', url: imageUrl },
      {
        type: 'video',
        content: videoUrl,
        url: videoUrl,
        video: { type: 'direct', embedUrl: videoUrl, originalUrl: videoUrl },
      },
    ])
  })

  it('keeps official direct-host S3 image and video URLs renderer-reachable', () => {
    const imageUrl =
      'https://project.storage.supabase.co/storage/v1/s3/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp?X-Amz-Signature=one'
    const videoUrl =
      'https://project.storage.supabase.co/storage/v1/s3/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4?X-Amz-Signature=one'

    expect(
      parseContent(`![image](${imageUrl})\n${videoUrl}`).filter((part) => part.type !== 'text')
    ).toEqual([
      { type: 'image', content: 'image', url: imageUrl },
      {
        type: 'video',
        content: videoUrl,
        url: videoUrl,
        video: { type: 'direct', embedUrl: videoUrl, originalUrl: videoUrl },
      },
    ])
  })
})

describe('isAllowedContentImageUrl', () => {
  it.each([
    'http://example.com/image.png',
    'https://example.com/image.png',
    'HTTPS://EXAMPLE.COM/image.png',
  ])('allows an absolute network image URL: %s', (url) => {
    expect(isAllowedContentImageUrl(url)).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'blob:https://example.com/id',
    'file:///tmp/image.png',
    '//example.com/image.png',
    'https://',
    '',
  ])('rejects a non-http(s) or malformed image URL: %s', (url) => {
    expect(isAllowedContentImageUrl(url)).toBe(false)
  })
})
