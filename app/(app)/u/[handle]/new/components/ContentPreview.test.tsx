import { fireEvent, render, screen } from '@testing-library/react'
import { renderContentWithControls } from './ContentPreview'

const translate = (key: string) => key

describe('profile post content preview', () => {
  it('preserves unsafe markdown image targets as text', () => {
    render(
      <div>
        {renderContentWithControls(
          'before ![attack](javascript:alert(1)) after',
          jest.fn(),
          jest.fn(),
          translate
        )}
      </div>
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText(/!\[attack\]\(javascript:alert\(1\)\)/)).toBeInTheDocument()
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
})
