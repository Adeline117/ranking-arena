import { fireEvent, render, screen } from '@testing-library/react'
import ExchangeRankingsClient from '../ExchangeRankingsClient'
import type {
  ExchangeRankingRow,
  ExchangeRankings,
  ExchangeRankingsTimeframe,
} from '@/lib/data/serving/exchange-rankings'

const mockRefresh = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    refresh: mockRefresh,
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => key,
  }),
}))

const row: ExchangeRankingRow = {
  source: 'hyperliquid',
  exchangeSlug: 'hyperliquid',
  exchangeName: 'Hyperliquid',
  productType: 'onchain',
  currency: 'USDC',
  rankedTraders: 20,
  medianRoi: 12,
  topDecileRoi: 42,
  pctProfitable: 60,
  copierPnl: null,
  botShare: 5,
  provenance: {
    source: 'hyperliquid',
    asOf: '2026-07-18T12:00:00.000Z',
    derived: false,
  },
}

function result(
  timeframe: ExchangeRankingsTimeframe,
  rows: ExchangeRankingRow[] = []
): ExchangeRankings {
  return {
    nonLegacyCount: 5,
    timeframe,
    rows,
  }
}

describe('ExchangeRankingsClient failure states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows a retryable error instead of empty copy for a failed timeframe', () => {
    render(
      <ExchangeRankingsClient
        byTimeframe={{ 7: result(7), 30: result(30), 90: null }}
        failedTimeframes={[90]}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(screen.queryByText('exchangeRankingsEmpty')).not.toBeInTheDocument()

    const retry = screen.getByRole('button', { name: 'retry' })
    expect(window.getComputedStyle(retry).minHeight).toBe('44px')
    expect(window.getComputedStyle(retry).minWidth).toBe('44px')

    fireEvent.click(retry)
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('keeps successful rows visible and labels a partial result', () => {
    render(
      <ExchangeRankingsClient
        byTimeframe={{ 7: null, 30: result(30), 90: result(90, [row]) }}
        failedTimeframes={[7]}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('dataLoadIncomplete')
    expect(screen.getByRole('link', { name: 'Hyperliquid' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps last-known-good rows visible when a later refresh fails', () => {
    const view = render(
      <ExchangeRankingsClient
        byTimeframe={{ 7: result(7), 30: result(30), 90: result(90, [row]) }}
      />
    )

    view.rerender(
      <ExchangeRankingsClient
        byTimeframe={{ 7: result(7), 30: result(30), 90: null }}
        failedTimeframes={[90]}
      />
    )

    expect(screen.getByRole('link', { name: 'Hyperliquid' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('dataLoadIncomplete')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('exchangeRankingsEmpty')).not.toBeInTheDocument()
  })

  it('keeps timeframe, retry, and table-sort touch targets at least 44px tall', () => {
    render(
      <ExchangeRankingsClient
        byTimeframe={{ 7: null, 30: result(30), 90: result(90, [row]) }}
        failedTimeframes={[7]}
      />
    )

    expect(screen.getByRole('tab', { name: '90D' })).toHaveStyle({
      minWidth: '44px',
      minHeight: '44px',
    })
    expect(screen.getByRole('button', { name: 'retry' })).toHaveStyle({
      minWidth: '44px',
      minHeight: '44px',
    })
    expect(screen.getByRole('button', { name: 'sortBy exchangeRankingsColExchange' })).toHaveStyle({
      minHeight: '44px',
    })
  })

  it('renders genuine successful emptiness without an error state', () => {
    render(
      <ExchangeRankingsClient byTimeframe={{ 7: result(7), 30: result(30), 90: result(90) }} />
    )

    expect(screen.getByText('exchangeRankingsEmpty')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
