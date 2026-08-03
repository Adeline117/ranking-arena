import { parsedHistoryRowSchema, parsedPositionHistoryRowSchema } from '../schemas'

function fieldSources(): Record<string, { fieldPaths: string[] }> {
  return {
    sourceFactId: { fieldPaths: ['portfolioId', 'response.data.list[].id'] },
    sourceLifecycleMarker: { fieldPaths: ['response.data.list[].status'] },
    sourceReturn: { fieldPaths: ['response.data.list[].roi'] },
    openedAt: { fieldPaths: ['response.data.list[].opened'] },
    closedAt: { fieldPaths: ['response.data.list[].closed'] },
    symbol: { fieldPaths: ['response.data.list[].symbol'] },
    side: { fieldPaths: ['response.data.list[].side'] },
    leverage: { fieldPaths: ['response.data.list[].leverage'] },
    size: { fieldPaths: ['response.data.list[].closedVolume'] },
    entryPrice: { fieldPaths: ['response.data.list[].avgCost'] },
    exitPrice: { fieldPaths: ['response.data.list[].avgClosePrice'] },
    realizedPnl: { fieldPaths: ['response.data.list[].closingPnl'] },
  }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'position_history',
    openedAt: '2026-06-01T00:00:00.000Z',
    closedAt: '2026-06-02T00:00:00.000Z',
    symbol: 'BTCUSDT',
    side: 'long',
    leverage: 5,
    size: 1,
    entryPrice: 100,
    exitPrice: 110,
    realizedPnl: 10,
    sourceFactId: '["trader","position"]',
    sourceLifecycleMarker: 'All Closed',
    sourceReturn: 0.1,
    fieldSources: fieldSources(),
    limitations: [],
    dedupeHash: 'stable-hash',
    raw: {},
    ...overrides,
  }
}

describe('parsedPositionHistoryRowSchema parser-only claims', () => {
  it('accepts exact non-empty field-path sets and the history union', () => {
    expect(parsedPositionHistoryRowSchema.parse(row())).toMatchObject({
      sourceFactId: '["trader","position"]',
      sourceLifecycleMarker: 'All Closed',
      sourceReturn: 0.1,
    })
    expect(parsedHistoryRowSchema.parse(row())).toMatchObject({ kind: 'position_history' })
  })

  it('keeps the claim substrate optional for adapters that have not migrated', () => {
    const legacy = row({ realizedPnl: null })
    delete legacy.sourceFactId
    delete legacy.sourceLifecycleMarker
    delete legacy.sourceReturn
    delete legacy.fieldSources
    delete legacy.limitations

    expect(() => parsedPositionHistoryRowSchema.parse(legacy)).not.toThrow()
  })

  it('accepts a missing lifecycle marker for a preserved partial row', () => {
    const partial = row({
      closedAt: null,
      sourceLifecycleMarker: null,
      limitations: ['source_lifecycle_marker_missing', 'source_lifecycle_marker_partial'],
    })
    delete (partial.fieldSources as Record<string, unknown>).closedAt
    delete (partial.fieldSources as Record<string, unknown>).sourceLifecycleMarker

    expect(parsedPositionHistoryRowSchema.parse(partial)).toMatchObject({
      closedAt: null,
      sourceLifecycleMarker: null,
    })
  })

  it('rejects a blank lifecycle marker instead of treating it as evidence', () => {
    expect(() =>
      parsedPositionHistoryRowSchema.parse(row({ sourceLifecycleMarker: '   ' }))
    ).toThrow()
  })

  it.each(['sourceFactId', 'sourceLifecycleMarker'])(
    'rejects edge whitespace in canonical %s values instead of silently trimming it',
    (field) => {
      expect(() => parsedPositionHistoryRowSchema.parse(row({ [field]: ' padded ' }))).toThrow(
        /canonical without edge whitespace/
      )
    }
  )

  it.each([
    ['sourceFactId', null, 'source_fact_id_missing'],
    ['sourceLifecycleMarker', null, 'source_lifecycle_marker_missing'],
    ['sourceReturn', null, 'source_return_missing'],
    ['closedAt', null, null],
    ['realizedPnl', null, 'source_realized_pnl_missing'],
  ])('rejects a %s field source when that value is missing', (field, value, limitation) => {
    expect(() =>
      parsedPositionHistoryRowSchema.parse(
        row({
          [field]: value,
          fieldSources: { [field]: { fieldPaths: [`data[].${field}`] } },
          limitations: limitation === null ? [] : [limitation],
        })
      )
    ).toThrow(/field source must exactly match/)
  })

  it.each([
    'sourceFactId',
    'sourceLifecycleMarker',
    'sourceReturn',
    'openedAt',
    'closedAt',
    'symbol',
    'side',
    'leverage',
    'size',
    'entryPrice',
    'exitPrice',
    'realizedPnl',
  ])('rejects a present %s value without its field source', (field) => {
    const missingSource = row()
    delete (missingSource.fieldSources as Record<string, unknown>)[field]

    expect(() => parsedPositionHistoryRowSchema.parse(missingSource)).toThrow(
      /field source must exactly match/
    )
  })

  it.each([
    ['sourceFactId', 'source_fact_id_missing'],
    ['sourceLifecycleMarker', 'source_lifecycle_marker_missing'],
    ['sourceReturn', 'source_return_missing'],
    ['realizedPnl', 'source_realized_pnl_missing'],
  ])('requires %s absence and its missing limitation to agree both ways', (field, limitation) => {
    const missing = row({ [field]: null, limitations: [limitation] })
    delete (missing.fieldSources as Record<string, unknown>)[field]
    expect(() => parsedPositionHistoryRowSchema.parse(missing)).not.toThrow()

    expect(() => parsedPositionHistoryRowSchema.parse({ ...missing, limitations: [] })).toThrow(
      /must exactly match/
    )
    expect(() => parsedPositionHistoryRowSchema.parse(row({ limitations: [limitation] }))).toThrow(
      /must exactly match/
    )
  })

  it.each([
    { fieldPaths: [] },
    { fieldPaths: [''] },
    { fieldPaths: ['data[].pnl', 'data[].pnl'] },
    { fieldPaths: ['data[].pnl', ' data[].pnl '] },
  ])('rejects empty, blank, or duplicate field paths: %p', (source) => {
    expect(() =>
      parsedPositionHistoryRowSchema.parse(row({ fieldSources: { realizedPnl: source } }))
    ).toThrow()
  })

  it('rejects unknown field-source keys and framework/trust assertions', () => {
    expect(() =>
      parsedPositionHistoryRowSchema.parse(
        row({ fieldSources: { pnlTrust: { fieldPaths: ['data[].pnl'] } } })
      )
    ).toThrow()
    expect(() =>
      parsedPositionHistoryRowSchema.parse(row({ provenance: 'source_reported' }))
    ).toThrow()
    expect(() =>
      parsedPositionHistoryRowSchema.parse(
        row({ fieldSources: { realizedPnl: { fieldPaths: ['data[].pnl'], sourcePageOrdinal: 1 } } })
      )
    ).toThrow()
    expect(() => parsedPositionHistoryRowSchema.parse(row({ rankEligible: true }))).toThrow()
  })

  it('rejects duplicate limitations', () => {
    expect(() =>
      parsedPositionHistoryRowSchema.parse(
        row({ limitations: ['source_return_missing', 'source_return_missing'] })
      )
    ).toThrow(/limitations must be unique/)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite source return: %p',
    (sourceReturn) => {
      expect(() => parsedPositionHistoryRowSchema.parse(row({ sourceReturn }))).toThrow()
    }
  )

  it('preserves genuine zero return and PnL claims when both paths are present', () => {
    expect(
      parsedPositionHistoryRowSchema.parse(row({ sourceReturn: 0, realizedPnl: 0 }))
    ).toMatchObject({ sourceReturn: 0, realizedPnl: 0, limitations: [] })
  })
})
