/**
 * @jest-environment node
 */

import { decodeColumnarScoreBundle, encodeColumnarScoreBundle } from '../columnar-score-bundle'

const boards = [{ registry_slug: 'alpha' }]
const rows = [
  {
    platform: 'alpha',
    trader_key: 't-1',
    roi_pct: 12.5,
    handle: '交易员 ✓',
    avatar_url: null,
    unevidenced_metrics: ['mdd'],
  },
  {
    platform: 'alpha',
    trader_key: 't-2',
    roi_pct: -0.001,
    handle: null,
    avatar_url: 'https://example.invalid/a.png',
    unevidenced_metrics: [],
  },
]

describe('decodeColumnarScoreBundle', () => {
  it('rebuilds exactly the object-form bundle, rows in order', () => {
    const encoded = encodeColumnarScoreBundle({ scoreRows: rows, physicalBoards: boards })
    // Through JSON, as the database sends it.
    const decoded = decodeColumnarScoreBundle(JSON.parse(JSON.stringify(encoded)))
    expect(decoded).toEqual({ scoreRows: rows, physicalBoards: boards })
    expect(JSON.stringify(decoded)).toBe(
      JSON.stringify({ scoreRows: rows, physicalBoards: boards })
    )
  })

  it('sends each key name once', () => {
    const objectForm = JSON.stringify({ scoreRows: rows, physicalBoards: boards })
    const columnar = JSON.stringify(
      encodeColumnarScoreBundle({ scoreRows: rows, physicalBoards: boards })
    )
    expect(columnar.split('"trader_key"')).toHaveLength(2)
    expect(objectForm.split('"trader_key"')).toHaveLength(rows.length + 1)
  })

  it('decodes an empty board set', () => {
    expect(
      decodeColumnarScoreBundle({ scoreRowColumns: [], scoreRowValues: [], physicalBoards: boards })
    ).toEqual({ scoreRows: [], physicalBoards: boards })
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['the object form', { scoreRows: rows, physicalBoards: boards }],
    [
      'an extra top-level key',
      { scoreRowColumns: [], scoreRowValues: [], physicalBoards: [], x: 1 },
    ],
    ['non-string columns', { scoreRowColumns: [1], scoreRowValues: [[1]], physicalBoards: [] }],
    ['duplicate columns', { scoreRowColumns: ['a', 'a'], scoreRowValues: [], physicalBoards: [] }],
    ['a short row', { scoreRowColumns: ['a', 'b'], scoreRowValues: [['x']], physicalBoards: [] }],
    ['a non-array row', { scoreRowColumns: ['a'], scoreRowValues: [{ a: 1 }], physicalBoards: [] }],
  ])('returns %s unchanged for the strict parse to judge', (_label, data) => {
    expect(decodeColumnarScoreBundle(data)).toBe(data)
  })

  it('keeps a hostile column name an own property', () => {
    const decoded = decodeColumnarScoreBundle({
      scoreRowColumns: ['__proto__'],
      scoreRowValues: [[{ polluted: true }]],
      physicalBoards: [],
    }) as { scoreRows: Record<string, unknown>[] }
    const [row] = decoded.scoreRows
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    expect(Object.keys(row)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses to encode rows with different keys', () => {
    expect(() =>
      encodeColumnarScoreBundle({ scoreRows: [{ a: 1 }, { b: 1 }], physicalBoards: [] })
    ).toThrow('same keys')
  })
})
