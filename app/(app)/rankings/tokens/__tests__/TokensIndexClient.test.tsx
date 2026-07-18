import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import TokensIndexClient from '../TokensIndexClient'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => key,
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

describe('TokensIndexClient hydration readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
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
})
