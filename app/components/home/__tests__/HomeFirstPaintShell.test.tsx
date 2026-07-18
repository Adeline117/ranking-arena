import { render, screen, within } from '@testing-library/react'
import HomeFirstPaintShell from '../HomeFirstPaintShell'
import { getCriticalCss } from '@/lib/performance/critical-css'

describe('HomeFirstPaintShell', () => {
  it('reserves the final desktop information architecture before hydration', () => {
    const { container } = render(
      <HomeFirstPaintShell>
        <div>Server rankings</div>
      </HomeFirstPaintShell>
    )

    const layout = container.querySelector('#ssr-ranking-table')
    expect(layout).not.toBeNull()
    expect(layout).toHaveClass('three-col-layout')
    expect(layout).not.toHaveClass('three-col-no-left')
    expect(layout).not.toHaveClass('three-col-no-right')

    const directRegions = Array.from(layout?.children ?? [])
    expect(directRegions.map((region) => region.className)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('three-col-left'),
        expect.stringContaining('three-col-center'),
        expect.stringContaining('three-col-right'),
      ])
    )
    expect(screen.getByTestId('first-paint-source-strip')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('first-paint-center')).getByText('Server rankings')
    ).toBeVisible()
  })

  it('keeps first-paint grid geometry aligned with the loaded stylesheet', () => {
    const criticalCss = getCriticalCss()

    expect(criticalCss).toContain(
      '.three-col-layout{display:grid;grid-template-columns:240px 1fr 260px;gap:20px'
    )
    expect(criticalCss).toContain(
      '@media(min-width:1280px) and (max-width:1439px){.three-col-layout{grid-template-columns:220px 1fr 240px}}'
    )
    expect(criticalCss).toContain(
      '@media(min-width:1441px){.three-col-layout{max-width:1600px;grid-template-columns:260px 1fr 280px}}'
    )
  })
})
