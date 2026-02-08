/**
 * EmptyState 组件测试
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import EmptyState from '../EmptyState'

describe('EmptyState', () => {
  it('should render title', () => {
    render(<EmptyState title="No data found" />)
    expect(screen.getByText('No data found')).toBeInTheDocument()
  })

  it('should render description when provided', () => {
    render(<EmptyState title="Empty" description="Try adjusting your filters" />)
    expect(screen.getByText('Try adjusting your filters')).toBeInTheDocument()
  })

  it('should not render description when not provided', () => {
    const { container } = render(<EmptyState title="Empty" />)
    // Only title text should be present
    expect(container.textContent).toBe('Empty')
  })

  it('should render icon when provided', () => {
    render(<EmptyState title="Empty" icon={<span data-testid="icon">📭</span>} />)
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('should render action when provided', () => {
    render(
      <EmptyState
        title="Empty"
        action={<button>Retry</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('should render compact variant', () => {
    const { container } = render(<EmptyState title="Empty" variant="compact" />)
    expect(container.firstChild).toBeTruthy()
  })

  it('should render card variant with glass-card class', () => {
    const { container } = render(<EmptyState title="Empty" variant="card" />)
    expect(container.querySelector('.glass-card')).toBeInTheDocument()
  })

  it('should render all props together', () => {
    render(
      <EmptyState
        icon={<span>🔍</span>}
        title="No results"
        description="We couldn't find what you're looking for"
        action={<button>Clear filters</button>}
        variant="card"
      />
    )
    expect(screen.getByText('No results')).toBeInTheDocument()
    expect(screen.getByText("We couldn't find what you're looking for")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument()
  })
})
