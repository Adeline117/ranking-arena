import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import TokensIndexClient from '../TokensIndexClient'

let mockLanguage = 'en'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: mockLanguage,
    t: (key: string) => (mockLanguage === 'en' ? key : `${mockLanguage}:${key}`),
  }),
}))

const initialTokens = [
  {
    token: 'BTC',
    trade_count: 10,
    trader_count: 3,
    total_pnl: 100,
  },
]

const originalFetch = global.fetch

function successfulResponse(body: unknown): Pick<Response, 'ok' | 'status' | 'json'> {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('TokensIndexClient hydration readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLanguage = 'en'
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  it('keeps controlled inputs inert in SSR markup', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<TokensIndexClient initialTokens={initialTokens} />)

    expect(container.querySelector('.tk-search-input')).toBeDisabled()
    for (const button of container.querySelectorAll('.tk-sort-btn')) {
      expect(button).toBeDisabled()
    }
  })

  it('enables every control only after the client mount effect', async () => {
    render(<TokensIndexClient initialTokens={initialTokens} />)

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeEnabled()
    }

    expect(screen.getByRole('link', { name: /BTC/ })).toHaveAttribute('data-trader-count', '3')
  })

  it('keeps the mobile search and sort controls at least 44px tall', async () => {
    render(<TokensIndexClient initialTokens={initialTokens} />)

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    expect(screen.getByRole('textbox')).toHaveStyle({ minHeight: '44px' })
    for (const button of screen.getAllByRole('button')) {
      expect(window.getComputedStyle(button).minHeight).toBe('44px')
    }
  })

  it('treats a successful empty SSR result as legitimate data', async () => {
    global.fetch = jest.fn()
    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="success" />)

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())

    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(container.querySelector('[data-token="BTC"]')).toHaveAttribute('data-trader-count', '0')
  })

  it('shows an honest retry state when SSR and API loading fail', async () => {
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
          tokens: [
            {
              token: 'BTC',
              trade_count: 12,
              trader_count: 4,
              total_pnl: 250,
            },
          ],
        }),
      })
    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-token="BTC"]')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    await waitFor(() =>
      expect(container.querySelector('[data-token="BTC"]')).toHaveAttribute(
        'data-trader-count',
        '4'
      )
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([400, 500])('turns an HTTP %i into a terminal retry state', async (status) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => ({ error: 'Unavailable' }),
    })

    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-token="BTC"]')).not.toBeInTheDocument()
  })

  it('turns a non-JSON response into a terminal retry state', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    })

    render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
  })

  it('rejects malformed token rows before they can reach sorting or rendering', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      successfulResponse({
        tokens: [
          {
            token: 'btc',
            trade_count: 1,
            trader_count: 1,
            total_pnl: Number.NaN,
          },
        ],
      })
    )

    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-token="btc"]')).not.toBeInTheDocument()
  })

  it('accepts an authoritative empty API result without disguising it as an error', async () => {
    global.fetch = jest.fn().mockResolvedValue(successfulResponse({ tokens: [] }))
    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    await waitFor(() =>
      expect(container.querySelector('[data-token="BTC"]')).toHaveAttribute(
        'data-trader-count',
        '0'
      )
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reaches an error at the hard deadline even when fetch ignores AbortSignal', async () => {
    jest.useFakeTimers()
    const lateResponse = deferred<Pick<Response, 'ok' | 'status' | 'json'>>()
    global.fetch = jest.fn().mockReturnValue(lateResponse.promise)
    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000)
    })

    expect(screen.getByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-token="BTC"]')).not.toBeInTheDocument()

    lateResponse.resolve(successfulResponse({ tokens: initialTokens }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-token="BTC"]')).not.toBeInTheDocument()
  })

  it('releases the timed-out request so retry can establish fresh truth', async () => {
    jest.useFakeTimers()
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce(
        successfulResponse({
          tokens: [{ ...initialTokens[0], trade_count: 22, trader_count: 8 }],
        })
      )
    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000)
    })
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[data-token="BTC"]')).toHaveAttribute('data-trader-count', '8')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps labelled last-known-good data visible with a compact retry state', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tokens: initialTokens, degraded: true }),
    })
    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-token="BTC"]')).toHaveAttribute('data-trader-count', '3')
  })

  it('retains last-known-good rows when a later retry also fails', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(successfulResponse({ tokens: initialTokens, degraded: true }))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Unavailable' }),
      })
    const { container } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-token="BTC"]')).toHaveAttribute('data-trader-count', '3')

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('failedToLoadRankings'))

    expect(container.querySelector('[data-token="BTC"]')).toHaveAttribute('data-trader-count', '3')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('localizes the terminal state without refetching public data on language changes', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Unavailable' }),
    })
    const { rerender } = render(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    mockLanguage = 'zh'
    rerender(<TokensIndexClient initialTokens={[]} initialStatus="error" />)

    expect(screen.getByRole('alert')).toHaveTextContent('zh:failedToLoadRankings')
    expect(screen.getByRole('button', { name: 'zh:retry' })).toBeInTheDocument()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
