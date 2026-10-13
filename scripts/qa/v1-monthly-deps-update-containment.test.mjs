import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = 'scripts/monthly-deps-update.mjs'
const source = readFileSync(resolve(ROOT, script), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const packageJson = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const ciWorkflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8')
const dependabot = readFileSync(resolve(ROOT, '.github/dependabot.yml'), 'utf8')
const forbiddenCapabilitySyntax =
  /\b(?:import|require|child_process|exec(?:Sync|File(?:Sync)?)?|spawn(?:Sync)?|npm|npx|git|audit|outdated|install|checkout|fs|writeFile(?:Sync)?|mkdir(?:Sync)?|existsSync|path|fileURLToPath|report|docs|process\.env|dotenv|https?|fetch|curl|wget|ssh|scp|docker|vercel|pm2)\b|[`$]|\b(?:read|append|unlink|rename|chmod|rm)\w*\s*\(/i

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

test('monthly dependency updater is an inert exit-2 tombstone', () => {
  assert.equal(
    source,
    "#!/usr/bin/env node\n\nprocess.stderr.write('[RETIRED] scripts/monthly-deps-update.mjs\\n')\nprocess.exitCode = 2\n"
  )
  assert.doesNotMatch(source, forbiddenCapabilitySyntax)
})

test('monthly dependency updater fails closed for every local invocation', () => {
  for (const args of [[], ['--check'], ['--apply'], ['--unexpected-legacy-flag=value']]) {
    const result = runTombstone(args)

    assert.equal(result.error, undefined, `${script} must launch`)
    assert.equal(result.status, 2, `${script} must exit 2 for every invocation`)
    assert.equal(result.stdout, '', `${script} must keep stdout empty`)
    assert.equal(
      result.stderr,
      '[RETIRED] scripts/monthly-deps-update.mjs\n',
      `${script} must only report its retirement on stderr`
    )
  }
})

test('containment documentation preserves independent dependency-review controls', () => {
  const progressSection = section(
    progress,
    '## V1 monthly dependency update source containment',
    '\n## '
  )
  const runbookSection = section(
    runbook,
    '### V1 monthly dependency update source boundary',
    '\n### '
  )

  for (const document of [progressSection, runbookSection]) {
    assert.match(document, /`scripts\/monthly-deps-update\.mjs`/)
    assert.match(document, /source-only/i)
    assert.match(document, /security:fix/)
    assert.match(document, /npm audit/)
    assert.match(document, /Dependabot/)
  }

  assert.match(packageJson, /"security:fix": "npm audit fix"/)
  assert.doesNotMatch(packageJson, /monthly-deps-update\.mjs/)
  assert.match(ciWorkflow, /Security — npm audit/)
  assert.match(ciWorkflow, /npm audit --audit-level=high/)
  assert.doesNotMatch(ciWorkflow, /monthly-deps-update\.mjs/)
  assert.match(dependabot, /package-ecosystem: "npm"/)
  assert.match(dependabot, /interval: "weekly"/)
  assert.match(packageJson, /"qa:sweep-unit": "node --test scripts\/qa\/\*\.test\.mjs"/)
})
