/**
 * Validation Tests for Ingestion Layer
 *
 * Tests TraderDataSchema (shared.ts) — the Zod schema that validates
 * all connector output before DB writes in upsertTraders().
 *
 * Coverage:
 *   - Valid trader data (normal case)
 *   - Missing required fields
 *   - Invalid types (string where number expected, etc.)
 *   - NaN / Infinity rejection
 *   - Boundary values (win_rate 0-100, negative followers, etc.)
 *   - Null vs undefined for optional fields
 *   - Empty strings for required string fields
 */

import { TraderDataSchema } from '../shared'

// ============================================
// Helpers
// ============================================

function validTrader(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'ABC123',
    handle: 'TestTrader',
    season_id: '90D',
    roi: 42.5,
    pnl: 10000,
    win_rate: 65.3,
    max_drawdown: 12.5,
    arena_score: 78.2,
    captured_at: '2025-01-15T00:00:00Z',
    ...overrides,
  }
}

// ============================================
// Valid Data
// ============================================

describe('TraderDataSchema — valid data', () => {
  test('accepts a complete valid trader', () => {
    const result = TraderDataSchema.safeParse(validTrader())
    expect(result.success).toBe(true)
  })

  test('accepts all-null numeric fields', () => {
    const result = TraderDataSchema.safeParse(validTrader({
      roi: null,
      pnl: null,
      win_rate: null,
      max_drawdown: null,
      arena_score: null,
    }))
    expect(result.success).toBe(true)
  })

  test('accepts null handle', () => {
    const result = TraderDataSchema.safeParse(validTrader({ handle: null }))
    expect(result.success).toBe(true)
  })

  test('accepts optional fields when absent', () => {
    const { profile_url, rank, followers, trades_count, sharpe_ratio, aum, avatar_url, ...minimal } = validTrader()
    void profile_url; void rank; void followers; void trades_count; void sharpe_ratio; void aum; void avatar_url;
    const result = TraderDataSchema.safeParse(minimal)
    expect(result.success).toBe(true)
  })

  test('accepts optional fields when explicitly null', () => {
    const result = TraderDataSchema.safeParse(validTrader({
      profile_url: null,
      rank: null,
      followers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
      avatar_url: null,
    }))
    expect(result.success).toBe(true)
  })

  test('accepts zero ROI and PnL', () => {
    const result = TraderDataSchema.safeParse(validTrader({ roi: 0, pnl: 0 }))
    expect(result.success).toBe(true)
  })

  test('accepts negative ROI and PnL', () => {
    const result = TraderDataSchema.safeParse(validTrader({ roi: -99.5, pnl: -50000 }))
    expect(result.success).toBe(true)
  })

  test('accepts extreme but finite ROI', () => {
    const result = TraderDataSchema.safeParse(validTrader({ roi: 99999.99 }))
    expect(result.success).toBe(true)
  })

  test('accepts win_rate at boundaries (0 and 100)', () => {
    expect(TraderDataSchema.safeParse(validTrader({ win_rate: 0 })).success).toBe(true)
    expect(TraderDataSchema.safeParse(validTrader({ win_rate: 100 })).success).toBe(true)
  })

  test('accepts rank as positive integer', () => {
    expect(TraderDataSchema.safeParse(validTrader({ rank: 1 })).success).toBe(true)
    expect(TraderDataSchema.safeParse(validTrader({ rank: 50000 })).success).toBe(true)
  })
})

// ============================================
// Missing Required Fields
// ============================================

describe('TraderDataSchema — missing required fields', () => {
  test('rejects missing source', () => {
    const { source, ...rest } = validTrader()
    void source;
    expect(TraderDataSchema.safeParse(rest).success).toBe(false)
  })

  test('rejects missing source_trader_id', () => {
    const { source_trader_id, ...rest } = validTrader()
    void source_trader_id;
    expect(TraderDataSchema.safeParse(rest).success).toBe(false)
  })

  test('rejects missing season_id', () => {
    const { season_id, ...rest } = validTrader()
    void season_id;
    expect(TraderDataSchema.safeParse(rest).success).toBe(false)
  })

  test('rejects missing captured_at', () => {
    const { captured_at, ...rest } = validTrader()
    void captured_at;
    expect(TraderDataSchema.safeParse(rest).success).toBe(false)
  })

  test('rejects missing roi (required, not optional)', () => {
    const { roi, ...rest } = validTrader()
    void roi;
    expect(TraderDataSchema.safeParse(rest).success).toBe(false)
  })

  test('rejects missing pnl (required, not optional)', () => {
    const { pnl, ...rest } = validTrader()
    void pnl;
    expect(TraderDataSchema.safeParse(rest).success).toBe(false)
  })

  test('rejects missing arena_score (required, not optional)', () => {
    const { arena_score, ...rest } = validTrader()
    void arena_score;
    expect(TraderDataSchema.safeParse(rest).success).toBe(false)
  })
})

// ============================================
// Empty String Rejection
// ============================================

describe('TraderDataSchema — empty strings', () => {
  test('rejects empty source', () => {
    expect(TraderDataSchema.safeParse(validTrader({ source: '' })).success).toBe(false)
  })

  test('rejects empty source_trader_id', () => {
    expect(TraderDataSchema.safeParse(validTrader({ source_trader_id: '' })).success).toBe(false)
  })

  test('rejects empty season_id', () => {
    expect(TraderDataSchema.safeParse(validTrader({ season_id: '' })).success).toBe(false)
  })

  test('rejects empty captured_at', () => {
    expect(TraderDataSchema.safeParse(validTrader({ captured_at: '' })).success).toBe(false)
  })
})

// ============================================
// Type Errors
// ============================================

describe('TraderDataSchema — type errors', () => {
  test('rejects string roi', () => {
    expect(TraderDataSchema.safeParse(validTrader({ roi: '42.5' })).success).toBe(false)
  })

  test('rejects string pnl', () => {
    expect(TraderDataSchema.safeParse(validTrader({ pnl: '10000' })).success).toBe(false)
  })

  test('rejects boolean win_rate', () => {
    expect(TraderDataSchema.safeParse(validTrader({ win_rate: true })).success).toBe(false)
  })

  test('rejects numeric source', () => {
    expect(TraderDataSchema.safeParse(validTrader({ source: 123 })).success).toBe(false)
  })

  test('rejects object as arena_score', () => {
    expect(TraderDataSchema.safeParse(validTrader({ arena_score: { value: 78 } })).success).toBe(false)
  })

  test('rejects array as roi', () => {
    expect(TraderDataSchema.safeParse(validTrader({ roi: [42.5] })).success).toBe(false)
  })
})

// ============================================
// NaN / Infinity Rejection
// ============================================

describe('TraderDataSchema — NaN and Infinity', () => {
  test('rejects NaN roi', () => {
    expect(TraderDataSchema.safeParse(validTrader({ roi: NaN })).success).toBe(false)
  })

  test('rejects NaN pnl', () => {
    expect(TraderDataSchema.safeParse(validTrader({ pnl: NaN })).success).toBe(false)
  })

  test('rejects NaN win_rate', () => {
    expect(TraderDataSchema.safeParse(validTrader({ win_rate: NaN })).success).toBe(false)
  })

  test('rejects NaN arena_score', () => {
    expect(TraderDataSchema.safeParse(validTrader({ arena_score: NaN })).success).toBe(false)
  })

  test('rejects Infinity roi', () => {
    expect(TraderDataSchema.safeParse(validTrader({ roi: Infinity })).success).toBe(false)
  })

  test('rejects -Infinity pnl', () => {
    expect(TraderDataSchema.safeParse(validTrader({ pnl: -Infinity })).success).toBe(false)
  })

  test('rejects NaN max_drawdown', () => {
    expect(TraderDataSchema.safeParse(validTrader({ max_drawdown: NaN })).success).toBe(false)
  })

  test('rejects Infinity sharpe_ratio', () => {
    expect(TraderDataSchema.safeParse(validTrader({ sharpe_ratio: Infinity })).success).toBe(false)
  })

  test('rejects NaN aum', () => {
    expect(TraderDataSchema.safeParse(validTrader({ aum: NaN })).success).toBe(false)
  })

  test('rejects NaN followers', () => {
    expect(TraderDataSchema.safeParse(validTrader({ followers: NaN })).success).toBe(false)
  })
})

// ============================================
// Boundary Values
// ============================================

describe('TraderDataSchema — boundary values', () => {
  test('rejects win_rate > 100', () => {
    expect(TraderDataSchema.safeParse(validTrader({ win_rate: 100.1 })).success).toBe(false)
  })

  test('rejects win_rate < 0', () => {
    expect(TraderDataSchema.safeParse(validTrader({ win_rate: -0.1 })).success).toBe(false)
  })

  test('rejects negative followers', () => {
    expect(TraderDataSchema.safeParse(validTrader({ followers: -1 })).success).toBe(false)
  })

  test('rejects negative trades_count', () => {
    expect(TraderDataSchema.safeParse(validTrader({ trades_count: -1 })).success).toBe(false)
  })

  test('rejects negative aum', () => {
    expect(TraderDataSchema.safeParse(validTrader({ aum: -100 })).success).toBe(false)
  })

  test('rejects rank = 0 (must be positive)', () => {
    expect(TraderDataSchema.safeParse(validTrader({ rank: 0 })).success).toBe(false)
  })

  test('rejects fractional rank', () => {
    expect(TraderDataSchema.safeParse(validTrader({ rank: 1.5 })).success).toBe(false)
  })

  test('rejects negative rank', () => {
    expect(TraderDataSchema.safeParse(validTrader({ rank: -1 })).success).toBe(false)
  })

  test('accepts followers = 0', () => {
    expect(TraderDataSchema.safeParse(validTrader({ followers: 0 })).success).toBe(true)
  })

  test('accepts trades_count = 0', () => {
    expect(TraderDataSchema.safeParse(validTrader({ trades_count: 0 })).success).toBe(true)
  })

  test('accepts aum = 0', () => {
    expect(TraderDataSchema.safeParse(validTrader({ aum: 0 })).success).toBe(true)
  })
})

// ============================================
// Error Detail Quality
// ============================================

describe('TraderDataSchema — error details', () => {
  test('reports correct path for invalid field', () => {
    const result = TraderDataSchema.safeParse(validTrader({ roi: NaN }))
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path.join('.'))
      expect(paths).toContain('roi')
    }
  })

  test('reports multiple errors for multiple invalid fields', () => {
    const result = TraderDataSchema.safeParse(validTrader({
      roi: NaN,
      pnl: 'bad',
      win_rate: 200,
    }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(3)
    }
  })
})
