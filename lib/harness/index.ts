/**
 * Arena Harness — unified export for all harness modules.
 *
 * Pipeline harness:
 * - PipelineCheckpoint: crash recovery for batch jobs
 * - PipelineEvaluator: independent data quality verification
 * - withCronHarness: PipelineLogger + auth wrapper for cron routes
 *
 * Health checks:
 * - checkFrontendHealth: core page load + SSR verification
 * - checkAPIHealth: API endpoint response validation
 * - checkDataQuality: ranking consistency, anomalies, coverage
 * - runFullHealthCheck: combined report
 *
 * Code quality:
 * - formatEvalReport: format evaluation results for terminal
 */

export { PipelineCheckpoint } from './pipeline-checkpoint'
export type { CheckpointData, TraceMetadata } from './pipeline-checkpoint'

export { PipelineEvaluator } from './pipeline-evaluator'
export type { EvaluationCheck, EvaluationIssue, EvaluationResult } from './pipeline-evaluator'

export { withCronHarness, withCronHarnessPost } from './cron-wrapper'
export type { CronContext } from './cron-wrapper'

export {
  checkFrontendHealth,
  checkAPIHealth,
  checkDataQuality,
  runFullHealthCheck,
} from './health-checks'
export type { HealthCheck, HealthReport } from './health-checks'

export { formatEvalReport } from './code-evaluator'
export type { EvalCheck, EvalResult } from './code-evaluator'
