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
})

describe('hashtag DOM canonicalization', () => {
  it('links a 30-character tag but never links a truncated prefix of a longer token', () => {
    const validTag = 'x'.repeat(30)
    const overlongTag = 'y'.repeat(31)
    const { container } = render(
      <div>{linkifyTagsAndMentions(`#${validTag} #${overlongTag}`)}</div>
    )

    const links = Array.from(container.querySelectorAll('a'))
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', `/hashtag/${validTag}`)
    expect(container).toHaveTextContent(`#${overlongTag}`)
  })

  it('keeps a token plain when lowercase expansion leaves the canonical alphabet', () => {
    const { container } = render(<div>{linkifyTagsAndMentions('#İ')}</div>)

    expect(container.querySelector('a')).toBeNull()
    expect(container).toHaveTextContent('#İ')
  })
})
