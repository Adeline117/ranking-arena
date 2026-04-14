/**
 * Data Validation Gatekeeper Tests
 *
 * Tests validateBeforeWrite() and sanitizeRow() — the guardrails that
 * prevent dirty data from entering trader_snapshots_v2 / leaderboard_ranks.
 */

import { VALIDATION_BOUNDS } from '../types'
import { validateBeforeWrite, sanitizeRow } from '../validate-before-write'

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'binance-futures',
    trader_key: 'trader-abc-123',
    roi_pct: 25.5,
    pnl_usd: 5000,
    win_rate: 60,
    max_drawdown: 15,
    sharpe_ratio: 1.2,
    arena_score: 55,
    ...overrides,
  }
}

const TABLE = 'trader_snapshots_v2'

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — valid rows pass through
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — valid rows', () => {
  test('valid row passes through', () => {
    const { valid, rejected } = validateBeforeWrite([makeRow()], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('multiple valid rows all pass', () => {
    const rows = [
      makeRow({ trader_key: 'a' }),
      makeRow({ trader_key: 'b' }),
      makeRow({ trader_key: 'c' }),
    ]
    const { valid, rejected } = validateBeforeWrite(rows, TABLE)
    expect(valid).toHaveLength(3)
    expect(rejected).toHaveLength(0)
  })

  test('row with null optional fields passes', () => {
    const row = makeRow({
      roi_pct: null,
      pnl_usd: null,
      win_rate: null,
      max_drawdown: null,
      sharpe_ratio: null,
      arena_score: null,
    })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('row at boundary values passes', () => {
    const row = makeRow({
      roi_pct: VALIDATION_BOUNDS.roi_pct.max,
      pnl_usd: VALIDATION_BOUNDS.pnl_usd.max,
      win_rate: 100,
      max_drawdown: 100,
      arena_score: 100,
    })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('row with negative ROI within bounds passes', () => {
    const row = makeRow({ roi_pct: -5000 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('accepts source as alias for platform', () => {
    const row = {
      source: 'bybit',
      source_trader_id: 'trader-xyz',
      roi_pct: 10,
    }
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — ROI bounds
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — ROI bounds', () => {
  test('ROI > 10000 is rejected', () => {
    const row = makeRow({ roi_pct: 10001 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected.some(r => r.field === 'roi')).toBe(true)
  })

  test('ROI < -10000 is rejected', () => {
    const row = makeRow({ roi_pct: -10001 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'roi')).toBe(true)
  })

  test('ROI = 100000 is rejected (extreme value)', () => {
    const row = makeRow({ roi_pct: 100000 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'roi')).toBe(true)
  })

  test('ROI at exact boundary (10000) passes', () => {
    const row = makeRow({ roi_pct: 10000 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('ROI at exact lower boundary (-10000) passes', () => {
    const row = makeRow({ roi_pct: -10000 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('roi field name alias (roi instead of roi_pct) is validated', () => {
    const row = makeRow({ roi: 50000, roi_pct: undefined })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'roi')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — PnL bounds
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — PnL bounds', () => {
  test('PnL > $100M (non-DEX) is rejected', () => {
    const row = makeRow({ pnl_usd: 100_000_001 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'pnl')).toBe(true)
  })

  test('PnL = $100M (non-DEX) passes', () => {
    const row = makeRow({ pnl_usd: 100_000_000 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('PnL > $1B (DEX whale platform hyperliquid) is rejected', () => {
    const row = makeRow({
      platform: 'hyperliquid',
      pnl_usd: 1_000_000_001,
    })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'pnl')).toBe(true)
  })

  test('PnL = $500M on hyperliquid passes (whale-exempt)', () => {
    const row = makeRow({
      platform: 'hyperliquid',
      pnl_usd: 500_000_000,
    })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('PnL = $500M on binance-futures (non-DEX) is rejected', () => {
    const row = makeRow({
      platform: 'binance-futures',
      pnl_usd: 500_000_000,
    })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'pnl')).toBe(true)
  })

  test('negative PnL below minimum is rejected', () => {
    const row = makeRow({ pnl_usd: -10_000_001 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'pnl')).toBe(true)
  })

  test('gmx is also whale-exempt', () => {
    const row = makeRow({
      platform: 'gmx',
      pnl_usd: 200_000_000,
    })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('dydx is whale-exempt', () => {
    const row = makeRow({
      platform: 'dydx',
      pnl_usd: 200_000_000,
    })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('drift is whale-exempt', () => {
    const row = makeRow({
      platform: 'drift',
      pnl_usd: 200_000_000,
    })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — Win Rate bounds
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — Win Rate bounds', () => {
  test('win rate > 100 is rejected', () => {
    const row = makeRow({ win_rate: 101 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'win_rate')).toBe(true)
  })

  test('win rate < 0 is rejected', () => {
    const row = makeRow({ win_rate: -1 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'win_rate')).toBe(true)
  })

  test('win rate = 0 passes', () => {
    const row = makeRow({ win_rate: 0 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('win rate = 100 passes', () => {
    const row = makeRow({ win_rate: 100 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — Arena Score bounds
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — Arena Score bounds', () => {
  test('arena score > 100 is rejected', () => {
    const row = makeRow({ arena_score: 101 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'arena_score')).toBe(true)
  })

  test('arena score < 0 is rejected', () => {
    const row = makeRow({ arena_score: -1 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'arena_score')).toBe(true)
  })

  test('arena score = 0 passes', () => {
    const row = makeRow({ arena_score: 0 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('arena score = 100 passes', () => {
    const row = makeRow({ arena_score: 100 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — Sharpe ratio bounds
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — Sharpe ratio bounds', () => {
  test('sharpe > 20 is rejected', () => {
    const row = makeRow({ sharpe_ratio: 21 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'sharpe_ratio')).toBe(true)
  })

  test('sharpe < -20 is rejected', () => {
    const row = makeRow({ sharpe_ratio: -21 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'sharpe_ratio')).toBe(true)
  })

  test('sharpe within range passes', () => {
    const row = makeRow({ sharpe_ratio: 3.5 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — Max Drawdown bounds
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — Max Drawdown bounds', () => {
  test('max drawdown > 100 is rejected', () => {
    const row = makeRow({ max_drawdown: 101 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'max_drawdown')).toBe(true)
  })

  test('max drawdown < 0 is rejected', () => {
    const row = makeRow({ max_drawdown: -1 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'max_drawdown')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — Required fields
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — required fields', () => {
  test('missing platform is rejected', () => {
    const row = makeRow({ platform: null })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'platform')).toBe(true)
  })

  test('empty string platform is rejected', () => {
    const row = makeRow({ platform: '' })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'platform')).toBe(true)
  })

  test('missing trader_key is rejected', () => {
    const row = makeRow({ trader_key: null })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'trader_key')).toBe(true)
  })

  test('empty string trader_key is rejected', () => {
    const row = makeRow({ trader_key: '   ' })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'trader_key')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — ROI = PnL detection
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — ROI equals PnL detection', () => {
  test('ROI and PnL with same large value is rejected (field mapping error)', () => {
    const row = makeRow({ roi_pct: 5000, pnl_usd: 5000 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected.some(r => r.field === 'roi_equals_pnl')).toBe(true)
  })

  test('ROI and PnL differ by more than 1 is not flagged', () => {
    const row = makeRow({ roi_pct: 5000, pnl_usd: 5100 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('small ROI = small PnL (common coincidence) is not flagged', () => {
    // Only checked when both > 1000
    const row = makeRow({ roi_pct: 15, pnl_usd: 15 })
    const { valid, rejected } = validateBeforeWrite([row], TABLE)
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// validateBeforeWrite — mixed valid/invalid rows
// ═══════════════════════════════════════════════════════

describe('validateBeforeWrite — mixed rows', () => {
  test('mix of valid and invalid rows separates correctly', () => {
    const rows = [
      makeRow({ trader_key: 'good-1', roi_pct: 50 }),
      makeRow({ trader_key: 'bad-1', roi_pct: 999999 }),
      makeRow({ trader_key: 'good-2', roi_pct: -100 }),
      makeRow({ trader_key: 'bad-2', win_rate: 200 }),
    ]
    const { valid, rejected } = validateBeforeWrite(rows, TABLE)
    expect(valid).toHaveLength(2)
    expect(rejected.length).toBeGreaterThanOrEqual(2)
  })

  test('empty array returns empty results', () => {
    const { valid, rejected } = validateBeforeWrite([], TABLE)
    expect(valid).toHaveLength(0)
    expect(rejected).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// sanitizeRow
// ═══════════════════════════════════════════════════════

describe('sanitizeRow', () => {
  test('valid row returns cleaned row with no nulled fields', () => {
    const row = makeRow()
    const result = sanitizeRow(row, TABLE)
    expect(result.nulledFields).toHaveLength(0)
    expect(result.rejected).toHaveLength(0)
    expect(result.row.roi_pct).toBe(25.5)
  })

  test('row with out-of-bounds ROI nulls the ROI field', () => {
    const row = makeRow({ roi_pct: 50000 })
    const result = sanitizeRow(row, TABLE)
    expect(result.nulledFields).toContain('roi_pct')
    expect(result.row.roi_pct).toBeNull()
    // Other fields should be preserved
    expect(result.row.pnl_usd).toBe(5000)
  })

  test('row with out-of-bounds win_rate nulls win_rate', () => {
    const row = makeRow({ win_rate: 150 })
    const result = sanitizeRow(row, TABLE)
    expect(result.nulledFields).toContain('win_rate')
    expect(result.row.win_rate).toBeNull()
  })

  test('missing platform returns rejected failures (required field)', () => {
    const row = makeRow({ platform: null })
    const result = sanitizeRow(row, TABLE)
    expect(result.rejected.length).toBeGreaterThan(0)
    expect(result.rejected.some(r => r.field === 'platform')).toBe(true)
  })

  test('missing trader_key returns rejected failures (required field)', () => {
    const row = makeRow({ trader_key: null })
    const result = sanitizeRow(row, TABLE)
    expect(result.rejected.length).toBeGreaterThan(0)
    expect(result.rejected.some(r => r.field === 'trader_key')).toBe(true)
  })

  test('roi=pnl field mapping error nulls ROI fields', () => {
    const row = makeRow({ roi_pct: 5000, pnl_usd: 5000 })
    const result = sanitizeRow(row, TABLE)
    expect(result.nulledFields).toContain('roi_pct')
    expect(result.row.roi_pct).toBeNull()
    // PnL should be preserved (PnL is more likely correct)
    expect(result.row.pnl_usd).toBe(5000)
  })

  test('sanitizeRow returns a new object, does not mutate input', () => {
    const original = makeRow({ roi_pct: 50000 })
    const originalRoi = original.roi_pct
    sanitizeRow(original, TABLE)
    expect(original.roi_pct).toBe(originalRoi) // original not mutated
  })
})

// ═══════════════════════════════════════════════════════
// VALIDATION_BOUNDS integrity
// ═══════════════════════════════════════════════════════

describe('VALIDATION_BOUNDS — integrity', () => {
  test('ROI bounds are symmetric around zero', () => {
    expect(VALIDATION_BOUNDS.roi_pct.min).toBe(-10000)
    expect(VALIDATION_BOUNDS.roi_pct.max).toBe(10000)
  })

  test('PnL DEX whale max > PnL standard max', () => {
    expect(VALIDATION_BOUNDS.pnl_usd_dex_whale.max).toBeGreaterThan(
      VALIDATION_BOUNDS.pnl_usd.max
    )
  })

  test('arena score bounds are [0, 100]', () => {
    expect(VALIDATION_BOUNDS.arena_score.min).toBe(0)
    expect(VALIDATION_BOUNDS.arena_score.max).toBe(100)
  })

  test('win rate bounds are [0, 100]', () => {
    expect(VALIDATION_BOUNDS.win_rate_pct.min).toBe(0)
    expect(VALIDATION_BOUNDS.win_rate_pct.max).toBe(100)
  })
})
