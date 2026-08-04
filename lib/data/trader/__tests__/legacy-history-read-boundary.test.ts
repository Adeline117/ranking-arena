import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('legacy position-history read boundary', () => {
  it('keeps the unified detail query off the legacy relation', () => {
    const source = read('lib/data/trader/queries.ts')

    expect(source).not.toContain(".from('trader_position_history')")
    expect(source).toContain('const positionHistory: TraderPosition[] = []')
  })

  it('keeps the compatibility query export fail-closed without a database lookup', () => {
    const source = read('lib/data/trader-queries.ts')
    const functionBody = source.slice(
      source.indexOf('export async function getTraderPositionHistory'),
      source.indexOf('/**\n * 获取交易员动态 feed')
    )

    expect(functionBody).toContain('return success([])')
    expect(functionBody).not.toContain('.from(')
    expect(functionBody).not.toContain('findTraderAcrossSources(')
  })

  it('does not bridge unproven history or coerce unknown values to zero', () => {
    const source = read('lib/data/trader/bridge.ts')

    expect(source).not.toContain('detail.positionHistory')
    expect(source).toContain('const positionHistory: never[] = []')
  })
})
