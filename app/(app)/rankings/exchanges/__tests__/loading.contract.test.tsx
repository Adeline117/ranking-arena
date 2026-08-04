import { render, screen } from '@testing-library/react'
import ExchangeRankingsLoading from '../loading'

describe('exchange rankings loading shell', () => {
  it('reserves the final three-control header and table geometry', () => {
    const view = render(<ExchangeRankingsLoading />)

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    const timeframes = view.container.querySelectorAll('.exr-loading-timeframe')
    expect(timeframes).toHaveLength(3)
    timeframes.forEach((timeframe) => {
      expect(timeframe).toHaveStyle({ width: '52px', height: '44px' })
    })
    expect(view.container.querySelector('.exr-loading-table')).toHaveStyle({
      overflow: 'hidden',
    })
  })
})
