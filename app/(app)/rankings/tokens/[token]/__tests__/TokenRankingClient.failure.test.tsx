import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TokenTrader } from '../TokenRankingClient'

const mockReplace = jest.fn()
const mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/rankings/tokens/BTC',
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/app/components/common/ProvenanceFooter', () => ({
  __esModule: true,
  default: () => null,
}))

import TokenRankingClient from '../TokenRankingClient'

const initialTrader: TokenTrader = {
  source: 'binance',
  source_trader_id: 'trader-90d',
  handle: 'Alice',
  avatar_url: null,
  arena_score: 81,
  roi: 12,
  total_pnl: 500,
  token_pnl: 200,
  token_trade_count: 8,
  token_win_rate: 62,
  token_avg_pnl_pct: 3,
}

const originalFetch = global.fetch

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('TokenRankingClient failure state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams.delete('page')
    mockSearchParams.delete('period')
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('does not fetch or show an error for a legitimate empty SSR page', async () => {
    global.fetch = jest.fn()
    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="success"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    await waitFor(() => expect(screen.getAllByText('tokenRankingNoData').length).toBeGreaterThan(0))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('isolates failures by period and restores the exact last-good period', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: 'BTC',
          period: '7D',
          traders: [],
          total: 0,
        }),
      })

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[initialTrader]}
        initialTotal={1}
        initialStatus="success"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    expect(screen.getByText('Alice')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'days7' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
    expect(screen.getAllByText('tokenRankingNoData').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'days90' }))

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not show page zero data under a failed later page', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: 'BTC',
          period: '90D',
          traders: [
            {
              ...initialTrader,
              source_trader_id: 'trader-page-1',
              handle: 'Bob',
            },
          ],
          total: 51,
        }),
      })

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[initialTrader]}
        initialTotal={51}
        initialStatus="success"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'tokenRankingNext' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'tokenRankingPrev' }))

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('lets a newer period abort and replace an in-flight period request', async () => {
    const sevenDay = deferred<{
      ok: boolean
      status: number
      json: () => Promise<unknown>
    }>()
    const thirtyDay = deferred<{
      ok: boolean
      status: number
      json: () => Promise<unknown>
    }>()
    const requestSignals: AbortSignal[] = []
    global.fetch = jest.fn((_input, init) => {
      if (init?.signal) requestSignals.push(init.signal)
      return requestSignals.length === 1 ? sevenDay.promise : thirtyDay.promise
    }) as typeof fetch

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[initialTrader]}
        initialTotal={1}
        initialStatus="success"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'days7' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    const thirtyDayButton = screen.getByRole('button', { name: 'days30' })
    expect(thirtyDayButton).toBeEnabled()
    fireEvent.click(thirtyDayButton)

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(requestSignals[0]?.aborted).toBe(true)
    expect(requestSignals[1]?.aborted).toBe(false)

    thirtyDay.resolve({
      ok: true,
      status: 200,
      json: async () => ({ token: 'BTC', period: '30D', traders: [], total: 0 }),
    })
    await waitFor(() => expect(thirtyDayButton).toHaveAttribute('aria-pressed', 'true'))
    await waitFor(() => expect(screen.getAllByText('tokenRankingNoData').length).toBeGreaterThan(0))

    sevenDay.resolve({
      ok: true,
      status: 200,
      json: async () => ({ token: 'BTC', period: '7D', traders: [initialTrader], total: 1 }),
    })
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument())
  })
})
