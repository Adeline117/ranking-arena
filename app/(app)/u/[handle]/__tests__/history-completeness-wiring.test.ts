import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('legacy claimed-profile history quarantine', () => {
  it.each(['UserProfileContent.tsx', 'TraderProfileView.tsx'])(
    'drops cached history and supplies explicit unknown evidence in %s',
    (filename) => {
      const source = readFileSync(
        join(process.cwd(), 'app/(app)/u/[handle]/components', filename),
        'utf8'
      )

      expect(source).not.toContain('traderData?.positionHistory')
      expect(source).toContain('const traderPositionHistory = EMPTY_LEGACY_POSITION_HISTORY')
      expect(source).toContain('const legacyHistoryComplete =')
      expect(source).toContain('traderEquityCurve = legacyHistoryComplete')
      expect(
        source.match(/historyCompleteness=\{LEGACY_HISTORY_COMPLETENESS_UNKNOWN\}/g)
      ).toHaveLength(2)
    }
  )
})
