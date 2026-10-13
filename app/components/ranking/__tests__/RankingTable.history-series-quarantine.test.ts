import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8')

describe('ranking historical ROI series quarantine', () => {
  it('does not reconnect the retired sparkline endpoint or carry raw ROI points through row props', () => {
    const rankingTable = read('app/components/ranking/RankingTable.tsx')
    const traderRow = read('app/components/ranking/TraderRow.tsx')
    const metricCells = read('app/components/ranking/TraderMetricCells.tsx')

    expect(rankingTable).not.toContain('/api/traders/sparklines')
    expect(rankingTable).not.toContain('equitySeries')
    expect(rankingTable).not.toContain('roiSpark')
    expect(traderRow).not.toContain('roiSpark')
    expect(metricCells).not.toContain('roiSpark')
    expect(metricCells).not.toContain('<Sparkline')

    // Current scalar ROI remains a separately published ranking field.
    expect(metricCells).toContain('<AnimatedROI')
  })
})
