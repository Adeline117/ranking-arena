import { fireEvent, render, screen } from '@testing-library/react'
import BuiltInVoteCard from '../BuiltInVoteCard'

describe('BuiltInVoteCard', () => {
  it('renders absolute percentages and exposes the selected choice', () => {
    render(
      <BuiltInVoteCard
        postId="post-1"
        counts={{ bull: 2, bear: 1, wait: 1 }}
        selectedChoice="bull"
        onVote={jest.fn().mockResolvedValue(undefined)}
        t={(key) => ({ poll: 'Poll', bullish: 'Bullish', bearish: 'Bearish', wait: 'Wait' })[key]!}
      />
    )

    expect(screen.getByRole('region', { name: 'Poll' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bullish 50%' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Bearish 25%' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('keeps every choice clickable so a pending intent can be superseded', () => {
    const onVote = jest.fn().mockResolvedValue(undefined)
    render(
      <BuiltInVoteCard
        postId="post-1"
        counts={{ bull: 0, bear: 0, wait: 0 }}
        selectedChoice={null}
        onVote={onVote}
        t={(key) => ({ poll: 'Poll', bullish: 'Bullish', bearish: 'Bearish', wait: 'Wait' })[key]!}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Bullish 0%' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bearish 0%' }))

    expect(onVote).toHaveBeenNthCalledWith(1, 'post-1', 'bull')
    expect(onVote).toHaveBeenNthCalledWith(2, 'post-1', 'bear')
  })
})
