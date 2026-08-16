import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockTrackEvent = jest.fn()
const mockUserFollowButton = jest.fn(() => <button data-testid="user-follow-action">Follow</button>)
const mockMessageButton = jest.fn(() => (
  <button data-testid="message-action">Send a private message with a long label</button>
))
const mockTraderFollowButton = jest.fn(() => (
  <button data-testid="trader-follow-action">Follow trader</button>
))
const mockWatchlistToggleButton = jest.fn(() => (
  <button data-testid="watchlist-action" aria-label="Watchlist" />
))
const comparisonState = {
  isSelected: jest.fn(() => false),
  addTrader: jest.fn(() => false),
  removeTrader: jest.fn(),
  canAddMore: jest.fn(() => false),
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          compare: 'Compare',
          comparing: 'Comparing',
          addToCompare: 'Add to compare',
          removeFromCompare: 'Remove from compare',
          compareListFull: 'Compare list full (max 10)',
          more: 'More',
          editProfile: 'Edit profile',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/stores/comparisonStore', () => ({
  useComparisonStore: (selector: (state: typeof comparisonState) => unknown) =>
    selector(comparisonState),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

jest.mock('../../base', () => ({
  Box: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> }) => (
    <div {...props}>{children}</div>
  ),
}))

jest.mock('../TraderHeaderHelpers', () => ({
  ActionButton: ({
    onClick,
    ariaLabel,
    children,
  }: {
    onClick: () => void
    ariaLabel?: string
    children: React.ReactNode
  }) => (
    <button onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}))

jest.mock('../../ui/TraderFollowButton', () => ({
  __esModule: true,
  default: (props: unknown) => mockTraderFollowButton(props),
}))
jest.mock('../../ui/UserFollowButton', () => ({
  __esModule: true,
  default: (props: unknown) => mockUserFollowButton(props),
}))
jest.mock('../../ui/MessageButton', () => ({
  __esModule: true,
  default: (props: unknown) => mockMessageButton(props),
}))
jest.mock('../WatchlistToggleButton', () => ({
  __esModule: true,
  default: (props: unknown) => mockWatchlistToggleButton(props),
}))
jest.mock('../AlertBellButton', () => () => null)
jest.mock('../TraderShareActions', () => () => null)

import { TraderHeaderActions } from '../TraderHeaderActions'

function renderActions() {
  render(
    <TraderHeaderActions
      traderId="trader-1"
      handle="Trader One"
      source="binance"
      isOwnProfile={false}
      userId={null}
    />
  )
}

function renderClaimedActions(userId: string | null = null) {
  return render(
    <TraderHeaderActions
      traderId="exchange-account-id"
      registeredUserId="11111111-1111-4111-8111-111111111111"
      handle="Trader One"
      source="binance"
      isOwnProfile={false}
      isRegistered
      userId={userId}
    />
  )
}

describe('TraderHeaderActions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    comparisonState.isSelected.mockReturnValue(false)
    comparisonState.addTrader.mockReturnValue(false)
    comparisonState.canAddMore.mockReturnValue(false)
  })

  it('uses the claimed user UUID for social actions without replacing the trader account ID', () => {
    comparisonState.addTrader.mockReturnValue(true)
    comparisonState.canAddMore.mockReturnValue(true)
    render(
      <TraderHeaderActions
        traderId="exchange-account-id"
        registeredUserId="11111111-1111-4111-8111-111111111111"
        handle="Trader One"
        source="binance"
        isOwnProfile={false}
        isRegistered
        userId="22222222-2222-4222-8222-222222222222"
      />
    )

    expect(mockUserFollowButton).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: '11111111-1111-4111-8111-111111111111',
        currentUserId: '22222222-2222-4222-8222-222222222222',
      })
    )
    expect(mockUserFollowButton).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: 'exchange-account-id' })
    )
    expect(mockMessageButton).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: '11111111-1111-4111-8111-111111111111',
        currentUserId: '22222222-2222-4222-8222-222222222222',
        loginReturnPath: '/trader/Trader%20One?platform=binance',
      })
    )
    expect(mockMessageButton).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: 'exchange-account-id' })
    )
    expect(mockWatchlistToggleButton).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'binance',
        sourceTraderID: 'exchange-account-id',
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(comparisonState.addTrader).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exchange-account-id', source: 'binance' })
    )
  })

  it('keeps the single message action in the responsive secondary disclosure', () => {
    const { container } = renderClaimedActions()
    const actions = container.querySelector('.profile-header-actions')
    const secondary = actions?.querySelector(':scope > .trader-secondary-actions')
    const follow = screen.getByTestId('user-follow-action')
    const message = screen.getByTestId('message-action')
    const watchlist = screen.getByTestId('watchlist-action')
    const more = screen.getByRole('button', { name: 'More' })

    expect(actions).not.toBeNull()
    expect(actions).toHaveClass('trader-profile-header-actions')
    expect(secondary).not.toBeNull()
    expect(actions?.querySelectorAll('[data-testid="message-action"]')).toHaveLength(1)
    expect(secondary).toContainElement(message)
    expect(secondary).not.toContainElement(follow)
    expect(secondary).not.toContainElement(watchlist)
    expect(more).toHaveAttribute('aria-controls', secondary?.id)
    expect(more).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(secondary).toHaveAttribute('data-open', 'true')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(secondary).toHaveAttribute('data-open', 'false')
    expect(more).toHaveFocus()
  })

  it.each([
    ['English', en],
    ['Japanese', ja],
    ['Korean', ko],
    ['Chinese', zh],
  ])('keeps the 320px primary row within its conservative %s label budget', (_name, labels) => {
    const responsiveCss = readFileSync(join(process.cwd(), 'public/styles/responsive.css'), 'utf8')
    const actionCss = responsiveCss.slice(
      responsiveCss.indexOf('/* Trader profile actions: Follow/Save stay primary')
    )
    const mobileActionCss = actionCss.slice(actionCss.indexOf('@media (max-width: 767px)'))

    // Bind the arithmetic to the responsive contract: the long Message label
    // is in the hidden secondary group until More opens, while the primary row
    // stays nowrap with only Follow, Watch, and More.
    expect(mobileActionCss).toMatch(
      /\.trader-profile-header-actions\s*\{[^}]*flex-wrap:\s*nowrap\s*!important;/s
    )
    expect(mobileActionCss).not.toMatch(
      /(?:^|\n)\s*\.profile-header-actions\s*\{[^}]*flex-wrap:\s*nowrap\s*!important;/s
    )
    expect(mobileActionCss).toMatch(/\.trader-secondary-actions\s*\{\s*display: none;/)
    expect(mobileActionCss).toContain(".trader-secondary-actions[data-open='true']")

    const codePointWidthUpperBound = 13
    const latinAdvanceUpperBound = codePointWidthUpperBound * 0.75
    const textWidth = (label: string) =>
      [...label].reduce(
        (width, character) =>
          width +
          (character.codePointAt(0)! <= 0x7f ? latinAdvanceUpperBound : codePointWidthUpperBound),
        0
      )
    const availableWidth = 320 - 2 * 8 - 2 * 10 - 2
    const followWidth = 2 * 16 + 2 + textWidth(labels.follow)
    const watchWidth = 2 * 12 + 2 + 16
    const moreWidth = 2 * 12 + 2 + 3 * codePointWidthUpperBound + 6 + textWidth(labels.more)
    const primaryGapWidth = 2 * 6

    expect(followWidth + watchWidth + moreWidth + primaryGapWidth).toBeLessThanOrEqual(
      availableWidth
    )
  })

  it('fails closed when a registered profile is missing its user UUID', () => {
    render(
      <TraderHeaderActions
        traderId="exchange-account-id"
        handle="Trader One"
        source="binance"
        isOwnProfile={false}
        isRegistered
        userId="22222222-2222-4222-8222-222222222222"
      />
    )

    expect(mockUserFollowButton).not.toHaveBeenCalled()
    expect(mockMessageButton).not.toHaveBeenCalled()
    expect(mockTraderFollowButton).not.toHaveBeenCalled()
  })

  it('never exposes user messaging for an unregistered exchange account', () => {
    render(
      <TraderHeaderActions
        traderId="exchange-account-id"
        handle="Trader One"
        source="binance"
        isOwnProfile={false}
        isRegistered={false}
        userId="22222222-2222-4222-8222-222222222222"
      />
    )

    expect(mockMessageButton).not.toHaveBeenCalled()
    expect(mockTraderFollowButton).toHaveBeenCalledWith(
      expect.objectContaining({ traderId: 'exchange-account-id', source: 'binance' })
    )
  })

  it('preserves the anonymous message login intent and exact trader return path', () => {
    render(
      <TraderHeaderActions
        traderId="exchange-account-id"
        registeredUserId="11111111-1111-4111-8111-111111111111"
        handle="Trader One"
        source="binance"
        isOwnProfile={false}
        isRegistered
        userId={null}
      />
    )

    expect(mockMessageButton).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: '11111111-1111-4111-8111-111111111111',
        currentUserId: null,
        loginReturnPath: '/trader/Trader%20One?platform=binance',
      })
    )
  })

  it('uses the claimed user route override for every login-gated action', () => {
    render(
      <TraderHeaderActions
        traderId="exchange-account-id"
        registeredUserId="11111111-1111-4111-8111-111111111111"
        handle="Trader One"
        source="binance"
        isOwnProfile={false}
        isRegistered
        userId={null}
        loginReturnPath="/u/arena-user"
      />
    )

    expect(mockUserFollowButton).toHaveBeenCalledWith(
      expect.objectContaining({ loginReturnPath: '/u/arena-user' })
    )
    expect(mockMessageButton).toHaveBeenCalledWith(
      expect.objectContaining({ loginReturnPath: '/u/arena-user' })
    )
    expect(mockWatchlistToggleButton).toHaveBeenCalledWith(
      expect.objectContaining({ loginReturnPath: '/u/arena-user' })
    )
  })

  it('keeps edit and suppresses follow actions for the authenticated profile owner', () => {
    render(
      <TraderHeaderActions
        traderId="exchange-account-id"
        registeredUserId="11111111-1111-4111-8111-111111111111"
        handle="Trader One"
        source="binance"
        isOwnProfile
        isRegistered
        userId="11111111-1111-4111-8111-111111111111"
      />
    )

    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeInTheDocument()
    expect(mockUserFollowButton).not.toHaveBeenCalled()
    expect(mockMessageButton).not.toHaveBeenCalled()
    expect(mockTraderFollowButton).not.toHaveBeenCalled()
  })

  it('warns when the store rejects a full-list add and does not report a selection', () => {
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))

    expect(comparisonState.addTrader).toHaveBeenCalledWith({
      id: 'trader-1',
      handle: 'Trader One',
      source: 'binance',
      avatarUrl: undefined,
    })
    expect(mockShowToast).toHaveBeenCalledWith('Compare list full (max 10)', 'warning')
    expect(mockTrackEvent).not.toHaveBeenCalled()
  })

  it('reports selected only after the store accepts the add', () => {
    comparisonState.addTrader.mockReturnValue(true)
    comparisonState.canAddMore.mockReturnValue(true)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))

    expect(mockShowToast).not.toHaveBeenCalled()
    expect(mockTrackEvent).toHaveBeenCalledWith('compare_trader', {
      traderId: 'trader-1',
      source: 'binance',
      selected: true,
    })
  })
})
