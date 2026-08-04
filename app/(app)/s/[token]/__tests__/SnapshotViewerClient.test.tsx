import { act, fireEvent, render, screen } from '@testing-library/react'
import SnapshotViewerClient from '../SnapshotViewerClient'

const mockShowToast = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

jest.mock('@/lib/utils/avatar-proxy', () => ({
  avatarSrc: (value: string) => value,
}))

const snapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  shareToken: '0123456789abcdef',
  timeRange: '90D',
  exchange: 'all',
  totalTraders: 1,
  topTrader: { handle: 'alpha', roi: 12.5 },
  dataCapturedAt: '2026-08-03T12:00:00.000Z',
  dataDelayMinutes: 5,
  viewCount: 3,
  expiresAt: '2026-08-10T12:00:00.000Z',
  createdAt: '2026-08-03T12:00:01.000Z',
  isExpired: false,
}

const traders = [
  {
    rank: 1,
    id: 'trader/one',
    handle: 'alpha',
    source: 'binance futures',
    roi: 12.5,
    pnl: 100,
    winRate: 55,
    maxDrawdown: 8,
    arenaScore: 70,
  },
]

describe('SnapshotViewerClient interaction contract', () => {
  const writeText = jest.fn<Promise<void>, [string]>()

  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    writeText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('offers 44px navigation/share targets and a canonical trader-profile row link', () => {
    render(<SnapshotViewerClient snapshot={snapshot} traders={traders} />)

    expect(screen.getByRole('link', { name: 'backToHome' })).toHaveStyle({
      width: '44px',
      height: '44px',
    })
    expect(screen.getByRole('button', { name: 'shareSnapshot' })).toHaveStyle({
      minWidth: '44px',
      minHeight: '44px',
    })
    expect(screen.getByRole('link', { name: 'trader: alpha' })).toHaveAttribute(
      'href',
      '/trader/trader%2Fone?platform=binance%20futures'
    )
  })

  it('single-flights clipboard writes and exposes copied truth only after completion', async () => {
    let resolveWrite: (() => void) | undefined
    writeText.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
    )
    render(<SnapshotViewerClient snapshot={snapshot} traders={traders} />)

    const share = screen.getByRole('button', { name: 'shareSnapshot' })
    fireEvent.click(share)
    fireEvent.click(share)

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(share).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'snapshotCopied' })).not.toBeInTheDocument()

    await act(async () => resolveWrite?.())

    expect(screen.getByRole('button', { name: 'snapshotCopied' })).toBeEnabled()
    expect(mockShowToast).toHaveBeenCalledWith('copiedToClipboard', 'success')
  })

  it('bounds a hung clipboard operation and unlocks retry with explicit failure truth', async () => {
    jest.useFakeTimers()
    writeText.mockReturnValue(new Promise<void>(() => undefined))
    render(<SnapshotViewerClient snapshot={snapshot} traders={traders} />)

    fireEvent.click(screen.getByRole('button', { name: 'shareSnapshot' }))
    expect(screen.getByRole('button', { name: 'shareSnapshot' })).toBeDisabled()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000)
    })

    expect(screen.getByRole('button', { name: 'shareSnapshot' })).toBeEnabled()
    expect(mockShowToast).toHaveBeenCalledWith('copyFailed', 'error')
  })
})
