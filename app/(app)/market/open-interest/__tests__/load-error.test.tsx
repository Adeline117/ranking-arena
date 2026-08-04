import type { ReactElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

const mockRefresh = jest.fn()
const mockRpc = jest.fn()
const mockLimit = jest.fn()
const mockOrder = jest.fn(() => ({ limit: mockLimit }))
const mockSelect = jest.fn(() => ({ order: mockOrder }))
const mockFrom = jest.fn(() => ({ select: mockSelect }))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          all: 'All',
          failedToLoad: 'Failed to load',
          marketDataPending: 'Market data is pending',
          noOpenInterestData: 'No open interest data',
          retry: 'Retry',
          tryAgain: 'Please try again',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <div>{title}</div>,
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({
    title,
    description,
    retry,
  }: {
    title: string
    description: string
    retry: () => void
  }) => (
    <div role="alert">
      <span>{title}</span>
      <span>{description}</span>
      <button onClick={retry}>Retry</button>
    </div>
  ),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

import OpenInterestPage from '../page'
import OpenInterestClient from '../OpenInterestClient'

type PageElementProps = {
  rows: unknown[]
  loadError: boolean
  degraded: boolean
}

describe('OpenInterestPage load state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('passes a retryable error to the client when RPC and fallback both fail', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } })
    mockLimit.mockResolvedValue({ data: null, error: { message: 'DB unavailable' } })

    const element = (await OpenInterestPage()) as ReactElement<PageElementProps>
    expect(element.props).toMatchObject({ rows: [], loadError: true, degraded: false })

    render(element)

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load')
    expect(screen.queryByText('No open interest data')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful empty response as a genuine empty state', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })

    const element = (await OpenInterestPage()) as ReactElement<PageElementProps>
    expect(element.props).toMatchObject({ rows: [], loadError: false, degraded: false })

    render(element)

    expect(screen.getByText('No open interest data')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('physically bounds both database attempts when the query client never settles', async () => {
    jest.useFakeTimers()
    mockRpc.mockReturnValue(new Promise(() => undefined))
    mockLimit.mockReturnValue(new Promise(() => undefined))

    const request = OpenInterestPage()
    await jest.advanceTimersByTimeAsync(4_000)
    const element = (await request) as ReactElement<PageElementProps>

    expect(element.props).toMatchObject({ rows: [], loadError: true, degraded: false })
  })

  it('rejects malformed canonical data and labels the bounded fallback as incomplete', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          platform: 'binance',
          symbol: 'BTCUSDT',
          open_interest_usd: -1,
          open_interest_contracts: 2,
          timestamp: '2026-08-03T20:00:00.000Z',
        },
      ],
      error: null,
    })
    mockLimit.mockResolvedValue({
      data: [
        {
          platform: 'binance',
          symbol: 'BTCUSDT',
          open_interest_usd: 1_000,
          open_interest_contracts: 2,
          timestamp: '2026-08-03T20:00:00.000Z',
        },
      ],
      error: null,
    })

    const element = (await OpenInterestPage()) as ReactElement<PageElementProps>
    expect(element.props).toMatchObject({ loadError: false, degraded: true })

    render(element)
    expect(screen.getByRole('status')).toHaveTextContent('dataLoadIncomplete')
  })

  it('separates a symbol-filter miss from a genuine empty authority', () => {
    render(
      <OpenInterestClient
        rows={[
          {
            platform: 'binance',
            symbol: 'BTCUSDT',
            open_interest_usd: 1_000,
            open_interest_contracts: 2,
            timestamp: '2026-08-03T20:00:00.000Z',
          },
        ]}
        observedAt="2026-08-03T20:30:00.000Z"
      />
    )

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ETH' } })
    expect(screen.getByText('noMatchingResults')).toBeInTheDocument()
    expect(screen.queryByText('noOpenInterestData')).not.toBeInTheDocument()
  })

  it('marks an entirely old snapshot as incomplete even when its rows are mutually recent', () => {
    render(
      <OpenInterestClient
        rows={[
          {
            platform: 'binance',
            symbol: 'BTCUSDT',
            open_interest_usd: 1_000,
            open_interest_contracts: null,
            timestamp: '2026-08-01T20:00:00.000Z',
          },
        ]}
        observedAt="2026-08-03T20:30:00.000Z"
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('dataLoadIncomplete')
  })
})
