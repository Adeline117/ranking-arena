import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('default trader history completeness wiring', () => {
  it('scopes serving evidence to three-tab mode and supplies both history views', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )

    expect(source).toContain(
      'const effHistoryCompleteness = useThreeTab ? servingTab.historyCompleteness : null'
    )
    expect(source.match(/historyCompleteness=\{effHistoryCompleteness\}/g)).toHaveLength(2)
  })
})
