import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import StatsPage from '../StatsPage'

jest.mock('../../../Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))

jest.mock('../components/BreakdownSection', () => ({
  BreakdownSection: () => <div>breakdown-content</div>,
}))

jest.mock('../components/EquityCurveSection', () => ({
  EquityCurveSection: () => <div>equity-content</div>,
}))

jest.mock('../components/TradingSection', () => ({
  TradingSection: () => <div>trading-content</div>,
}))

jest.mock('../../../ui/ProGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('stats server visibility', () => {
  it('renders real stats content instead of a hydration-only skeleton', () => {
    const markup = renderToStaticMarkup(<StatsPage stats={null} traderHandle="alice" />)

    expect(markup).toContain('breakdown-content')
    expect(markup).toContain('equity-content')
    expect(markup).toContain('trading-content')
    expect(markup).not.toContain('statsSkeletonPulse')
  })

  it.each(['BreakdownSection.tsx', 'EquityCurveSection.tsx', 'TradingSection.tsx'])(
    '%s does not hide its server markup behind mounted state',
    (fileName) => {
      const source = readFileSync(resolve(__dirname, '..', 'components', fileName), 'utf8')

      expect(source).not.toMatch(/opacity:\s*mounted\s*\?\s*1\s*:\s*0/)
      expect(source).not.toMatch(/transform:\s*mounted\s*\?\s*['"]translateY\(0\)['"]/)
    }
  )
})
