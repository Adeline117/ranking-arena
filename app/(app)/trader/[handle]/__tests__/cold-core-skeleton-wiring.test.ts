import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('default trader cold-core skeleton wiring', () => {
  it('renders a truthful first-screen snapshot before falling back to the cold-core skeleton', () => {
    const client = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )

    expect(client).toContain(
      "import ServingFirstScreenPerformance from '@/app/components/trader/serving/ServingFirstScreenPerformance'"
    )
    expect(client).toContain(
      "import ServingOverviewCoreSkeleton from '@/app/components/trader/serving/ServingOverviewCoreSkeleton'"
    )
    expect(client).toContain(
      'const selectedServingPeriod = resolveAvailablePeriod(selectedPeriod, servingPeriodAvailability)'
    )
    expect(client).toContain(
      'const selectedServingCore = servingTab.coreByPeriod[selectedServingPeriod]'
    )
    expect(client).toContain('const isSelectedCoreUnavailable =')
    expect(client).toContain('const isSelectedCoreColdLoading =')
    expect(client).toContain("typeof window === 'undefined' && servingTab.isColdCoreLoading")
    expect(client).toContain('const shouldRenderFirstScreenSnapshot =')
    expect(client).toContain('!hasSelectedServingCore')
    expect(client).toContain('!suppressAccountContent')
    expect(client).toContain('Boolean(servingViewCapability)')
    expect(client).toContain('hasAuthorityEligibleFirstScreenSnapshot')
    expect(client).toContain('isPeriodAvailable(`${entry.timeframe}D` as Period')
    expect(client).toContain('<ServingFirstScreenPerformance')
    expect(client).toContain('preferredTimeframe={selectedServingTimeframe}')
    expect(client).toContain('periodAvailability={servingPeriodAvailability}')
    expect(client).toContain('const shouldRenderColdCoreSkeleton =')
    expect(client).toContain('<ServingOverviewCoreSkeleton />')
    expect(client).toContain('isPendingUpstream={selectedServingCore.isPendingUpstream}')
    expect(client).toContain('isUnavailable={isSelectedCoreUnavailable}')
    expect(client).toContain('onRetry={selectedServingCore.refetch}')
  })

  it('keeps the swipe shell and default overview server-renderable', () => {
    const client = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )
    const overviewDeclaration = client.slice(
      client.indexOf('const OverviewTab = dynamic'),
      client.indexOf('const StatsTab = dynamic')
    )

    expect(client).toContain("import SwipeableView from '@/app/components/ui/SwipeableView'")
    expect(client).not.toContain('const SwipeableView = dynamic')
    expect(overviewDeclaration).not.toContain('ssr: false')
  })
})
