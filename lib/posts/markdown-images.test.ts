import {
  findMarkdownImageTokens,
  findMarkdownLinkTokens,
  findMarkdownVideoTokens,
  findRawContentUrlTokens,
  moveMarkdownImage,
  removeMarkdownImage,
} from './markdown-images'

describe('post Markdown image controls', () => {
  const firstUrl = 'https://cdn.example/image.png'
  const secondUrl = 'https://cdn.example/image.png?variant=2'

  it('recognizes custom alt text and compares image URLs exactly', () => {
    expect(
      findMarkdownImageTokens(`![custom alt](${firstUrl})\n![second](${secondUrl})`)
    ).toMatchObject([
      { alt: 'custom alt', url: firstUrl },
      { alt: 'second', url: secondUrl },
    ])

    expect(removeMarkdownImage(`![custom alt](${secondUrl})`, firstUrl)).toEqual({
      content: `![custom alt](${secondUrl})`,
      removed: false,
    })
  })

  it('moves adjacent images without corrupting placeholder-like user content', () => {
    const content = `__PLACEHOLDER_1__\n![first](${firstUrl})\nbetween\n![second](${secondUrl})`

    expect(moveMarkdownImage(content, secondUrl, 'up')).toEqual({
      content: `__PLACEHOLDER_1__\n![second](${secondUrl})\nbetween\n![first](${firstUrl})`,
      status: 'moved',
    })
  })

  it('reports boundaries and removes custom-alt tokens', () => {
    const content = `before\n![custom alt](${firstUrl})\nafter`

    expect(moveMarkdownImage(content, firstUrl, 'up')).toEqual({ content, status: 'boundary' })
    expect(removeMarkdownImage(content, firstUrl)).toEqual({
      content: 'before\n\nafter',
      removed: true,
    })
  })

  it.each(['\n', '\r'])('does not span a %p inside an image destination', (lineBreak) => {
    expect(
      findMarkdownImageTokens(
        `![image](https://evil.example${lineBreak}@project.supabase.co/image.png)`
      )
    ).toEqual([])
  })

  it.each(['{', '}', '|', '^', '\\'])(
    'keeps raw URLs separated across the renderer delimiter %p',
    (delimiter) => {
      const first = 'https://cdn.example/first'
      const second = 'https://cdn.example/second.mp4'

      expect(findRawContentUrlTokens(`${first}${delimiter}${second}`)).toEqual([
        { url: first, start: 0, end: first.length },
        {
          url: second,
          start: first.length + delimiter.length,
          end: first.length + delimiter.length + second.length,
        },
      ])
    }
  )

  it('parses non-image Markdown links without duplicating image destinations', () => {
    expect(
      findMarkdownLinkTokens(
        `[video](https://cdn.example/video.mp4) ![image](https://cdn.example/image.webp)`
      )
    ).toMatchObject([
      {
        label: 'video',
        url: 'https://cdn.example/video.mp4',
        start: 0,
        end: '[video](https://cdn.example/video.mp4)'.length,
      },
    ])
  })

  it.each(['\n', '\r'])('does not span a %p inside a link destination', (lineBreak) => {
    expect(
      findMarkdownLinkTokens(
        `[video](https://evil.example${lineBreak}@project.supabase.co/video.mp4)`
      )
    ).toEqual([])
  })

  it.each(['video', 'Video', 'VIDEO', '视频', '動画', '동영상'])(
    'recognizes the exact persisted video marker label %p',
    (label) => {
      expect(findMarkdownVideoTokens(`[${label}](https://cdn.example/video.mp4)`)).toMatchObject([
        { label, url: 'https://cdn.example/video.mp4' },
      ])
    }
  )

  it.each([' video', 'video ', 'videos', '视 频', '影片', '비디오'])(
    'does not widen the video marker label to %p',
    (label) => {
      expect(findMarkdownVideoTokens(`[${label}](https://cdn.example/video.mp4)`)).toEqual([])
    }
  )

  it.each(['\n', '\r'])('does not span a %p inside a video marker', (lineBreak) => {
    expect(findMarkdownVideoTokens(`[video](https://evil.example${lineBreak}/video.mp4)`)).toEqual(
      []
    )
  })
})
