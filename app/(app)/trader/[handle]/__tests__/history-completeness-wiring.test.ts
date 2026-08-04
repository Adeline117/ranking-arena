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
    expect(source.match(/historyCompleteness=\{effHistoryCompleteness\}/g)).toHaveLength(2)
  })
})
