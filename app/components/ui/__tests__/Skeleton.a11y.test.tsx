import { render } from '@testing-library/react'
import { RankingSkeleton, Skeleton } from '../Skeleton'

describe('Skeleton accessibility', () => {
  it('renders placeholder blocks as decorative, without a role-less aria-label', () => {
    const { container } = render(<Skeleton width={120} height={16} />)
    const block = container.querySelector('.skeleton') as HTMLElement
    expect(block).toHaveAttribute('aria-hidden', 'true')
    expect(block).not.toHaveAttribute('aria-label')
  })

  it('announces loading once through the ranking skeleton status container', () => {
    const { getAllByRole, container } = render(<RankingSkeleton rows={4} />)
    expect(getAllByRole('status')).toHaveLength(1)
    expect(container.querySelectorAll('.skeleton[aria-label]')).toHaveLength(0)
  })
})
