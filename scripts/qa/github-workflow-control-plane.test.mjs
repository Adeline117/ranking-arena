import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  analyzeWorkflowControlPlane,
  EXPECTED_DYNAMIC_WORKFLOWS,
  EXPECTED_REPOSITORY_WORKFLOWS,
  GH_QUERY_TIMEOUT_MS,
  LIVE_OBSERVATION_ROUND_COUNT,
  NON_COMPLETED_RUN_STATUSES,
  REPORT_SCHEMA,
  runGhJson,
} from './github-workflow-control-plane.mjs'

const scriptPath = fileURLToPath(new URL('./github-workflow-control-plane.mjs', import.meta.url))
const workflowRunResponseProjection =
  '{total_count: .total_count, workflow_runs: [.workflow_runs[] | {databaseId: .id, workflowName: .name, status: .status, createdAt: .created_at, event: .event, headSha: .head_sha, url: .html_url}]}'

function passingWorkflows() {
  const repositoryDefined = EXPECTED_REPOSITORY_WORKFLOWS.map((workflow, index) => ({
    id: index + 1,
    ...workflow,
    state: 'disabled_manually',
    secretFixtureValue: 'must-never-be-projected',
  }))
  const dynamic = EXPECTED_DYNAMIC_WORKFLOWS.map((workflow, index) => ({
    id: repositoryDefined.length + index + 1,
    name: workflow.name,
    path: workflow.path,
    state: 'active',
  }))
  return [...dynamic, ...repositoryDefined].reverse()
}

function completedRun(overrides = {}) {
  return {
    createdAt: '2026-08-05T01:00:00Z',
    databaseId: 9001,
    event: 'schedule',
    headSha: 'a'.repeat(40),
    status: 'completed',
    url: 'https://github.com/Adeline117/ranking-arena/actions/runs/9001',
    workflowName: 'Health Monitor',
    secretFixtureValue: 'must-never-be-projected',
    ...overrides,
  }
}

function emptyStatusResponses() {
  return Object.fromEntries(
    NON_COMPLETED_RUN_STATUSES.map((status) => [status, { total_count: 0, workflow_runs: [] }])
  )
}

function installFakeGh(directory) {
  const ghPath = path.join(directory, 'gh')
  const logPath = path.join(directory, 'gh-arguments.jsonl')
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const arguments_ = process.argv.slice(2)
const logPath = process.env.FAKE_GH_LOG
const previousQueries = existsSync(logPath)
  ? readFileSync(logPath, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line))
  : []
appendFileSync(logPath, JSON.stringify(arguments_) + '\\n')
if (process.env.FAKE_GH_HANG === '1') {
  setInterval(() => {}, 60_000)
} else if (process.env.FAKE_GH_SIGNAL === '1') {
  process.kill(process.pid, 'SIGTERM')
} else if (arguments_[0] === 'workflow') {
  const priorWorkflowQueries = previousQueries.filter((query) => query[0] === 'workflow').length
  process.stdout.write(
    priorWorkflowQueries === 0
      ? process.env.FAKE_GH_WORKFLOWS_BEFORE
      : process.env.FAKE_GH_WORKFLOWS_AFTER
  )
} else if (arguments_[0] === 'api') {
  const endpoint = arguments_.find((argument) => argument.startsWith('repos/'))
  const status = new URL('https://api.github.test/' + endpoint).searchParams.get('status')
  const responses = JSON.parse(process.env.FAKE_GH_STATUS_RESPONSES)
  const priorApiQueries = previousQueries.filter((query) => query[0] === 'api').length
  const round = Math.floor(priorApiQueries / ${NON_COMPLETED_RUN_STATUSES.length})
  const roundResponses = Array.isArray(responses) ? responses[round] : responses
  process.stdout.write(JSON.stringify(roundResponses[status]))
} else {
  process.exitCode = 9
}
`
  )
  chmodSync(ghPath, 0o700)
  return { logPath }
}

function fakeGhEnvironment(directory, logPath, overrides = {}) {
  return {
    ...process.env,
    FAKE_GH_HANG: overrides.hang ? '1' : '0',
    FAKE_GH_LOG: logPath,
    FAKE_GH_SIGNAL: overrides.signal ? '1' : '0',
    FAKE_GH_STATUS_RESPONSES: JSON.stringify(overrides.statusResponses ?? emptyStatusResponses()),
    FAKE_GH_WORKFLOWS_AFTER: JSON.stringify(
      overrides.workflowsAfter ?? overrides.workflowsBefore ?? passingWorkflows()
    ),
    FAKE_GH_WORKFLOWS_BEFORE: JSON.stringify(overrides.workflowsBefore ?? passingWorkflows()),
    PATH: `${directory}:${process.env.PATH ?? ''}`,
  }
}

test('passing report is deterministic, exact, and redacts unrelated input fields', () => {
  const first = analyzeWorkflowControlPlane({
    repository: 'Adeline117/ranking-arena',
    runs: [completedRun()],
    workflows: passingWorkflows(),
  })
  const second = analyzeWorkflowControlPlane({
    repository: 'Adeline117/ranking-arena',
    runs: [completedRun()],
    workflows: [...passingWorkflows()].reverse(),
  })

  assert.equal(first.schema, REPORT_SCHEMA)
  assert.equal(first.status, 'pass')
  assert.equal(first.summary.repositoryDefinedCount, 17)
  assert.equal(first.summary.disabledRepositoryDefinedCount, 17)
  assert.equal(first.summary.dynamicWorkflowCount, 1)
  assert.equal(first.summary.nonCompletedRunCount, 0)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first).includes('must-never-be-projected'), false)
})

test('an expected repository workflow becoming active fails closed', () => {
  const workflows = passingWorkflows()
  const ci = workflows.find((workflow) => workflow.path === '.github/workflows/ci.yml')
  ci.state = 'active'

  const report = analyzeWorkflowControlPlane({ runs: [], workflows })

  assert.equal(report.status, 'fail')
  assert.deepEqual(
    report.violations.find((violation) => violation.code === 'repository_workflow_state_mismatch'),
    {
      actual: 'active',
      code: 'repository_workflow_state_mismatch',
      expected: 'disabled_manually',
      path: '.github/workflows/ci.yml',
    }
  )
})

test('missing, renamed, and unknown active repository workflows are all rejected', () => {
  const workflows = passingWorkflows().filter(
    (workflow) => workflow.path !== '.github/workflows/ci.yml'
  )
  workflows.find((workflow) => workflow.path === '.github/workflows/backup-db.yml').name =
    'Renamed Backup'
  workflows.push({
    id: 99,
    name: 'Surprise Deploy',
    path: '.github/workflows/surprise-deploy.yml',
    state: 'active',
  })

  const report = analyzeWorkflowControlPlane({ runs: [], workflows })
  const codes = report.violations.map((violation) => violation.code)

  assert.equal(report.status, 'fail')
  assert.ok(codes.includes('missing_repository_workflow'))
  assert.ok(codes.includes('repository_workflow_name_mismatch'))
  assert.ok(codes.includes('unknown_repository_workflow_active'))
})

test('Dependabot may be active or manually disabled, but no other dynamic workflow is allowed', () => {
  for (const state of ['active', 'disabled_manually']) {
    const workflows = passingWorkflows()
    workflows.find((workflow) => workflow.path.startsWith('dynamic/')).state = state
    assert.equal(analyzeWorkflowControlPlane({ runs: [], workflows }).status, 'pass')
  }

  const workflows = passingWorkflows()
  workflows.push({
    id: 100,
    name: 'Unknown Dynamic',
    path: 'dynamic/example/unknown',
    state: 'active',
  })
  const report = analyzeWorkflowControlPlane({ runs: [], workflows })
  assert.ok(report.violations.some((violation) => violation.code === 'unknown_dynamic_workflow'))
})

test('every prohibited run status is reported regardless of input ordering', () => {
  const runs = NON_COMPLETED_RUN_STATUSES.map((status, index) =>
    completedRun({ databaseId: 100 + index, status })
  ).reverse()

  const report = analyzeWorkflowControlPlane({ runs, workflows: passingWorkflows() })

  assert.equal(report.status, 'fail')
  assert.equal(report.summary.nonCompletedRunCount, NON_COMPLETED_RUN_STATUSES.length)
  assert.deepEqual(
    report.nonCompletedRuns.map((run) => run.databaseId),
    [100, 101, 102, 103, 104]
  )
  assert.equal(
    report.violations.filter((violation) => violation.code === 'non_completed_run').length,
    NON_COMPLETED_RUN_STATUSES.length
  )
})

test('unknown non-completed statuses and duplicate evidence fail closed', () => {
  const workflows = passingWorkflows()
  workflows.push({ ...workflows[0] })
  const run = completedRun({ databaseId: 77, status: 'future_status' })
  const report = analyzeWorkflowControlPlane({
    runs: [run, { ...run }],
    workflows,
  })
  const codes = report.violations.map((violation) => violation.code)

  assert.ok(codes.includes('duplicate_workflow_id'))
  assert.ok(codes.includes('duplicate_workflow_path'))
  assert.ok(codes.includes('duplicate_run_id'))
  assert.ok(codes.includes('unknown_non_completed_run_status'))
})

test('malformed evidence is rejected before policy evaluation', () => {
  assert.throws(
    () => analyzeWorkflowControlPlane({ runs: [], workflows: {} }),
    /workflows must be a JSON array/
  )
  assert.throws(
    () =>
      analyzeWorkflowControlPlane({
        runs: [{ databaseId: 'not-a-number', status: 'queued' }],
        workflows: passingWorkflows(),
      }),
    /positive safe integer/
  )
})

test('fixture CLI is read-only, returns policy exit codes, and does not expose extra fields', () => {
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'arena-workflow-control-plane-'))
  const workflowsPath = path.join(fixtureDirectory, 'workflows.json')
  const runsPath = path.join(fixtureDirectory, 'runs.json')
  try {
    writeFileSync(workflowsPath, JSON.stringify(passingWorkflows()))
    writeFileSync(runsPath, JSON.stringify([completedRun()]))
    const passing = spawnSync(
      process.execPath,
      [scriptPath, '--workflows-json', workflowsPath, '--runs-json', runsPath],
      { encoding: 'utf8' }
    )
    assert.equal(passing.status, 0, passing.stderr)
    assert.equal(JSON.parse(passing.stdout).status, 'pass')
    assert.equal(passing.stdout.includes('must-never-be-projected'), false)

    const failingRuns = [completedRun({ status: 'queued' })]
    writeFileSync(runsPath, JSON.stringify(failingRuns))
    const failing = spawnSync(
      process.execPath,
      [scriptPath, '--workflows-json', workflowsPath, '--runs-json', runsPath],
      { encoding: 'utf8' }
    )
    assert.equal(failing.status, 1, failing.stderr)
    assert.equal(JSON.parse(failing.stdout).status, 'fail')
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  }
})

test('CLI reports fixture parse errors without echoing fixture content', () => {
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'arena-workflow-control-plane-'))
  const workflowsPath = path.join(fixtureDirectory, 'workflows.json')
  const runsPath = path.join(fixtureDirectory, 'runs.json')
  try {
    writeFileSync(workflowsPath, '{"secret":"do-not-echo"')
    writeFileSync(runsPath, '[]')
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--workflows-json', workflowsPath, '--runs-json', runsPath],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 2)
    assert.equal(result.stderr.includes('do-not-echo'), false)
    assert.equal(JSON.parse(result.stderr).status, 'error')
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  }
})

test('a hung or signaled gh query is bounded and fails closed', async (t) => {
  for (const [scenario, result] of [
    [
      'timeout',
      {
        error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        signal: 'SIGKILL',
        status: null,
      },
    ],
    ['signal', { error: undefined, signal: 'SIGTERM', status: null }],
  ]) {
    await t.test(scenario, () => {
      let invocation
      assert.throws(
        () =>
          runGhJson(['workflow', 'list'], 'bounded test query', (command, arguments_, options) => {
            invocation = { arguments_, command, options }
            return result
          }),
        /Read-only GitHub query failed: bounded test query/
      )
      assert.equal(invocation.command, 'gh')
      assert.deepEqual(invocation.arguments_, ['workflow', 'list'])
      assert.equal(invocation.options.timeout, GH_QUERY_TIMEOUT_MS)
      assert.equal(invocation.options.killSignal, 'SIGKILL')
      assert.equal(invocation.options.shell, false)
    })
  }
})

test('live CLI performs two complete rounds, retains unique runs, and reports maximum counts', () => {
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'arena-workflow-control-plane-live-'))
  try {
    const { logPath } = installFakeGh(fixtureDirectory)
    const statusResponses = emptyStatusResponses()
    statusResponses.queued = {
      total_count: 137,
      workflow_runs: [completedRun({ databaseId: 9002, status: 'queued' })],
    }

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: fakeGhEnvironment(fixtureDirectory, logPath, { statusResponses }),
    })

    assert.equal(result.status, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.workflowInventoryStable, true)
    assert.match(report.observationStartedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(report.observationCompletedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(report.observationCompletedAt >= report.observationStartedAt)
    assert.equal(report.observationRoundCount, LIVE_OBSERVATION_ROUND_COUNT)
    assert.equal(report.summary.nonCompletedRunCount, 1)
    assert.equal(report.summary.retainedNonCompletedRunCount, 1)
    assert.equal(report.summary.maximumObservedRunStatusTotalSum, 137)
    assert.equal(report.maxObservedRunStatusTotals.queued, 137)
    assert.equal(report.nonCompletedRuns.length, 1)
    assert.deepEqual(
      report.violations.find(
        (violation) =>
          violation.code === 'non_completed_run_status_present' && violation.status === 'queued'
      ),
      {
        code: 'non_completed_run_status_present',
        maximumObservedTotalCount: 137,
        retainedCount: 1,
        status: 'queued',
      }
    )
    assert.equal(result.stdout.includes('must-never-be-projected'), false)

    const queries = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(queries.length, 12)
    assert.equal(queries.filter((arguments_) => arguments_[0] === 'workflow').length, 2)
    const runQueries = queries.filter((arguments_) => arguments_[0] === 'api')
    assert.equal(
      runQueries.length,
      NON_COMPLETED_RUN_STATUSES.length * LIVE_OBSERVATION_ROUND_COUNT
    )
    const observedStatuses = runQueries.map((arguments_) => {
      assert.deepEqual(arguments_.slice(-2), ['--jq', workflowRunResponseProjection])
      assert.equal(arguments_.includes('--paginate'), false)
      assert.equal(arguments_.includes('--status'), false)
      const endpoint = arguments_.find((argument) => argument.startsWith('repos/'))
      const url = new URL(`https://api.github.test/${endpoint}`)
      assert.equal(url.searchParams.get('per_page'), '100')
      return url.searchParams.get('status')
    })
    assert.deepEqual(observedStatuses, [
      ...NON_COMPLETED_RUN_STATUSES,
      ...NON_COMPLETED_RUN_STATUSES,
    ])
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  }
})

test('a new non-completed run appearing only in the second round prevents PASS', () => {
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'arena-workflow-control-plane-live-'))
  try {
    const { logPath } = installFakeGh(fixtureDirectory)
    const firstRound = emptyStatusResponses()
    const secondRound = emptyStatusResponses()
    secondRound.waiting = {
      total_count: 1,
      workflow_runs: [completedRun({ databaseId: 9010, status: 'waiting' })],
    }
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: fakeGhEnvironment(fixtureDirectory, logPath, {
        statusResponses: [firstRound, secondRound],
      }),
    })

    assert.equal(result.status, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.observationRoundCount, 2)
    assert.equal(report.maxObservedRunStatusTotals.waiting, 1)
    assert.deepEqual(
      report.nonCompletedRuns.map((run) => run.databaseId),
      [9010]
    )
    const queries = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(queries.filter((arguments_) => arguments_[0] === 'api').length, 10)
    assert.equal(queries.at(-1)[0], 'workflow')
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  }
})

test('live CLI fails closed when workflow inventory changes during observation', () => {
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'arena-workflow-control-plane-live-'))
  try {
    const { logPath } = installFakeGh(fixtureDirectory)
    const workflowsAfter = passingWorkflows()
    workflowsAfter.find((workflow) => workflow.path === '.github/workflows/ci.yml').state = 'active'
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: fakeGhEnvironment(fixtureDirectory, logPath, { workflowsAfter }),
    })

    assert.equal(result.status, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.workflowInventoryStable, false)
    assert.ok(
      report.violations.some(
        (violation) => violation.code === 'workflow_inventory_changed_during_observation'
      )
    )
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  }
})

test('live CLI rejects a malformed bounded status response without echoing its content', () => {
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'arena-workflow-control-plane-live-'))
  try {
    const { logPath } = installFakeGh(fixtureDirectory)
    const statusResponses = emptyStatusResponses()
    statusResponses.pending = {
      total_count: 1,
      workflow_runs: 'malformed-do-not-echo',
    }
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: fakeGhEnvironment(fixtureDirectory, logPath, { statusResponses }),
    })

    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr)
    assert.equal(error.status, 'error')
    assert.match(error.error.message, /workflow_runs must be a JSON array/)
    assert.equal(result.stderr.includes('malformed-do-not-echo'), false)
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  }
})

test('implementation contains no GitHub workflow mutation command', () => {
  const source = readFileSync(scriptPath, 'utf8')
  assert.doesNotMatch(source, /['"](?:enable|disable|delete|cancel|rerun)['"]/)
  assert.doesNotMatch(source, /secret(?:s)?\s+(?:list|set|delete)/i)
})
