#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const REPORT_SCHEMA = 'arena.github-workflow-control-plane@1'
export const DEFAULT_REPOSITORY = 'Adeline117/ranking-arena'
export const REQUIRED_REPOSITORY_STATE = 'disabled_manually'
export const LIVE_OBSERVATION_ROUND_COUNT = 2
export const GH_QUERY_TIMEOUT_MS = 20_000
export const NON_COMPLETED_RUN_STATUSES = Object.freeze([
  'in_progress',
  'pending',
  'queued',
  'requested',
  'waiting',
])

const WORKFLOW_RUN_RESPONSE_PROJECTION =
  '{total_count: .total_count, workflow_runs: [.workflow_runs[] | {databaseId: .id, workflowName: .name, status: .status, createdAt: .created_at, event: .event, headSha: .head_sha, url: .html_url}]}'

export const EXPECTED_REPOSITORY_WORKFLOWS = Object.freeze([
  {
    name: 'DB Backup to R2',
    path: '.github/workflows/backup-db.yml',
  },
  {
    name: 'Build Ingest Worker Image',
    path: '.github/workflows/build-ingest-image.yml',
  },
  { name: 'CI', path: '.github/workflows/ci.yml' },
  {
    name: 'Smart Contract Build',
    path: '.github/workflows/contracts.yml',
  },
  {
    name: 'Deploy Freshness Sentinel',
    path: '.github/workflows/deploy-freshness.yml',
  },
  {
    name: 'Deploy Gate (CI-green production deploy)',
    path: '.github/workflows/deploy-gate.yml',
  },
  {
    name: 'Deploy Ingest Worker (SG)',
    path: '.github/workflows/deploy-ingest-sg.yml',
  },
  {
    name: 'E2E Nightly (main)',
    path: '.github/workflows/e2e-nightly.yml',
  },
  {
    name: 'Emergency Supabase restart',
    path: '.github/workflows/emergency-supabase-restart.yml',
  },
  {
    name: 'Emergency Supabase Status',
    path: '.github/workflows/emergency-supabase-status.yml',
  },
  {
    name: 'Health Monitor',
    path: '.github/workflows/health-monitor.yml',
  },
  {
    name: 'Lighthouse CI',
    path: '.github/workflows/lighthouse-ci.yml',
  },
  {
    name: 'Mobile App Build',
    path: '.github/workflows/mobile-build.yml',
  },
  {
    name: 'OpenClaw Sentinels',
    path: '.github/workflows/openclaw-sentinels.yml',
  },
  {
    name: 'Post-Deploy Evaluate',
    path: '.github/workflows/post-deploy-evaluate.yml',
  },
  {
    // V1 owner-approved sole exception (2026-11): read-only GET of the public
    // /api/health, no repository secret, job token limited to issues:write —
    // the only dead-man's switch independent of every V1 kill switch.
    allowedStates: Object.freeze(['active', 'disabled_manually']),
    name: 'Public Data Freshness Probe',
    path: '.github/workflows/public-freshness-probe.yml',
  },
  {
    name: 'Post-Deploy Smoke Test',
    path: '.github/workflows/post-deploy-smoke.yml',
  },
  {
    name: 'Vercel Release Control',
    path: '.github/workflows/vercel-release-control.yml',
  },
])

/** Names of repository workflows whose policy allows the `active` state. */
const ACTIVE_ALLOWED_WORKFLOW_NAMES = new Set(
  EXPECTED_REPOSITORY_WORKFLOWS.filter((workflow) =>
    workflow.allowedStates?.includes('active')
  ).map((workflow) => workflow.name)
)

export const EXPECTED_DYNAMIC_WORKFLOWS = Object.freeze([
  {
    allowedStates: Object.freeze(['active', 'disabled_manually']),
    name: 'Dependabot Updates',
    path: 'dynamic/dependabot/dependabot-updates',
  },
])

function compareText(left, right) {
  return left.localeCompare(right, 'en')
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON array`)
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function optionalString(value, label) {
  if (value === null || value === undefined || value === '') return null
  return requiredString(value, label)
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

function normalizeWorkflow(workflow, index, collectionLabel = 'workflows') {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new TypeError(`${collectionLabel}[${index}] must be an object`)
  }

  return {
    id: positiveSafeInteger(workflow.id, `${collectionLabel}[${index}].id`),
    name: requiredString(workflow.name, `${collectionLabel}[${index}].name`),
    path: requiredString(workflow.path, `${collectionLabel}[${index}].path`),
    state: requiredString(workflow.state, `${collectionLabel}[${index}].state`),
  }
}

function normalizeRun(run, index) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    throw new TypeError(`runs[${index}] must be an object`)
  }

  return {
    createdAt: optionalString(run.createdAt, `runs[${index}].createdAt`),
    databaseId: positiveSafeInteger(run.databaseId, `runs[${index}].databaseId`),
    event: optionalString(run.event, `runs[${index}].event`),
    headSha: optionalString(run.headSha, `runs[${index}].headSha`),
    status: requiredString(run.status, `runs[${index}].status`),
    url: optionalString(run.url, `runs[${index}].url`),
    workflowName: optionalString(run.workflowName, `runs[${index}].workflowName`),
  }
}

function violationSortKey(violation) {
  return [
    violation.code,
    violation.path ?? '',
    String(violation.databaseId ?? ''),
    violation.actual ?? '',
    violation.expected ?? '',
  ].join('\u0000')
}

function isRepositoryDefined(path) {
  return path.startsWith('.github/workflows/')
}

function pushDuplicateViolations(items, key, code, violations) {
  const seen = new Set()
  for (const item of items) {
    if (seen.has(item[key])) {
      violations.push({ code, [key]: item[key] })
    }
    seen.add(item[key])
  }
}

function canonicalWorkflowInventory(workflows) {
  return [...workflows].sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      left.id - right.id ||
      compareText(left.name, right.name) ||
      compareText(left.state, right.state)
  )
}

function normalizeMaxObservedRunStatusTotals(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('maxObservedRunStatusTotals must be an object')
  }

  const unknownStatuses = Object.keys(value).filter(
    (status) => !NON_COMPLETED_RUN_STATUSES.includes(status)
  )
  if (unknownStatuses.length > 0) {
    throw new TypeError('maxObservedRunStatusTotals contains an unknown status')
  }

  const totals = {}
  for (const status of NON_COMPLETED_RUN_STATUSES) {
    if (!Object.hasOwn(value, status)) {
      throw new TypeError(`maxObservedRunStatusTotals.${status} is required`)
    }
    totals[status] = nonNegativeSafeInteger(value[status], `maxObservedRunStatusTotals.${status}`)
  }
  return totals
}

/**
 * Pure policy analyzer. It deliberately projects only known-safe GitHub fields,
 * so unrelated fixture/API properties cannot appear in the report.
 */
export function analyzeWorkflowControlPlane({
  maxObservedRunStatusTotals = null,
  observationCompletedAt = null,
  observationRoundCount = null,
  observationStartedAt = null,
  repository = DEFAULT_REPOSITORY,
  runs,
  workflows,
  workflowsAfter = workflows,
}) {
  requiredString(repository, 'repository')
  assertArray(workflows, 'workflows')
  assertArray(workflowsAfter, 'workflowsAfter')
  assertArray(runs, 'runs')

  const normalizedWorkflows = workflows.map(normalizeWorkflow)
  const normalizedWorkflowsAfter = workflowsAfter.map((workflow, index) =>
    normalizeWorkflow(workflow, index, 'workflowsAfter')
  )
  const normalizedRuns = runs.map(normalizeRun)
  const normalizedMaxObservedRunStatusTotals = normalizeMaxObservedRunStatusTotals(
    maxObservedRunStatusTotals
  )
  const normalizedObservationRoundCount =
    observationRoundCount === null || observationRoundCount === undefined
      ? null
      : positiveSafeInteger(observationRoundCount, 'observationRoundCount')
  if (
    (normalizedMaxObservedRunStatusTotals === null) !==
    (normalizedObservationRoundCount === null)
  ) {
    throw new TypeError(
      'observationRoundCount and maxObservedRunStatusTotals must be provided together'
    )
  }
  const workflowInventoryStable =
    JSON.stringify(canonicalWorkflowInventory(normalizedWorkflows)) ===
    JSON.stringify(canonicalWorkflowInventory(normalizedWorkflowsAfter))
  const repositoryDefined = normalizedWorkflows
    .filter((workflow) => isRepositoryDefined(workflow.path))
    .sort((left, right) => compareText(left.path, right.path))
  const dynamic = normalizedWorkflows
    .filter((workflow) => !isRepositoryDefined(workflow.path))
    .sort((left, right) => compareText(left.path, right.path))
  const violations = []

  if (!workflowInventoryStable) {
    violations.push({ code: 'workflow_inventory_changed_during_observation' })
  }

  pushDuplicateViolations(normalizedWorkflows, 'id', 'duplicate_workflow_id', violations)
  pushDuplicateViolations(normalizedWorkflows, 'path', 'duplicate_workflow_path', violations)
  pushDuplicateViolations(normalizedRuns, 'databaseId', 'duplicate_run_id', violations)

  const expectedRepositoryByPath = new Map(
    EXPECTED_REPOSITORY_WORKFLOWS.map((workflow) => [workflow.path, workflow])
  )
  const actualRepositoryByPath = new Map(
    repositoryDefined.map((workflow) => [workflow.path, workflow])
  )

  if (repositoryDefined.length !== EXPECTED_REPOSITORY_WORKFLOWS.length) {
    violations.push({
      actual: String(repositoryDefined.length),
      code: 'repository_workflow_count_mismatch',
      expected: String(EXPECTED_REPOSITORY_WORKFLOWS.length),
    })
  }

  for (const expected of EXPECTED_REPOSITORY_WORKFLOWS) {
    const actual = actualRepositoryByPath.get(expected.path)
    if (!actual) {
      violations.push({ code: 'missing_repository_workflow', path: expected.path })
      continue
    }
    if (actual.name !== expected.name) {
      violations.push({
        actual: actual.name,
        code: 'repository_workflow_name_mismatch',
        expected: expected.name,
        path: expected.path,
      })
    }
    const allowedStates = expected.allowedStates ?? [REQUIRED_REPOSITORY_STATE]
    if (!allowedStates.includes(actual.state)) {
      violations.push({
        actual: actual.state,
        code: 'repository_workflow_state_mismatch',
        expected: allowedStates.join('|'),
        path: expected.path,
      })
    }
  }

  for (const actual of repositoryDefined) {
    if (!expectedRepositoryByPath.has(actual.path)) {
      violations.push({
        code:
          actual.state === 'active'
            ? 'unknown_repository_workflow_active'
            : 'unknown_repository_workflow',
        path: actual.path,
        state: actual.state,
      })
    }
  }

  const expectedDynamicByPath = new Map(
    EXPECTED_DYNAMIC_WORKFLOWS.map((workflow) => [workflow.path, workflow])
  )
  const actualDynamicByPath = new Map(dynamic.map((workflow) => [workflow.path, workflow]))

  for (const expected of EXPECTED_DYNAMIC_WORKFLOWS) {
    const actual = actualDynamicByPath.get(expected.path)
    if (!actual) {
      violations.push({ code: 'missing_dynamic_workflow', path: expected.path })
      continue
    }
    if (actual.name !== expected.name) {
      violations.push({
        actual: actual.name,
        code: 'dynamic_workflow_name_mismatch',
        expected: expected.name,
        path: expected.path,
      })
    }
    if (!expected.allowedStates.includes(actual.state)) {
      violations.push({
        actual: actual.state,
        code: 'dynamic_workflow_state_not_allowed',
        expected: expected.allowedStates.join('|'),
        path: expected.path,
      })
    }
  }

  for (const actual of dynamic) {
    if (!expectedDynamicByPath.has(actual.path)) {
      violations.push({
        code: 'unknown_dynamic_workflow',
        path: actual.path,
        state: actual.state,
      })
    }
  }

  const nonCompletedRuns = normalizedRuns
    .filter((run) => run.status !== 'completed')
    .sort((left, right) => left.databaseId - right.databaseId)
  // Runs of a workflow explicitly allowed to be active are expected; every
  // other non-completed run remains a violation.
  const isExemptRun = (run) =>
    ACTIVE_ALLOWED_WORKFLOW_NAMES.has(run.workflowName) &&
    NON_COMPLETED_RUN_STATUSES.includes(run.status)

  for (const run of nonCompletedRuns) {
    if (isExemptRun(run)) continue
    violations.push({
      code: NON_COMPLETED_RUN_STATUSES.includes(run.status)
        ? 'non_completed_run'
        : 'unknown_non_completed_run_status',
      databaseId: run.databaseId,
      status: run.status,
      workflowName: run.workflowName,
    })
  }

  if (normalizedMaxObservedRunStatusTotals) {
    for (const status of NON_COMPLETED_RUN_STATUSES) {
      const maximumObservedTotalCount = normalizedMaxObservedRunStatusTotals[status]
      const exemptRetainedCount = nonCompletedRuns.filter(
        (run) => run.status === status && isExemptRun(run)
      ).length
      if (maximumObservedTotalCount > exemptRetainedCount) {
        violations.push({
          code: 'non_completed_run_status_present',
          maximumObservedTotalCount,
          retainedCount: nonCompletedRuns.filter((run) => run.status === status).length,
          status,
        })
      }
    }
  }

  const maximumObservedRunStatusTotalSum = normalizedMaxObservedRunStatusTotals
    ? Object.values(normalizedMaxObservedRunStatusTotals).reduce((total, count) => total + count, 0)
    : null

  violations.sort((left, right) => compareText(violationSortKey(left), violationSortKey(right)))

  return {
    schema: REPORT_SCHEMA,
    status: violations.length === 0 ? 'pass' : 'fail',
    repository,
    observationStartedAt,
    observationCompletedAt,
    observationRoundCount: normalizedObservationRoundCount,
    workflowInventoryStable,
    policy: {
      allowedDynamicWorkflows: EXPECTED_DYNAMIC_WORKFLOWS.map((workflow) => ({
        allowedStates: [...workflow.allowedStates],
        name: workflow.name,
        path: workflow.path,
      })),
      expectedRepositoryWorkflowCount: EXPECTED_REPOSITORY_WORKFLOWS.length,
      repositoryStateExceptions: EXPECTED_REPOSITORY_WORKFLOWS.filter(
        (workflow) => workflow.allowedStates
      ).map((workflow) => ({ allowedStates: [...workflow.allowedStates], path: workflow.path })),
      prohibitedRunStatuses: [...NON_COMPLETED_RUN_STATUSES],
      requiredRepositoryState: REQUIRED_REPOSITORY_STATE,
    },
    summary: {
      disabledRepositoryDefinedCount: repositoryDefined.filter(
        (workflow) => workflow.state === REQUIRED_REPOSITORY_STATE
      ).length,
      dynamicWorkflowCount: dynamic.length,
      inspectedRunCount: normalizedRuns.length,
      maximumObservedRunStatusTotalSum,
      nonCompletedRunCount: nonCompletedRuns.length,
      retainedNonCompletedRunCount: nonCompletedRuns.length,
      repositoryDefinedCount: repositoryDefined.length,
      violationCount: violations.length,
      workflowCount: normalizedWorkflows.length,
    },
    maxObservedRunStatusTotals: normalizedMaxObservedRunStatusTotals,
    workflows: {
      dynamic,
      repositoryDefined,
    },
    nonCompletedRuns,
    violations,
  }
}

function parseArguments(argv) {
  const parsed = {
    repository: DEFAULT_REPOSITORY,
    runsJsonPath: null,
    workflowsJsonPath: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      parsed.help = true
      continue
    }
    if (argument === '--repo') {
      parsed.repository = argv[index + 1]
      index += 1
      continue
    }
    if (argument === '--workflows-json') {
      parsed.workflowsJsonPath = argv[index + 1]
      index += 1
      continue
    }
    if (argument === '--runs-json') {
      parsed.runsJsonPath = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repository ?? '')) {
    throw new Error('--repo must use OWNER/REPO format')
  }
  if (Boolean(parsed.workflowsJsonPath) !== Boolean(parsed.runsJsonPath)) {
    throw new Error('--workflows-json and --runs-json must be provided together')
  }

  return parsed
}

function parseJsonFile(path, label) {
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Unable to read ${label} JSON file`)
  }
  try {
    return JSON.parse(source)
  } catch {
    throw new Error(`Unable to parse ${label} JSON file`)
  }
}

export function runGhJson(arguments_, label, runner = spawnSync) {
  const result = runner('gh', arguments_, {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: GH_QUERY_TIMEOUT_MS,
  })
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`Read-only GitHub query failed: ${label}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`GitHub returned invalid JSON: ${label}`)
  }
}

function fetchWorkflowInventory(repository, label) {
  return runGhJson(
    [
      'workflow',
      'list',
      '--repo',
      repository,
      '--all',
      '--limit',
      '1000',
      '--json',
      'id,name,path,state',
    ],
    label
  )
}

function normalizeRunStatusResponse(response, requestedStatus) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError(`${requestedStatus} run response must be an object`)
  }
  const totalCount = nonNegativeSafeInteger(
    response.total_count,
    `${requestedStatus} run response.total_count`
  )
  assertArray(response.workflow_runs, `${requestedStatus} run response.workflow_runs`)
  if (response.workflow_runs.length > 100) {
    throw new TypeError(`${requestedStatus} run response retained more than 100 runs`)
  }
  if (response.workflow_runs.length > totalCount) {
    throw new TypeError(`${requestedStatus} run response exceeds total_count`)
  }
  if (totalCount > 0 && response.workflow_runs.length === 0) {
    throw new TypeError(`${requestedStatus} run response omitted available evidence`)
  }
  for (const [index, run] of response.workflow_runs.entries()) {
    if (run === null || typeof run !== 'object' || Array.isArray(run)) {
      throw new TypeError(
        `${requestedStatus} run response.workflow_runs[${index}] must be an object`
      )
    }
    if (run.status !== requestedStatus) {
      throw new TypeError(`${requestedStatus} run response contained a mismatched status`)
    }
  }
  return { runs: response.workflow_runs, totalCount }
}

function fetchLiveEvidence(repository) {
  const observationStartedAt = new Date().toISOString()
  const workflows = fetchWorkflowInventory(repository, 'workflow inventory at observation start')
  const retainedRuns = new Map()
  const maxObservedRunStatusTotals = Object.fromEntries(
    NON_COMPLETED_RUN_STATUSES.map((status) => [status, 0])
  )

  for (let round = 1; round <= LIVE_OBSERVATION_ROUND_COUNT; round += 1) {
    for (const status of NON_COMPLETED_RUN_STATUSES) {
      const response = runGhJson(
        [
          'api',
          `repos/${repository}/actions/runs?status=${status}&per_page=100`,
          '--jq',
          WORKFLOW_RUN_RESPONSE_PROJECTION,
        ],
        `${status} workflow run observation round ${round}`
      )
      const normalized = normalizeRunStatusResponse(response, status)
      maxObservedRunStatusTotals[status] = Math.max(
        maxObservedRunStatusTotals[status],
        normalized.totalCount
      )
      for (const run of normalized.runs) retainedRuns.set(run.databaseId, run)
    }
  }

  const workflowsAfter = fetchWorkflowInventory(
    repository,
    'workflow inventory at observation completion'
  )
  const observationCompletedAt = new Date().toISOString()

  return {
    observationCompletedAt,
    observationRoundCount: LIVE_OBSERVATION_ROUND_COUNT,
    observationStartedAt,
    maxObservedRunStatusTotals,
    runs: [...retainedRuns.values()],
    workflows,
    workflowsAfter,
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/qa/github-workflow-control-plane.mjs [--repo OWNER/REPO]
  node scripts/qa/github-workflow-control-plane.mjs --workflows-json FILE --runs-json FILE [--repo OWNER/REPO]

The default mode performs a bounded read-only observation: workflow inventory,
two complete REST-query rounds across every documented non-completed run status,
then workflow inventory again.
`)
}

function errorReport(message) {
  return {
    schema: REPORT_SCHEMA,
    status: 'error',
    error: { code: 'control_plane_verifier_error', message },
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv)
    if (options.help) {
      printHelp()
      return 0
    }
    const evidence = options.workflowsJsonPath
      ? {
          runs: parseJsonFile(options.runsJsonPath, 'runs'),
          workflows: parseJsonFile(options.workflowsJsonPath, 'workflows'),
        }
      : fetchLiveEvidence(options.repository)
    const report = analyzeWorkflowControlPlane({
      repository: options.repository,
      ...evidence,
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.status === 'pass' ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown verifier error'
    process.stderr.write(`${JSON.stringify(errorReport(message), null, 2)}\n`)
    return 2
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main()
}
