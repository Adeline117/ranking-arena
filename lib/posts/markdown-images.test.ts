import { findMarkdownImageTokens, moveMarkdownImage, removeMarkdownImage } from './markdown-images'

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
})
