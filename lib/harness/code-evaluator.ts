/**
 * Code Quality Evaluator — scores code changes before commit.
 *
 * Checks:
 * 1. TypeScript compilation (30 points)
 * 2. ESLint (20 points)
 * 3. Unit tests pass (20 points)
 * 4. No console.log in production code (10 points)
 * 5. No hardcoded secrets (10 points)
 * 6. PipelineLogger in cron routes (10 points)
 *
 * Total: 100 points. Threshold: 80 to commit.
 */

export interface EvalCheck {
  name: string
  score: number
  max: number
  details: string
}

export interface EvalResult {
  total_score: number
  max_score: number
  passed: boolean
  threshold: number
  checks: EvalCheck[]
}

export function formatEvalReport(result: EvalResult): string {
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════',
    '  Code Quality Evaluation',
    '═══════════════════════════════════════════',
    '',
  ]

  for (const check of result.checks) {
    const icon = check.score === check.max ? '✓' : check.score > 0 ? '△' : '✗'
    lines.push(`  ${icon} ${check.name}: ${check.score}/${check.max} — ${check.details}`)
  }

  lines.push('')
  lines.push(`  Total: ${result.total_score}/${result.max_score} (threshold: ${result.threshold})`)
  lines.push(`  ${result.passed ? '✓ PASS — safe to commit' : '✗ FAIL — fix issues before commit'}`)
  lines.push('═══════════════════════════════════════════')
  lines.push('')

  return lines.join('\n')
}
