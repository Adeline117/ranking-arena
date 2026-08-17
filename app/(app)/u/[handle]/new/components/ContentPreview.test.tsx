import { fireEvent, render, screen } from '@testing-library/react'
import { renderContentWithControls } from './ContentPreview'

const translate = (key: string) => key

describe('profile post content preview', () => {
  it('preserves unsafe markdown image targets as text', () => {
    const content = 'before ![attack](javascript:alert(1)) after'
    const { container } = render(
      <div>{renderContentWithControls(content, jest.fn(), jest.fn(), translate)}</div>
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.textContent).toBe(content)
  })

  it('opens verified network images without sharing the parent window', () => {
    const openedWindow = { opener: window } as unknown as Window
    const open = jest.spyOn(window, 'open').mockReturnValue(openedWindow)

    render(
      <div>
        {renderContentWithControls(
          '![image](https://cdn.example/image.png)',
          jest.fn(),
          jest.fn(),
          translate
        )}
      </div>
    )

    fireEvent.click(screen.getByRole('img', { name: 'image' }))
    expect(open).toHaveBeenCalledWith(
      'https://cdn.example/image.png',
      '_blank',
      'noopener,noreferrer'
    )
    expect(openedWindow.opener).toBeNull()
    expect(screen.getByTitle('moveUp')).toBeDisabled()
    expect(screen.getByTitle('moveDown')).toBeDisabled()

    open.mockRestore()
  })

  it.each(['\n', '\r'])('does not render an image destination spanning %p', (lineBreak) => {
    const markdown = `![image](https://evil.example${lineBreak}@project.supabase.co/image.png)`
    const { container } = render(
      <div>{renderContentWithControls(markdown, jest.fn(), jest.fn(), translate)}</div>
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.textContent).toBe(markdown)
  })

  it.each(['{', '}', '|', '^', '\\'])(
    'keeps links separate across the shared raw URL delimiter %p',
    (delimiter) => {
      const firstUrl = 'https://evil.example/x'
      const secondUrl =
        'https://project.supabase.co/storage/v1/object/public/posts/abcdefab-cdef-4abc-8def-abcdefabcdef/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4'
      const { container } = render(
        <div>
          {renderContentWithControls(
            `${firstUrl}${delimiter}${secondUrl}`,
            jest.fn(),
            jest.fn(),
            translate
          )}
        </div>
      )

      expect([...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(
        [firstUrl, secondUrl]
      )
      expect(container.querySelector('video')).toBeNull()
    }
  )

  it('renders a persisted direct-video marker without changing raw direct-link behavior', () => {
    const url = 'https://cdn.example/video.mp4'
    const { container } = render(
      <div>{renderContentWithControls(`[video](${url})`, jest.fn(), jest.fn(), translate)}</div>
    )

    expect(container.querySelector('video')).toHaveAttribute('src', url)
    expect(container.querySelector('video')).toHaveAttribute('controls')
    expect(container.querySelector('video')).toHaveAttribute('preload', 'metadata')
  })

  it.each([
    ['VIDEO', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube video'],
    ['動画', 'https://www.bilibili.com/video/BV1xx411c7mD', 'Bilibili video'],
    ['동영상', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube video'],
  ])('renders the persisted %s marker through the existing embed player', (label, url, title) => {
    render(
      <div>{renderContentWithControls(`[${label}](${url})`, jest.fn(), jest.fn(), translate)}</div>
    )

    expect(screen.getByTitle(title)).toBeInTheDocument()
  })

  it.each([
    '[video](javascript:evil.mp4)',
    '[video](/relative/video.mp4)',
    '[视频](https://cdn.example/video.txt)',
  ])('preserves an invalid or unsupported marker verbatim: %s', (marker) => {
    const { container } = render(
      <div>{renderContentWithControls(marker, jest.fn(), jest.fn(), translate)}</div>
    )

    expect(container.querySelector('video, iframe')).toBeNull()
    expect(container.textContent).toBe(marker)
  })

  it.each(['\n', '\r'])(
    'does not consume a video marker whose destination spans %p',
    (lineBreak) => {
      const marker = `[video](https://evil.example${lineBreak}/video.mp4)`
      const { container } = render(
        <div>{renderContentWithControls(marker, jest.fn(), jest.fn(), translate)}</div>
      )

      expect(container.querySelector('video, iframe')).toBeNull()
      expect(container.textContent).toBe(marker)
    }
  )

  it.each([
    '[video](![image](https://cdn.example/image.png))',
    '![image]([video](https://cdn.example/video.mp4))',
  ])('does not render a nested media token outside its outer range: %s', (content) => {
    const { container } = render(
      <div>{renderContentWithControls(content, jest.fn(), jest.fn(), translate)}</div>
    )

    expect(container.querySelector('img, video, iframe')).toBeNull()
    expect(container.textContent).toBe(content)
  })
})
