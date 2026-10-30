import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = 'scripts/archive/check-homepage-regression.mjs'
const source = readFileSync(resolve(ROOT, script), 'utf8')
const runtimeSource = source.replace(/^#!\/usr\/bin\/env node\n/, '')
const archiveReadme = readFileSync(resolve(ROOT, 'scripts/archive/README.md'), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const packageJson = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const ciWorkflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8')
const lighthouseWorkflow = readFileSync(
  resolve(ROOT, '.github/workflows/lighthouse-ci.yml'),
  'utf8'
)
const healthMonitorWorkflow = readFileSync(
  resolve(ROOT, '.github/workflows/health-monitor.yml'),
  'utf8'
)
const forbiddenLegacyCapabilitySyntax =
  /\b(?:site_url|env|fetch|console|fs|read\w*|existsSync|import|require|curl|wget|network|http)\b|process\.(?:env|exit\s*\(|kill)|node:(?:fs|path|url)|https?:\/\/|\$[({A-Za-z_]/i

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

test('homepage regression CLI is an inert exact Node tombstone', () => {
  assert.equal(
    source,
    "#!/usr/bin/env node\n\nprocess.stderr.write('[RETIRED] scripts/archive/check-homepage-regression.mjs\\n')\nprocess.exitCode = 2\n"
  )
  assert.doesNotMatch(runtimeSource, forbiddenLegacyCapabilitySyntax)
  assert.equal(
    statSync(resolve(ROOT, script)).mode & 0o111,
    0,
    `${script} must remain non-executable`
  )
})

test('homepage regression CLI fails closed under an empty environment', () => {
  for (const args of [[], ['--url=https://ignored.invalid'], ['--force', '--verbose']]) {
    const result = runTombstone(args)

    assert.equal(result.error, undefined, `${script} must launch`)
    assert.equal(result.status, 2, `${script} must exit 2 for every invocation`)
    assert.equal(result.stdout, '', `${script} must keep stdout empty`)
    assert.equal(
      result.stderr,
      '[RETIRED] scripts/archive/check-homepage-regression.mjs\n',
      `${script} must only report its retirement on stderr`
    )
  }
})

test('documentation keeps live homepage and health coverage outside this one CLI', () => {
  const progressSection = section(
    progress,
    '## V1 homepage regression archive CLI source containment',
    '\n## '
  )
  const runbookSection = section(
    runbook,
    '### V1 homepage regression archive CLI source boundary',
    '\n### '
  )

  assert.match(archiveReadme, /`scripts\/archive\/check-homepage-regression\.mjs`/)
  assert.match(archiveReadme, /covers that file only/)
  for (const document of [progressSection, runbookSection]) {
    assert.match(document, /`scripts\/archive\/check-homepage-regression\.mjs`/)
    assert.match(document, /source-only/i)
    assert.match(document, /app\/page\.tsx/)
    assert.match(document, /HomePage/)
    assert.match(document, /HomePageLoader/)
    assert.match(document, /SSR ranking/i)
    assert.match(document, /homepage Jest\/E2E/i)
    assert.match(document, /Lighthouse CI/i)
    assert.match(document, /\/api\/health/)
    assert.match(document, /current workflows|当前 workflows/i)
    assert.match(document, /external state/i)
    assert.doesNotMatch(document, /all homepage.*stopped/i)
  }

  for (const activePath of [
    'app/page.tsx',
    'app/components/home/HomePage.tsx',
    'app/components/home/HomePageLoader.tsx',
    'app/components/home/SSRRankingTable.tsx',
    'app/components/home/__tests__/HomePageLoader.test.tsx',
    'e2e/home.spec.ts',
    'e2e/runtime-qa.spec.ts',
    'scripts/lighthouse-test.mjs',
    '.github/workflows/lighthouse-ci.yml',
    '.github/workflows/health-monitor.yml',
    'app/api/health/route.ts',
    'app/api/health/pipeline/route.ts',
  ]) {
    assert.ok(existsSync(resolve(ROOT, activePath)), `${activePath} must remain outside this batch`)
  }
  assert.match(packageJson, /"test:e2e": "playwright test"/)
  assert.match(packageJson, /"lighthouse": "node scripts\/lighthouse-test\.mjs"/)
  assert.doesNotMatch(packageJson, /check-homepage-regression\.mjs/)
  assert.doesNotMatch(ciWorkflow, /check-homepage-regression\.mjs/)
  assert.match(lighthouseWorkflow, /^name: Lighthouse CI$/m)
  assert.doesNotMatch(lighthouseWorkflow, /check-homepage-regression\.mjs/)
  assert.match(healthMonitorWorkflow, /^name: Health Monitor$/m)
  assert.doesNotMatch(healthMonitorWorkflow, /check-homepage-regression\.mjs/)
  assert.match(packageJson, /"qa:sweep-unit": "node --test scripts\/qa\/\*\.test\.mjs"/)
})
