import { fireEvent, render, screen } from '@testing-library/react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockTrackEvent = jest.fn()
const mockUserFollowButton = jest.fn(() => null)
const mockTraderFollowButton = jest.fn(() => null)
const mockWatchlistToggleButton = jest.fn(() => null)
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

describe('TraderHeaderActions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    comparisonState.isSelected.mockReturnValue(false)
    comparisonState.addTrader.mockReturnValue(false)
    comparisonState.canAddMore.mockReturnValue(false)
  })

  it('uses the claimed user UUID for social follow without replacing the trader account ID', () => {
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

  it('does not fall back to an exchange account ID for a registered user follow', () => {
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
    expect(mockTraderFollowButton).not.toHaveBeenCalled()
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
