import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('default trader history completeness wiring', () => {
  it('quarantines legacy history and supplies explicit evidence to both history views', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )

    expect(source).not.toContain('scopedTraderData?.positionHistory')
    expect(source).toContain(': EMPTY_LEGACY_POSITION_HISTORY')
    expect(source).toContain(': LEGACY_HISTORY_COMPLETENESS_UNKNOWN')
    expect(source).toContain('const legacyHistoryComplete =')
    expect(source).toContain('PUBLIC_PROFILE_HISTORY_QUERY_EPOCH')
    expect(source.match(/historyCompleteness=\{effHistoryCompleteness\}/g)).toHaveLength(2)
  })

  it('quarantines server hydration before it becomes React Query initialData', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )

    expect(source).toContain('const quarantinedServerTraderData = useMemo(')
    expect(source).toContain('quarantineLegacyPositionHistory(serverTraderData)')
    expect(source).toContain(
      'initialData: primaryUsesServerDetail ? quarantinedServerTraderData : undefined'
    )
    expect(source).not.toContain('((serverTraderData as TraderDataWithExtras) ?? undefined)')
  })
})
