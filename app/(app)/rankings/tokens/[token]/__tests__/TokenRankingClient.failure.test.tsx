import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  source: 'binance_futures',
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
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function receipt(
  period: '7D' | '30D' | '90D',
  traders: TokenTrader[],
  total: number,
  offset = 0,
  token = 'BTC'
) {
  return { token, period, limit: 50, offset, traders, total }
}

function successfulResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

describe('TokenRankingClient failure state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams.delete('page')
    mockSearchParams.delete('period')
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
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
    for (const label of ['days7', 'days30', 'days90']) {
      expect(screen.getByRole('button', { name: label })).toHaveStyle({ minHeight: '44px' })
    }
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
        json: async () => receipt('7D', [], 0),
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
        json: async () =>
          receipt(
            '90D',
            [
              {
                ...initialTrader,
                source_trader_id: 'trader-page-1',
                handle: 'Bob',
              },
            ],
            51,
            50
          ),
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

  it('reconciles browser period navigation and restores the exact cached scope', async () => {
    global.fetch = jest.fn().mockResolvedValue(successfulResponse(receipt('7D', [], 0)))
    const { rerender } = render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[initialTrader]}
        initialTotal={1}
        initialStatus="success"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    mockSearchParams.set('period', '7D')
    rerender(
      <TokenRankingClient
        token="BTC"
        initialPeriod="7D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="success"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    await waitFor(() =>
      expect(String((global.fetch as jest.Mock).mock.calls[0]?.[0])).toContain(
        'token=BTC&period=7D&limit=50&offset=0'
      )
    )
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument())
    expect(screen.getAllByText('tokenRankingNoData').length).toBeGreaterThan(0)

    mockSearchParams.delete('period')
    rerender(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[initialTrader]}
        initialTotal={1}
        initialStatus="success"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(global.fetch).toHaveBeenCalledTimes(1)
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
      json: async () => receipt('30D', [], 0),
    })
    await waitFor(() => expect(thirtyDayButton).toHaveAttribute('aria-pressed', 'true'))
    await waitFor(() => expect(screen.getAllByText('tokenRankingNoData').length).toBeGreaterThan(0))

    sevenDay.resolve({
      ok: true,
      status: 200,
      json: async () => receipt('7D', [initialTrader], 1),
    })
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument())
  })

  it('reaches a terminal error when fetch ignores AbortSignal and ignores its late response', async () => {
    jest.useFakeTimers()
    const lateFetch = deferred<ReturnType<typeof successfulResponse>>()
    global.fetch = jest.fn().mockReturnValue(lateFetch.promise)
    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="error"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(screen.queryByText('tokenRankingNoData')).not.toBeInTheDocument()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000)
    })

    expect(screen.getByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(screen.getByRole('button', { name: 'retry' })).toHaveStyle({ minHeight: '44px' })

    lateFetch.resolve(successfulResponse(receipt('90D', [initialTrader], 1)))
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  })

  it('applies the same physical deadline when response.json ignores AbortSignal', async () => {
    jest.useFakeTimers()
    const lateJson = deferred<unknown>()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => lateJson.promise,
    })
    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="error"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('failedToLoadRankings')

    lateJson.resolve(receipt('90D', [initialTrader], 1))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  })

  it('releases a timed-out request so retry can establish fresh same-scope truth', async () => {
    jest.useFakeTimers()
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce(successfulResponse(receipt('90D', [initialTrader], 1)))
    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="error"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000)
    })
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['token', { ...receipt('90D', [], 0), token: 'ETH' }],
    ['period', { ...receipt('90D', [], 0), period: '7D' }],
    ['limit', { ...receipt('90D', [], 0), limit: 25 }],
    ['offset', { ...receipt('90D', [], 0), offset: 50 }],
    ['extra root field', { ...receipt('90D', [], 0), request_id: 'wrong-contract' }],
    ['malformed trader', receipt('90D', [{ ...initialTrader, token_win_rate: 101 }], 1)],
  ])('fails closed on a 200 response with mismatched %s identity', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue(successfulResponse(body))
    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="error"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  })

  it('turns non-JSON success into an explicit retry state', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    })
    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="error"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
  })

  it('aborts the old token scope and ignores a late response after a keyed remount', async () => {
    const btc = deferred<ReturnType<typeof successfulResponse>>()
    const eth = deferred<ReturnType<typeof successfulResponse>>()
    const signals: AbortSignal[] = []
    global.fetch = jest.fn((_input, init) => {
      if (init?.signal) signals.push(init.signal)
      return signals.length === 1 ? btc.promise : eth.promise
    }) as typeof fetch
    const { rerender } = render(
      <TokenRankingClient
        key="BTC"
        token="BTC"
        initialPeriod="90D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="error"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    rerender(
      <TokenRankingClient
        key="ETH"
        token="ETH"
        initialPeriod="7D"
        initialTraders={[]}
        initialTotal={0}
        initialStatus="error"
        asOf="2026-07-18T00:00:00.000Z"
      />
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(signals[0]?.aborted).toBe(true)
    expect(String((global.fetch as jest.Mock).mock.calls[1]?.[0])).toContain(
      'token=ETH&period=7D&limit=50&offset=0'
    )

    eth.resolve(
      successfulResponse(
        receipt(
          '7D',
          [{ ...initialTrader, source_trader_id: 'eth-trader', handle: 'Bob' }],
          1,
          0,
          'ETH'
        )
      )
    )
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument())

    btc.resolve(successfulResponse(receipt('90D', [initialTrader], 1)))
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument())
    expect(screen.getByText('Bob')).toBeInTheDocument()
  })
})
