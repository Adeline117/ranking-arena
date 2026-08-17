import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('serving period truth wiring', () => {
  const client = source('app/(app)/trader/[handle]/TraderProfileClient.tsx')
  const overview = source('app/components/trader/tabs/OverviewTab.tsx')
  const stats = source('app/components/trader/stats/StatsPage.tsx')
  const equityCurve = source('app/components/trader/stats/components/EquityCurveSection.tsx')

  it('threads the resolved serving window through both default three-tab surfaces', () => {
    expect(client).toContain(
      'selectedPeriod={useThreeTab ? selectedServingPeriod : selectedPeriod}'
    )
    expect(client).toContain('selectedPeriod={useThreeTab ? selectedServingPeriod : undefined}')
    expect(client.match(/strictPeriod=\{useThreeTab\}/g)).toHaveLength(2)
  })

  it('does not retain a broader chart as serving evidence for a missing selected window', () => {
    expect(overview).toContain('resolveAuxiliaryEquityCurve')
    expect(overview).toContain(
      'if (strictPeriod || selectedCurve !== undefined) return selectedCurve'
    )
    expect(overview).toContain(
      "equityCurve={strictPeriod ? undefined : traderEquityCurve?.['90D']}"
    )
    expect(stats).toContain(
      "strictPeriod && selectedPeriod ? equityCurve?.[selectedPeriod] : equityCurve?.['90D']"
    )
    expect(equityCurve).toContain('if (strictPeriod || didInitPeriodRef.current) return')
  })
})
