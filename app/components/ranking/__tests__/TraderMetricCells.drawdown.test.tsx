import { render } from '@testing-library/react'
import { TraderMetricCells } from '../TraderMetricCells'
import type { Trader } from '../RankingTable'

function trader(maxDrawdown: number | null, estimated = false): Trader {
  return {
    id: 'metric-trader',
    handle: 'Metric Trader',
    source: 'bybit',
    roi: 10,
    pnl: 0,
    win_rate: 0,
    max_drawdown: maxDrawdown,
    sharpe_ratio: 0,
    followers: 0,
    copiers: 0,
    trades_count: 1,
    arena_score: 50,
    metrics_estimated: estimated,
  }
}

function renderCells(maxDrawdown: number | null, estimated = false) {
  return render(
    <div>
      <TraderMetricCells
        trader={trader(maxDrawdown, estimated)}
        rank={4}
        language="en"
        getPnLTooltipFn={() => ''}
        t={(key) => key}
      />
    </div>
  )
}

describe('TraderMetricCells drawdown display', () => {
  it('renders an unknown ROI as a dash with no zero-value direction signal', () => {
    const unknown = { ...trader(10), roi: null }
    const { container } = render(
      <div>
        <TraderMetricCells
          trader={unknown}
          rank={1}
          language="en"
          getPnLTooltipFn={() => ''}
          t={(key) => key}
        />
      </div>
    )
    const cell = container.querySelector('.roi-cell')

    expect(cell).toHaveTextContent('—')
    expect(cell).not.toHaveTextContent('▲')
    expect(cell).not.toHaveTextContent('▼')
    expect(cell?.querySelector('[title="ROI unknown"]')).not.toBeNull()
  })

  it.each([
    [0, '0.0%'],
    [0.01, '< 0.1%'],
    [12.34, '-12.3%'],
    [100.01, '—'],
    [null, '—'],
  ])('renders max drawdown %p as %s', (maxDrawdown, expected) => {
    const { container } = renderCells(maxDrawdown)
    const cell = container.querySelector('.col-mdd')

    expect(cell).not.toBeNull()
    expect(cell).toHaveTextContent(expected)
    if (maxDrawdown === 0 || maxDrawdown == null || maxDrawdown > 100) {
      expect(cell).not.toHaveTextContent('▼')
    }
    if (maxDrawdown == null || maxDrawdown > 100) {
      expect(cell!.querySelector('[title]')).not.toBeNull()
    }
  })

  it('labels estimated drawdown without losing an exact zero', () => {
    const { container } = renderCells(0, true)
    const cell = container.querySelector('.col-mdd')

    expect(cell).toHaveTextContent('~0.0%')
    expect(cell!.querySelector('[title="estimatedFromRoi"]')).not.toBeNull()
    expect(cell).not.toHaveTextContent('▼')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'renders corrupt copier and trade counts as unknown for %p',
    (count) => {
      const corrupted = {
        ...trader(10),
        followers: count,
        copiers: count,
        trades_count: count,
      }
      const { container } = render(
        <div>
          <TraderMetricCells
            trader={corrupted}
            rank={4}
            language="en"
            getPnLTooltipFn={() => ''}
            t={(key) => key}
          />
        </div>
      )

      expect(container.querySelector('.col-followers')).toHaveTextContent('—')
      expect(container.querySelector('.col-trades')).toHaveTextContent('—')
      expect(container).not.toHaveTextContent('NaN')
      expect(container).not.toHaveTextContent('Infinity')
    }
  )
})
