import { fireEvent, render, screen } from '@testing-library/react'
import ExchangeScopeNotice from '../ExchangeScopeNotice'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) => (key === 'rankingFilteredByExchange' ? 'Filtered by {exchange}' : key),
  }),
}))

describe('ExchangeScopeNotice', () => {
  it('renders nothing without an exchange scope', () => {
    const { container } = render(<ExchangeScopeNotice exchange={null} onClear={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the exchange and clears it on click', () => {
    const onClear = jest.fn()
    render(<ExchangeScopeNotice exchange="bybit" onClear={onClear} />)
    expect(screen.getByTestId('exchange-scope-notice')).toHaveTextContent(/Filtered by Bybit/i)
    fireEvent.click(screen.getByRole('button', { name: 'rankingClearExchangeFilter' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
