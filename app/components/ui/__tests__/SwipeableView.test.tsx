import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import SwipeableView from '../SwipeableView'

describe('SwipeableView accessibility', () => {
  const originalResizeObserver = global.ResizeObserver

  beforeEach(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  afterEach(() => {
    global.ResizeObserver = originalResizeObserver
  })

  it('keeps translated inactive panes out of the accessibility and focus trees', () => {
    const { rerender } = render(
      <SwipeableView activeIndex={1} onIndexChange={jest.fn()}>
        <button type="button">First panel action</button>
        <button type="button">Second panel action</button>
        <button type="button">Third panel action</button>
      </SwipeableView>
    )

    const firstPane = screen.getByRole('button', {
      name: 'First panel action',
      hidden: true,
    }).parentElement
    const secondPane = screen.getByRole('button', { name: 'Second panel action' }).parentElement
    const thirdPane = screen.getByRole('button', {
      name: 'Third panel action',
      hidden: true,
    }).parentElement

    expect(firstPane).toHaveAttribute('data-swipeable-pane', '0')
    expect(firstPane).toHaveAttribute('aria-hidden', 'true')
    expect(firstPane).toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: 'First panel action' })).not.toBeInTheDocument()
    expect(secondPane).toHaveAttribute('data-swipeable-pane', '1')
    expect(secondPane).toHaveAttribute('aria-hidden', 'false')
    expect(secondPane).not.toHaveAttribute('inert')
    expect(thirdPane).toHaveAttribute('aria-hidden', 'true')
    expect(thirdPane).toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: 'Third panel action' })).not.toBeInTheDocument()

    rerender(
      <SwipeableView activeIndex={2} onIndexChange={jest.fn()}>
        <button type="button">First panel action</button>
        <button type="button">Second panel action</button>
        <button type="button">Third panel action</button>
      </SwipeableView>
    )

    expect(firstPane).toHaveAttribute('aria-hidden', 'true')
    expect(firstPane).toHaveAttribute('inert')
    expect(secondPane).toHaveAttribute('aria-hidden', 'true')
    expect(secondPane).toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: 'Second panel action' })).not.toBeInTheDocument()
    expect(thirdPane).toHaveAttribute('aria-hidden', 'false')
    expect(thirdPane).not.toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Third panel action' })).toBeInTheDocument()
  })

  it('renders its shell during SSR before browser-only measurement starts', () => {
    const markup = renderToStaticMarkup(
      <SwipeableView activeIndex={0} onIndexChange={jest.fn()}>
        <div>Overview SSR content</div>
        <div>Stats deferred content</div>
      </SwipeableView>
    )

    expect(markup).toContain('Overview SSR content')
    expect(markup).toContain('data-swipeable-pane="0"')
  })
})
