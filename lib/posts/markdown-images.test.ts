import {
  findMarkdownImageTokens,
  findMarkdownLinkTokens,
  findMarkdownVideoTokens,
  findRawContentUrlTokens,
  moveMarkdownImage,
  removeMarkdownImage,
  removeMarkdownImageReferences,
  removeMarkdownVideoMarkers,
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

  it('removes every exact image reference while preserving all other bytes', () => {
    const content =
      `before\r\n![custom alt](${firstUrl})\r\nmiddle ` +
      `![duplicate](${firstUrl}) after\n![near match](${secondUrl})\n`

    const result = removeMarkdownImageReferences(content, firstUrl)

    expect(result).toEqual({
      content: `before\r\n\r\nmiddle  after\n![near match](${secondUrl})\n`,
      removed: 2,
    })
    expect(removeMarkdownImageReferences(result.content, firstUrl)).toEqual({
      content: result.content,
      removed: 0,
    })
  })

  it('returns empty content only when removing image references leaves whitespace', () => {
    expect(removeMarkdownImageReferences(` \r\n![only](${firstUrl})\n\t`, firstUrl)).toEqual({
      content: '',
      removed: 1,
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

  it.each(['video', 'Video', 'VIDEO', '视频', '動画', '동영상'])(
    'removes the persisted video marker label %p from its own line',
    (label) => {
      expect(
        removeMarkdownVideoMarkers(`before\n[${label}](https://cdn.example/video.mp4)\nafter`)
      ).toEqual({ content: 'before\n\nafter', removed: 1 })
    }
  )

  it('removes a standalone marker from CRLF content without leaving a carriage return', () => {
    expect(
      removeMarkdownVideoMarkers('before\r\n[video](https://cdn.example/video.mp4)\r\nafter')
    ).toEqual({ content: 'before\r\n\r\nafter', removed: 1 })
  })

  it('removes multiple markers once and is idempotent', () => {
    const content =
      '[VIDEO](https://cdn.example/one.mp4)\nbody\n[视频](https://cdn.example/two.mp4)\n' +
      '[動画](https://cdn.example/three.mp4)[동영상](https://cdn.example/four.mp4)'

    const result = removeMarkdownVideoMarkers(content)

    expect(result).toEqual({ content: '\nbody\n\n', removed: 4 })
    expect(removeMarkdownVideoMarkers(result.content)).toEqual({
      content: result.content,
      removed: 0,
    })
  })

  it('returns empty content when only whitespace remains after marker removal', () => {
    expect(removeMarkdownVideoMarkers('\n[video](https://cdn.example/video.mp4)\n')).toEqual({
      content: '',
      removed: 1,
    })
  })

  it('preserves every byte outside the removed marker ranges', () => {
    expect(removeMarkdownVideoMarkers('left[video](https://cdn.example/video.mp4)right')).toEqual({
      content: 'leftright',
      removed: 1,
    })
    expect(
      removeMarkdownVideoMarkers(
        'before\n\n[video](https://cdn.example/video.mp4)\n\nafter\n\nunchanged'
      )
    ).toEqual({ content: 'before\n\n\n\nafter\n\nunchanged', removed: 1 })
    expect(
      removeMarkdownVideoMarkers('left[video](https://cdn.example/video.mp4)\n\n\nright')
    ).toEqual({ content: 'left\n\n\nright', removed: 1 })
  })

  it.each([
    '[videos](https://cdn.example/video.mp4)',
    '[ video](https://cdn.example/video.mp4)',
    '[video ](https://cdn.example/video.mp4)',
    '[link](https://cdn.example/video.mp4)',
    '![video](https://cdn.example/video.mp4)',
    '[video]()',
    '[video](https://cdn.example\n/video.mp4)',
    '[video](https://cdn.example\r/video.mp4)',
  ])('preserves a non-marker token exactly: %p', (content) => {
    expect(removeMarkdownVideoMarkers(content)).toEqual({ content, removed: 0 })
  })

  it('does not remove beyond a parsed marker range when tokens overlap', () => {
    expect(
      removeMarkdownVideoMarkers('[video](![image](https://cdn.example/image.webp))tail')
    ).toEqual({ content: ')tail', removed: 1 })

    const imageContainingMarker = '![image]([video](https://cdn.example/video.mp4))'
    expect(removeMarkdownVideoMarkers(imageContainingMarker)).toEqual({
      content: imageContainingMarker,
      removed: 0,
    })
  })
})
