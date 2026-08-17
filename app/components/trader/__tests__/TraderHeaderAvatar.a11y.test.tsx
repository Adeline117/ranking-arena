import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { TraderHeaderAvatar } from '../TraderHeaderAvatar'

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <img src={src} alt={alt} {...props} />
  ),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => ({ scrollToTop: 'Back to top' })[key] ?? key }),
}))

describe('TraderHeaderAvatar accessibility', () => {
  let scrollToSpy: jest.SpyInstance

  beforeEach(() => {
    scrollToSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  })

  afterEach(() => {
    scrollToSpy.mockRestore()
  })

  it('uses a focusable native button for the back-to-top affordance', () => {
    render(<TraderHeaderAvatar traderId="trader-1" handle="Trader One" />)

    const button = screen.getByRole('button', { name: 'Back to top' })
    expect(button).toHaveAttribute('type', 'button')
    button.focus()
    expect(button).toHaveFocus()

    fireEvent.click(button)
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })
})
