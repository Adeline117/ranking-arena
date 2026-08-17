import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('default trader core refresh disclosure', () => {
  it('renders the propagated serving-core state before the shared tab content', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )

    expect(source).toContain('servingTab.isCorePendingUpstream')
    expect(source).toContain('servingTab.isCoreStale')
    expect(source).toContain('servingTab.isCoreUnavailable')
    expect(source).toContain('<ModuleRefreshFailureNotice')
    expect(source).toContain('<ModuleDegraded')
    expect(source).toContain('onRetry={() => void servingTab.refetchDegradedCore()}')
  })
})
