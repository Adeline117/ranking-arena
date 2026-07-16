import { render, screen, waitFor } from '@testing-library/react'
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

describe('TokensIndexClient hydration readiness', () => {
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
})
