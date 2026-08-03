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
