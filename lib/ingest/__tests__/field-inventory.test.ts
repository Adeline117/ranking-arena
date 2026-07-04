import { collectFieldPaths } from '../field-inventory'

describe('collectFieldPaths (upstream field radar, P1)', () => {
  it('walks objects with [] array descent, capped at object depth 3', () => {
    const paths = collectFieldPaths({
      code: 0,
      data: { total: 3, list: [{ roi: 1, nested: { deep: { toodeep: 1 } } }] },
    })
    expect(paths.sort()).toEqual([
      'code',
      'data',
      'data.list',
      'data.list[].nested',
      'data.list[].nested.deep', // depth cap: 'toodeep' below it is NOT walked
      'data.list[].roi',
      'data.total',
    ])
  })

  it('samples only the FIRST array element (shape, not content)', () => {
    const paths = collectFieldPaths({ rows: [{ a: 1 }, { b: 2 }] })
    expect(paths).toContain('rows[].a')
    expect(paths).not.toContain('rows[].b')
  })

  it('caps total paths so a malformed payload cannot flood the table', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 1000; i++) wide[`k${i}`] = i
    expect(collectFieldPaths(wide).length).toBeLessThanOrEqual(300)
  })

  it('tolerates primitives, null and empty arrays', () => {
    expect(collectFieldPaths(null)).toEqual([])
    expect(collectFieldPaths('str')).toEqual([])
    expect(collectFieldPaths({ empty: [] }).sort()).toEqual(['empty'])
  })
})
