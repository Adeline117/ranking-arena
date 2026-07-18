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

  it('passes an explicit error state to the client when RPC and fallback both fail', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } })
    mockFrom.mockReturnValue(
      fallbackResult({ data: null, error: { message: 'database unavailable' } })
    )

    const page = await FundingRatesPage()

    expect(page.props).toMatchObject({ rates: [], loadError: true })
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[funding-rates] fetch error:',
      'database unavailable'
    )
  })

  it('keeps a successful empty response distinct from a load failure', async () => {
    mockRpc.mockRejectedValue(new Error('RPC unavailable'))
    mockFrom.mockReturnValue(fallbackResult({ data: [], error: null }))

    const page = await FundingRatesPage()

    expect(page.props).toMatchObject({ rates: [], loadError: false })
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
})
