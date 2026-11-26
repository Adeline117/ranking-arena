import { scoreDisplayState, withoutScores } from '../idle-window'

describe('scoreDisplayState', () => {
  it('is idle only for a period the account is idle in', () => {
    expect(scoreDisplayState(['30D'], '30D')).toBe('idle')
    expect(scoreDisplayState(['30D'], '30d')).toBe('idle')
    expect(scoreDisplayState(['30D'], '90D')).toBe('scored')
    expect(scoreDisplayState([], '90D')).toBe('scored')
  })

  it('is unknown — not scored — when the ranking read failed', () => {
    expect(scoreDisplayState(null, '90D')).toBe('unknown')
  })

  it('treats an absent list as scored (callers that never supplied it)', () => {
    expect(scoreDisplayState(undefined, '90D')).toBe('scored')
  })
})

describe('withoutScores', () => {
  it('empties every score field and nothing else', () => {
    const performance = {
      arena_score: 0.01,
      arena_score_7d: 0.01,
      arena_score_30d: 0.01,
      arena_score_90d: 0.01,
      profitability_score: 1,
      risk_control_score: 2,
      execution_score: 3,
      roi_90d: 0,
      win_rate: 61,
      score_confidence: 'minimal',
      trading_style: 'swing',
    }
    expect(withoutScores(performance)).toEqual({
      arena_score: null,
      arena_score_7d: null,
      arena_score_30d: null,
      arena_score_90d: null,
      profitability_score: null,
      risk_control_score: null,
      execution_score: null,
      roi_90d: 0,
      win_rate: 61,
      score_confidence: 'minimal',
      trading_style: 'swing',
    })
    // The caller's object is not modified.
    expect(performance.arena_score_90d).toBe(0.01)
  })

  it('passes null and undefined through', () => {
    expect(withoutScores(null)).toBeNull()
    expect(withoutScores(undefined)).toBeUndefined()
  })
})
