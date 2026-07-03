import {
  generateExplanation,
  getScoreGradeLetter,
  getCompletenessLabel,
  getCompletenessColor,
} from '../score-explain'

describe('generateExplanation', () => {
  it('三维度都有 → 拼接三段解读', () => {
    const out = generateExplanation({
      profitability_score: 85,
      risk_control_score: 60,
      execution_score: 40,
    })
    expect(out).toContain('收益能力突出(85分)')
    expect(out).toContain('风险控制良好(60分)')
    expect(out).toContain('执行质量一般(40分)')
  })

  it('null 维度被跳过', () => {
    const out = generateExplanation({ profitability_score: 70, risk_control_score: null })
    expect(out).toContain('收益能力')
    expect(out).not.toContain('风险控制')
  })

  it('回撤 >30 → 追加风险提示（显示为负）', () => {
    const out = generateExplanation({ profitability_score: 50, max_drawdown: 45 })
    expect(out).toContain('最大回撤偏高(-45%)')
  })

  it('回撤 ≤30 → 不提示', () => {
    const out = generateExplanation({ profitability_score: 50, max_drawdown: 20 })
    expect(out).not.toContain('最大回撤')
  })

  it('completeness=minimal → 缺失字段提示 + 置信度低', () => {
    const out = generateExplanation({
      profitability_score: 50,
      score_completeness: 'minimal',
      win_rate: null,
      max_drawdown: null,
    })
    expect(out).toContain('胜率、回撤缺失')
    expect(out).toContain('置信度低')
  })

  it('全空 → 兜底文案', () => {
    expect(generateExplanation({})).toBe('暂无评分数据')
  })

  it('等级边界：80突出/65优秀/50良好/35一般/34较弱', () => {
    expect(generateExplanation({ profitability_score: 80 })).toContain('突出')
    expect(generateExplanation({ profitability_score: 65 })).toContain('优秀')
    expect(generateExplanation({ profitability_score: 50 })).toContain('良好')
    expect(generateExplanation({ profitability_score: 35 })).toContain('一般')
    expect(generateExplanation({ profitability_score: 34 })).toContain('较弱')
  })
})

describe('getScoreGradeLetter — S/A/B/C/D 边界', () => {
  it('90→S, 75→A, 55→B, 35→C, <35→D', () => {
    expect(getScoreGradeLetter(90)).toBe('S')
    expect(getScoreGradeLetter(89)).toBe('A')
    expect(getScoreGradeLetter(75)).toBe('A')
    expect(getScoreGradeLetter(55)).toBe('B')
    expect(getScoreGradeLetter(35)).toBe('C')
    expect(getScoreGradeLetter(0)).toBe('D')
  })
})

describe('getCompletenessLabel / Color', () => {
  it('label 映射', () => {
    expect(getCompletenessLabel('full')).toBe('完整')
    expect(getCompletenessLabel('partial')).toBe('部分')
    expect(getCompletenessLabel('minimal')).toBe('最少')
    expect(getCompletenessLabel(null)).toBe('未知')
    expect(getCompletenessLabel('garbage')).toBe('未知')
  })

  it('color 映射（各档不同 CSS 变量）', () => {
    expect(getCompletenessColor('full')).toContain('great')
    expect(getCompletenessColor('minimal')).toContain('error')
    expect(getCompletenessColor(undefined)).toContain('low')
  })
})
