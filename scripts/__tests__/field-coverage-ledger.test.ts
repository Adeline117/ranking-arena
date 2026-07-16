import {
  FIELD_COVERAGE_DATA_CONTRACT,
  FIELD_COVERAGE_DATA_CONTRACT_VERSION,
  renderFieldCoverageLedger,
  type FieldCoverageSourceRow,
} from '../lib/field-coverage-ledger'

const METADATA = {
  generatedAt: '2026-07-16T17:30:00.000Z',
  gitSha: '0123456789abcdef0123456789abcdef01234567',
}

const ROWS: FieldCoverageSourceRow[] = [
  {
    slug: 'zeta',
    timeframe: 30,
    total: 2,
    typed: { roi: 2, pnl: 0 },
    extras: { zebra: 1, alpha: 2 },
  },
  {
    slug: 'alpha',
    timeframe: 90,
    total: 4,
    typed: { roi: 1 },
    extras: {},
  },
  {
    slug: 'zeta',
    timeframe: 7,
    total: 4,
    typed: { roi: 1, pnl: 0 },
    extras: { zebra: 4 },
  },
]

describe('field coverage ledger renderer', () => {
  it('renders reproducible provenance metadata', () => {
    const output = renderFieldCoverageLedger(ROWS, METADATA)

    expect(output).toContain(`| generated_at | \`${METADATA.generatedAt}\` |`)
    expect(output).toContain(`| git_sha | \`${METADATA.gitSha}\` |`)
    expect(output).toContain(`| data_contract | \`${FIELD_COVERAGE_DATA_CONTRACT}\` |`)
    expect(output).toContain(
      `| data_contract_version | \`${FIELD_COVERAGE_DATA_CONTRACT_VERSION}\` |`
    )
  })

  it.each(['2026-07-16', '2026-07-16T17:30:00Z', 'not-a-date'])(
    'rejects a non-canonical generatedAt value: %s',
    (generatedAt) => {
      expect(() => renderFieldCoverageLedger(ROWS, { ...METADATA, generatedAt })).toThrow(
        /generatedAt/
      )
    }
  )

  it.each(['abc123', 'G123456789abcdef0123456789abcdef01234567', ''])(
    'rejects an invalid full Git SHA: %s',
    (gitSha) => {
      expect(() => renderFieldCoverageLedger(ROWS, { ...METADATA, gitSha })).toThrow(/gitSha/)
    }
  )

  it('sorts sources, timeframes, and extras without mutating caller order', () => {
    const originalOrder = ROWS.map((row) => `${row.slug}:${row.timeframe}`)
    const output = renderFieldCoverageLedger(ROWS, METADATA)

    expect(output.indexOf('## alpha')).toBeLessThan(output.indexOf('## zeta'))
    expect(output).toContain('Timeframes: 7, 30 · rows: 4 / 2')
    expect(output.indexOf('| alpha |')).toBeLessThan(output.indexOf('| zebra |'))
    expect(ROWS.map((row) => `${row.slug}:${row.timeframe}`)).toEqual(originalOrder)
  })

  it('omits all-zero typed fields and calculates fill rates deterministically', () => {
    const output = renderFieldCoverageLedger(ROWS, METADATA)

    expect(output).not.toContain('| pnl |')
    expect(output).toContain('| roi | 25% | 100% |')
    expect(output).toContain('| zebra | 100% | 50% |')
    expect(output).toMatch(/[^\n]\n$/)
    expect(output).not.toMatch(/\n\n$/)
  })

  it('pins the field coverage contract identity', () => {
    expect(`${FIELD_COVERAGE_DATA_CONTRACT}@${FIELD_COVERAGE_DATA_CONTRACT_VERSION}`).toBe(
      'arena.trader_stats.field-coverage@1'
    )
  })
})
