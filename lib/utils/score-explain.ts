/**
 * 评分可解释性 - 自然语言解读
 * 根据三维度评分生成中文解读文本
 */

export interface ScoreResult {
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  score_completeness?: 'full' | 'partial' | 'minimal' | null
  max_drawdown?: number | null
  win_rate?: number | null
  roi?: number | null
}

function describeLevel(score: number): string {
  if (score >= 80) return '突出'
  if (score >= 65) return '优秀'
  if (score >= 50) return '良好'
  if (score >= 35) return '一般'
  return '较弱'
}

/**
 * 生成评分的中文自然语言解读
 */
export function generateExplanation(result: ScoreResult): string {
  const parts: string[] = []

  const p = result.profitability_score
  const r = result.risk_control_score
  const e = result.execution_score

  if (p != null) {
    parts.push(`收益能力${describeLevel(p)}(${p.toFixed(0)}分)`)
  }
  if (r != null) {
    parts.push(`风险控制${describeLevel(r)}(${r.toFixed(0)}分)`)
  }
  if (e != null) {
    parts.push(`执行质量${describeLevel(e)}(${e.toFixed(0)}分)`)
  }

  // 补充风险提示
  // max_drawdown is stored as a positive percentage [0, 100] (see migration
  // 20260409180432). Display as "-25%" to match user expectation that
  // drawdown is a negative move from peak.
  if (result.max_drawdown != null && Math.abs(result.max_drawdown) > 30) {
    parts.push(`注意最大回撤偏高(-${Math.abs(result.max_drawdown).toFixed(0)}%)`)
  }

  if (result.score_completeness === 'minimal') {
    const missing = [
      result.win_rate == null ? '胜率' : null,
      result.max_drawdown == null ? '回撤' : null,
    ].filter(Boolean)
    parts.push(`数据较少(${missing.join('、')}缺失)，评分置信度低`)
  } else if (result.score_completeness === 'partial') {
    const missing = [
      result.win_rate == null ? '胜率' : null,
      result.max_drawdown == null ? '回撤' : null,
    ].filter(Boolean)
    parts.push(`${missing.join('、')}数据缺失`)
  }

  return parts.join('，') || '暂无评分数据'
}

/**
 * 获取评分等级标签 S/A/B/C/D
 */
export function getScoreGradeLetter(score: number): string {
  if (score >= 90) return 'S'
  if (score >= 75) return 'A'
  if (score >= 55) return 'B'
  if (score >= 35) return 'C'
  return 'D'
}

/**
 * 获取置信度中文标签
 */
export function getCompletenessLabel(completeness: string | null | undefined): string {
  switch (completeness) {
    case 'full': return '完整'
    case 'partial': return '部分'
    case 'minimal': return '最少'
    default: return '未知'
  }
}

export function getCompletenessColor(completeness: string | null | undefined): string {
  switch (completeness) {
    case 'full': return 'var(--color-score-great)'
    case 'partial': return 'var(--color-score-average)'
    case 'minimal': return 'var(--color-accent-error)'
    default: return 'var(--color-score-low)'
  }
}
