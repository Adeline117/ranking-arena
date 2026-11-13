/**
 * Keyboard flow through the real SearchDropdown inside the mobile overlay.
 * The dropdown listens on `document`; the overlay input must not swallow the
 * Enter that should open the highlighted result.
 */
import { render, screen, fireEvent, act } from '@testing-library/react'

const mockPush = jest.fn()
const mockAddToHistory = jest.fn().mockResolvedValue([])
const mockOnClose = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, prefetch: jest.fn(), replace: jest.fn() }),
}))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (k: string) => k }),
}))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ userId: null, isLoggedIn: false, authChecked: true, accessToken: null }),
}))
jest.mock('@/lib/services/search-history', () => ({
  initializeHistory: jest.fn().mockResolvedValue([]),
  addToHistory: (...a: unknown[]) => mockAddToHistory(...a),
  removeFromHistory: jest.fn().mockResolvedValue([]),
  clearHistory: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('@/lib/features', () => ({ features: { social: false } }))

import MobileSearchOverlay from '../MobileSearchOverlay'

const fetchMock = jest.fn()

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes('/api/search?q=')
        ? {
            data: {
              query: 'btc',
              total: 2,
              results: {
                traders: [
                  { id: 't1', type: 'trader', title: 'Alpha', href: '/trader/alpha' },
                  { id: 't2', type: 'trader', title: 'Beta', href: '/trader/beta' },
                ],
                posts: [],
                users: [],
                groups: [],
              },
            },
          }
        : { data: {} },
  }))
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => jest.useRealTimers())

async function typeQuery(value: string) {
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value } })
  await act(async () => {
    await jest.advanceTimersByTimeAsync(300)
  })
  return input
}

describe('MobileSearchOverlay keyboard', () => {
  it('Enter without a highlighted result opens the full search page', async () => {
    render(<MobileSearchOverlay open onClose={mockOnClose} />)
    const input = await typeQuery('btc')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockPush).toHaveBeenCalledWith('/search?q=btc')
    expect(mockOnClose).toHaveBeenCalled()
  })

  it('ArrowDown then Enter opens the highlighted result', async () => {
    render(<MobileSearchOverlay open onClose={mockOnClose} />)
    const input = await typeQuery('btc')
    expect(screen.getByText('Alpha')).toBeTruthy()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.getElementById('search-option-1')?.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockPush).toHaveBeenCalledWith('/trader/beta')
    expect(mockPush).not.toHaveBeenCalledWith('/search?q=btc')
  })

  it('Escape closes the overlay', async () => {
    render(<MobileSearchOverlay open onClose={mockOnClose} />)
    const input = await typeQuery('btc')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(mockOnClose).toHaveBeenCalled()
  })
})
