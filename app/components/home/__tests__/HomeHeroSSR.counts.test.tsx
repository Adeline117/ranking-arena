import { render, screen } from '@testing-library/react'
import HomeHeroSSR from '../HomeHeroSSR'

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
// Render the i18n key (plus any variables) so the test sees which copy was chosen.
jest.mock('../HomeHeroText', () => ({
  __esModule: true,
  default: ({ k, vars }: { k: string; vars?: Record<string, unknown> }) => (
    <span data-hero-key={k}>{vars ? `${k}:${JSON.stringify(vars)}` : k}</span>
  ),
}))

async function renderHero(sourceBoardCount?: number | null) {
  render(await HomeHeroSSR({ sourceBoardCount }))
}

describe('HomeHeroSSR board count', () => {
  it('states the live board count when there is one', async () => {
    await renderHero(21)

    expect(screen.getByText('heroSubtitle:{"boards":21}')).toBeInTheDocument()
    expect(screen.getByText('21+')).toBeInTheDocument()
    expect(screen.queryByText('heroSubtitleNoCount')).not.toBeInTheDocument()
  })

  it.each([
    ['the lookup failed', null],
    ['no count was provided', undefined],
    ['the public boards are genuinely empty', 0],
  ])('shows no number at all when %s', async (_name, count) => {
    await renderHero(count)

    expect(screen.getByText('heroSubtitleNoCount')).toBeInTheDocument()
    expect(screen.queryByText('heroStatSourceBoards')).not.toBeInTheDocument()
    // The old hard-coded fallback must never come back.
    expect(document.body.textContent).not.toMatch(/28|9,?600/)
    // The cadence stat is an operational fact and stays.
    expect(screen.getByText('2h')).toBeInTheDocument()
  })
})
