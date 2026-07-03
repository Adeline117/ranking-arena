import { getScoreColor, getScoreGrade, scoreColorAlpha, getScoreColorInfo } from '../score-colors'

describe('getScoreGrade — 分级边界', () => {
  it('≥90 → legendary', () => {
    expect(getScoreGrade(90)).toBe('legendary')
    expect(getScoreGrade(100)).toBe('legendary')
    expect(getScoreGrade(150)).toBe('legendary') // 超范围仍 legendary
  })

  it('70-89 → great', () => {
    expect(getScoreGrade(70)).toBe('great')
    expect(getScoreGrade(89)).toBe('great')
  })

  it('50-69 → average', () => {
    expect(getScoreGrade(50)).toBe('average')
    expect(getScoreGrade(69)).toBe('average')
  })

  it('30-49 → below', () => {
    expect(getScoreGrade(30)).toBe('below')
    expect(getScoreGrade(49)).toBe('below')
  })

  it('0-29 → low', () => {
    expect(getScoreGrade(0)).toBe('low')
    expect(getScoreGrade(29)).toBe('low')
  })

  it('负分 → low（兜底）', () => {
    expect(getScoreGrade(-10)).toBe('low')
  })
})

describe('getScoreColor', () => {
  it('返回对应 tier 的 CSS 变量', () => {
    expect(getScoreColor(95)).toBe('var(--color-score-legendary)')
    expect(getScoreColor(75)).toBe('var(--color-score-great)')
    expect(getScoreColor(10)).toBe('var(--color-score-low)')
  })
})

describe('scoreColorAlpha', () => {
  it('生成 color-mix 字符串（含 score 的 CSS 变量 + 百分比）', () => {
    expect(scoreColorAlpha(85, 25)).toBe(
      'color-mix(in srgb, var(--color-score-great) 25%, transparent)'
    )
  })
})

describe('getScoreColorInfo', () => {
  it('返回完整信息（color/grade/label/渐变/边框/填充）', () => {
    const info = getScoreColorInfo(95)
    expect(info.grade).toBe('legendary')
    expect(info.label).toBe('Legendary')
    expect(info.color).toBe('var(--color-score-legendary)')
    expect(info.bgGradient).toContain('linear-gradient')
    expect(info.borderColor).toContain('color-mix')
    expect(info.fillColor).toContain('color-mix')
  })

  it('所有派生颜色都基于该 tier 的 CSS 变量（无 hex 硬编码）', () => {
    const info = getScoreColorInfo(60) // average
    expect(info.bgGradient).toContain('var(--color-score-average)')
    expect(info.borderColor).toContain('var(--color-score-average)')
    expect(info).not.toHaveProperty('hex')
  })
})
