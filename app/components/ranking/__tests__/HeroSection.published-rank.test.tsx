import { render, screen } from '@testing-library/react'
import HeroSection from '../HeroSection'
import type { Trader } from '../RankingTableTypes'

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock('../shared/TraderDisplay', () => ({
  TraderAvatar: ({ traderId, rank }: { traderId: string; rank: number }) => (
    <span data-testid="hero-published-rank" data-trader-id={traderId} data-rank={rank} />
  ),
}))

function trader(id: string, rank: number | null): Trader {
  return {
    id,
    handle: id,
    roi: 1,
    followers: 0,
    rank,
  }
}

describe('HeroSection persisted rank authority', () => {
  it('renders authoritative top three ranks from unordered input without index fallback', () => {
    render(
      <HeroSection
        traders={[
          trader('rank-three', 3),
          trader('unpublished', null),
          trader('rank-one', 1),
          trader('rank-four', 4),
          trader('rank-two', 2),
        ]}
      />
    )

    expect(
      screen
        .getAllByTestId('hero-published-rank')
        .map((node) => [node.getAttribute('data-trader-id'), node.getAttribute('data-rank')])
    ).toEqual([
      ['rank-one', '1'],
      ['rank-two', '2'],
      ['rank-three', '3'],
    ])
    expect(screen.queryByText('unpublished')).not.toBeInTheDocument()
    expect(screen.queryByText('rank-four')).not.toBeInTheDocument()
  })
})
