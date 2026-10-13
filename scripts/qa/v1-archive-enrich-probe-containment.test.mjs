import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = 'scripts/archive/test-enrich-fix.sh'
const source = readFileSync(resolve(ROOT, script), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const archiveReadme = readFileSync(resolve(ROOT, 'scripts/archive/README.md'), 'utf8')

const forbiddenRuntimeTokens =
  /https?:\/\/|\b(?:curl|wget|fetch|ssh|scp|ping|jq|tail|head|node|npm|npx|python|git|docker|pm2|vercel)\b|\b(?:api|cron|secret|token|key|env|platform)\b|\$\{?/i

function runProbe(args) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
  })
}

function section(document, heading) {
  const start = document.indexOf(heading)
  assert.ok(start >= 0, `missing ${heading}`)
  const nextHeading = document.indexOf('\n##', start + heading.length)

  return document.slice(start, nextHeading === -1 ? undefined : nextHeading)
}

test('archive enrich probe is an executable inert exit-2 tombstone', () => {
  assert.match(source, /\[RETIRED\] scripts\/archive\/test-enrich-fix\.sh/)
  assert.match(source, /^exit 2$/m)
  assert.doesNotMatch(source, forbiddenRuntimeTokens)
  assert.notEqual(statSync(resolve(ROOT, script)).mode & 0o111, 0, `${script} must stay executable`)

  for (const args of [[], ['--legacy', '--force'], ['platform=ignored', 'period=90D']]) {
    const result = runProbe(args)

    assert.equal(result.error, undefined, `${script} must launch`)
    assert.equal(result.status, 2, `${script} must exit 2 for every invocation`)
    assert.equal(result.stdout, '', `${script} must keep stdout empty`)
    assert.equal(
      result.stderr,
      '[RETIRED] scripts/archive/test-enrich-fix.sh\n',
      `${script} must only report its retirement on stderr`
    )
  }
})

test('archive enrich probe retirement is narrowly documented as source-only', () => {
  const progressSection = section(progress, '## V1 archive enrich probe source containment')
  const runbookSection = section(runbook, '### V1 archive enrich probe source boundary')
  const readmeSection = section(archiveReadme, '## V1 retired compatibility path')

  for (const document of [progressSection, runbookSection]) {
    assert.match(document, /`scripts\/archive\/test-enrich-fix\.sh`/)
    assert.match(document, /source-only/)
    assert.match(document, /not a recoverable work route|不是可恢复的工作入口/)
    assert.doesNotMatch(document, /api\/cron\/enrich|CRON_SECRET|API_BASE|curl/i)
  }

  assert.match(readmeSection, /`scripts\/archive\/test-enrich-fix\.sh`/)
  assert.match(readmeSection, /not treat it as a recoverable work route/)
  assert.match(readmeSection, /covers that file only/)
})
