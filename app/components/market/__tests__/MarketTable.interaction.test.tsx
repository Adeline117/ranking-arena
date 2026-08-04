import { fireEvent, render, screen } from '@testing-library/react'
import MarketTable, { type Column } from '../MarketTable'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) => (key === 'noDataGeneric' ? 'No data available' : key),
  }),
}))

interface Row {
  id: string
  rank: number
  name: string
}

describe('MarketTable interaction semantics', () => {
  it('provides a 44px native row action with Enter and Space support', () => {
    const onRowClick = jest.fn()
    const onFavorite = jest.fn()
    const rows: Row[] = [{ id: 'alpha', rank: 1, name: 'Alpha' }]
    const columns: Column<Row>[] = [
      {
        key: 'rank',
        label: 'Rank',
        sortable: true,
        getValue: (row) => row.rank,
      },
      {
        key: 'name',
        label: 'Asset',
        align: 'left',
        render: (row) => <span>{row.name}</span>,
      },
      {
        key: 'favorite',
        label: 'Favorite',
        render: (row) => (
          <button type="button" aria-label={`Favorite ${row.name}`} onClick={onFavorite}>
            Favorite
          </button>
        ),
      },
    ]

    render(
      <MarketTable
        columns={columns}
        data={rows}
        defaultSortKey="rank"
        defaultSortDir="asc"
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
        rowActionColumnKey="name"
        rowActionLabel={(row) => `Open ${row.name}`}
      />
    )

    const rowAction = screen.getByRole('button', { name: 'Open Alpha' })
    expect(rowAction.tagName).toBe('BUTTON')
    expect(rowAction.tabIndex).toBe(0)
    expect(rowAction).toHaveStyle({ minWidth: '44px', minHeight: '44px' })

    fireEvent.click(rowAction)
    fireEvent.keyDown(rowAction, { key: 'Enter' })
    fireEvent.keyDown(rowAction, { key: ' ' })
    expect(onRowClick).toHaveBeenCalledTimes(3)
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0])

    const favorite = screen.getByRole('button', { name: 'Favorite Alpha' })
    fireEvent.click(favorite)
    expect(onFavorite).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledTimes(3)

    const bodyRow = screen.getByText('1').closest('tr')
    expect(bodyRow).not.toHaveAttribute('role', 'button')
    expect(bodyRow).not.toHaveAttribute('tabindex')
    fireEvent.click(bodyRow!)
    expect(onRowClick).toHaveBeenCalledTimes(4)
  })

  it('keeps sortable headers keyboard-operable and at least 44px tall', () => {
    const columns: Column<Row>[] = [
      {
        key: 'rank',
        label: 'Rank',
        sortable: true,
        getValue: (row) => row.rank,
      },
    ]

    render(
      <MarketTable
        columns={columns}
        data={[
          { id: 'alpha', rank: 1, name: 'Alpha' },
          { id: 'beta', rank: 2, name: 'Beta' },
        ]}
        defaultSortKey="rank"
        defaultSortDir="asc"
        rowKey={(row) => row.id}
      />
    )

    const header = screen.getByRole('columnheader', { name: /Rank/ })
    expect(header.tabIndex).toBe(0)
    expect(header).toHaveStyle({ height: '44px' })
    expect(header).toHaveAttribute('aria-sort', 'ascending')

    fireEvent.keyDown(header, { key: 'Enter' })
    expect(header).toHaveAttribute('aria-sort', 'descending')
    fireEvent.keyDown(header, { key: ' ' })
    expect(header).toHaveAttribute('aria-sort', 'ascending')
  })
})
