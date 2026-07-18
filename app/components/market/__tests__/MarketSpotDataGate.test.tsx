import { fireEvent, render, screen } from '@testing-library/react'
import MarketSpotDataGate from '../MarketSpotDataGate'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          marketDataError: 'Market data failed to load',
          loadFailedRetryShort: 'Failed to load, please retry',
          retry: 'Retry',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

describe('MarketSpotDataGate', () => {
  it('reserves the skeleton for a pending request', () => {
    const view = render(
      <MarketSpotDataGate pending failed={false} retry={jest.fn()} height={300}>
        <span>spot content</span>
      </MarketSpotDataGate>
    )

    expect(screen.getByTestId('market-spot-loading')).toBeInTheDocument()
    expect(screen.queryByText('spot content')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).toBeInTheDocument()
  })

  it('ends a failed request with a visible retry action', () => {
    const retry = jest.fn()
    const view = render(
      <MarketSpotDataGate pending={false} failed retry={retry} height={300}>
        <span>spot content</span>
      </MarketSpotDataGate>
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Market data failed to load')
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('renders successful content, including a genuine empty result', () => {
    render(
      <MarketSpotDataGate pending={false} failed={false} retry={jest.fn()} height={300}>
        <span>No data available</span>
      </MarketSpotDataGate>
    )

    expect(screen.getByText('No data available')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByTestId('market-spot-loading')).not.toBeInTheDocument()
  })
})
