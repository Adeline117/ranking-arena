import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { computeArenaScoresV4, computeArenaScoresV5, type TraderScoreInputV4 } from '../arena-score'

const ZERO_METRICS = 0
const POSITIVE_METRICS = 1
const UNKNOWN_METRICS = 2

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

const fixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      'supabase/migrations/__tests__/fixtures/arena-score-v5-zero-metrics-golden.json'
    ),
    'utf8'
  )
) as {
  contract: string
  period: '30D'
  inputs: GoldenInput[]
  expectedEnvelope: {
    contract: string
    inputDigest: string
    outputDigest: string
    outputs: GoldenOutput[]
  }
}

const cohort = (): TraderScoreInputV4[] =>
  fixture.inputs.map((input) => ({
    roi: input.roi,
    pnl: input.pnl,
    maxDrawdown: input.max_drawdown,
    winRate: input.win_rate,
    sharpeRatio: input.sharpe_ratio,
    profitFactor: input.profit_factor,
    tradesCount: input.trades_count,
  }))

describe('computeArenaScoresV5 zero-metric semantics', () => {
  it('matches every checked-in PostgreSQL 17 golden output field', () => {
    expect(fixture.contract).toBe('arena-score-v5-zero-metrics-golden@1')
    expect(fixture.expectedEnvelope.contract).toBe('arena-score-v5-pg17@1')
    expect(fixture.expectedEnvelope.inputDigest).toHaveLength(64)
    expect(fixture.expectedEnvelope.outputDigest).toHaveLength(64)

    const outputs = computeArenaScoresV5(cohort(), fixture.period)
      .map((output, index) => ({
        source: fixture.inputs[index].source,
        sourceTraderId: fixture.inputs[index].source_trader_id,
        ...output,
      }))
      .sort((left, right) => {
        const sourceOrder = Buffer.compare(Buffer.from(left.source), Buffer.from(right.source))
        if (sourceOrder !== 0) return sourceOrder
        return Buffer.compare(Buffer.from(left.sourceTraderId), Buffer.from(right.sourceTraderId))
      })

    expect(outputs).toEqual(fixture.expectedEnvelope.outputs)
  })

  it('keeps trusted zero drawdown and win rate distinct from unknown', () => {
    const result = computeArenaScoresV5(cohort(), '30D')

    expect(result[ZERO_METRICS].factors.drawdown).toBe(1)
    expect(result[POSITIVE_METRICS].factors.drawdown).toBe(0)
    expect(result[UNKNOWN_METRICS].factors.drawdown).toBeNull()

    expect(result[ZERO_METRICS].factors.consistency).toBe(0)
    expect(result[POSITIVE_METRICS].factors.consistency).toBe(1)
    expect(result[UNKNOWN_METRICS].factors.consistency).toBeNull()

    expect(result[ZERO_METRICS].confidence).toBe(result[POSITIVE_METRICS].confidence)
    expect(result[ZERO_METRICS].confidence).toBeGreaterThan(result[UNKNOWN_METRICS].confidence)
  })

  it('does not alter the historical v4 zero-as-missing contract', () => {
    const result = computeArenaScoresV4(cohort(), '30D')

    expect(result[ZERO_METRICS].factors.drawdown).toBeNull()
    expect(result[ZERO_METRICS].factors.consistency).toBeNull()
    expect(result[ZERO_METRICS].confidence).toBe(result[UNKNOWN_METRICS].confidence)
  })

  it('normalizes positive and negative zero but not null', () => {
    const positiveZero = cohort()
    const negativeZero = cohort()
    negativeZero[ZERO_METRICS] = {
      ...negativeZero[ZERO_METRICS],
      maxDrawdown: -0,
      winRate: -0,
    }

    expect(computeArenaScoresV5(positiveZero, '30D')).toEqual(
      computeArenaScoresV5(negativeZero, '30D')
    )
    expect(computeArenaScoresV5(positiveZero, '30D')).not.toEqual(
      computeArenaScoresV5(
        positiveZero.map((input, index) =>
          index === ZERO_METRICS ? { ...input, maxDrawdown: null, winRate: null } : input
        ),
        '30D'
      )
    )
  })
})
