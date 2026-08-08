import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { PollEditor } from './PollEditor'
import type { PollOption } from '../types'

const labels: Record<string, string> = {
  enablePoll: 'Enable poll',
  pollDescription: 'Add choices',
  pollOptionsLabel: 'Options',
  pollOptionPlaceholder: 'Option',
  close: 'Close',
  addPollOption: 'Add option',
  pollTypeLabel: 'Poll type',
  singleChoice: 'Single choice',
  multipleChoice: 'Multiple choice',
  pollDurationLabel: 'Poll duration',
  pollDuration1h: '1時間',
  pollDuration6h: '6時間',
  pollDuration12h: '12時間',
  pollDuration1d: '1日',
  pollDuration3d: '3日',
  pollDuration7d: '7日',
  pollResultsNote: 'Results note',
}

const t = (key: string) => labels[key] ?? key

function InteractivePollEditor() {
  const [enabled, setEnabled] = useState(false)
  const [options, setOptions] = useState<PollOption[]>([
    { text: 'Alpha', votes: 0 },
    { text: 'Beta', votes: 0 },
    { text: 'Gamma', votes: 0 },
  ])
  const [type, setType] = useState<'single' | 'multiple'>('single')
  const [duration, setDuration] = useState(24)

  return (
    <PollEditor
      pollEnabled={enabled}
      setPollEnabled={setEnabled}
      pollOptions={options}
      setPollOptions={setOptions}
      pollType={type}
      setPollType={setType}
      pollDuration={duration}
      setPollDuration={setDuration}
      t={t}
    />
  )
}

describe('profile post PollEditor', () => {
  it('uses native accessible controls with valid selected-state borders and touch targets', () => {
    render(<InteractivePollEditor />)

    const toggle = screen.getByRole('switch', { name: /Enable poll/ })
    expect(toggle).toHaveAttribute('type', 'button')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toHaveStyle({ minHeight: '44px' })
    expect(toggle.parentElement).toHaveStyle({
      border: `1px solid ${tokens.colors.border.primary}`,
    })

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle.parentElement).toHaveStyle({
      border: `1px solid ${tokens.colors.accent.brand}`,
    })

    const single = screen.getByRole('button', { name: 'Single choice' })
    const multiple = screen.getByRole('button', { name: 'Multiple choice' })
    expect(single).toHaveAttribute('aria-pressed', 'true')
    expect(multiple).toHaveAttribute('aria-pressed', 'false')
    expect(single).toHaveStyle({
      minHeight: '44px',
      border: `1px solid ${tokens.colors.accent.brand}`,
    })

    fireEvent.click(multiple)

    expect(single).toHaveAttribute('aria-pressed', 'false')
    expect(multiple).toHaveAttribute('aria-pressed', 'true')
    expect(multiple).toHaveStyle({
      minHeight: '44px',
      border: `1px solid ${tokens.colors.accent.brand}`,
    })
    expect(screen.getByRole('button', { name: 'Close 3' })).toHaveStyle({
      width: '44px',
      height: '44px',
    })
    expect(screen.getByRole('button', { name: /Add option/ })).toHaveStyle({
      minHeight: '44px',
    })
  })

  it('renders all duration labels through i18n and updates options without mutating props', () => {
    const options: PollOption[] = [
      { text: 'Alpha', votes: 1 },
      { text: 'Beta', votes: 2 },
    ]
    const setOptions = jest.fn()

    render(
      <PollEditor
        pollEnabled
        setPollEnabled={jest.fn()}
        pollOptions={options}
        setPollOptions={setOptions}
        pollType="single"
        setPollType={jest.fn()}
        pollDuration={24}
        setPollDuration={jest.fn()}
        t={t}
      />
    )

    expect(screen.getByRole('combobox', { name: 'Poll duration' })).toHaveDisplayValue('1日')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '1時間',
      '6時間',
      '12時間',
      '1日',
      '3日',
      '7日',
    ])

    fireEvent.change(screen.getByRole('textbox', { name: 'Option 2' }), {
      target: { value: 'Updated' },
    })

    expect(options[1]).toEqual({ text: 'Beta', votes: 2 })
    expect(setOptions).toHaveBeenCalledWith([
      { text: 'Alpha', votes: 1 },
      { text: 'Updated', votes: 2 },
    ])
  })
})
