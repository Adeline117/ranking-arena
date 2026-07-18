import { fireEvent, render, screen } from '@testing-library/react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockTrackEvent = jest.fn()
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

jest.mock('../../ui/TraderFollowButton', () => () => null)
jest.mock('../../ui/UserFollowButton', () => () => null)
jest.mock('../WatchlistToggleButton', () => () => null)
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

describe('TraderHeaderActions compare feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    comparisonState.isSelected.mockReturnValue(false)
    comparisonState.addTrader.mockReturnValue(false)
    comparisonState.canAddMore.mockReturnValue(false)
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
