import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import RecordsTable from '../RecordsTable'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

describe('RecordsTable asset quantities', () => {
  it('keeps the asset unit and never labels a transfer with settlement currency', () => {
    const view = render(
      <RecordsTable
        columns={[{ key: 'amount', i18nKey: 'colAmount', format: 'asset_quantity' }]}
        rows={[
          { amount: 0.5, asset: 'BTC', currency: 'USDC' },
          { amount: 0.00000012, asset: 'ETH', currency: 'USDT' },
        ]}
      />
    )

    expect(screen.getByText('0.5 BTC')).toBeInTheDocument()
    expect(screen.getByText('0.00000012 ETH')).toBeInTheDocument()
    expect(view.container).not.toHaveTextContent('$')
    expect(view.container).not.toHaveTextContent('USDC')
    expect(view.container).not.toHaveTextContent('USDT')
  })

  it('fails closed when the asset unit is missing', () => {
    render(
      <RecordsTable
        columns={[{ key: 'amount', i18nKey: 'colAmount', format: 'asset_quantity' }]}
        rows={[{ amount: 0.5, asset: null, currency: 'USDC' }]}
      />
    )

    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('never defaults an unknown money unit to USDT', () => {
    render(
      <RecordsTable
        columns={[{ key: 'pnl', i18nKey: 'colRealizedPnl', format: 'money' }]}
        rows={[{ pnl: 12 }, { pnl: 12, currency: 'BTC' }, { pnl: 12, currency: 'USDC' }]}
      />
    )

    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getByText('+$12 USDC')).toBeInTheDocument()
    expect(screen.queryByText(/USDT/)).not.toBeInTheDocument()
  })
})

describe('RecordsTable pagination recovery', () => {
  it('keeps successful rows visible and offers an inline retry after load-more fails', () => {
    const onLoadMore = jest.fn()

    render(
      <RecordsTable
        columns={[{ key: 'symbol', i18nKey: 'colSymbol' }]}
        rows={[{ symbol: 'BTCUSDT' }]}
        hasNextPage
        hasLoadMoreError
        onLoadMore={onLoadMore}
      />
    )

    expect(screen.getByText('BTCUSDT')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('loadMoreFailed')

    const retry = screen.getByRole('button', { name: 'moduleRetry' })
    expect(retry).toHaveAttribute('type', 'button')
    fireEvent.click(retry)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('retains pagination focus when the same action becomes a retry', () => {
    const props = {
      columns: [{ key: 'symbol', i18nKey: 'colSymbol' }],
      rows: [{ symbol: 'BTCUSDT' }],
      hasNextPage: true,
      onLoadMore: jest.fn(),
    }
    const view = render(<RecordsTable {...props} />)
    screen.getByRole('button', { name: 'recordsLoadMore' }).focus()

    view.rerender(<RecordsTable {...props} hasLoadMoreError />)

    expect(screen.getByRole('button', { name: 'moduleRetry' })).toHaveFocus()
  })

  it('disables the pagination action while a retry is running', () => {
    render(
      <RecordsTable
        columns={[{ key: 'symbol', i18nKey: 'colSymbol' }]}
        rows={[{ symbol: 'ETHUSDT' }]}
        hasNextPage
        hasLoadMoreError
        isFetchingNextPage
        onLoadMore={jest.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'loading' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'loading' }).parentElement).toHaveAttribute(
      'aria-busy',
      'true'
    )
  })
})
