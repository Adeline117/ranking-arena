import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('default trader cold-core skeleton wiring', () => {
  it('uses the explicit cold-core verdict before rendering the empty-capable Overview adapter', () => {
    const client = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )

    expect(client).toContain(
      "import ServingOverviewCoreSkeleton from '@/app/components/trader/serving/ServingOverviewCoreSkeleton'"
    )
    expect(client).toContain('{useThreeTab && servingTab.isColdCoreLoading ? (')
    expect(client).toContain('<ServingOverviewCoreSkeleton />')
    expect(client).toMatch(
      /\{useThreeTab && servingTab\.isColdCoreLoading \? \(\s*<ServingOverviewCoreSkeleton \/>\s*\) : \(\s*<OverviewTab/
    )
  })
})
