import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const root = path.resolve(import.meta.dirname, '../..')
const workflowPath = path.join(root, '.github/workflows/public-freshness-probe.yml')
const source = fs.readFileSync(workflowPath, 'utf8')
const workflow = parse(source)

function probeScript() {
  const job = workflow.jobs.probe
  const step = job.steps.find((s) => s.name === 'Probe public health and publication watermark')
  assert.ok(step, 'probe step missing')
  return step.run
}

test('probe is secret-free, checkout-free and independent of the V1 kill switches', () => {
  assert.deepEqual(Object.keys(workflow.on), ['schedule'])
  assert.equal(workflow.on.workflow_dispatch, undefined)
  assert.deepEqual(workflow.permissions, { issues: 'write' })
  const job = workflow.jobs.probe
  assert.equal(job.if, undefined, 'probe must not share the `if: false` suspension')
  assert.equal(job.permissions, undefined)
  for (const step of job.steps) {
    assert.equal(step.uses, undefined, 'probe runs no third-party action or checkout')
  }
  // The only secret is the job-scoped GITHUB_TOKEN.
  const secrets = [...source.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(secrets)], ['GITHUB_TOKEN'])
  assert.equal(job.env.HEALTH_URL, 'https://www.arenafi.org/api/health')
  const script = probeScript()
  assert.match(script, /--request GET/)
  assert.doesNotMatch(script, /Authorization|CRON_SECRET|--data/)
})

function runScenario({ http = '200', body, curlExit = '0', issues = '[]' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-public-freshness-'))
  try {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, 'curl'),
      [
        '#!/usr/bin/env bash',
        'output=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'printf "%s" "$FAKE_BODY" > "$output"',
        'printf "%s" "$FAKE_HTTP"',
        'exit "$FAKE_CURL_EXIT"',
        '',
      ].join('\n')
    )
    fs.writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
        'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then printf "%s" "$FAKE_ISSUES"; fi',
        'exit 0',
        '',
      ].join('\n')
    )
    fs.chmodSync(path.join(bin, 'curl'), 0o755)
    fs.chmodSync(path.join(bin, 'gh'), 0o755)
    const ghLog = path.join(dir, 'gh.log')
    const summary = path.join(dir, 'summary.md')
    fs.writeFileSync(ghLog, '')
    fs.writeFileSync(summary, '')
    const result = spawnSync('bash', ['-c', probeScript()], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: summary,
        HEALTH_URL: 'https://health.example.test/api/health',
        MAX_PUBLICATION_AGE_HOURS: '8',
        ISSUE_TITLE: 'freshness probe',
        FAKE_BODY: body === undefined ? '' : JSON.stringify(body),
        FAKE_HTTP: http,
        FAKE_CURL_EXIT: curlExit,
        FAKE_ISSUES: issues,
        FAKE_GH_LOG: ghLog,
      },
    })
    return { ...result, ghLog: fs.readFileSync(ghLog, 'utf8') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()
const health = (publishedAt, freshness = 'pass') => ({
  status: freshness === 'pass' ? 'healthy' : 'degraded',
  checks: {
    freshness: {
      status: freshness,
      message: '32/32 sources fresh; 0 stale; 0 critical; 0 unknown',
      details: { latestSuccessfulPublicationAt: publishedAt },
    },
  },
})

test('passes and closes an open issue when the publication is fresh', () => {
  const result = runScenario({
    body: health(hoursAgo(1)),
    issues: '[{"number":7,"title":"freshness probe"}]',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.ghLog, /issue close 7/)
  assert.doesNotMatch(result.ghLog, /issue create/)
})

test('fails and opens an issue on a non-2xx health response (stale data = 503)', () => {
  const result = runScenario({ http: '503', body: health(hoursAgo(1), 'fail') })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /非 2xx/)
  assert.match(result.ghLog, /issue create --title freshness probe/)
})

test('fails when health is unreachable', () => {
  const result = runScenario({ http: '000', curlExit: '28' })
  assert.equal(result.status, 1)
  assert.match(result.ghLog, /issue create/)
})

test('fails when the publication watermark is older than the threshold even on 200', () => {
  const result = runScenario({ body: health(hoursAgo(72)) })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /72 小时未发布/)
})

test('fails when the publication watermark is missing', () => {
  const result = runScenario({ body: health(null) })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /发布水位缺失/)
})

test('edits the existing issue instead of opening a duplicate', () => {
  const result = runScenario({
    body: health(hoursAgo(30)),
    issues: '[{"number":9,"title":"freshness probe"}]',
  })
  assert.equal(result.status, 1)
  assert.match(result.ghLog, /issue edit 9/)
  assert.doesNotMatch(result.ghLog, /issue create/)
})
