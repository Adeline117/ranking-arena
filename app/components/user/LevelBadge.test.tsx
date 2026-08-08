import { render, screen } from '@testing-library/react'
import { tokens } from '@/lib/design-tokens'
import LevelBadge from './LevelBadge'

describe('LevelBadge contrast surface', () => {
  it('uses opaque foregrounds on a dark backing surface over arbitrary cover art', () => {
    const { container } = render(<LevelBadge exp={0} size="md" showName contrastSurface />)

    const badge = screen.getByLabelText(/Level 1/)
    expect(badge).toHaveStyle({
      color: '#FFFFFF',
      background: 'var(--color-backdrop-heavy)',
      borderRadius: '9999px',
    })
    expect(screen.getByText('Lv1')).toHaveStyle({ color: tokens.colors.white })
    expect(screen.getByText('磷虾')).toHaveStyle({ color: tokens.colors.white })
    expect(screen.getByText('磷虾')).not.toHaveClass('opacity-70')
    expect(container.querySelector('svg')).toHaveAttribute('width', '20')
  })

  it('preserves the level palette on ordinary surfaces', () => {
    render(<LevelBadge exp={0} showName />)

    expect(screen.getByText('Lv1')).toHaveStyle({ color: 'var(--color-text-tertiary)' })
    expect(screen.getByText('磷虾')).toHaveClass('opacity-70')
  })
})
