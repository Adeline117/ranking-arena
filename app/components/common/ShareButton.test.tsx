import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ShareButton from './ShareButton'

const mockShowToast = jest.fn()
const mockTrackEvent = jest.fn()
const mockWriteText = jest.fn()
const nativeUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
const nativeShare = Object.getOwnPropertyDescriptor(navigator, 'share')
const nativeClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

const translations: Record<string, string> = {
  share: 'Share',
  shareUserText: 'Discover @{handle} on Arena {url}',
  shareToTwitter: 'Share to X',
  shareToTelegram: 'Share to Telegram',
  shareToWhatsApp: 'Share to WhatsApp',
  copyLink: 'Copy link',
  linkCopied: 'Link copied',
  copyFailed: 'Copy failed',
  popupBlocked: 'Popup blocked',
}

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => translations[key] ?? key }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

function overrideNavigatorProperty(property: string, value: unknown) {
  Object.defineProperty(navigator, property, { configurable: true, value })
}

function restoreNavigatorProperty(property: string, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(navigator, property, descriptor)
  else Reflect.deleteProperty(navigator, property)
}

describe('ShareButton user profiles', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    overrideNavigatorProperty('userAgent', 'Desktop Browser')
    overrideNavigatorProperty('clipboard', { writeText: mockWriteText })
    mockWriteText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    restoreNavigatorProperty('userAgent', nativeUserAgent)
    restoreNavigatorProperty('share', nativeShare)
    restoreNavigatorProperty('clipboard', nativeClipboard)
  })

  it('opens an accessible touch-sized menu and copies the canonical profile URL', async () => {
    const url = 'https://www.arenafi.org/u/alice'
    render(<ShareButton data={{ type: 'user', url, userHandle: 'alice' }} showLabel={false} />)

    const trigger = screen.getByRole('button', { name: 'Share' })
    expect(trigger).toHaveAttribute('type', 'button')
    expect(trigger).toHaveStyle({ minHeight: '44px' })

    fireEvent.click(trigger)
    const copy = screen.getByRole('menuitem', { name: 'Copy link' })
    expect(copy).toHaveAttribute('type', 'button')
    expect(copy).toHaveStyle({ minHeight: '44px' })
    fireEvent.click(copy)

    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(url))
    expect(mockShowToast).toHaveBeenCalledWith('Link copied', 'success', 2000)
  })

  it('uses the localized profile text with native mobile sharing', async () => {
    const url = 'https://www.arenafi.org/u/alice'
    const share = jest.fn().mockResolvedValue(undefined)
    overrideNavigatorProperty('userAgent', 'Mobile Safari')
    overrideNavigatorProperty('share', share)
    render(<ShareButton data={{ type: 'user', url, userHandle: 'alice' }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({
        text: `Discover @alice on Arena ${url}`,
        url,
      })
    )
  })
})
