import { act, fireEvent, render, screen } from '@testing-library/react'
import CookieConsent from '../CookieConsent'

jest.mock('next/navigation', () => ({
  usePathname: () => '/groups',
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

describe('CookieConsent bottom flow', () => {
  const originalResizeObserver = global.ResizeObserver
  const originalMutationObserver = global.MutationObserver
  let cookieHeight = 156
  let mutationCallback: MutationCallback | null
  let mutationObserve: jest.Mock
  let mutationDisconnect: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    cookieHeight = 156
    mutationCallback = null
    mutationObserve = jest.fn()
    mutationDisconnect = jest.fn()
    localStorage.clear()
    document.documentElement.classList.remove('has-cookie-consent')
    document.documentElement.style.removeProperty('--cookie-consent-height')
    document.documentElement.style.removeProperty('--transient-bottom-offset')
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const height = this.classList.contains('cookie-consent') ? cookieHeight : 0
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 390,
        bottom: height,
        left: 0,
        width: 390,
        height,
        toJSON: () => ({}),
      }
    })
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    global.MutationObserver = class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback
      }

      observe = mutationObserve
      disconnect = mutationDisconnect
      takeRecords() {
        return []
      }
    }
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    global.ResizeObserver = originalResizeObserver
    global.MutationObserver = originalMutationObserver
    document.documentElement.classList.remove('has-cookie-consent')
    document.documentElement.style.removeProperty('--cookie-consent-height')
    document.documentElement.style.removeProperty('--transient-bottom-offset')
  })

  it('publishes its measured height, clears the mobile nav, and links directly to privacy', () => {
    render(<CookieConsent />)

    act(() => {
      jest.advanceTimersByTime(2000)
    })

    const region = screen.getByRole('region', { name: 'cookieSettings' })
    expect(region).toHaveStyle({
      bottom: 'calc(var(--mobile-nav-height, 60px) + var(--safe-area-inset-bottom, 0px))',
    })
    expect(screen.getByRole('link', { name: 'privacyPolicy' })).toHaveAttribute('href', '/privacy')
    expect(screen.getByRole('button', { name: 'necessaryOnly' })).toHaveClass(
      'cookie-consent-action'
    )
    expect(screen.getByRole('button', { name: 'acceptAll' })).toHaveClass('cookie-consent-action')
    expect(document.documentElement).toHaveClass('has-cookie-consent')
    expect(document.documentElement.style.getPropertyValue('--cookie-consent-height')).toBe('156px')
    expect(document.documentElement.style.getPropertyValue('--transient-bottom-offset')).toBe(
      '156px'
    )
    expect(mutationObserve).toHaveBeenCalledWith(region, {
      characterData: true,
      childList: true,
      subtree: true,
    })
  })

  it('publishes a DOM-driven height change in the mutation microtask before the first frame', () => {
    render(<CookieConsent />)
    act(() => {
      jest.advanceTimersByTime(2000)
    })

    cookieHeight = 221
    act(() => {
      mutationCallback?.([], {} as MutationObserver)
    })

    expect(document.documentElement.style.getPropertyValue('--cookie-consent-height')).toBe('221px')
    expect(document.documentElement.style.getPropertyValue('--transient-bottom-offset')).toBe(
      '221px'
    )
  })

  it('stores the explicit choice and removes the reserved offset', () => {
    render(<CookieConsent />)
    act(() => {
      jest.advanceTimersByTime(2000)
    })

    fireEvent.click(screen.getByRole('button', { name: 'necessaryOnly' }))

    expect(localStorage.getItem('cookie_consent')).toBe('rejected')
    expect(screen.queryByRole('region', { name: 'cookieSettings' })).not.toBeInTheDocument()
    expect(document.documentElement).not.toHaveClass('has-cookie-consent')
    expect(document.documentElement.style.getPropertyValue('--transient-bottom-offset')).toBe('')
    expect(mutationDisconnect).toHaveBeenCalledTimes(1)
  })
})
