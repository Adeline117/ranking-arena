import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = 'scripts/archive/check-stuck-simple.mjs'
const source = readFileSync(resolve(ROOT, script), 'utf8')
const runtimeSource = source.replace(/^#!\/usr\/bin\/env node\n/, '')
const archiveReadme = readFileSync(resolve(ROOT, 'scripts/archive/README.md'), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const packageJson = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const ciWorkflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8')
const forbiddenLegacyCapabilitySyntax =
  /\b(?:import|require|env|supabase|service(?:_| |-)?role|fetch|url|pipeline_logs|console|log|readFileSync|writeFileSync|existsSync|fs|path|child_process|exec(?:sync|file(?:sync)?)?)\b|node:(?:fs|path|url)|process\.(?:env|argv)|https?:\/\/|\$[({A-Za-z_]/i

function section(source, heading, nextHeading) {
  const start = source.indexOf(heading)
  const end = source.indexOf(nextHeading, start + heading.length)

  assert.notEqual(start, -1, `missing ${heading}`)
  return source.slice(start, end === -1 ? undefined : end)
}

function runTombstone(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
  })
}

test('stuck-log diagnostic is an executable inert Node exit-2 tombstone', () => {
  assert.equal(
    source,
    "#!/usr/bin/env node\n\nprocess.stderr.write('[RETIRED] scripts/archive/check-stuck-simple.mjs\\n')\nprocess.exitCode = 2\n"
  )
  assert.doesNotMatch(runtimeSource, forbiddenLegacyCapabilitySyntax)
  assert.notEqual(statSync(resolve(ROOT, script)).mode & 0o111, 0, `${script} must stay executable`)
})

test('stuck-log diagnostic fails closed for every local invocation', () => {
  for (const args of [[], ['--url', 'https://ignored.invalid'], ['--logs=10'], ['--force']]) {
    const result = runTombstone(args)

    assert.equal(result.error, undefined, `${script} must launch`)
    assert.equal(result.status, 2, `${script} must exit 2 for every invocation`)
    assert.equal(result.stdout, '', `${script} must keep stdout empty`)
    assert.equal(
      result.stderr,
      '[RETIRED] scripts/archive/check-stuck-simple.mjs\n',
      `${script} must only report its retirement on stderr`
    )
  }
})

test('documentation keeps current monitoring outside this single-script boundary', () => {
  const progressSection = section(
    progress,
    '## V1 stuck-log diagnostic CLI source containment',
    '\n## '
  )
  const runbookSection = section(
    runbook,
    '### V1 stuck-log diagnostic CLI source boundary',
    '\n### '
  )

  assert.match(archiveReadme, /`scripts\/archive\/check-stuck-simple\.mjs`/)
  assert.match(archiveReadme, /not a `pipeline_logs` diagnostic or recovery route/)
  for (const document of [progressSection, runbookSection]) {
    assert.match(document, /`scripts\/archive\/check-stuck-simple\.mjs`/)
    assert.match(document, /source-only/i)
    assert.match(document, /pipeline_logs/)
    assert.match(document, /current monitoring APIs?/i)
    assert.match(document, /meta-monitor/i)
    assert.match(document, /external state|外部状态/i)
    assert.match(document, /lib\/services\/pipeline-logger\.ts/)
    assert.match(document, /\/api\/health\/pipeline/)
    assert.match(document, /enrichment-completeness/)
    assert.match(document, /lib\/cron\/auto-cleanup-stuck\.ts/)
    assert.match(document, /\/api\/cron\/cleanup-stuck-logs/)
    assert.doesNotMatch(document, /all monitoring.*stopped/i)
  }

  assert.ok(existsSync(resolve(ROOT, 'lib/services/pipeline-logger.ts')))
  assert.ok(existsSync(resolve(ROOT, 'app/api/health/pipeline/route.ts')))
  assert.ok(existsSync(resolve(ROOT, 'app/api/admin/monitoring/enrichment-completeness/route.ts')))
  assert.ok(existsSync(resolve(ROOT, 'lib/cron/auto-cleanup-stuck.ts')))
  assert.ok(existsSync(resolve(ROOT, 'app/api/cron/cleanup-stuck-logs/route.ts')))
  assert.doesNotMatch(packageJson, /check-stuck-simple\.mjs/)
  assert.doesNotMatch(ciWorkflow, /check-stuck-simple\.mjs/)
  assert.match(packageJson, /"qa:sweep-unit": "node --test scripts\/qa\/\*\.test\.mjs"/)
})
