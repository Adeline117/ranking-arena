/**
 * RankingBadge 组件测试
 */

import React from 'react'
import { render } from '@testing-library/react'
import { RankingBadge } from '../IconSystem'

describe('RankingBadge', () => {
  it('should render rank 1 (gold) badge', () => {
    const { container } = render(<RankingBadge rank={1} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('width', '24')
    expect(svg).toHaveAttribute('height', '24')

    // Should display rank number
    const text = container.querySelector('text')
    expect(text?.textContent).toBe('1')
  })

  it('should render rank 2 (silver) badge', () => {
    const { container } = render(<RankingBadge rank={2} />)
    const text = container.querySelector('text')
    expect(text?.textContent).toBe('2')

    // Should have gradient specific to rank 2
    const gradient = container.querySelector('#rank-grad-2')
    expect(gradient).toBeInTheDocument()
  })

  it('should render rank 3 (bronze) badge', () => {
    const { container } = render(<RankingBadge rank={3} />)
    const text = container.querySelector('text')
    expect(text?.textContent).toBe('3')

    const gradient = container.querySelector('#rank-grad-3')
    expect(gradient).toBeInTheDocument()
  })

  it('should use unique gradient IDs per rank', () => {
    const { container: c1 } = render(<RankingBadge rank={1} />)
    const { container: c2 } = render(<RankingBadge rank={2} />)
    const { container: c3 } = render(<RankingBadge rank={3} />)

    expect(c1.querySelector('#rank-grad-1')).toBeInTheDocument()
    expect(c2.querySelector('#rank-grad-2')).toBeInTheDocument()
    expect(c3.querySelector('#rank-grad-3')).toBeInTheDocument()
  })

  it('should support custom size', () => {
    const { container } = render(<RankingBadge rank={1} size={48} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '48')
    expect(svg).toHaveAttribute('height', '48')
  })

  it('should default to size 24', () => {
    const { container } = render(<RankingBadge rank={1} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '24')
  })

  it('should have a circle element for the badge background', () => {
    const { container } = render(<RankingBadge rank={1} />)
    const circle = container.querySelector('circle')
    expect(circle).toBeInTheDocument()
    expect(circle).toHaveAttribute('r', '10')
  })

  it('should render inline with vertical-align middle', () => {
    const { container } = render(<RankingBadge rank={1} />)
    const svg = container.querySelector('svg')
    expect(svg?.style.verticalAlign).toBe('middle')
    expect(svg?.style.display).toBe('inline-block')
  })
})
