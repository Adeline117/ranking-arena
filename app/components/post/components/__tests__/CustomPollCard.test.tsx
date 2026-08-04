import { fireEvent, render, screen } from '@testing-library/react'
import { CustomPollCard } from '../CustomPollCard'

const poll = {
  id: '11111111-1111-4111-8111-111111111111',
  question: 'Direction?',
  options: [
    { text: 'Up', votes: null },
    { text: 'Down', votes: null },
  ],
  type: 'single' as const,
  endAt: null,
  isExpired: false,
  showResults: false,
  totalVotes: null,
}

const baseProps = {
  poll,
  loadState: 'ready' as const,
  userVotes: [] as number[],
  selectedOptions: [] as number[],
  onSelectOption: jest.fn(),
  onSubmitVote: jest.fn(),
  onRetry: jest.fn(),
  votingInProgress: false,
  language: 'en',
  t: (key: string) => key,
}

describe('CustomPollCard truth states and controls', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders loading, failed and authoritative empty states distinctly', () => {
    const { rerender } = render(<CustomPollCard {...baseProps} poll={null} loadState="loading" />)
    expect(screen.getByRole('status')).toHaveTextContent('loadingPoll')
    expect(screen.queryByText('noPoll')).not.toBeInTheDocument()

    rerender(<CustomPollCard {...baseProps} poll={null} loadState="error" />)
    expect(screen.getByRole('alert')).toHaveTextContent('operationFailed')
    expect(screen.queryByText('noPoll')).not.toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'retry' })
    expect(retry).toHaveStyle({ minHeight: '44px', minWidth: '44px' })
    fireEvent.click(retry)
    expect(baseProps.onRetry).toHaveBeenCalledTimes(1)

    rerender(<CustomPollCard {...baseProps} poll={null} loadState="empty" />)
    expect(screen.getByRole('status')).toHaveTextContent('noPoll')
    expect(screen.queryByText('operationFailed')).not.toBeInTheDocument()
  })

  it('keeps a last-known snapshot visible but non-interactive after refresh failure', () => {
    render(<CustomPollCard {...baseProps} loadState="error" />)

    expect(screen.getByText('Direction?')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('operationFailed')
    expect(screen.getByRole('button', { name: /Up/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'submitVote' })).toBeDisabled()
  })

  it('gives option and submit controls a 44px target and freezes choices while submitting', () => {
    const { rerender } = render(
      <CustomPollCard {...baseProps} selectedOptions={[0]} loadState="ready" />
    )
    const option = screen.getByRole('button', { name: /Up/ })
    const submit = screen.getByRole('button', { name: 'submitVote' })

    expect(option).toHaveAttribute('type', 'button')
    expect(option).toHaveAttribute('aria-pressed', 'true')
    expect(option).toHaveStyle({ minHeight: '44px', minWidth: '44px' })
    expect(submit).toHaveAttribute('type', 'button')
    expect(submit).toHaveStyle({ minHeight: '44px', minWidth: '44px' })
    fireEvent.click(option)
    fireEvent.click(submit)
    expect(baseProps.onSelectOption).toHaveBeenCalledWith(0)
    expect(baseProps.onSubmitVote).toHaveBeenCalledTimes(1)

    rerender(
      <CustomPollCard {...baseProps} selectedOptions={[0]} loadState="ready" votingInProgress />
    )
    expect(screen.getByRole('button', { name: /Up/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'submittingVote' })).toBeDisabled()
  })
})
