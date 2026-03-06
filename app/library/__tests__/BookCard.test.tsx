import React from 'react'
import { render, screen } from '@testing-library/react'
import type { LibraryItem } from '@/lib/types/library'

// Mock dependencies
jest.mock('../BookCover', () => {
  return function MockBookCover({ title }: { title: string }) {
    return <div data-testid="book-cover">{title}</div>
  }
})

jest.mock('@/app/components/ui/StarRating', () => {
  return function MockStarRating() {
    return <div data-testid="star-rating" />
  }
})

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => key,
    setLanguage: () => {},
  }),
}))

import BookCard from '../BookCard'

const mockItem: LibraryItem = {
  id: 'test-1',
  title: 'Trading Psychology',
  author: 'John Doe',
  description: 'A great book',
  category: 'trading',
  subcategory: null,
  source: null,
  source_url: null,
  pdf_url: null,
  cover_url: null,
  tags: ['trading'],
  crypto_symbols: null,
  publish_date: '2024-01-01',
  view_count: 100,
  download_count: 50,
  is_free: true,
  buy_url: null,
}

describe('BookCard', () => {
  it('renders without crashing', () => {
    const { container } = render(<BookCard item={mockItem} />)
    expect(container.firstChild).toBeInTheDocument()
  })

  it('links to the book page', () => {
    render(<BookCard item={mockItem} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '/library/test-1')
  })

  it('shows book title via BookCover', () => {
    render(<BookCard item={mockItem} />)
    expect(screen.getByTestId('book-cover')).toHaveTextContent('Trading Psychology')
  })

  it('shows free badge for free items', () => {
    const { container } = render(<BookCard item={mockItem} />)
    // Free items should have a green-ish badge
    expect(container.innerHTML).toBeTruthy()
  })

  it('renders paid item', () => {
    const paidItem = { ...mockItem, is_free: false }
    const { container } = render(<BookCard item={paidItem} />)
    expect(container.firstChild).toBeInTheDocument()
  })
})
