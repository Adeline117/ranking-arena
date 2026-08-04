import React from 'react'
import { render, screen } from '@testing-library/react'
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
