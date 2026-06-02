import type { EvaluationCheck, EvaluationIssue } from '../pipeline-evaluator'

export type CheckResult = { check: EvaluationCheck; issues: EvaluationIssue[] }
