import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = 'scripts/performance/measure-lcp.mjs'
const source = readFileSync(resolve(ROOT, script), 'utf8')
const performanceReadme = readFileSync(resolve(ROOT, 'scripts/performance/README.md'), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const packageJson = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const lighthouseWorkflow = readFileSync(
  resolve(ROOT, '.github/workflows/lighthouse-ci.yml'),
  'utf8'
)
const forbiddenLegacyCapabilitySyntax =
  /\b(?:lighthouse|npm|npx|install|target_url|url|report|child_process|exec(?:sync|file(?:sync)?)?|fetch|curl|wget|require|import|existsSync|readFileSync|writeFileSync|join)\b|node:(?:fs|path)|process\.(?:argv|env)|https?:\/\/|\$[({A-Za-z_]/i

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

test('LCP measurement CLI is an inert JavaScript exit-2 tombstone', () => {
  assert.equal(
    source,
    "#!/usr/bin/env node\n\nprocess.stderr.write('[RETIRED] scripts/performance/measure-lcp.mjs\\n')\nprocess.exitCode = 2\n"
  )
  assert.doesNotMatch(source, forbiddenLegacyCapabilitySyntax)
  assert.notEqual(statSync(resolve(ROOT, script)).mode & 0o111, 0, `${script} must stay executable`)
})

test('LCP measurement tombstone fails closed for every local invocation', () => {
  // Invoke through Node while separately retaining the legacy executable-path contract.
  for (const args of [
    [],
    ['--url', 'https://ignored.invalid'],
    ['--report=ignored'],
    ['--force'],
  ]) {
    const result = runTombstone(args)

    assert.equal(result.error, undefined, `${script} must launch`)
    assert.equal(result.status, 2, `${script} must exit 2 for every invocation`)
    assert.equal(result.stdout, '', `${script} must keep stdout empty`)
    assert.equal(
      result.stderr,
      '[RETIRED] scripts/performance/measure-lcp.mjs\n',
      `${script} must only report its retirement on stderr`
    )
  }
})

test('retired LCP documentation does not restore its recipe or disable independent tooling', () => {
  const readmeSection = section(
    performanceReadme,
    '## 📊 LCP 测量脚本（V1 NO-GO 历史边界）',
    '\n---'
  )
  const progressSection = section(progress, '## V1 LCP measurement CLI source containment', '\n## ')
  const runbookSection = section(runbook, '### V1 LCP measurement CLI source boundary', '\n### ')

  for (const document of [readmeSection, progressSection, runbookSection]) {
    assert.match(document, /`scripts\/performance\/measure-lcp\.mjs`/)
    assert.match(document, /source-only/i)
    assert.match(document, /\[RETIRED\]/)
  }

  assert.match(readmeSection, /不提供旧脚本的手动运行/)
  assert.doesNotMatch(
    readmeSection,
    /```|https?:\/\/|node scripts\/performance\/measure-lcp\.mjs|npm install|npx wait-on|\.lighthouse-(?:report|summary)\.json/i
  )
  assert.match(progressSection, /Lighthouse CI\/workflow/)
  assert.match(runbookSection, /genuine Lighthouse CI\/workflow/)
  assert.match(performanceReadme, /## 🎯 性能目标/)
  assert.match(performanceReadme, /Vercel Analytics/)
  assert.match(performanceReadme, /Chrome DevTools/)
  assert.match(performanceReadme, /## 🛠️ 优化工具/)

  assert.match(packageJson, /"lighthouse": "node scripts\/lighthouse-test\.mjs"/)
  assert.doesNotMatch(packageJson, /measure-lcp\.mjs/)
  assert.match(lighthouseWorkflow, /^name: Lighthouse CI$/m)
  assert.doesNotMatch(lighthouseWorkflow, /measure-lcp\.mjs/)
  assert.ok(existsSync(resolve(ROOT, 'scripts/lighthouse-test.mjs')))
  assert.match(packageJson, /"qa:sweep-unit": "node --test scripts\/qa\/\*\.test\.mjs"/)
})
