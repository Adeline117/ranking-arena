import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import FundingRatesClient from '../FundingRatesClient'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockRefresh = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLoggerError(...args) }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => null,
}))

import FundingRatesPage from '../page'

function fallbackResult(result: {
  data: Array<{
    platform: string
    symbol: string
    funding_rate: number
    funding_time: string
  }> | null
  error: { message: string } | null
}) {
  const limit = jest.fn().mockResolvedValue(result)
  const order = jest.fn(() => ({ limit }))
  const select = jest.fn(() => ({ order }))
  return { select }
}

describe('funding rates load state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('passes an explicit error state to the client when RPC and fallback both fail', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } })
    mockFrom.mockReturnValue(
      fallbackResult({ data: null, error: { message: 'database unavailable' } })
    )

    const page = await FundingRatesPage()

    expect(page.props).toMatchObject({ rates: [], loadError: true, degraded: false })
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[funding-rates] fetch error:',
      'database unavailable'
    )
  })

  it('keeps a successful empty response distinct from a load failure', async () => {
    mockRpc.mockRejectedValue(new Error('RPC unavailable'))
    mockFrom.mockReturnValue(fallbackResult({ data: [], error: null }))

    const page = await FundingRatesPage()

    expect(page.props).toMatchObject({ rates: [], loadError: false, degraded: true })
  })

  it('accepts a genuine empty canonical RPC without running the degraded fallback', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })

    const page = await FundingRatesPage()

    expect(page.props).toMatchObject({ rates: [], loadError: false, degraded: false })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('physically bounds both database attempts even when their promises never settle', async () => {
    jest.useFakeTimers()
    mockRpc.mockReturnValue(new Promise(() => undefined))
    const limit = jest.fn(() => new Promise(() => undefined))
    const order = jest.fn(() => ({ limit }))
    const select = jest.fn(() => ({ order }))
    mockFrom.mockReturnValue({ select })

    const request = FundingRatesPage()
    await jest.advanceTimersByTimeAsync(4_000)
    const page = await request

    expect(page.props).toMatchObject({ rates: [], loadError: true, degraded: false })
  })

  it('shows a persistent retry error and refreshes the route on request', () => {
    render(<FundingRatesClient rates={[]} loadError />)

    expect(screen.getByRole('alert')).toHaveTextContent('marketDataError')
    expect(screen.getByText('checkNetworkAndRetry')).toBeInTheDocument()
    expect(screen.queryByText('noFundingData')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('preserves the normal empty state when the request succeeds with no rows', () => {
    render(<FundingRatesClient rates={[]} />)

    expect(screen.getByText('noFundingData')).toBeInTheDocument()
    expect(screen.getByText('marketDataPending')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('marks the bounded fallback as incomplete and lets the user retry', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } })
    mockFrom.mockReturnValue(
      fallbackResult({
        data: [
          {
            platform: 'binance',
            symbol: 'BTCUSDT',
            funding_rate: 0.0001,
            funding_time: '2026-08-03T20:00:00.000Z',
          },
        ],
        error: null,
      })
    )

    const page = await FundingRatesPage()
    render(page)

    expect(screen.getByRole('status')).toHaveTextContent('dataLoadIncomplete')
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed successful payload instead of publishing partial rows', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          platform: 'binance',
          symbol: 'BTCUSDT',
          funding_rate: Number.NaN,
          funding_time: '2026-08-03T20:00:00.000Z',
        },
      ],
      error: null,
    })
    mockFrom.mockReturnValue(fallbackResult({ data: null, error: null }))

    const page = await FundingRatesPage()

    expect(page.props).toMatchObject({ rates: [], loadError: true, degraded: false })
  })

  it('shows a true filtered-empty state without erasing the loaded source set', () => {
    render(
      <FundingRatesClient
        rates={[
          {
            platform: 'binance',
            symbol: 'BTCUSDT',
            funding_rate: 0.0001,
            funding_time: '2026-08-03T20:00:00.000Z',
          },
        ]}
      />
    )

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ETH' } })
    expect(screen.getByText('noMatchingResults')).toBeInTheDocument()
    expect(screen.queryByText('noFundingData')).not.toBeInTheDocument()
  })
})
