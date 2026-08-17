import { fireEvent, render, screen } from '@testing-library/react'
import { linkifyTagsAndMentions, renderContentParts, renderContentWithLinks } from '../content'

describe('markdown image DOM safety', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'blob:https://example.com/1234',
    'file:///etc/passwd',
    '//example.com/protocol-relative.png',
  ])('renders a rejected image URL as ordinary text: %s', (url) => {
    const markdown = `![unsafe](${url})`
    const { container } = render(<div>{renderContentWithLinks(markdown)}</div>)

    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent(markdown)
  })

  it('rejects unsafe image parts constructed without the parser', () => {
    const markdown = '![unsafe](javascript:alert(1))'
    const { container } = render(
      <div>
        {renderContentParts([{ type: 'image', content: 'unsafe', url: 'javascript:alert(1)' }])}
      </div>
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent(markdown)
  })

  it('opens an allowed image with an isolated window context', () => {
    const popup = { opener: window } as unknown as Window
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(popup)
    const url = 'https://example.com/image.png'

    render(<div>{renderContentWithLinks(`![chart](${url})`)}</div>)
    fireEvent.click(screen.getByRole('img', { name: 'chart' }))

    expect(openSpy).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
    expect(popup.opener).toBeNull()
  })

  it.each(['\n', '\r'])('does not render an image destination spanning %p', (lineBreak) => {
    const markdown = `![image](https://evil.example${lineBreak}@project.supabase.co/image.png)`
    const { container } = render(<div>{renderContentWithLinks(markdown)}</div>)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe(markdown)
  })

  it.each(["'", '(', ')'])(
    'keeps %p inside a renderer-reachable direct-video URL token',
    (delimiter) => {
      const url = `https://evil.example${delimiter}@project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`
      const { container } = render(<div>{renderContentWithLinks(url)}</div>)
      const video = container.querySelector('video')

      expect(video).not.toBeNull()
      expect(video).toHaveAttribute('src', url)
    }
  )

  it.each(['{', '}', '|', '^', '\\'])(
    'renders a direct video separately after the raw URL delimiter %p',
    (delimiter) => {
      const videoUrl =
        'https://project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4'
      const { container } = render(
        <div>{renderContentWithLinks(`https://evil.example/x${delimiter}${videoUrl}`)}</div>
      )

      expect(container.querySelector('video')).toHaveAttribute('src', videoUrl)
    }
  )

  it('renders a persisted direct-video marker as a video element', () => {
    const url = 'https://cdn.example/video.mp4'
    const { container } = render(<div>{renderContentWithLinks(`[video](${url})`)}</div>)

    expect(container.querySelector('video')).toHaveAttribute('src', url)
    expect(container.textContent).toBe('')
  })

  it('renders a persisted Chinese Bilibili marker through the existing iframe capability', () => {
    const url = 'https://www.bilibili.com/video/BV1xx411c7mD'
    const { container } = render(<div>{renderContentWithLinks(`[视频](${url})`)}</div>)

    expect(container.querySelector('iframe')).toHaveAttribute(
      'src',
      '//player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0'
    )
  })

  it('preserves an unsupported video marker without creating media', () => {
    const marker = '[video](https://cdn.example/video.txt)'
    const { container } = render(<div>{renderContentWithLinks(marker)}</div>)

    expect(container.querySelector('video, iframe')).toBeNull()
    expect(container.textContent).toBe(marker)
  })

  it.each([
    [
      'same-host HTTP public routes',
      'http://project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
      'http://project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
    ],
    [
      'alternate render and sign routes',
      'https://project.supabase.co/storage/v1/render/image/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp?width=100',
      'https://project.supabase.co/storage/v1/object/sign/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4?token=one',
    ],
    [
      'DNS root-dot public routes',
      'https://project.supabase.co./storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
      'https://project.supabase.co./storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
    ],
    [
      'official direct-host S3 routes',
      'https://project.storage.supabase.co/storage/v1/s3/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp?X-Amz-Signature=one',
      'https://project.storage.supabase.co/storage/v1/s3/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4?X-Amz-Signature=one',
    ],
  ])('renders %s before the claim boundary rejects them', (_label, imageUrl, videoUrl) => {
    const { container } = render(
      <div>{renderContentWithLinks(`![image](${imageUrl})\n${videoUrl}`)}</div>
    )

    expect(container.querySelector('img')).toHaveAttribute('src', imageUrl)
    expect(container.querySelector('video')).toHaveAttribute('src', videoUrl)
  })
})

describe('mention rendering', () => {
  it('links canonical Unicode and dotted legacy handles', () => {
    render(<div>{linkifyTagsAndMentions('Hi @测试用户 and @legacy.name')}</div>)

    expect(screen.getByRole('link', { name: '@测试用户' })).toHaveAttribute(
      'href',
      `/u/${encodeURIComponent('测试用户')}`
    )
    expect(screen.getByRole('link', { name: '@legacy.name' })).toHaveAttribute(
      'href',
      '/u/legacy.name'
    )
  })

  it('does not link email suffixes or partial overlong handles', () => {
    const overlong = `@${'a'.repeat(31)}`
    const { container } = render(
      <div>{linkifyTagsAndMentions(`mail@example.com ${overlong}`)}</div>
    )

    expect(container.querySelector('a')).toBeNull()
    expect(container).toHaveTextContent(`mail@example.com ${overlong}`)
  })
})
