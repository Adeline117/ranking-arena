import { render, screen } from '@testing-library/react'
import HomeFirstPaintShell from '../HomeFirstPaintShell'
import { FOUNDING_MEMBER_BANNER_HEIGHT } from '../founding-member-layout'

jest.mock('@/lib/types/premium', () => ({
  PRO_FREE_PROMO: false,
}))

describe('HomeFirstPaintShell post-promo footprint', () => {
  it('reserves exactly one founding-member slot before the source strip', () => {
    const { container } = render(
      <HomeFirstPaintShell>
        <div>Rankings</div>
      </HomeFirstPaintShell>
    )

    const shell = container.querySelector('#ssr-home-content-shell')
    const slot = screen.getByTestId('first-paint-founding-member-slot')

    expect(screen.getAllByTestId('first-paint-founding-member-slot')).toHaveLength(1)
    expect(slot).toHaveStyle({ height: `${FOUNDING_MEMBER_BANNER_HEIGHT}px` })
    expect(slot.parentElement).toBe(shell)
    expect(shell?.firstElementChild).toBe(slot)
  })
})
