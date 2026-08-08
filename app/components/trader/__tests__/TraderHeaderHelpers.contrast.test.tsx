import { render, screen } from '@testing-library/react'
import { tokens } from '@/lib/design-tokens'
import { StatItem } from '../TraderHeaderHelpers'

describe('TraderHeaderHelpers cover contrast', () => {
  it('uses opaque text for secondary labels over cover art', () => {
    render(<StatItem value="12.4%" label="ROI" hasCover />)

    expect(screen.getByText('ROI')).toHaveStyle({ color: tokens.colors.white })
  })

  it('keeps the ordinary secondary token without cover art', () => {
    render(<StatItem value="12.4%" label="ROI" hasCover={false} />)

    expect(screen.getByText('ROI')).toHaveStyle({ color: tokens.colors.text.tertiary })
  })
})
