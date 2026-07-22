import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { computeArenaScoresV4, type Period } from '@/lib/utils/arena-score'
import { round2 } from '@/lib/utils/currency'

interface GoldenInput {
  source: string
  source_trader_id: string
  roi: number
  pnl: number | null
  max_drawdown: number | null
  win_rate: number | null
  sharpe_ratio: number | null
  profit_factor: number | null
  trades_count: number | null
}

interface GoldenOutput {
  source: string
  sourceTraderId: string
  totalScore: number
  quality: number
  confidence: number
  factors: {
    roi: number
    pnl: number
    drawdown: number | null
    sharpe: number | null
    consistency: number | null
  }
}

interface GoldenCase {
  name: string
  period: Period
  inputs: GoldenInput[]
  expected: GoldenOutput[]
}

interface DenseCase {
  contract: string
  period: Period
  count: number
  expectedCentDigest: string
}

interface RoundingBoundary {
  input: number
  expected: number
}

interface Pg17MathBoundary {
  contract: string
  period: Period
  input: GoldenInput
  expectedPg17FactorPnl: number
  expectedLegacyV8FactorPnl: number
}

const fixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      'supabase/migrations/__tests__/fixtures/arena-score-v4-golden-vectors.json'
    ),
    'utf8'
  )
) as {
  contract: string
  cases: GoldenCase[]
  pg17MathBoundary: Pg17MathBoundary
  denseCase: DenseCase
  roundingBoundary: RoundingBoundary[]
}

const cOrder = (left: GoldenOutput, right: GoldenOutput): number => {
  const sourceOrder = Buffer.compare(Buffer.from(left.source), Buffer.from(right.source))
  if (sourceOrder !== 0) return sourceOrder
  return Buffer.compare(Buffer.from(left.sourceTraderId), Buffer.from(right.sourceTraderId))
}

const score = (inputs: GoldenInput[], period: Period): GoldenOutput[] =>
  computeArenaScoresV4(
    inputs.map((input) => ({
      roi: input.roi,
      pnl: input.pnl,
      maxDrawdown: input.max_drawdown,
      winRate: input.win_rate,
      sharpeRatio: input.sharpe_ratio,
      profitFactor: input.profit_factor,
      tradesCount: input.trades_count,
    })),
    period
  )
    .map((result, index) => ({
      source: inputs[index].source,
      sourceTraderId: inputs[index].source_trader_id,
      ...result,
    }))
    .sort(cOrder)

const denseInputs = (count: number): GoldenInput[] =>
  Array.from({ length: count }, (_, offset) => {
    const i = offset + 1
    return {
      source: `dense-${i % 11}`,
      source_trader_id: `row-${String(i).padStart(4, '0')}`,
      roi: ((i * 7919) % 20001) - 10000 + (i % 7) / 10,
      pnl:
        i % 13 === 0
          ? null
          : i % 17 === 0
            ? -((i * 104729) % 100000000)
            : ((i * 104729) % 100000000) + 1,
      max_drawdown: i % 11 === 0 ? null : i % 19 === 0 ? 0 : ((i * 37) % 10001) / 100,
      win_rate: i % 7 === 0 ? null : i % 23 === 0 ? 0 : ((i * 53) % 10001) / 100,
      sharpe_ratio: i % 5 === 0 ? null : (((i * 97) % 4001) - 2000) / 100,
      profit_factor: i % 3 === 0 ? null : (((i * 61) % 5001) - 1000) / 100,
      trades_count: i % 29 === 0 ? null : i % 31 === 0 ? 0 : (i * 43) % 5000,
    }
  })

const centDigest = (outputs: GoldenOutput[]): string => {
  const cents = (value: number | null): string =>
    value == null ? 'null' : String(Math.round(value * 100))
  const canonical = outputs
    .map((output) =>
      [
        output.source,
        output.sourceTraderId,
        cents(output.totalScore),
        cents(output.quality),
        cents(output.confidence),
        cents(output.factors.roi),
        cents(output.factors.pnl),
        cents(output.factors.drawdown),
        cents(output.factors.sharpe),
        cents(output.factors.consistency),
      ].join('\x1f')
    )
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

describe('Arena Score v4 PostgreSQL golden vectors', () => {
  it('pins the checked-in fixture contract', () => {
    expect(fixture.contract).toBe('arena-score-v4-golden-vectors@1')
    expect(fixture.cases.map(({ name }) => name)).toEqual([
      'empty_cohort',
      'ties_nulls_and_unknown_trade_count',
      'utf8_c_order',
      'single_row_7d',
      'single_row_30d',
      'single_row_90d',
      'extreme_positive_and_negative_pnl',
    ])
  })

  it.each(fixture.cases)('$name matches the TypeScript v4 implementation', (testCase) => {
    expect(score(testCase.inputs, testCase.period)).toEqual(testCase.expected)
  })

  it.each(fixture.cases)(
    '$name is invariant to input order after canonical key sorting',
    (testCase) => {
      expect(score([...testCase.inputs].reverse(), testCase.period)).toEqual(testCase.expected)
    }
  )

  it('keeps the current v4 math period-independent while period remains a contract label', () => {
    const singleCases = fixture.cases.filter(({ name }) => name.startsWith('single_row_'))
    expect(singleCases).toHaveLength(3)
    expect(new Set(singleCases.map(({ period }) => period))).toEqual(new Set(['7D', '30D', '90D']))
    expect(singleCases.map(({ expected }) => expected)).toEqual([
      singleCases[0].expected,
      singleCases[0].expected,
      singleCases[0].expected,
    ])
  })

  it('pins currency.js round2 behavior at half-cent and pre-half-cent boundaries', () => {
    for (const boundary of fixture.roundingBoundary) {
      expect(round2(boundary.input)).toBe(boundary.expected)
    }
  })

  it('pins the documented legacy V8 Math.log side of the PG17 authority boundary', () => {
    const boundary = fixture.pg17MathBoundary
    expect(boundary.contract).toBe('arena-score-v4-pg17-math-boundary@1')
    expect(score([boundary.input], boundary.period)[0].factors.pnl).toBe(
      boundary.expectedLegacyV8FactorPnl
    )
    expect(boundary.expectedLegacyV8FactorPnl).toBe(0.11)
    expect(boundary.expectedPg17FactorPnl).toBe(0.1)
    expect(boundary.expectedLegacyV8FactorPnl).not.toBe(boundary.expectedPg17FactorPnl)
  })

  it('pins a 257-row deterministic cohort to the shared PostgreSQL cent digest', () => {
    expect(fixture.denseCase.contract).toBe('arena-score-v4-dense-seed@1')
    const inputs = denseInputs(fixture.denseCase.count)
    const outputs = score(inputs, fixture.denseCase.period)
    expect(outputs).toHaveLength(257)
    expect(centDigest(outputs)).toBe(fixture.denseCase.expectedCentDigest)
    expect(centDigest(score([...inputs].reverse(), fixture.denseCase.period))).toBe(
      fixture.denseCase.expectedCentDigest
    )
  })
})
