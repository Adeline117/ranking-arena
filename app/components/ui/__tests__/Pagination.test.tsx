import { fireEvent, render, screen } from '@testing-library/react'
import Pagination from '../Pagination'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          paginationNav: 'Pagination',
          prevPage: 'Previous page',
          nextPage: 'Next page',
          goToPage: 'Go to page {page}',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

describe('Pagination unknown-total mode', () => {
  it('renders only previous and a look-ahead-proven next button', () => {
    const onPageChange = jest.fn()
    render(
      <Pagination
        currentPage={2}
        totalPages={null}
        totalCountIsExact={false}
        hasMore
        onPageChange={onPageChange}
      />
    )

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Go to page/ })).not.toBeInTheDocument()
    expect(screen.queryByText('...')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onPageChange).toHaveBeenCalledWith(3)
  })

  it('fails closed when unknown-total pagination has no next-page witness', () => {
    render(
      <Pagination
        currentPage={2}
        totalPages={null}
        totalCountIsExact={false}
        onPageChange={jest.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Go to page/ })).not.toBeInTheDocument()
  })

  it('keeps numbered controls for a finite exact total', () => {
    render(
      <Pagination
        currentPage={2}
        totalPages={4}
        totalCountIsExact
        hasMore={false}
        onPageChange={jest.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Go to page 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to page 4' })).toBeInTheDocument()
  })
})
